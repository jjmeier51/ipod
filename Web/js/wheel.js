/*
 * Click Wheel input (4th generation).
 *
 * The whole disc is one touch surface. Dragging around it scrolls (the same
 * angle/dead-zone/reversal rules as the original web iPod); pressing and
 * releasing near a printed label clicks that button; holding a label fires a
 * long press (MENU → backlight, ⏮/⏭ → seek with repeat); the centre button
 * selects, or fires a hold after `selectHoldMs`.
 *
 * Events are delivered to the handlers object:
 *   scroll({step, degrees, speed}), dragStart(), dragEnd(),
 *   menu(), menuHold(), back(), forward(), backHold({repeat}),
 *   forwardHold({repeat}), playPause(), select(), selectHold(),
 *   keyScroll({step, heldMs}), activity()
 */
"use strict";
window.IPOD = window.IPOD || {};

(function (IPOD) {
  const REVERSAL_DEGREES = 8;       // accumulate this much before flipping direction
  const DEAD_ZONE_RATIO = 0.1;      // ignore moves shorter than 10% of the radius
  const TAP_MAX_DEGREES = 5;        // a press that rotates less than this is a tap
  const TAP_MAX_PX = 14;            // ...and moves less than this
  const LONG_PRESS_MS = 1000;
  const REPEAT_MS = 500;

  function angleOf({ x, y }) {
    return (Math.atan2(y, x) * 180) / Math.PI;
  }
  function deltaDegrees(a, b) {
    return ((((b - a) % 360) + 540) % 360) - 180;
  }
  // Squared distance from the centre to the segment a→b (lets a swipe across
  // the middle be ignored instead of read as a 180° jump).
  function segmentDistanceSq(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.min(1, Math.max(0, -(a.x * dx + a.y * dy) / len));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    return px * px + py * py;
  }
  function speedOf(degrees, ms) {
    return ms > 0 ? (degrees / ms) * 1000 : 0;
  }
  function quadrantOf(deg) {
    // atan2 angles: right = 0, down = 90, left = ±180, up = -90
    if (deg >= -135 && deg < -45) return "menu";
    if (deg >= -45 && deg < 45) return "forward";
    if (deg >= 45 && deg < 135) return "playpause";
    return "back";
  }

  function longPressTimer(fire) {
    let timeout, interval, fired = false;
    function clear() {
      clearTimeout(timeout);
      clearInterval(interval);
      timeout = interval = undefined;
    }
    return {
      start(duration, repeatInterval) {
        clear();
        fired = false;
        timeout = setTimeout(() => {
          timeout = undefined;
          fired = true;
          fire(false);
          if (repeatInterval !== undefined) interval = setInterval(() => fire(true), repeatInterval);
        }, duration);
      },
      // Returns true if the long press already fired (so the release is not a click).
      stop() {
        clear();
        const f = fired;
        fired = false;
        return f;
      },
      get active() {
        return timeout !== undefined || interval !== undefined;
      },
    };
  }

  function createWheel(root, handlers, options = {}) {
    const face = root.querySelector(".wheel-face");
    const selectButton = root.querySelector(".select-button");
    const buttons = {
      menu: root.querySelector(".menu-button"),
      back: root.querySelector(".back-button"),
      forward: root.querySelector(".forward-button"),
      playpause: root.querySelector(".playpause-button"),
    };
    let excludeRatio = options.excludeRadiusRatio ?? 0.361;
    let disabled = false;
    let selectHoldMs = null;

    const h = (name, ...args) => {
      if (typeof handlers[name] === "function") handlers[name](...args);
    };

    // ── Disc: rotate / tap / hold ───────────────────────────────────────────
    let pointerId;
    let last;            // last offset {x,y}
    let lastTime;
    let direction;       // +1 / -1
    let reversal = 0;    // degrees accumulated against `direction`
    let mode;            // "press" | "scroll"
    let pressQuadrant;
    let travelled = 0;   // total |degrees| in this gesture
    let start;           // offset at pointerdown
    let holdConsumed = false;

    const holdTimer = longPressTimer((repeat) => {
      if (mode !== "press") return;
      holdConsumed = true;
      if (pressQuadrant === "menu") {
        if (!repeat) h("menuHold");
      } else if (pressQuadrant === "back") {
        h("backHold", { repeat });
      } else if (pressQuadrant === "forward") {
        h("forwardHold", { repeat });
      }
    });

    function geometry(ev) {
      const rect = face.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const radius = Math.min(rect.width, rect.height) / 2;
      const inner = radius * excludeRatio;
      const x = ev.clientX - cx;
      const y = ev.clientY - cy;
      const d2 = x * x + y * y;
      return {
        offset: { x, y },
        radius,
        withinWheel: d2 <= radius * radius + 1e-6 && d2 >= inner * inner,
      };
    }

    function setPressed(q) {
      if (q) root.dataset.pressed = q;
      else delete root.dataset.pressed;
    }

    function reset() {
      pointerId = undefined;
      last = undefined;
      lastTime = undefined;
      direction = undefined;
      reversal = 0;
      mode = undefined;
      travelled = 0;
      start = undefined;
      holdConsumed = false;
      holdTimer.stop();
      setPressed(null);
      root.classList.remove("dragging");
    }

    function onDown(ev) {
      if (disabled || pointerId !== undefined) return;
      if (!ev.isPrimary || (ev.pointerType === "mouse" && ev.button !== 0)) return;
      const g = geometry(ev);
      if (!g.withinWheel) return;
      h("activity");
      pointerId = ev.pointerId;
      last = g.offset;
      start = g.offset;
      lastTime = ev.timeStamp;
      mode = "press";
      pressQuadrant = quadrantOf(angleOf(g.offset));
      setPressed(pressQuadrant);
      const repeat = pressQuadrant === "back" || pressQuadrant === "forward" ? REPEAT_MS : undefined;
      if (pressQuadrant !== "playpause") holdTimer.start(LONG_PRESS_MS, repeat);
      try {
        face.setPointerCapture(pointerId);
      } catch (_) {}
    }

    function onMove(ev) {
      if (ev.pointerId !== pointerId || !last) return;
      const g = geometry(ev);
      const deadZone = g.radius * DEAD_ZONE_RATIO;
      const prev = last;
      const dt = ev.timeStamp - lastTime;
      last = g.offset;
      lastTime = ev.timeStamp;

      if (mode === "press") {
        const dx = g.offset.x - start.x;
        const dy = g.offset.y - start.y;
        const rotated = Math.abs(deltaDegrees(angleOf(start), angleOf(g.offset)));
        if (Math.hypot(dx, dy) > TAP_MAX_PX && rotated > TAP_MAX_DEGREES) {
          mode = "scroll";
          holdTimer.stop();
          setPressed(null);
          root.classList.add("dragging");
          h("dragStart");
        } else {
          return;
        }
      }

      if (segmentDistanceSq(prev, g.offset) < deadZone * deadZone) return;
      const delta = deltaDegrees(angleOf(prev), angleOf(g.offset));
      if (delta === 0) return;
      const sign = delta > 0 ? 1 : -1;
      const degrees = Math.abs(delta);
      if (direction === undefined || sign === direction) {
        direction = sign;
        reversal = 0;
      } else {
        reversal += degrees;
        if (reversal < REVERSAL_DEGREES) return;
        direction = sign;
        reversal = 0;
      }
      travelled += degrees;
      h("scroll", { step: direction, degrees, speed: speedOf(degrees, dt) });
    }

    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      const wasPress = mode === "press";
      const quadrant = pressQuadrant;
      const consumed = holdConsumed || holdTimer.stop();
      const wasScroll = mode === "scroll";
      try {
        face.releasePointerCapture(pointerId);
      } catch (_) {}
      reset();
      if (wasScroll) h("dragEnd");
      if (wasPress && !consumed && ev.type === "pointerup") {
        if (quadrant === "menu") h("menu");
        else if (quadrant === "back") h("back");
        else if (quadrant === "forward") h("forward");
        else if (quadrant === "playpause") h("playPause");
      } else if (wasPress && consumed && (quadrant === "back" || quadrant === "forward")) {
        h("holdEnd");
      }
    }

    face.addEventListener("pointerdown", onDown);
    face.addEventListener("pointermove", onMove);
    face.addEventListener("pointerup", onUp);
    face.addEventListener("pointercancel", onUp);
    face.addEventListener("lostpointercapture", (ev) => {
      if (ev.pointerId === pointerId) onUp(ev);
    });
    face.addEventListener("contextmenu", (ev) => ev.preventDefault());

    // ── Centre button ──────────────────────────────────────────────────────
    let selectPointer;
    const selectTimer = longPressTimer(() => {
      selectButton.classList.remove("pressed");
      h("selectHold");
    });
    selectButton.addEventListener("pointerdown", (ev) => {
      if (disabled || !ev.isPrimary) return;
      h("activity");
      selectPointer = ev.pointerId;
      selectButton.classList.add("pressed");
      if (selectHoldMs !== null) selectTimer.start(selectHoldMs);
      else selectTimer.stop();
    });
    const selectRelease = (ev) => {
      if (ev.pointerId !== selectPointer) return;
      selectPointer = undefined;
      selectButton.classList.remove("pressed");
      const held = selectTimer.stop();
      if (!held && ev.type === "pointerup") h("select");
    };
    selectButton.addEventListener("pointerup", selectRelease);
    selectButton.addEventListener("pointercancel", selectRelease);
    selectButton.addEventListener("pointerleave", (ev) => {
      if (ev.pointerId === selectPointer) {
        selectPointer = undefined;
        selectButton.classList.remove("pressed");
        selectTimer.stop();
      }
    });
    selectButton.addEventListener("contextmenu", (ev) => ev.preventDefault());
    // Keyboard / assistive technology activation of the centre button.
    selectButton.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        if (!ev.repeat) h("select");
      }
    });

    // ── Accessible quadrant buttons (VoiceOver / keyboard) ─────────────────
    for (const [name, btn] of Object.entries(buttons)) {
      if (!btn) continue;
      btn.addEventListener("click", (ev) => {
        if (disabled || ev.detail === -1) return;
        h("activity");
        if (name === "menu") h("menu");
        else if (name === "back") h("back");
        else if (name === "forward") h("forward");
        else h("playPause");
      });
    }

    // ── Keyboard (desktop debugging; iOS hardware keyboards) ───────────────
    let keyHeldSince;
    root.addEventListener("keydown", (ev) => {
      if (disabled) return;
      const now = performance.now();
      switch (ev.key) {
        case "ArrowDown":
        case "ArrowUp": {
          ev.preventDefault();
          if (!ev.repeat || keyHeldSince === undefined) keyHeldSince = now;
          h("activity");
          h("keyScroll", { step: ev.key === "ArrowDown" ? 1 : -1, heldMs: ev.repeat ? now - keyHeldSince : 0 });
          break;
        }
        case "Enter":
        case " ":
          ev.preventDefault();
          if (!ev.repeat) { h("activity"); h("select"); }
          break;
        case "Escape":
        case "Backspace":
          ev.preventDefault();
          if (!ev.repeat) { h("activity"); h("menu"); }
          break;
        case "ArrowLeft":
          ev.preventDefault();
          if (!ev.repeat) { h("activity"); h("back"); }
          break;
        case "ArrowRight":
          ev.preventDefault();
          if (!ev.repeat) { h("activity"); h("forward"); }
          break;
        case "p":
          if (!ev.repeat) { h("activity"); h("playPause"); }
          break;
        case "b":
          if (!ev.repeat) { h("activity"); h("menuHold"); }
          break;
        default:
          return;
      }
    });
    root.addEventListener("keyup", (ev) => {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") keyHeldSince = undefined;
    });

    return {
      setDisabled(v) {
        disabled = !!v;
        if (disabled) reset();
      },
      setSelectHoldMs(ms) {
        selectHoldMs = ms;
      },
      setExcludeRadiusRatio(r) {
        excludeRatio = r;
      },
      setPlaying(isPlaying) {
        if (buttons.playpause) buttons.playpause.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
      },
      focus() {
        root.focus({ preventScroll: true });
      },
    };
  }

  IPOD.createWheel = createWheel;
})(window.IPOD);
