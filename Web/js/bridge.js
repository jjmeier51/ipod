/*
 * Bridge between the iPod UI and the host.
 *
 * Inside the iOS app, calls go to WKWebView's `ipod` message handler and the
 * native side answers through `IPOD.bridge._resolve/_reject`, and pushes
 * events through `IPOD.bridge._emit`. In a plain browser a mock Spotify
 * (mock-spotify.js) answers instead so the UI can be developed and tested.
 */
"use strict";
window.IPOD = window.IPOD || {};

(function (IPOD) {
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  let mock = null;

  const native =
    typeof window.webkit !== "undefined" &&
    window.webkit.messageHandlers &&
    window.webkit.messageHandlers.ipod;

  function call(method, args) {
    if (native) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try {
          window.webkit.messageHandlers.ipod.postMessage({ id, method, args: args ?? {} });
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      });
    }
    if (!mock) return Promise.reject(new Error("No host for " + method));
    return mock.call(method, args ?? {});
  }

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  }

  function _emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error("bridge listener failed", event, err);
      }
    }
  }

  function _resolve(id, result) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.resolve(result);
  }

  function _reject(id, message) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.reject(new Error(message || "Bridge call failed"));
  }

  IPOD.bridge = {
    isNative: !!native,
    call,
    on,
    _emit,
    _resolve,
    _reject,
    useMock(m) {
      mock = m;
      if (m && m.attach) m.attach(_emit);
    },
  };
})(window.IPOD);
