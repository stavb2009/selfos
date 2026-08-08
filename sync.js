// sync.js — cross-device sync for SELF OS via Supabase (Postgres + Auth), no SDK required.
//
// Table: public.selfos_sync (user_id uuid references auth.users, data jsonb, updated_at timestamptz)
// RLS:   auth.uid() = user_id — only the logged-in account can read/write its own row.
//
// Design:
//  - Auth: email magic link, implicit flow. Tokens arrive in the URL hash after the link is clicked
//    and are consumed once, then stripped from the address bar.
//  - The synced payload excludes photos (device-local only, same as the existing Export button).
//  - Merge is per-entry and id-based. New entries never collide (fresh ids), so they simply union.
//    Edits to an *existing* id are resolved by a per-item `_t` (ms timestamp) — newest wins.
//  - Deletions use tombstones so a delete on one device isn't resurrected by a stale copy elsewhere.
//    Tombstones older than 90 days are pruned so the payload doesn't grow forever.
//
// This file has no dependency on the rest of tracker.html and can be unit-tested standalone —
// see the `_test` export at the bottom.

(function () {
  const SUPA_URL = 'https://dbwutepkaowmsolhaghu.supabase.co';
  const SUPA_KEY = 'sb_publishable_BhPK6qWkjQDt5tINJ6-yBw_hLY3fWvK'; // public by design — protected by RLS, not secrecy

  const AUTH_KEY = 'selfos_auth';            // { access_token, refresh_token, expires_at }
  const LAST_SYNC_KEY = 'selfos_last_sync';
  const TOMBSTONE_KEY = 'selfos_tombstones'; // { workout:[{id,t}], tasks:[...], ... }
  const LIST_KEYS = ['weight', 'workout', 'alcohol', 'work', 'hobby', 'tweeter', 'tasks', 'worklog'];
  const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

  function nowIso() { return new Date().toISOString(); }
  function safeParse(raw, fallback) { try { return JSON.parse(raw); } catch (e) { return fallback; } }

  function getAuth() { return safeParse(localStorage.getItem(AUTH_KEY), null); }
  function setAuth(a) { if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a)); else localStorage.removeItem(AUTH_KEY); }
  function getTombstones() { return safeParse(localStorage.getItem(TOMBSTONE_KEY), {}); }
  function setTombstones(t) { localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(t)); }

  function isLoggedIn() {
    const a = getAuth();
    return !!(a && a.access_token && a.refresh_token);
  }

  // ---- Auth: request a magic link ----
  async function requestLogin(email) {
    const res = await fetch(SUPA_URL + '/auth/v1/otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY },
      body: JSON.stringify({ email: email, options: { emailRedirectTo: location.origin + location.pathname } }),
    });
    if (!res.ok) throw new Error('Login request failed: ' + res.status + ' ' + (await res.text()));
    return true;
  }

  // ---- Auth: pick up tokens from the magic-link redirect (#access_token=...&refresh_token=...) ----
  function consumeAuthRedirect() {
    if (!location.hash || location.hash.indexOf('access_token') === -1) return false;
    const params = new URLSearchParams(location.hash.slice(1));
    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    const expires_in = parseInt(params.get('expires_in') || '3600', 10);
    if (!access_token || !refresh_token) return false;
    setAuth({ access_token: access_token, refresh_token: refresh_token, expires_at: Date.now() + expires_in * 1000 });
    history.replaceState(null, '', location.pathname + location.search); // tokens shouldn't linger in the address bar
    return true;
  }

  // ---- Auth: refresh an expired access token ----
  async function ensureFreshToken() {
    const a = getAuth();
    if (!a) return null;
    if (a.expires_at - Date.now() > 60000) return a; // still valid for >1 min
    const res = await fetch(SUPA_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY },
      body: JSON.stringify({ refresh_token: a.refresh_token }),
    });
    if (!res.ok) { setAuth(null); return null; } // refresh token dead — needs a fresh login
    const j = await res.json();
    const next = { access_token: j.access_token, refresh_token: j.refresh_token || a.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 };
    setAuth(next);
    return next;
  }

  function logout() { setAuth(null); }

  function decodeUserId(accessToken) {
    // Read the JWT payload client-side to get the row's primary key. No verification needed here —
    // PostgREST independently re-verifies the token's signature before honoring any request.
    const payload = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub;
  }

  // ---- REST against selfos_sync ----
  async function restGet(accessToken) {
    const res = await fetch(SUPA_URL + '/rest/v1/selfos_sync?select=data,updated_at', {
      headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + accessToken },
    });
    if (!res.ok) throw new Error('Pull failed: ' + res.status);
    const rows = await res.json();
    return rows[0] || null;
  }

  async function restUpsert(accessToken, userId, data) {
    const res = await fetch(SUPA_URL + '/rest/v1/selfos_sync', {
      method: 'POST',
      headers: {
        apikey: SUPA_KEY, Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([{ user_id: userId, data: data, updated_at: nowIso() }]),
    });
    if (!res.ok) throw new Error('Push failed: ' + res.status + ' ' + (await res.text()));
  }

  // ---- Merge (pure functions — no DOM/network, safe to unit test) ----
  function itemTime(item) { return typeof item._t === 'number' ? item._t : 0; }

  function mergeList(localList, remoteList, tombLocal, tombRemote) {
    const dead = new Map(); // id -> latest delete timestamp
    (tombLocal || []).concat(tombRemote || []).forEach(function (t) {
      if (!dead.has(t.id) || t.t > dead.get(t.id)) dead.set(t.id, t.t);
    });
    const byId = new Map();
    (remoteList || []).forEach(function (item) { if (item && item.id) byId.set(item.id, item); });
    (localList || []).forEach(function (item) {
      if (!item || !item.id) return;
      const existing = byId.get(item.id);
      if (!existing || itemTime(item) >= itemTime(existing)) byId.set(item.id, item);
    });
    const out = [];
    byId.forEach(function (item, id) {
      const deletedAt = dead.get(id);
      if (deletedAt !== undefined && deletedAt >= itemTime(item)) return; // delete wins unless edited after the delete
      out.push(item);
    });
    return out;
  }

  function mergeChores(local, remote) {
    const out = Object.assign({}, remote || {});
    Object.entries(local || {}).forEach(function (pair) {
      const k = pair[0], v = pair[1];
      if (!out[k] || v > out[k]) out[k] = v; // 'YYYY-MM-DD' strings compare correctly as text
    });
    return out;
  }

  function mergeQueueSeen(local, remote) {
    const set = new Set((local || []).concat(remote || []));
    return Array.from(set).slice(-2000);
  }

  function pruneTombstones(tomb) {
    const cutoff = Date.now() - TOMBSTONE_RETENTION_MS;
    const out = {};
    Object.entries(tomb || {}).forEach(function (pair) {
      out[pair[0]] = (pair[1] || []).filter(function (t) { return t.t >= cutoff; });
    });
    return out;
  }

  function mergeTombstoneKey(tombLocal, tombRemote) {
    const latest = new Map();
    (tombLocal || []).concat(tombRemote || []).forEach(function (t) {
      if (!latest.has(t.id) || t.t > latest.get(t.id).t) latest.set(t.id, t);
    });
    return Array.from(latest.values());
  }

  function buildMergedPayload(localSnapshot, remotePayload) {
    const remote = remotePayload || {};
    const tombLocal = localSnapshot._tombstones || {};
    const tombRemote = remote._tombstones || {};
    const merged = {};
    LIST_KEYS.forEach(function (key) {
      merged[key] = mergeList(localSnapshot[key], remote[key], tombLocal[key], tombRemote[key]);
    });
    merged._chores = mergeChores(localSnapshot._chores, remote._chores);
    merged._queueSeen = mergeQueueSeen(localSnapshot._queueSeen, remote._queueSeen);
    const mergedTomb = {};
    LIST_KEYS.forEach(function (key) { mergedTomb[key] = mergeTombstoneKey(tombLocal[key], tombRemote[key]); });
    merged._tombstones = pruneTombstones(mergedTomb);
    return merged;
  }

  // ---- localStorage <-> sync payload ----
  function readLocalSnapshot() {
    const snap = {};
    LIST_KEYS.forEach(function (key) {
      const raw = safeParse(localStorage.getItem('selfos_' + key), []);
      snap[key] = key === 'weight' ? raw.map(function (e) { const c = Object.assign({}, e); delete c.photo; return c; }) : raw;
    });
    snap._chores = safeParse(localStorage.getItem('selfos_chores'), {});
    snap._queueSeen = safeParse(localStorage.getItem('selfos_queue_seen'), []);
    snap._tombstones = getTombstones();
    return snap;
  }

  function writeLocalSnapshot(merged) {
    LIST_KEYS.forEach(function (key) {
      if (key === 'weight') {
        // Photos are device-local and never synced — keep whatever photo this device already has
        // for each id rather than letting the synced (photo-less) copy erase it.
        const existing = safeParse(localStorage.getItem('selfos_weight'), []);
        const photoById = new Map(existing.filter(function (e) { return e && e.photo; }).map(function (e) { return [e.id, e.photo]; }));
        const withPhotos = (merged.weight || []).map(function (e) {
          return photoById.has(e.id) ? Object.assign({}, e, { photo: photoById.get(e.id) }) : e;
        });
        localStorage.setItem('selfos_weight', JSON.stringify(withPhotos));
      } else {
        localStorage.setItem('selfos_' + key, JSON.stringify(merged[key] || []));
      }
    });
    localStorage.setItem('selfos_chores', JSON.stringify(merged._chores || {}));
    localStorage.setItem('selfos_queue_seen', JSON.stringify(merged._queueSeen || []));
    setTombstones(merged._tombstones || {});
  }

  // Called by tracker.html's DB.set wrapper whenever an id disappears from a saved list.
  function recordTombstone(key, id) {
    if (LIST_KEYS.indexOf(key) === -1) return;
    const t = getTombstones();
    t[key] = (t[key] || []).filter(function (x) { return x.id !== id; });
    t[key].push({ id: id, t: Date.now() });
    setTombstones(t);
  }

  async function syncNow() {
    if (!navigator.onLine) return { ok: false, reason: 'offline' };
    const tok = await ensureFreshToken();
    if (!tok) return { ok: false, reason: 'not-logged-in' };
    try {
      const remoteRow = await restGet(tok.access_token);
      const local = readLocalSnapshot();
      const merged = buildMergedPayload(local, remoteRow ? remoteRow.data : null);
      writeLocalSnapshot(merged);
      const userId = decodeUserId(tok.access_token);
      await restUpsert(tok.access_token, userId, merged);
      localStorage.setItem(LAST_SYNC_KEY, Date.now().toString());
      return { ok: true };
    } catch (err) {
      console.error('[sync] failed:', err);
      return { ok: false, reason: String((err && err.message) || err) };
    }
  }

  window.SELFOS_SYNC = {
    isLoggedIn: isLoggedIn,
    requestLogin: requestLogin,
    logout: logout,
    syncNow: syncNow,
    consumeAuthRedirect: consumeAuthRedirect,
    recordTombstone: recordTombstone,
    lastSyncedAt: function () { const v = localStorage.getItem(LAST_SYNC_KEY); return v ? new Date(+v) : null; },
    // Exposed only so a test harness can exercise the pure merge logic without a browser/network.
    _test: { mergeList: mergeList, mergeChores: mergeChores, mergeQueueSeen: mergeQueueSeen, buildMergedPayload: buildMergedPayload, pruneTombstones: pruneTombstones },
  };
})();
