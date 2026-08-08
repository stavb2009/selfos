// Auto-log queue for tracker.html — appended to by the scheduled email watcher.
// Item shape: { id: "<unique-id>", date: "YYYY-MM-DD", slot: "morning"|"noon"|"evening", note: "" }
// Each id is merged into the Tweeter log exactly once.
window.SELFOS_QUEUE = [];
