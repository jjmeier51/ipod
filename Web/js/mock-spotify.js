/*
 * Browser-only stand-in for the native Spotify services, so the UI can run in
 * a desktop browser. It fakes a small library, a Premium account and a player
 * that advances time. Not loaded inside the iOS app.
 */
"use strict";
window.IPOD = window.IPOD || {};

(function (IPOD) {
  if (IPOD.bridge.isNative) return;

  const artists = ["Daft Punk", "The Strokes", "Gorillaz", "Interpol", "Yeah Yeah Yeahs", "Outkast", "The White Stripes", "Phoenix", "LCD Soundsystem", "Beck", "Radiohead", "Modest Mouse", "Jay-Z", "Missy Elliott", "Coldplay", "U2"];
  const albums = ["Discovery", "Is This It", "Demon Days", "Turn On the Bright Lights", "Fever to Tell", "Speakerboxxx/The Love Below", "Elephant", "Alphabetical", "Sound of Silver", "Sea Change", "Hail to the Thief", "Good News for People Who Love Bad News", "The Black Album", "Under Construction", "A Rush of Blood to the Head", "How to Dismantle an Atomic Bomb"];
  const words = ["Digital", "Love", "Harder", "Last", "Nite", "Feel", "Good", "Inc", "Obstacle", "Maps", "Hey", "Ya", "Seven", "Nation", "Army", "Too", "Young", "Daft", "Punk", "Is", "Playing", "Lose", "Yourself", "Clocks", "Vertigo", "There", "Float", "On", "Golden", "Age", "Work", "It", "Ocean", "Breathes", "Salty", "Everyone", "Nose", "Shelter", "Reptilia", "Someday"];

  function rnd(seed) {
    let s = seed;
    return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  }
  const r = rnd(7);
  const songs = [];
  for (let i = 0; i < 1029; i++) {
    const a = Math.floor(r() * artists.length);
    const n = 1 + Math.floor(r() * 3);
    const title = Array.from({ length: n }, () => words[Math.floor(r() * words.length)]).join(" ");
    songs.push({
      id: "t" + i,
      uri: "spotify:track:mock" + i,
      name: i % 37 === 0 ? title + " (Extended Club Remix feat. Someone Else)" : title,
      artistName: artists[a],
      artistId: "a" + a,
      albumName: albums[a],
      albumId: "al" + a,
      durationMs: 150000 + Math.floor(r() * 180000),
    });
  }
  const playlists = [
    "Songs From iPod Ads", "Alternative Hits: 2004", "Pop Hits: 2004", "Indie Rock Essentials", "Dance Rock", "2000s Hip-Hop/R&B Essentials", "Road Trip", "Late Night", "Liked From Radio",
  ].map((name, i) => ({
    id: "pl" + i,
    uri: "spotify:playlist:mock" + i,
    name,
    trackCount: 40 + i * 7,
    songIds: songs.filter((_, j) => (j + i) % 9 === 0).slice(0, 40 + i * 7).map((s) => s.id),
  }));
  const artistList = artists.map((name, i) => ({ id: "a" + i, uri: "spotify:artist:mock" + i, name }));
  const albumList = albums.map((name, i) => ({ id: "al" + i, uri: "spotify:album:mock" + i, name, artistName: artists[i] }));
  const byId = new Map(songs.map((s) => [s.id, s]));

  let emit = () => {};
  let signedIn = true;
  let volume = 50;
  const player = {
    hasTrack: false,
    isPaused: true,
    positionMs: 0,
    durationMs: 0,
    track: null,
    shuffle: false,
    repeat: "off",
    queue: [],
    index: 0,
    startedAt: 0,
  };

  function trackFor(uri) {
    return songs.find((s) => s.uri === uri);
  }

  function state() {
    return {
      hasTrack: player.hasTrack,
      isPaused: player.isPaused,
      positionMs: Math.min(player.positionMs, player.durationMs),
      durationMs: player.durationMs,
      track: player.track
        ? { uri: player.track.uri, name: player.track.name, artist: player.track.artistName, album: player.track.albumName }
        : null,
      shuffle: player.shuffle,
      repeat: player.repeat,
      remoteConnected: true,
    };
  }

  function publish() {
    emit("playerState", state());
  }

  function load(i) {
    player.index = i;
    const t = trackFor(player.queue[i]);
    player.track = t;
    player.hasTrack = !!t;
    player.durationMs = t ? t.durationMs : 0;
    player.positionMs = 0;
  }

  function tick() {
    if (!player.hasTrack || player.isPaused) return;
    player.positionMs += 500;
    if (player.positionMs >= player.durationMs) {
      if (player.repeat === "track") {
        player.positionMs = 0;
      } else if (player.index + 1 < player.queue.length) {
        load(player.index + 1);
      } else if (player.repeat === "context") {
        load(0);
      } else {
        player.isPaused = true;
        player.positionMs = player.durationMs;
      }
      publish();
    }
  }
  setInterval(tick, 500);

  const api = {
    "auth.status": async () => ({ signedIn, displayName: "Jordan", product: "premium", spotifyInstalled: true }),
    "auth.signIn": async () => {
      signedIn = true;
      emit("auth", { signedIn, displayName: "Jordan", product: "premium" });
      return { signedIn };
    },
    "auth.signOut": async () => {
      signedIn = false;
      emit("auth", { signedIn });
      return { signedIn };
    },
    "library.load": async () => {
      await new Promise((res) => setTimeout(res, 600));
      if (!signedIn) return { playlists: [], artists: [], albums: [], songs: [] };
      return { playlists, artists: artistList, albums: albumList, songs };
    },
    "library.refresh": async () => api["library.load"](),
    "library.playlistTracks": async ({ id }) => {
      await new Promise((res) => setTimeout(res, 250));
      const pl = playlists.find((p) => p.id === id);
      return { tracks: pl ? pl.songIds.map((sid) => byId.get(sid)) : [] };
    },
    "library.artistTracks": async ({ id }) => ({ tracks: songs.filter((s) => s.artistId === id) }),
    "library.albumTracks": async ({ id }) => ({ tracks: songs.filter((s) => s.albumId === id) }),
    "player.play": async ({ uris, offset }) => {
      player.queue = uris;
      player.isPaused = false;
      load(offset ?? 0);
      publish();
      return {};
    },
    "player.resume": async () => {
      if (player.hasTrack) player.isPaused = false;
      publish();
      return {};
    },
    "player.pause": async () => {
      player.isPaused = true;
      publish();
      return {};
    },
    "player.next": async () => {
      if (player.queue.length) load((player.index + 1) % player.queue.length);
      publish();
      return {};
    },
    "player.previous": async () => {
      if (player.positionMs > 3000) player.positionMs = 0;
      else if (player.queue.length) load((player.index - 1 + player.queue.length) % player.queue.length);
      publish();
      return {};
    },
    "player.seek": async ({ positionMs }) => {
      player.positionMs = Math.max(0, Math.min(positionMs, player.durationMs));
      publish();
      return {};
    },
    "player.setShuffle": async ({ enabled }) => {
      player.shuffle = !!enabled;
      publish();
      return {};
    },
    "player.setRepeat": async ({ mode }) => {
      player.repeat = mode;
      publish();
      return {};
    },
    "player.state": async () => state(),
    "system.volume": async () => ({ volume }),
    "system.setVolume": async ({ volume: v }) => {
      volume = Math.max(0, Math.min(100, Math.round(v)));
      emit("volume", { volume });
      return { volume };
    },
    "system.haptic": async () => ({}),
    "system.click": async () => ({}),
    "system.openSpotify": async () => ({}),
    "system.ready": async () => ({}),
  };

  IPOD.bridge.useMock({
    attach(e) {
      emit = e;
    },
    call(method, args) {
      const fn = api[method];
      if (!fn) return Promise.reject(new Error("mock: unknown method " + method));
      // Always answer asynchronously, like the native bridge does.
      return new Promise((resolve) => setTimeout(resolve, 0)).then(() => fn(args));
    },
  });
})(window.IPOD);
