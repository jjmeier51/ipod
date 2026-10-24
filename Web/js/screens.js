/*
 * Screen descriptors — the 4th-generation iPod firmware menu tree, backed by a
 * Spotify library.
 *
 * Each screen has a `view` (list | now-playing | brick | clock), a title (static
 * or derived) and an `items(ctx)` builder. Item actions: navigate,
 * inline-toggle, toggle, info, play, shuffle-all, backlight, cancel, reset-all,
 * sign-in, sign-out, refresh, open-spotify.
 */
"use strict";
window.IPOD = window.IPOD || {};

(function (IPOD) {
  const STRINGS = {
    "Menu.Music": "Music",
    "Menu.Extras": "Extras",
    "Menu.Settings": "Settings",
    "Menu.ShuffleSongs": "Shuffle Songs",
    "Menu.Backlight": "Backlight",
    "Menu.NowPlaying": "Now Playing",
    "Menu.Playlists": "Playlists",
    "Menu.Artists": "Artists",
    "Menu.Albums": "Albums",
    "Menu.Songs": "Songs",
    "Menu.All": "All",
    "Menu.AllSongs": "All Songs",
    "Menu.NoMusic": "No Music",
    "Menu.Loading": "Loading…",
    "Menu.CouldNotLoad": "Could Not Load",
    "Menu.SignIn": "Sign In to Spotify",
    "Extras.Clock": "Clock",
    "Extras.Games": "Games",
    "Settings.About": "About",
    "Settings.Shuffle": "Shuffle",
    "Settings.Repeat": "Repeat",
    "Settings.BacklightTimer": "Backlight Timer",
    "Settings.Clicker": "Clicker",
    "Settings.Spotify": "Spotify",
    "Settings.ResetAllSettings": "Reset All Settings",
    "Settings.Value.Off": "Off",
    "Settings.Value.On": "On",
    "Settings.Value.Songs": "Songs",
    "Settings.Value.One": "One",
    "Settings.Value.All": "All",
    "Backlight.Off": "Off",
    "Backlight.2": "2 Seconds",
    "Backlight.5": "5 Seconds",
    "Backlight.10": "10 Seconds",
    "Backlight.20": "20 Seconds",
    "Backlight.AlwaysOn": "Always On",
    "Reset.Cancel": "Cancel",
    "Reset.Reset": "Reset",
    "About.Songs": "Songs",
    "About.Capacity": "Capacity",
    "About.Available": "Available",
    "About.Version": "Version",
    "About.SerialNumber": "S/N",
    "About.Model": "Model",
    "About.Format": "Format",
    "Spotify.Account": "Account",
    "Spotify.Plan": "Plan",
    "Spotify.SignIn": "Sign In",
    "Spotify.SignOut": "Sign Out",
    "Spotify.Refresh": "Refresh Library",
    "Spotify.Open": "Open Spotify",
    "Spotify.NotSignedIn": "Not signed in",
    "Spotify.Premium": "Premium",
    "Spotify.Free": "Free",
    "NowPlaying.Position": "@@index@@ of @@total@@",
    "NowPlaying.ShuffleOn": "Shuffle on",
    "NowPlaying.RepeatOne": "Repeat one",
    "NowPlaying.RepeatAll": "Repeat all",
    "NowPlaying.PlaybackProgress": "Playback Progress",
    "NowPlaying.Volume": "Volume",
    "Wheel.Menu": "Menu",
    "Wheel.Back": "Back",
    "Wheel.Forward": "Forward",
    "Wheel.Play": "Play",
    "Wheel.Pause": "Pause",
    "Wheel.Select": "Select",
    "Game.Title": "Brick",
    "Game.GameOver": "GAME OVER",
    "Game.LaunchBall": "Press Center to Launch Ball",
    "Status.Loading": "Loading",
    "Status.Ready": "Ready",
    "Error.NotConnected": "You are not connected to the internet",
  };

  const numberFormat = new Map();
  const i18n = {
    t(key, vars) {
      const s = STRINGS[key];
      if (s === undefined) return `**${key}**`;
      return vars ? s.replace(/@@(\w+)@@/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
    },
    formatNumber(n, opts) {
      const k = JSON.stringify(opts || {});
      if (!numberFormat.has(k)) numberFormat.set(k, new Intl.NumberFormat("en-US", opts));
      return numberFormat.get(k).format(n);
    },
  };

  const SHUFFLE_VALUES = ["off", "songs"];
  const REPEAT_VALUES = ["off", "one", "all"];
  const CLICKER_VALUES = ["off", "on"];
  const BACKLIGHT_MODES = [
    { mode: "off", label: "Backlight.Off" },
    { mode: "2sec", label: "Backlight.2", durationMs: 2000 },
    { mode: "5sec", label: "Backlight.5", durationMs: 5000 },
    { mode: "10sec", label: "Backlight.10", durationMs: 10000 },
    { mode: "20sec", label: "Backlight.20", durationMs: 20000 },
    { mode: "always_on", label: "Backlight.AlwaysOn" },
  ];

  function valueLabel(toggleKey, value) {
    if (toggleKey === "shuffle") return i18n.t(value === "songs" ? "Settings.Value.Songs" : "Settings.Value.Off");
    if (toggleKey === "repeat") return i18n.t(value === "one" ? "Settings.Value.One" : value === "all" ? "Settings.Value.All" : "Settings.Value.Off");
    if (toggleKey === "clicker") return i18n.t(value === "on" ? "Settings.Value.On" : "Settings.Value.Off");
    return String(value);
  }

  const nav = (key, titleKey) => ({ id: key, title: i18n.t(titleKey || SCREENS[key].titleKey), action: "navigate", target: key });
  const info = (id, title, value, centered) => ({ id, title, action: "info", value, centered });
  const toggleRow = (key, titleKey, values) => ({ id: key, title: i18n.t(titleKey), action: "inline-toggle", toggleKey: key, values });

  function orEmpty(items, { loading, failed, signedIn }) {
    if (items.length) return items;
    if (!signedIn) return [{ id: "sign-in", title: i18n.t("Menu.SignIn"), action: "sign-in", centered: true }];
    if (failed) return [info("failed", i18n.t("Menu.CouldNotLoad"), undefined, true)];
    if (loading) return [info("loading", i18n.t("Menu.Loading"), undefined, true)];
    return [info("no-music", i18n.t("Menu.NoMusic"), undefined, true)];
  }

  function trackItems(tracks, ctx) {
    const items = (tracks || []).map((t, i) => ({ id: t.uri || t.id, title: t.name, action: "play", trackIndex: i }));
    return orEmpty(items, ctx);
  }
  const trackCtx = (ctx) => ({ ...ctx, loading: ctx.tracks === undefined, failed: ctx.tracks === null });

  const SCREENS = {
    main: {
      view: "list",
      title: () => "iPod",
      items: (ctx) => [
        nav("music"),
        nav("extras"),
        nav("settings"),
        { id: "shuffle-songs", title: i18n.t("Menu.ShuffleSongs"), action: "shuffle-all" },
        { id: "backlight", title: i18n.t("Menu.Backlight"), action: "backlight" },
        ...(ctx.hasNowPlaying ? [nav("now-playing")] : []),
      ],
      listsNowPlaying: true,
    },
    music: {
      view: "list",
      titleKey: "Menu.Music",
      items: () => [nav("playlists"), nav("artists"), nav("albums"), nav("songs")],
    },
    extras: {
      view: "list",
      titleKey: "Menu.Extras",
      items: () => [nav("clock"), nav("games")],
    },
    games: {
      view: "list",
      titleKey: "Extras.Games",
      items: () => [{ id: "brick", title: i18n.t("Game.Title"), action: "navigate", target: "brick" }],
    },
    clock: {
      view: "clock",
      titleKey: "Extras.Clock",
      blocksIdleJump: true,
    },
    settings: {
      view: "list",
      titleKey: "Menu.Settings",
      items: () => [
        nav("about"),
        toggleRow("shuffle", "Settings.Shuffle", SHUFFLE_VALUES),
        toggleRow("repeat", "Settings.Repeat", REPEAT_VALUES),
        nav("backlight"),
        toggleRow("clicker", "Settings.Clicker", CLICKER_VALUES),
        nav("spotify"),
        nav("reset-settings"),
      ],
    },
    about: {
      view: "list",
      titleKey: "Settings.About",
      items: (ctx) => {
        const gb = (n) => i18n.formatNumber(n, { style: "unit", unit: "gigabyte" });
        return [
          info("ipod", ctx.deviceName || "iPod", undefined, true),
          info("songs-count", i18n.t("About.Songs"), i18n.formatNumber((ctx.library.songs || []).length)),
          info("capacity", i18n.t("About.Capacity"), gb(18.5)),
          info("available", i18n.t("About.Available"), gb(11.2)),
          info("version", i18n.t("About.Version"), "3.1.1"),
          info("serial", i18n.t("About.SerialNumber"), "JQ5" + "4" + "2" + "G" + "0" + "QQZ7"),
          info("model", i18n.t("About.Model"), "M9282"),
          info("format", i18n.t("About.Format"), "Macintosh"),
        ];
      },
      selectHold: { ms: 5000, target: "brick" },
    },
    backlight: {
      view: "list",
      titleKey: "Settings.BacklightTimer",
      items: () => BACKLIGHT_MODES.map((m) => ({ id: m.mode, title: i18n.t(m.label), action: "toggle", target: m.mode })),
    },
    spotify: {
      view: "list",
      titleKey: "Settings.Spotify",
      items: (ctx) => {
        const a = ctx.auth || {};
        if (!a.signedIn) {
          return [
            info("account", i18n.t("Spotify.Account"), i18n.t("Spotify.NotSignedIn")),
            { id: "sign-in", title: i18n.t("Spotify.SignIn"), action: "sign-in" },
          ];
        }
        return [
          info("account", i18n.t("Spotify.Account"), a.displayName || "—"),
          info("plan", i18n.t("Spotify.Plan"), a.product === "premium" ? i18n.t("Spotify.Premium") : i18n.t("Spotify.Free")),
          { id: "refresh", title: i18n.t("Spotify.Refresh"), action: "refresh" },
          { id: "open", title: i18n.t("Spotify.Open"), action: "open-spotify" },
          { id: "sign-out", title: i18n.t("Spotify.SignOut"), action: "sign-out" },
        ];
      },
      forgetsSelection: true,
    },
    "reset-settings": {
      view: "list",
      titleKey: "Settings.ResetAllSettings",
      items: () => [
        { id: "cancel", title: i18n.t("Reset.Cancel"), action: "cancel" },
        { id: "reset-all", title: i18n.t("Reset.Reset"), action: "reset-all" },
      ],
      forgetsSelection: true,
    },
    playlists: {
      view: "list",
      titleKey: "Menu.Playlists",
      items: (ctx) => orEmpty((ctx.library.playlists || []).map((p) => ({ id: p.id, title: p.name, action: "navigate", target: "playlist-tracks", contextId: p.id })), ctx),
    },
    artists: {
      view: "list",
      titleKey: "Menu.Artists",
      items: (ctx) => {
        const items = (ctx.library.artists || []).map((a) => ({ id: a.id, title: a.name, action: "navigate", target: "artist-tracks", contextId: a.id }));
        if (items.length && (ctx.library.songs || []).length) {
          items.unshift({ id: "all", title: i18n.t("Menu.All"), action: "navigate", target: "songs", screenTitleKey: "Menu.AllSongs" });
        }
        return orEmpty(items, ctx);
      },
    },
    albums: {
      view: "list",
      titleKey: "Menu.Albums",
      items: (ctx) => orEmpty((ctx.library.albums || []).map((a) => ({ id: a.id, title: a.name, action: "navigate", target: "album-tracks", contextId: a.id })), ctx),
    },
    songs: {
      view: "list",
      titleKey: "Menu.Songs",
      items: (ctx) => trackItems(ctx.library.songs, ctx),
      tracks: (ctx) => ctx.library.songs || [],
      contextUri: () => null,
    },
    "playlist-tracks": {
      view: "list",
      titleKey: "Menu.Playlists",
      title: (ctx) => (ctx.library.playlists || []).find((p) => p.id === ctx.contextId)?.name,
      items: (ctx) => trackItems(ctx.tracks, trackCtx(ctx)),
      tracks: (ctx) => ctx.tracks || [],
      contextUri: (ctx) => (ctx.library.playlists || []).find((p) => p.id === ctx.contextId)?.uri || null,
      fetch: "library.playlistTracks",
    },
    "artist-tracks": {
      view: "list",
      titleKey: "Menu.Artists",
      title: (ctx) => (ctx.library.artists || []).find((a) => a.id === ctx.contextId)?.name,
      items: (ctx) => trackItems(ctx.tracks, trackCtx(ctx)),
      tracks: (ctx) => ctx.tracks || [],
      contextUri: () => null,
      fetch: "library.artistTracks",
    },
    "album-tracks": {
      view: "list",
      titleKey: "Menu.Albums",
      title: (ctx) => (ctx.library.albums || []).find((a) => a.id === ctx.contextId)?.name,
      items: (ctx) => trackItems(ctx.tracks, trackCtx(ctx)),
      tracks: (ctx) => ctx.tracks || [],
      contextUri: (ctx) => (ctx.library.albums || []).find((a) => a.id === ctx.contextId)?.uri || null,
      fetch: "library.albumTracks",
    },
    "now-playing": {
      view: "now-playing",
      titleKey: "Menu.NowPlaying",
      blocksIdleJump: true,
    },
    brick: {
      view: "brick",
      titleKey: "Game.Title",
      blocksIdleJump: true,
    },
  };

  IPOD.i18n = i18n;
  IPOD.SCREENS = SCREENS;
  IPOD.BACKLIGHT_MODES = BACKLIGHT_MODES;
  IPOD.valueLabel = valueLabel;
})(window.IPOD);
