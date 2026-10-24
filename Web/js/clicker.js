/*
 * Click Wheel clicker.
 *
 * In the app the click is played natively (so it mixes with Spotify through an
 * ambient audio session and pairs with a haptic tap). In a browser it is played
 * with Web Audio from the embedded WAV, with the same scheduling rules as the
 * original: clicks are spaced at least 50 ms apart on the audio clock and
 * dropped if the queue runs more than 150 ms ahead.
 */
"use strict";
window.IPOD = window.IPOD || {};

(function (IPOD) {
  const MIN_SPACING_S = 0.05;
  const MAX_AHEAD_S = 0.15;
  const GAIN = 0.3;
  const RESUME_REPLAY_MS = 200;

  function createClicker() {
    if (IPOD.bridge.isNative) {
      let lastClick = 0;
      return {
        playClick() {
          const now = performance.now();
          if (now - lastClick < MIN_SPACING_S * 1000) return;
          lastClick = now;
          IPOD.bridge.call("system.click").catch(() => {});
        },
        unlock() {},
      };
    }

    let ctx = null;
    let gain = null;
    let buffer = null;
    let nextTime = 0;
    let lastGestureAt = 0;

    function ensureContext() {
      if (ctx) return ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      gain = ctx.createGain();
      gain.gain.value = GAIN;
      gain.connect(ctx.destination);
      if (typeof CLICK_WAV_BASE64 === "string") {
        const bin = atob(CLICK_WAV_BASE64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        ctx.decodeAudioData(bytes.buffer).then((b) => {
          buffer = b;
        }).catch((err) => console.warn("click decode failed", err));
      }
      return ctx;
    }

    function schedule() {
      if (!ctx || !buffer) return;
      const now = ctx.currentTime;
      const at = Math.max(now, nextTime);
      if (at - now > MAX_AHEAD_S) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      src.start(at);
      nextTime = at + MIN_SPACING_S;
    }

    return {
      playClick() {
        const c = ensureContext();
        if (!c) return;
        if (c.state === "suspended") {
          const gestureAge = performance.now() - lastGestureAt;
          c.resume().then(() => {
            if (gestureAge < RESUME_REPLAY_MS) schedule();
          });
          return;
        }
        schedule();
      },
      unlock() {
        lastGestureAt = performance.now();
        const c = ensureContext();
        if (c && c.state === "suspended") c.resume().catch(() => {});
      },
    };
  }

  IPOD.createClicker = createClicker;
})(window.IPOD);
