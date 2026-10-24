/*
 * Brick — the Breakout clone hidden in the 2001–2004 iPod firmware.
 *
 * Game logic runs on a 148×101 virtual LCD. Instead of drawing shapes, each
 * frame writes a drive buffer (0 off, 1 brick/ball, 2 paddle) and the LCD
 * model relaxes every pixel's ink toward it with different time constants for
 * turning on (20 ms), off (70 ms) and for the paddle (25 ms). That reproduces
 * the slow response and ghosting of a passive-matrix monochrome display: the
 * ball leaves a fading trail. The painter then rasterises the ink buffer into
 * a canvas at device resolution with faint gaps between LCD cells.
 */
"use strict";
window.IPOD = window.IPOD || {};

(function (IPOD) {
  const W = 148, H = 101;
  const PADDLE_W = 30, PADDLE_H = 4;
  const BALL_R = 1.5;
  const BRICK_H = 4, BRICKS_PER_ROW = 12, BRICK_GAP = 2, ROW_GAP = 4, SIDE_PAD = 3, TOP_PAD = 3;
  const BRICK_W = (W - SIDE_PAD * 2 - (BRICKS_PER_ROW - 1) * BRICK_GAP) / BRICKS_PER_ROW;
  const START_ROWS = 2, MAX_ROWS = 5, START_BALLS = 3;
  const SERVE_MS = 1000, BASE_TICK_MS = 40, SPEEDUP_PER_LEVEL = 0.1, MAX_SPEEDUP = 1.5;
  const BALL_V = 1.7, BALL_SPEED = Math.hypot(BALL_V, BALL_V);
  const EDGE_BOOST = 0.25, MAX_DX_RATIO = 0.8;
  const PADDLE_RANGE = W - PADDLE_W;
  const PADDLE_Y = H - PADDLE_H;
  const KEY_STEP = 0.035;       // paddle range per tick for keyboard steering
  const MAX_CATCHUP_TICKS = 10;
  const DEGREES_PER_RANGE = 360; // one full wheel turn moves the paddle across the field

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const tickMs = (level) => BASE_TICK_MS / Math.min(1 + (level - 1) * SPEEDUP_PER_LEVEL, MAX_SPEEDUP);

  function makeBricks(level) {
    const rows = Math.min(START_ROWS + level - 1, MAX_ROWS);
    const bricks = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < BRICKS_PER_ROW; c++)
        bricks.push({ x: SIDE_PAD + c * (BRICK_W + BRICK_GAP), y: TOP_PAD + r * (BRICK_H + ROW_GAP), destroyed: false });
    return bricks;
  }
  const newBall = () => ({ x: BALL_R, y: H / 2, dx: BALL_V, dy: BALL_V });
  const initialState = () => ({
    paddleX: PADDLE_RANGE / 2, ball: newBall(), isBallInPlay: false, serveTicks: 0,
    bricks: makeBricks(1), score: 0, balls: START_BALLS, level: 1, isGameOver: false,
  });

  function createGame() {
    const s = initialState();
    function serve() {
      s.ball = newBall();
      s.isBallInPlay = false;
      s.serveTicks = Math.round(SERVE_MS / tickMs(s.level));
    }
    function loseBall() {
      s.balls -= 1;
      if (s.balls > 0) serve();
      else { s.isBallInPlay = false; s.isGameOver = true; }
    }
    function nextLevel() {
      s.level += 1;
      s.bricks = makeBricks(s.level);
      serve();
    }
    function bounceOffPaddle() {
      const b = s.ball, half = PADDLE_W / 2;
      const where = clamp((b.x - (s.paddleX + half)) / half, -1, 1);
      const speed = BALL_SPEED * (1 + Math.abs(where) * EDGE_BOOST);
      const dx = where * MAX_DX_RATIO;
      const n = Math.hypot(dx, 1);
      b.dx = (dx / n) * speed;
      b.dy = -speed / n;
    }
    function hitFace(i) {
      const b = s.ball, bricks = s.bricks, { x, y, destroyed } = bricks[i];
      const neighbour = i - Math.sign(b.dx);
      if (destroyed || b.x + BALL_R < x || b.x - BALL_R > x + BRICK_W || b.y + BALL_R < y || b.y - BALL_R > y + BRICK_H) return null;
      const penX = b.dx > 0 ? b.x + BALL_R - x : x + BRICK_W - b.x + BALL_R;
      const penY = b.dy > 0 ? b.y + BALL_R - y : y + BRICK_H - b.y + BALL_R;
      const sameRow = Math.floor(neighbour / BRICKS_PER_ROW) === Math.floor(i / BRICKS_PER_ROW);
      const neighbourAlive = sameRow && bricks[neighbour] && bricks[neighbour].destroyed === false;
      if (!neighbourAlive && penX * Math.abs(b.dy) < penY * Math.abs(b.dx)) {
        return (x + BRICK_W / 2 - b.x) * b.dx > 0 ? "side" : null;
      }
      return (y + BRICK_H / 2 - b.y) * b.dy > 0 ? "face" : null;
    }
    function hitBricks() {
      const b = s.ball;
      for (let i = 0; i < s.bricks.length; i++) {
        const hit = hitFace(i);
        if (hit) {
          s.bricks[i].destroyed = true;
          s.score += 1;
          if (hit === "face") b.dy = -b.dy; else b.dx = -b.dx;
          return true;
        }
      }
      return false;
    }
    function tick() {
      const b = s.ball;
      if (s.serveTicks > 0) {
        s.serveTicks -= 1;
        s.isBallInPlay = s.serveTicks === 0;
      }
      if (!s.isBallInPlay) return;
      const wasAbovePaddle = b.y + BALL_R < PADDLE_Y;
      b.x += b.dx;
      b.y += b.dy;
      if ((b.x <= BALL_R && b.dx < 0) || (b.x >= W - BALL_R && b.dx > 0)) b.dx = -b.dx;
      if (b.y <= BALL_R && b.dy < 0) b.dy = -b.dy;
      if (b.y >= H) { loseBall(); return; }
      if (b.dy > 0 && wasAbovePaddle && b.y + BALL_R >= PADDLE_Y && b.x + BALL_R >= s.paddleX && b.x - BALL_R <= s.paddleX + PADDLE_W) bounceOffPaddle();
      if (hitBricks() && s.bricks.every((k) => k.destroyed)) nextLevel();
    }
    return {
      state: s,
      movePaddle(fraction) {
        if (!s.isGameOver) s.paddleX = clamp(s.paddleX + fraction * PADDLE_RANGE, 0, PADDLE_RANGE);
      },
      launchBall() {
        if (s.isGameOver) Object.assign(s, initialState());
        else { s.isBallInPlay = true; s.serveTicks = 0; }
      },
      tick,
    };
  }

  // ── LCD response model ───────────────────────────────────────────────────
  const TAU_ON = 20, TAU_OFF = 70, TAU_PADDLE = 25, EPS = 1 / 255, PADDLE = 2;
  function createLcd(width, height) {
    const n = width * height;
    const drive = new Uint8Array(n);
    const mid = new Float32Array(n);
    const ink = new Float32Array(n);
    const kind = new Uint8Array(n);
    function fade(dt) {
      const kOn = 1 - Math.exp(-dt / TAU_ON);
      const kOff = 1 - Math.exp(-dt / TAU_OFF);
      const kPad = 1 - Math.exp(-dt / TAU_PADDLE);
      let settling = false;
      for (let i = 0; i < n; i++) {
        const target = drive[i] === 0 ? 0 : 1;
        kind[i] = drive[i] || kind[i];
        if (Math.abs(target - mid[i]) > EPS || Math.abs(target - ink[i]) > EPS) {
          const off = kind[i] === PADDLE ? kPad : kOff;
          const d1 = target - mid[i];
          mid[i] += d1 * (d1 > 0 ? kOn : off);
          const d2 = mid[i] - ink[i];
          ink[i] += d2 * (d2 > 0 ? kOn : off);
          settling = true;
        } else {
          settling = settling || mid[i] !== target || ink[i] !== target;
          mid[i] = target;
          ink[i] = target;
        }
      }
      return settling;
    }
    function settle() {
      for (let i = 0; i < n; i++) {
        kind[i] = drive[i] || kind[i];
        mid[i] = drive[i] === 0 ? 0 : 1;
        ink[i] = mid[i];
      }
    }
    return { width, height, drive, ink, fade, settle };
  }

  // ── Painter ───────────────────────────────────────────────────────────────
  const GRID_DIM = 0.7, MIN_UPSCALE = 3;
  function gridMask(px, cell) {
    const edge = Math.round((px + 0.5) / cell) * cell;
    return 1 - (1 - GRID_DIM) * Math.max(0, 1 - Math.abs(px + 0.5 - edge));
  }
  function createPainter(canvas, lcd) {
    const ctx = canvas.getContext("2d");
    let image, lookup = new Int32Array(0), mask = new Float32Array(0), media;
    function buildLookup() {
      const { width, height } = canvas;
      const cell = width / lcd.width;
      const up = cell > 1;
      lookup = new Int32Array(width * height);
      mask = new Float32Array(width * height);
      for (let y = 0; y < height; y++) {
        const sy = Math.min(Math.floor((y + 0.5) / cell), lcd.height - 1);
        const my = up ? gridMask(y, cell) : 1;
        for (let x = 0; x < width; x++) {
          const sx = Math.floor((x + 0.5) / cell);
          const mx = up ? gridMask(x, cell) : 1;
          lookup[y * width + x] = sy * lcd.width + sx;
          mask[y * width + x] = my * mx * 255;
        }
      }
    }
    function paint() {
      if (!ctx || !image) return;
      const d = image.data;
      for (let i = 0; i < lookup.length; i++) d[i * 4 + 3] = lcd.ink[lookup[i]] * mask[i];
      ctx.putImageData(image, 0, 0);
    }
    function resize() {
      const cs = getComputedStyle(canvas);
      const scale = Number(cs.getPropertyValue("--ipod-scale")) || 1;
      const want = Math.round(canvas.clientWidth * scale * devicePixelRatio);
      const width = want >= lcd.width * MIN_UPSCALE ? want : lcd.width;
      if (image && width === canvas.width) return;
      canvas.width = width;
      canvas.height = Math.round((width * lcd.height) / lcd.width);
      buildLookup();
      image = ctx ? ctx.createImageData(canvas.width, canvas.height) : null;
      if (image) {
        const [r = 0, g = 0, b = 0] = (cs.color.match(/\d+/g) || []).map(Number);
        for (let i = 0; i < image.data.length; i += 4) image.data.set([r, g, b], i);
      }
      paint();
    }
    function watchDpr() {
      if (media) media.removeEventListener("change", watchDpr);
      media = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
      media.addEventListener("change", watchDpr);
      resize();
    }
    const ro = new ResizeObserver(() => resize());
    ro.observe(document.documentElement);
    watchDpr();
    return {
      paint,
      destroy() {
        ro.disconnect();
        if (media) media.removeEventListener("change", watchDpr);
      },
    };
  }

  // ── Screen component ─────────────────────────────────────────────────────
  function createBrickScreen({ i18n, onStatus }) {
    const el = document.createElement("div");
    el.className = "brick-game-screen";
    el.dataset.testid = "brick-game";
    const canvas = document.createElement("canvas");
    canvas.className = "game-area";
    canvas.width = W;
    canvas.height = H;
    canvas.setAttribute("aria-hidden", "true");
    const msg = document.createElement("p");
    msg.className = "game-message";
    msg.setAttribute("role", "status");
    el.append(canvas, msg);

    const game = createGame();
    const lcd = createLcd(W, H);
    let painter, raf, lastT, acc = 0, dirty = false, steer = 0, steered = false, paused = false;

    function fill(x, y, w, h, value = 1) {
      const px = Math.round(x), py = Math.round(y);
      const x0 = Math.max(px, 0), x1 = Math.min(px + w, W), y1 = Math.min(py + h, H);
      for (let r = Math.max(py, 0); r < y1; r++) lcd.drive.fill(value, r * W + x0, r * W + x1);
    }
    function render() {
      lcd.drive.fill(0);
      for (const b of game.state.bricks) if (!b.destroyed) fill(b.x, b.y, BRICK_W, BRICK_H);
      fill(game.state.paddleX, PADDLE_Y, PADDLE_W, PADDLE_H, PADDLE);
      fill(game.state.ball.x - BALL_R, game.state.ball.y - BALL_R, BALL_R * 2, BALL_R * 2);
      dirty = false;
    }
    function status() {
      const s = game.state;
      msg.textContent = s.isGameOver ? i18n.t("Game.GameOver") : (s.isBallInPlay || s.serveTicks > 0 ? "" : i18n.t("Game.LaunchBall"));
      onStatus && onStatus({ score: s.score, balls: s.balls, gameOver: s.isGameOver });
    }
    function frame(t) {
      const dt = lastT === undefined ? 0 : t - lastT;
      const step = tickMs(game.state.level);
      lastT = t;
      acc = Math.min(acc + dt, step * MAX_CATCHUP_TICKS);
      let ticked = false;
      while (acc >= step) {
        acc -= step;
        ticked = true;
        if (!paused) {
          game.movePaddle(steer * KEY_STEP);
          if (!steered) steered = steer !== 0;
          game.tick();
        }
      }
      if (ticked) { render(); status(); }
      const settling = lcd.fade(dt);
      if (ticked || settling) painter && painter.paint();
      const s = game.state;
      const live = ((s.isBallInPlay || s.serveTicks > 0) && !paused) || dirty || settling || (steer !== 0 && !paused);
      raf = live ? requestAnimationFrame(frame) : undefined;
    }
    function run() {
      if (raf === undefined) { lastT = undefined; raf = requestAnimationFrame(frame); }
    }
    function stop() {
      if (raf !== undefined) { cancelAnimationFrame(raf); raf = undefined; }
    }

    render();
    lcd.settle();
    status();

    return {
      el,
      mount() {
        painter = createPainter(canvas, lcd);
        run();
      },
      unmount() {
        stop();
        painter && painter.destroy();
        painter = undefined;
      },
      // Wheel rotation, in signed degrees.
      turnPaddle(degrees) {
        game.movePaddle(degrees / DEGREES_PER_RANGE);
        dirty = true;
        run();
      },
      // Keyboard steering: -1, 0, +1 held direction.
      steerPaddle(dir) {
        if (dir === 0 && !steered && !paused) { game.movePaddle(steer * KEY_STEP); dirty = true; }
        steer = dir;
        steered = false;
        run();
      },
      launchBall() {
        game.launchBall();
        dirty = true;
        status();
        run();
      },
      setPaused(p) {
        paused = p;
        if (!p) run();
      },
      get state() {
        return game.state;
      },
    };
  }

  IPOD.createBrickScreen = createBrickScreen;
})(window.IPOD);
