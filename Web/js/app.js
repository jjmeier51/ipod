/*
 * iPod root: boots the device, owns settings, navigation, the screens and the
 * glue between the click wheel and Spotify playback (through IPOD.bridge).
 */
"use strict";
window.IPOD = window.IPOD || {};

(function (IPOD) {
  const { bridge, i18n, SCREENS, icons } = IPOD;

  // ── Timing and tuning (matching the original web iPod) ───────────────────
  const SETTINGS_KEY = "ipod-4g:settings";
  const MIN_DISPLAY_MS = 2000;          // Apple logo stays at least this long
  const MAX_HOLD_MS = 10000;            // ...and at most this long
  const DRAG_STEP_DEGREES = 15;         // one list row per 15° of rotation
  const KEY_STEP_DEGREES = 15;
  const LIST_ACCEL = { minSpeed: 180, tierMs: 500, tiers: [1, 2, 3, 5, 8, 13, 21, 34] };
  const SEEK_ACCEL = { minSpeed: 180, tierMs: 500, tiers: [1, 2, 3, 5] };
  const MAX_SPEED = 400, SMOOTHING = 0.15, PAUSE_RESET_MS = 250;
  const IDLE_JUMP_MS = 10000;           // menus → Now Playing after idling while playing
  const SEEK_HOLD_STEPS = [5, 5, 5, 10, 10, 10, 20];
  const SEEK_STEP_SECONDS = 1;
  const SEEK_COMMIT_MS = 1000;
  const SEEK_IDLE_MS = 5000;
  const VOLUME_IDLE_MS = 5000;
  const VOLUME_DEGREES_PER_PERCENT = (1.25 * 360) / 100;
  const VOLUME_DEGREES_PER_CLICK = (1.25 * 360) / 22;
  const VOLUME_KEY_STEP = 5;
  const SCREEN_SLIDE_MS = 240;

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const haptic = (kind) => bridge.call("system.haptic", { kind }).catch(() => {});

  // ── Settings ─────────────────────────────────────────────────────────────
  const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const defaultBacklight = () => (darkQuery && darkQuery.matches ? "always_on" : "off");
  const DEFAULTS = Object.freeze({ shuffle: "off", repeat: "off", clicker: "on", backlight: defaultBacklight(), volume: 50 });
  const BACKLIGHT_SET = new Set(IPOD.BACKLIGHT_MODES.map((m) => m.mode));
  let backlightChosen = false;

  function readSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw === null) return { ...DEFAULTS };
      const t = JSON.parse(raw) || {};
      backlightChosen = t.backlightChosen === true && BACKLIGHT_SET.has(t.backlight);
      return {
        shuffle: ["off", "songs"].includes(t.shuffle) ? t.shuffle : DEFAULTS.shuffle,
        repeat: ["off", "one", "all"].includes(t.repeat) ? t.repeat : DEFAULTS.repeat,
        clicker: ["off", "on"].includes(t.clicker) ? t.clicker : DEFAULTS.clicker,
        backlight: backlightChosen ? t.backlight : defaultBacklight(),
        volume: typeof t.volume === "number" && t.volume >= 0 && t.volume <= 100 ? t.volume : DEFAULTS.volume,
      };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }
  function writeSettings(s) {
    try {
      const { backlight, ...rest } = s;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(backlightChosen ? { ...rest, backlight, backlightChosen: true } : rest));
    } catch (_) {}
  }
  const settings = readSettings();
  function updateSettings(patch) {
    Object.assign(settings, patch);
    writeSettings(settings);
    onSettingsChanged(Object.keys(patch));
  }

  // ── Wheel speed → acceleration tier (exponential moving average) ─────────
  function createAccelerator(cfg) {
    let smoothed = 0, lastStep, lastAt, fastSince;
    const reset = () => { smoothed = 0; lastStep = undefined; lastAt = undefined; fastSince = undefined; };
    return {
      reset,
      next(speed, step, active) {
        if (!active) { reset(); return cfg.tiers[0]; }
        const now = performance.now();
        const paused = lastAt !== undefined && now - lastAt > PAUSE_RESET_MS;
        lastAt = now;
        const v = Math.min(speed, MAX_SPEED);
        if (step !== lastStep || paused) { smoothed = v; lastStep = step; fastSince = undefined; }
        else smoothed += SMOOTHING * (v - smoothed);
        if (smoothed <= cfg.minSpeed) { fastSince = undefined; return cfg.tiers[0]; }
        fastSince = fastSince ?? now;
        return cfg.tiers[Math.min(cfg.tiers.length - 1, Math.floor((now - fastSince) / cfg.tierMs))];
      },
    };
  }
  const tierForHeld = (cfg, heldMs) => cfg.tiers[Math.min(cfg.tiers.length - 1, Math.floor(heldMs / cfg.tierMs))];

  // ── Degrees → discrete steps ─────────────────────────────────────────────
  function split(value, unit) {
    const count = Math.floor(value / unit);
    return { count, remainder: value - count * unit };
  }
  function createQuantizer({ move, click }) {
    let acc = 0, lastStep, lastVolume, clickAcc = 0, moved = false;
    const reset = () => { acc = 0; clickAcc = 0; moved = false; };
    return {
      reset,
      scroll({ step, degrees, target, multiplier, dragStepDegrees }) {
        const isVolume = target === "volume";
        if (step !== lastStep || isVolume !== lastVolume) { lastStep = step; lastVolume = isVolume; reset(); }
        acc += degrees;
        if (isVolume) {
          const r = split(acc, VOLUME_DEGREES_PER_PERCENT);
          acc = r.remainder;
          if (r.count >= 1) moved = move(step, r.count) || moved;
          const c = split(clickAcc + degrees, VOLUME_DEGREES_PER_CLICK);
          clickAcc = c.remainder;
          if (c.count >= 1) { if (moved) click(c.count, "volume"); moved = false; }
          return;
        }
        const r = split(acc, dragStepDegrees);
        acc = r.remainder;
        if (r.count >= 1 && move(step, r.count * multiplier)) click(r.count, target);
      },
    };
  }

  // ── Timers ───────────────────────────────────────────────────────────────
  function debounce(ms, fn) {
    let t;
    return {
      start() { clearTimeout(t); t = setTimeout(() => { t = undefined; fn(); }, ms); },
      stop() { clearTimeout(t); t = undefined; },
      flush() { if (t !== undefined) { clearTimeout(t); t = undefined; fn(); } },
    };
  }
  // A mode that auto-exits after idling, unless held open.
  function createIdleMode({ timeoutMs, isActive, enter, onLeave }) {
    let held = false;
    const timer = debounce(timeoutMs, () => { if (isActive()) { timer.stop(); onLeave(); } });
    return {
      restartIdleTimer() { if (!held) timer.start(); },
      keepOpen() { held = true; timer.stop(); if (!isActive()) enter(); },
      release() { held = false; if (isActive()) timer.start(); },
      exit() { held = false; if (isActive()) { timer.stop(); onLeave(); } },
      handleScreenChange(stillHere) { if (!stillHere) this.exit(); },
    };
  }

  // ── State ────────────────────────────────────────────────────────────────
  const library = { playlists: [], artists: [], albums: [], songs: [] };
  const trackCache = new Map();          // "screen:contextId" → tracks[] | undefined (loading)
  let auth = { signedIn: false };
  const player = {
    hasTrack: false, isPaused: true, positionMs: 0, durationMs: 0, track: null,
    shuffle: false, repeat: "off", stateAt: performance.now(), remoteConnected: false,
    queue: [], queueSource: null, pendingUri: null,
  };
  let volumePercent = settings.volume;

  const dom = {
    screen: $("#ipod-screen"),
    loading: $("#loading-screen"),
    overlay: $("#overlay-screen"),
    status: $("#loading-message"),
    menuLayer: $("#menu-layer"),
    title: $("#screen-title"),
    titleBar: $("#menu-title"),
    playIcon: $("#title-play-icon"),
    body: $("#screen-body"),
    wheelRoot: $("#click-wheel"),
    shadowInner: $("#ipod-shadow-inner"),
  };

  const clicker = IPOD.createClicker();
  function click(count, target) {
    if (settings.clicker !== "on" || target === "seek") return;
    for (let i = 0; i < count; i++) clicker.playClick();
  }

  // ── Navigation stack ─────────────────────────────────────────────────────
  const stack = [{ key: "main" }];
  const memory = new Map();              // screen id → {itemId, index}
  let selectedIndex = 0;
  let currentItems = [];
  let currentView = null;                // {kind, el, api}
  let navigationId = 0;
  let isInert = true;
  let isLoading = true;

  const top = () => stack[stack.length - 1];
  const screenId = (s) => `${s.key}:${s.contextId ?? ""}`;
  const descriptor = (key) => SCREENS[key];

  function ctxFor(s) {
    const d = descriptor(s.key);
    return {
      library, auth, contextId: s.contextId,
      tracks: d.fetch ? trackCache.get(screenId(s)) : undefined,
      hasNowPlaying: !!d.listsNowPlaying && player.hasTrack,
      loading: isLoading || (auth.signedIn && libraryLoading),
      signedIn: auth.signedIn,
      deviceName: "iPod",
    };
  }
  function itemsFor(s) {
    const d = descriptor(s.key);
    return d.items ? d.items(ctxFor(s)) : [];
  }
  function titleFor(s) {
    if (s.titleKey) return i18n.t(s.titleKey);
    const d = descriptor(s.key);
    const t = d.title ? d.title(ctxFor(s)) : undefined;
    return t !== undefined ? t : d.titleKey ? i18n.t(d.titleKey) : "";
  }
  function remember(s, items, index) {
    const it = items[index];
    if (!it || descriptor(s.key).forgetsSelection) return;
    memory.set(screenId(s), { itemId: it.id, index });
  }
  function rememberedIndex(s, items) {
    const m = memory.get(screenId(s));
    if (!m) return -1;
    if (items[m.index] && items[m.index].id === m.itemId) return m.index;
    return items.findIndex((it) => it.id === m.itemId);
  }
  function nowPlayingIndexIn(items) {
    if (!player.track) return -1;
    return items.findIndex((it) => it.action === "play" && it.id === player.track.uri);
  }
  function initialIndex(s, items) {
    if (items[0] && items[0].action === "toggle") {
      const i = items.findIndex((it) => it.target === settings[s.key]);
      return i >= 0 ? i : 0;
    }
    const np = nowPlayingIndexIn(items);
    if (np >= 0) return np;
    return Math.max(0, rememberedIndex(s, items));
  }

  function ensureTracks(s) {
    const d = descriptor(s.key);
    if (!d.fetch || !s.contextId) return;
    const id = screenId(s);
    // `undefined` = loading, `null` = failed (retried on the next visit).
    if (trackCache.has(id) && trackCache.get(id) !== null) return;
    trackCache.set(id, undefined);
    bridge.call(d.fetch, { id: s.contextId }).then((res) => {
      trackCache.set(id, (res && res.tracks) || []);
      if (screenId(top()) === id) refreshList({ keepSelection: true });
    }).catch((err) => {
      console.warn("track fetch failed", err);
      trackCache.set(id, null);
      if (screenId(top()) === id) refreshList({ keepSelection: true });
    });
  }

  // ── Screen rendering ─────────────────────────────────────────────────────
  function renderTitle() {
    const s = top();
    const d = descriptor(s.key);
    if (d.view === "brick" && currentView && currentView.api && currentView.api.state) {
      const st = currentView.api.state;
      dom.title.className = "screen-title brick-game-title";
      dom.title.innerHTML = "";
      dom.title.append(el("span", "balls-left", String(st.balls)), el("span", "game-score", String(st.score)));
    } else {
      dom.title.className = "screen-title";
      dom.title.textContent = titleFor(s);
    }
    if (player.hasTrack) {
      dom.playIcon.hidden = false;
      dom.playIcon.className = "play-icon " + (player.isPaused ? "pause" : "play");
      dom.playIcon.innerHTML = player.isPaused ? icons.pause : icons.play;
    } else {
      dom.playIcon.hidden = true;
    }
  }

  function buildList(items, selected) {
    const ul = el("ul", "menu-items");
    ul.setAttribute("role", "listbox");
    ul.id = `menu-items-${navigationId}`;
    items.forEach((it, idx) => {
      const li = el("li", "menu-item");
      li.dataset.action = it.action;
      li.dataset.index = String(idx);
      if (it.action !== "info") li.setAttribute("role", "option");
      if (it.centered) li.classList.add("centered");
      if (idx === selected) li.classList.add("selected");
      const title = el("span", "item-title", it.title);
      title.setAttribute("dir", "auto");
      li.append(title);
      if (it.action === "info" && it.value !== undefined) li.append(el("span", "item-value", String(it.value)));
      else if (it.action === "inline-toggle") li.append(el("span", "item-value", IPOD.valueLabel(it.toggleKey, settings[it.toggleKey])));
      else if (it.action === "navigate") li.append(el("span", "chevron"));
      ul.append(li);
    });
    return ul;
  }

  function scrollSelectedIntoView(ul, idx) {
    const li = ul.children[idx];
    if (li) li.scrollIntoView({ block: "nearest" });
  }

  function buildNowPlaying() {
    const root = el("div", "now-playing");
    root.setAttribute("role", "group");
    root.innerHTML = `
      <div class="now-playing-index"><span class="position-label"></span><div class="play-modifier" aria-hidden="true"></div></div>
      <div class="now-playing-info">
        <div class="song-title"><div class="marquee" dir="auto"><div class="marquee-track"><span class="marquee-copy"></span></div></div></div>
        <div class="artist" dir="auto"></div>
        <div class="album" dir="auto"></div>
      </div>
      <div class="now-playing-progress" data-mode="">
        <div class="time-and-progress" aria-hidden="true">
          <div class="progress-bar"><div class="progress-fill"></div></div>
          <div class="progress-labels"><span class="elapsed"></span><span class="remaining"></span></div>
        </div>
        <div class="scrubbing-indicator inactive">
          <div class="progress-bar marker"><div class="progress-marker"></div></div>
          <div class="progress-labels" aria-hidden="true"><span class="scrub-elapsed"></span><span class="scrub-remaining"></span></div>
        </div>
        <div class="volume-labels inactive">${icons.volumeLow}<div class="progress-bar"><div class="progress-fill volume-fill"></div></div>${icons.volumeHigh}</div>
      </div>`;
    return root;
  }

  function buildClock() {
    const ul = el("ul", "menu-items");
    const date = el("li", "menu-item centered info-row");
    date.dataset.action = "info";
    date.append(el("span", "item-title"));
    const time = el("li", "menu-item centered info-row");
    time.dataset.action = "info";
    time.append(el("span", "item-title"));
    ul.append(date, time);
    const update = () => {
      const now = new Date();
      date.firstChild.textContent = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      time.firstChild.textContent = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
    };
    update();
    const timer = setInterval(update, 1000);
    return { el: ul, api: { destroy: () => clearInterval(timer) } };
  }

  function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  // Replace the visible screen, sliding it in from the side.
  function mountScreen(back) {
    if (currentView && currentView.api && currentView.api.unmount) currentView.api.unmount();
    if (currentView && currentView.api && currentView.api.destroy) currentView.api.destroy();
    const old = currentView ? currentView.wrapper : null;
    const s = top();
    const d = descriptor(s.key);
    const wrapper = el("div", "screen");
    let api = null, kind = d.view;

    if (d.view === "list") {
      currentItems = itemsFor(s);
      selectedIndex = clamp(selectedIndex, 0, Math.max(0, currentItems.length - 1));
      const ul = buildList(currentItems, selectedIndex);
      wrapper.append(ul);
      api = { ul };
    } else if (d.view === "now-playing") {
      currentItems = [];
      const np = buildNowPlaying();
      wrapper.append(np);
      api = { np };
    } else if (d.view === "brick") {
      currentItems = [];
      let game;
      game = IPOD.createBrickScreen({ i18n, onStatus: () => { if (currentView && currentView.api === game) renderTitle(); } });
      wrapper.append(game.el);
      api = game;
    } else if (d.view === "clock") {
      currentItems = [];
      const c = buildClock();
      wrapper.append(c.el);
      api = c.api;
    }

    currentView = { kind, wrapper, api };
    dom.body.append(wrapper);
    renderTitle();
    if (d.view === "list") scrollSelectedIntoView(api.ul, selectedIndex);
    if (d.view === "now-playing") updateNowPlaying(true);
    if (d.view === "brick") { api.mount(); api.setPaused(isInert); }

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const width = dom.body.clientWidth;
    if (old && width && !reduce) {
      const dir = back ? -1 : 1;
      const easing = "cubic-bezier(0.37, 0, 0.63, 1)";
      wrapper.animate([{ transform: `translateX(${dir * width}px)` }, { transform: "translateX(0)" }], { duration: SCREEN_SLIDE_MS, easing });
      const out = old.animate([{ transform: "translateX(0)" }, { transform: `translateX(${-dir * width}px)` }], { duration: SCREEN_SLIDE_MS, easing });
      out.onfinish = () => old.remove();
      out.oncancel = () => old.remove();
      // Belt and braces: never leave a stale screen behind if the animation never reports.
      setTimeout(() => old.remove(), SCREEN_SLIDE_MS + 60);
    } else if (old) {
      old.remove();
    }
    wheel.setSelectHoldMs(d.selectHold ? d.selectHold.ms : null);
    wheel.setExcludeRadiusRatio(0.361);
  }

  // Rebuild the current list in place (data arrived, setting changed...).
  function refreshList({ keepSelection = true } = {}) {
    if (!currentView || currentView.kind !== "list") { renderTitle(); return; }
    const s = top();
    const prev = currentItems[selectedIndex];
    currentItems = itemsFor(s);
    if (keepSelection && prev) {
      const i = currentItems.findIndex((it) => it.id === prev.id);
      selectedIndex = i >= 0 ? i : clamp(selectedIndex, 0, Math.max(0, currentItems.length - 1));
    } else {
      selectedIndex = initialIndex(s, currentItems);
    }
    const scrollTop = currentView.api.ul.scrollTop;
    const ul = buildList(currentItems, selectedIndex);
    currentView.api.ul.replaceWith(ul);
    currentView.api.ul = ul;
    ul.scrollTop = scrollTop;
    scrollSelectedIntoView(ul, selectedIndex);
    renderTitle();
  }

  function setSelected(idx) {
    if (!currentView || currentView.kind !== "list") return false;
    const next = clamp(idx, 0, Math.max(0, currentItems.length - 1));
    if (next === selectedIndex) return false;
    const ul = currentView.api.ul;
    ul.children[selectedIndex] && ul.children[selectedIndex].classList.remove("selected");
    selectedIndex = next;
    ul.children[selectedIndex] && ul.children[selectedIndex].classList.add("selected");
    scrollSelectedIntoView(ul, selectedIndex);
    return true;
  }
  function moveBy(step, count) {
    if (!currentItems.length) return false;
    return setSelected(selectedIndex + step * count);
  }

  function push(next, { idleJump = false } = {}) {
    const cur = top();
    remember(cur, currentItems, selectedIndex);
    cur.selectedIndexAtPush = selectedIndex;
    cur.scrollTopAtPush = currentView && currentView.api && currentView.api.ul ? currentView.api.ul.scrollTop : undefined;
    cur.suppressNowPlayingSync = idleJump;
    stack.push(next);
    navigationId += 1;
    ensureTracks(next);
    const items = descriptor(next.key).items ? itemsFor(next) : [];
    selectedIndex = initialIndex(next, items);
    listAccel.reset();
    seek.handleScreenChange(descriptor(next.key).view === "now-playing");
    volume.handleScreenChange(descriptor(next.key).view === "now-playing");
    mountScreen(false);
    armIdleJump();
  }

  function back() {
    if (stack.length <= 1) return;
    remember(top(), currentItems, selectedIndex);
    stack.pop();
    navigationId += 1;
    const s = top();
    const items = descriptor(s.key).items ? itemsFor(s) : [];
    const np = nowPlayingIndexIn(items);
    if (np >= 0 && !s.suppressNowPlayingSync) selectedIndex = np;
    else selectedIndex = Math.max(0, rememberedIndex(s, items));
    const restoreScroll = selectedIndex === s.selectedIndexAtPush ? s.scrollTopAtPush : undefined;
    listAccel.reset();
    seek.handleScreenChange(descriptor(s.key).view === "now-playing");
    volume.handleScreenChange(descriptor(s.key).view === "now-playing");
    mountScreen(true);
    if (restoreScroll !== undefined && currentView.api.ul) currentView.api.ul.scrollTop = restoreScroll;
    armIdleJump();
  }

  // ── Playback ─────────────────────────────────────────────────────────────
  let libraryLoading = false;

  function elapsedMs() {
    if (!player.hasTrack) return 0;
    const extra = player.isPaused ? 0 : performance.now() - player.stateAt;
    return clamp(player.positionMs + extra, 0, player.durationMs || Infinity);
  }
  function queueIndex() {
    if (!player.track) return -1;
    return player.queue.findIndex((t) => t.uri === player.track.uri);
  }

  function playTracks(tracks, index, contextUri, source) {
    if (!tracks.length) return;
    const uris = tracks.map((t) => t.uri);
    player.queue = tracks;
    player.queueSource = source || null;
    player.pendingUri = uris[index];
    bridge.call("player.play", { uris, offset: index, contextUri: contextUri || null }).catch((err) => {
      console.warn("play failed", err);
      player.pendingUri = null;
    });
  }

  function onPlayerState(s) {
    const hadTrack = player.hasTrack;
    player.hasTrack = !!s.hasTrack && !!s.track;
    player.isPaused = !!s.isPaused;
    player.positionMs = s.positionMs || 0;
    player.durationMs = s.durationMs || 0;
    player.track = s.track || null;
    player.shuffle = !!s.shuffle;
    player.repeat = s.repeat || "off";
    player.remoteConnected = !!s.remoteConnected;
    player.stateAt = performance.now();
    if (player.track && player.pendingUri === player.track.uri) player.pendingUri = null;
    wheel.setPlaying(player.hasTrack && !player.isPaused);
    renderTitle();
    if (hadTrack !== player.hasTrack && top().key === "main") refreshList({ keepSelection: true });
    if (currentView && currentView.kind === "now-playing") updateNowPlaying(true);
    armIdleJump();
  }

  // ── Seek / scrub controller ──────────────────────────────────────────────
  const seekAccel = createAccelerator(SEEK_ACCEL);
  const seekState = { isSeeking: false, previewMs: undefined };
  let seekCommitTimer, seekPending;
  function commitSeek() {
    clearTimeout(seekCommitTimer);
    seekCommitTimer = undefined;
    if (seekPending === undefined) return;
    const ms = seekPending;
    seekPending = undefined;
    bridge.call("player.seek", { positionMs: ms }).then(() => {
      // Keep the preview until the player confirms, then let the live position win.
      player.positionMs = ms;
      player.stateAt = performance.now();
      seekState.previewMs = undefined;
      updateNowPlaying();
    }).catch(() => { seekState.previewMs = undefined; });
  }
  const seekIdle = createIdleMode({
    timeoutMs: SEEK_IDLE_MS,
    isActive: () => seekState.isSeeking,
    enter() { seekState.isSeeking = true; seekState.previewMs = undefined; seekIdle.restartIdleTimer(); updateNowPlaying(); },
    onLeave() { commitSeek(); seekState.isSeeking = false; seekState.previewMs = undefined; updateNowPlaying(); },
  });
  const seek = {
    toggle() {
      if (seekState.isSeeking) { seekIdle.exit(); return; }
      seekIdle.keepOpen();
      seekIdle.release();
    },
    exit: () => seekIdle.exit(),
    handleScreenChange: (here) => seekIdle.handleScreenChange(here),
    current() { return seekState.previewMs ?? Math.floor(elapsedMs()); },
    seekBy(seconds) {
      if (!seekState.isSeeking) return false;
      const cur = this.current();
      const dur = player.durationMs > 0 ? player.durationMs : Infinity;
      const next = clamp(Math.round(cur + seconds * 1000), 0, dur);
      seekIdle.restartIdleTimer();
      if (next === cur) return false;
      seekState.previewMs = next;
      seekPending = next;
      clearTimeout(seekCommitTimer);
      seekCommitTimer = setTimeout(commitSeek, SEEK_COMMIT_MS);
      updateNowPlaying();
      return true;
    },
    accelerate(speed, step) {
      if (seekState.isSeeking) seekIdle.restartIdleTimer();
      return seekAccel.next(speed, step, seekState.isSeeking);
    },
  };

  // Hold ⏮/⏭ to skim through the song.
  const holdSeek = (() => {
    let anchor, trackUri, n = 0;
    return {
      step(dir, repeat) {
        if (!repeat) { anchor = isInert ? undefined : elapsedMs(); trackUri = player.track && player.track.uri; n = 0; }
        if (anchor === undefined || isInert || seekState.isSeeking || !player.hasTrack || player.durationMs <= 0) return;
        if (!player.track || player.track.uri !== trackUri) return;
        const secs = SEEK_HOLD_STEPS[Math.min(n, SEEK_HOLD_STEPS.length - 1)];
        const target = clamp(anchor + dir * secs * 1000, 0, player.durationMs);
        n += 1;
        anchor = target > 0 && target < player.durationMs ? target : undefined;
        player.positionMs = target;
        player.stateAt = performance.now();
        updateNowPlaying();
        bridge.call("player.seek", { positionMs: target }).catch(() => {});
      },
      cancel() { anchor = undefined; },
    };
  })();

  // ── Volume controller ────────────────────────────────────────────────────
  const volumeState = { adjusting: false };
  const volumeIdle = createIdleMode({
    timeoutMs: VOLUME_IDLE_MS,
    isActive: () => volumeState.adjusting,
    enter() { volumeState.adjusting = true; updateNowPlaying(); },
    onLeave() { volumeState.adjusting = false; updateNowPlaying(); },
  });
  const saveVolume = debounce(1000, () => updateSettings({ volume: volumePercent }));
  const volume = {
    peek: () => volumeState,
    exit: () => volumeIdle.exit(),
    handleScreenChange: (here) => volumeIdle.handleScreenChange(here),
    set(v) {
      const next = clamp(Math.round(v), 0, 100);
      volumeIdle.restartIdleTimer();
      if (!volumeState.adjusting) { volumeIdle.keepOpen(); volumeIdle.release(); }
      if (next === volumePercent) return false;
      volumePercent = next;
      bridge.call("system.setVolume", { volume: next }).catch(() => {});
      saveVolume.start();
      updateNowPlaying();
      return true;
    },
    adjust(delta) { return this.set(volumePercent + delta); },
  };

  // ── Now Playing updates ──────────────────────────────────────────────────
  let npTicker;
  function updateNowPlaying(full = false) {
    if (!currentView || currentView.kind !== "now-playing") return;
    const np = currentView.api.np;
    const t = player.track;
    const idx = queueIndex();
    const total = player.queue.length;
    $(".position-label", np).textContent = idx >= 0 && total ? i18n.t("NowPlaying.Position", { index: idx + 1, total }) : "";
    const mod = $(".play-modifier", np);
    const modHtml = (player.repeat === "track" ? icons.repeatOne : player.repeat === "context" ? icons.repeatAll : "") + (player.shuffle ? icons.shuffle : "");
    if (mod.innerHTML !== modHtml) mod.innerHTML = modHtml;

    if (full) {
      const title = t ? t.name : "";
      const marquee = $(".marquee", np);
      const track = $(".marquee-track", np);
      track.innerHTML = "";
      const copy = el("span", "marquee-copy", title);
      track.append(copy);
      marquee.classList.remove("scrolling");
      $(".artist", np).textContent = t ? t.artist || "" : "";
      $(".album", np).textContent = t ? t.album || "" : "";
      requestAnimationFrame(() => {
        const w = copy.getBoundingClientRect().width;
        if (w > marquee.clientWidth + 1) {
          const dup = el("span", "marquee-copy", title);
          dup.setAttribute("aria-hidden", "true");
          track.append(dup);
          track.style.setProperty("--marquee-copy-width", String(Math.round(w)));
          marquee.classList.add("scrolling");
        }
      });
    }

    const dur = player.durationMs;
    const pos = elapsedMs();
    const pct = dur > 0 ? clamp((pos / dur) * 100, 0, 100) : 0;
    $(".progress-fill:not(.volume-fill)", np).style.width = pct + "%";
    $(".elapsed", np).textContent = fmtTime(pos);
    $(".remaining", np).textContent = "-" + fmtTime(Math.max(0, dur - pos));

    const mode = seekState.isSeeking ? "scrubbing" : volumeState.adjusting ? "volume" : "";
    const progress = $(".now-playing-progress", np);
    progress.dataset.mode = mode;
    const scrub = $(".scrubbing-indicator", np);
    scrub.classList.toggle("inactive", mode !== "scrubbing");
    const vol = $(".volume-labels", np);
    vol.classList.toggle("inactive", mode !== "volume");
    if (mode === "scrubbing") {
      const p = seek.current();
      const sp = dur > 0 ? clamp((p / dur) * 100, 0, 100) : 0;
      $(".progress-marker", np).style.left = sp + "%";
      $(".scrub-elapsed", np).textContent = fmtTime(p);
      $(".scrub-remaining", np).textContent = "-" + fmtTime(Math.max(0, dur - p));
    }
    $(".volume-fill", np).style.width = volumePercent + "%";

    clearInterval(npTicker);
    if (player.hasTrack && !player.isPaused) npTicker = setInterval(() => updateNowPlaying(false), 250);
  }

  // ── Idle jump to Now Playing ─────────────────────────────────────────────
  const idleJump = debounce(IDLE_JUMP_MS, () => {
    if (!player.hasTrack || player.isPaused || isInert) return;
    if (descriptor(top().key).blocksIdleJump) return;
    push({ key: "now-playing" }, { idleJump: true });
  });
  function armIdleJump() {
    if (player.hasTrack && !player.isPaused && !descriptor(top().key).blocksIdleJump) idleJump.start();
    else idleJump.stop();
  }

  // ── Backlight ────────────────────────────────────────────────────────────
  const backlight = (() => {
    let override = null;    // true/false after a manual toggle, null otherwise
    let timer;
    function timed() {
      return IPOD.BACKLIGHT_MODES.find((m) => m.mode === settings.backlight)?.durationMs;
    }
    function apply() {
      const on = override !== null ? override : settings.backlight === "always_on" || (timer !== undefined);
      dom.screen.classList.toggle("backlit", on);
    }
    function startTimer(ms) {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; apply(); }, ms);
    }
    return {
      activity() {
        const ms = timed();
        if (ms !== undefined) { override = null; startTimer(ms); }
        apply();
      },
      toggle() {
        const on = dom.screen.classList.contains("backlit");
        override = !on;
        clearTimeout(timer);
        timer = undefined;
        apply();
      },
      modeChanged() {
        override = null;
        clearTimeout(timer);
        timer = undefined;
        const ms = timed();
        if (ms !== undefined) startTimer(ms);
        apply();
      },
    };
  })();

  function onSettingsChanged(keys) {
    if (keys.includes("backlight")) backlight.modeChanged();
    if (keys.includes("shuffle")) bridge.call("player.setShuffle", { enabled: settings.shuffle === "songs" }).catch(() => {});
    if (keys.includes("repeat")) bridge.call("player.setRepeat", { mode: settings.repeat === "one" ? "track" : settings.repeat === "all" ? "context" : "off" }).catch(() => {});
    if (currentView && currentView.kind === "list") refreshList({ keepSelection: true });
  }
  if (darkQuery) darkQuery.addEventListener("change", () => {
    if (!backlightChosen) { settings.backlight = defaultBacklight(); backlight.modeChanged(); }
  });

  // ── Activity ─────────────────────────────────────────────────────────────
  function activity() {
    backlight.activity();
    clicker.unlock();
    armIdleJump();
  }

  // ── Selection handling ───────────────────────────────────────────────────
  const listAccel = createAccelerator(LIST_ACCEL);
  const quantizer = createQuantizer({
    move: (step, count) => {
      switch (scrollTarget()) {
        case "seek": return seek.seekBy(step * count * SEEK_STEP_SECONDS);
        case "volume": return volume.adjust(step * count);
        case "list": return moveBy(step, count);
        default: return false;
      }
    },
    click,
  });

  function scrollTarget() {
    const view = descriptor(top().key).view;
    if (view === "brick") return "brick";
    if (view === "now-playing") return seekState.isSeeking ? "seek" : "volume";
    return "list";
  }

  function select() {
    const s = top();
    const d = descriptor(s.key);
    if (d.view === "brick") { currentView.api.launchBall(); return; }
    if (d.view === "now-playing") {
      if (volumeState.adjusting) { volume.exit(); return; }
      if (!player.hasTrack) return;
      seek.toggle();
      return;
    }
    if (d.view === "clock") return;
    const item = currentItems[selectedIndex];
    if (!item) return;
    switch (item.action) {
      case "navigate":
        push({ key: item.target, contextId: item.contextId, titleKey: item.screenTitleKey });
        break;
      case "inline-toggle": {
        const cur = settings[item.toggleKey];
        const next = item.values[(item.values.indexOf(cur) + 1) % item.values.length];
        updateSettings({ [item.toggleKey]: next });
        break;
      }
      case "toggle":
        backlightChosen = true;
        updateSettings({ backlight: item.target });
        back();
        break;
      case "cancel":
        back();
        break;
      case "reset-all":
        backlightChosen = false;
        updateSettings({ ...DEFAULTS, backlight: defaultBacklight() });
        back();
        break;
      case "play": {
        const tracks = d.tracks ? d.tracks(ctxFor(s)) : [];
        const i = item.trackIndex;
        if (!tracks[i]) break;
        if (player.track && player.track.uri === tracks[i].uri && queueIndex() >= 0) {
          if (player.isPaused) bridge.call("player.resume").catch(() => {});
        } else {
          playTracks(tracks, i, d.contextUri ? d.contextUri(ctxFor(s)) : null, screenId(s));
        }
        push({ key: "now-playing" });
        break;
      }
      case "shuffle-all": {
        const songs = library.songs || [];
        if (!songs.length) { push({ key: "songs" }); break; }
        if (settings.shuffle !== "songs") updateSettings({ shuffle: "songs" });
        playTracks(songs, Math.floor(Math.random() * songs.length), null, "songs:");
        push({ key: "now-playing" });
        break;
      }
      case "backlight":
        backlight.toggle();
        break;
      case "sign-in":
        signIn();
        break;
      case "sign-out":
        bridge.call("auth.signOut").then(() => { auth = { signedIn: false }; clearLibrary(); refreshList({ keepSelection: false }); }).catch(() => {});
        break;
      case "refresh":
        loadLibrary(true);
        break;
      case "open-spotify":
        bridge.call("system.openSpotify").catch(() => {});
        break;
      case "info":
      default:
        break;
    }
  }

  function selectHold() {
    const d = descriptor(top().key);
    if (d.selectHold) push({ key: d.selectHold.target });
  }

  function playPause() {
    if (player.hasTrack) {
      const resume = player.isPaused;
      // Optimistic flip so the title icon answers immediately.
      player.positionMs = elapsedMs();
      player.stateAt = performance.now();
      player.isPaused = !resume;
      renderTitle();
      updateNowPlaying();
      armIdleJump();
      bridge.call(resume ? "player.resume" : "player.pause").catch(() => {});
      return;
    }
    const item = currentItems[selectedIndex];
    const d = descriptor(top().key);
    if (item && item.action === "navigate" && SCREENS[item.target] && SCREENS[item.target].tracks) {
      // ▶ on a playlist/album/artist plays it from the top (like the firmware).
      const next = { key: item.target, contextId: item.contextId };
      const tracks = SCREENS[item.target].tracks(ctxFor(next));
      if (tracks.length) { playTracks(tracks, 0, SCREENS[item.target].contextUri(ctxFor(next)), screenId(next)); push({ key: "now-playing" }); return; }
      ensureTracks(next);
      return;
    }
    if (item && item.action === "play") { select(); return; }
    if (player.queue.length) bridge.call("player.resume").catch(() => {});
  }

  // ── Wheel wiring ─────────────────────────────────────────────────────────
  const ifBooted = (fn) => (...a) => { if (!isInert) fn(...a); };
  const wheel = IPOD.createWheel(dom.wheelRoot, {
    activity,
    scroll({ step, degrees, speed }) {
      activity();
      if (isInert) return;
      const target = scrollTarget();
      if (target === "brick") { currentView.api.turnPaddle(step * degrees); return; }
      const multiplier = target === "seek" ? seek.accelerate(speed, step) : listAccel.next(speed, step, target === "list");
      quantizer.scroll({ step, degrees, target, multiplier, dragStepDegrees: DRAG_STEP_DEGREES });
    },
    dragStart() { quantizer.reset(); },
    dragEnd() {},
    keyScroll({ step, heldMs }) {
      activity();
      if (isInert) return;
      const target = scrollTarget();
      let moved = false;
      if (target === "brick") { currentView.api.turnPaddle(step * KEY_STEP_DEGREES * 2); return; }
      if (target === "seek") moved = seek.seekBy(step * tierForHeld(SEEK_ACCEL, heldMs) * SEEK_STEP_SECONDS);
      else if (target === "volume") moved = volume.adjust(step * VOLUME_KEY_STEP);
      else moved = moveBy(step, tierForHeld(LIST_ACCEL, heldMs));
      if (moved) click(1, target);
    },
    menu: ifBooted(() => { haptic("light"); back(); }),
    menuHold: () => { haptic("medium"); backlight.toggle(); },
    back: ifBooted(() => { haptic("light"); if (!seekState.isSeeking) bridge.call("player.previous").catch(() => {}); }),
    forward: ifBooted(() => { haptic("light"); if (!seekState.isSeeking) bridge.call("player.next").catch(() => {}); }),
    backHold: ifBooted(({ repeat }) => holdSeek.step(-1, repeat)),
    forwardHold: ifBooted(({ repeat }) => holdSeek.step(1, repeat)),
    holdEnd: () => holdSeek.cancel(),
    playPause: ifBooted(() => { haptic("light"); playPause(); }),
    select: ifBooted(() => { haptic("light"); select(); }),
    selectHold: ifBooted(() => { haptic("medium"); selectHold(); }),
  });

  // ── Library / auth ───────────────────────────────────────────────────────
  function clearLibrary() {
    library.playlists = []; library.artists = []; library.albums = []; library.songs = [];
    trackCache.clear();
    player.queue = [];
  }
  function applyLibrary(lib) {
    if (!lib) return;
    library.playlists = lib.playlists || [];
    library.artists = lib.artists || [];
    library.albums = lib.albums || [];
    library.songs = lib.songs || [];
    // Forget only failed/empty track lists; successful ones stay valid.
    for (const [k, v] of [...trackCache.entries()]) if (v === null || (Array.isArray(v) && v.length === 0)) trackCache.delete(k);
    if (currentView && currentView.kind === "list") refreshList({ keepSelection: true });
  }
  function loadLibrary(force) {
    libraryLoading = true;
    if (currentView && currentView.kind === "list") refreshList({ keepSelection: true });
    return bridge.call(force ? "library.refresh" : "library.load").then((lib) => {
      libraryLoading = false;
      applyLibrary(lib);
    }).catch((err) => {
      libraryLoading = false;
      console.warn("library load failed", err);
      if (currentView && currentView.kind === "list") refreshList({ keepSelection: true });
    });
  }
  function signIn() {
    bridge.call("auth.signIn").then((res) => {
      auth = Object.assign({}, auth, res || {}, { signedIn: !!(res && res.signedIn) });
      if (auth.signedIn) loadLibrary(false);
      if (currentView && currentView.kind === "list") refreshList({ keepSelection: false });
    }).catch((err) => console.warn("sign in failed", err));
  }

  bridge.on("playerState", onPlayerState);
  bridge.on("volume", ({ volume: v }) => {
    if (typeof v !== "number") return;
    volumePercent = clamp(Math.round(v), 0, 100);
    updateNowPlaying();
  });
  bridge.on("auth", (a) => {
    auth = Object.assign({}, a || {});
    if (!auth.signedIn) clearLibrary();
    if (currentView && currentView.kind === "list") refreshList({ keepSelection: true });
  });
  bridge.on("library", (lib) => applyLibrary(lib));

  // ── Online / offline ─────────────────────────────────────────────────────
  let online = navigator.onLine !== false;
  function updateInert() {
    const inert = isLoading || !online;
    if (inert === isInert) return;
    isInert = inert;
    dom.menuLayer.classList.toggle("hidden", isInert);
    dom.overlay.hidden = online;
    dom.loading.hidden = !(online && isLoading);
    wheel.setDisabled(isInert);
    if (currentView && currentView.kind === "brick") currentView.api.setPaused(isInert);
    dom.status.textContent = online ? i18n.t(isLoading ? "Status.Loading" : "Status.Ready") : i18n.t("Error.NotConnected");
    if (!isInert) armIdleJump();
  }
  window.addEventListener("online", () => { online = true; updateInert(); });
  window.addEventListener("offline", () => { online = false; updateInert(); });

  // ── Layout: scale the 415×692 device to the viewport ────────────────────
  function layout() {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const padTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-top")) || 0;
    const padBottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-bottom")) || 0;
    // Leave room for the reflection under the device.
    const scale = Math.min(1, (vw - 32) / 415, (vh - padTop - padBottom - 24) / (692 + 70));
    const s = Math.max(0.4, Math.round(scale * 1000) / 1000);
    document.documentElement.style.setProperty("--ipod-scale", String(s));
    dom.shadowInner.style.setProperty("--ipod-scale", String(s));
    const used = 692 * s + 70 * s;
    const top = padTop + Math.max(12, (vh - padTop - padBottom - used) / 2);
    document.documentElement.style.setProperty("--page-pad-top", `${top}px`);
  }
  window.addEventListener("resize", layout);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", layout);

  // ── Boot ─────────────────────────────────────────────────────────────────
  async function boot() {
    layout();
    dom.loading.hidden = false;
    dom.overlay.hidden = true;
    dom.menuLayer.classList.add("hidden");
    dom.status.textContent = i18n.t("Status.Loading");
    backlight.modeChanged();
    wheel.setDisabled(true);
    mountScreen(false);

    const started = performance.now();
    const minDelay = new Promise((r) => setTimeout(r, MIN_DISPLAY_MS));
    const maxDelay = new Promise((r) => setTimeout(r, MAX_HOLD_MS));

    const ready = (async () => {
      try {
        const a = await bridge.call("auth.status");
        auth = Object.assign({}, a || {}, { signedIn: !!(a && a.signedIn) });
      } catch (_) {
        auth = { signedIn: false };
      }
      try {
        const v = await bridge.call("system.volume");
        if (v && typeof v.volume === "number") volumePercent = clamp(Math.round(v.volume), 0, 100);
      } catch (_) {}
      try {
        const st = await bridge.call("player.state");
        if (st) onPlayerState(st);
      } catch (_) {}
      if (auth.signedIn) await loadLibrary(false);
    })();

    await Promise.race([Promise.all([ready, minDelay]), maxDelay]);
    isLoading = false;
    refreshList({ keepSelection: false });
    updateInert();
    bridge.call("system.ready").catch(() => {});
    if (window.matchMedia("(any-pointer: fine)").matches) wheel.focus();
    console.debug("iPod booted in", Math.round(performance.now() - started), "ms");
  }

  IPOD.app = { boot, settings, player, library, push, back, select, stack };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window.IPOD);
