// The ONLY calls from Unity to the page: "ready" and "error" notifications.
// There is deliberately no function for bids, purses, squads, timers or results: Unity is a
// display-only layer and cannot act on the auction.
mergeInto(LibraryManager.library, {
  ArenaNotifyReady: function () {
    try { window.dispatchEvent(new CustomEvent('ipl-arena', { detail: { type: 'ready' } })); } catch (e) {}
  },
  ArenaNotifyError: function (messagePtr) {
    var message = UTF8ToString(messagePtr).slice(0, 300);
    try { window.dispatchEvent(new CustomEvent('ipl-arena', { detail: { type: 'error', message: message } })); } catch (e) {}
  }
});
