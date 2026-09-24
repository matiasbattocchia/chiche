// The kit every game starts from: boot, saving, adaptive difficulty, sound, prizes and
// the debug overlay. `game build` bundles it into each game, so a published game stands
// alone.
import Phaser from "phaser";

export { Phaser };

/** game.json: what the index page shows, and what the game's prizes are. */
export type Meta = {
  title: string;
  emoji: string;
  description: string;
  prizes: string[];
  published?: string;
};

const params = new URLSearchParams(location.search);
/** `?debug=1`: physics bodies drawn, and the overlay in the corner. */
export const debug = params.has("debug");
/** Under `game serve` and `game run`: a reload resumes the scene it left. */
const dev = Boolean((globalThis as { __DEV__?: boolean }).__DEV__);

// ── saving ──────────────────────────────────────────────────────────────────

/** Everything that outlives a reload. Put progress the kid would miss in `data`. */
export type Save = {
  scene?: string;
  data: Record<string, unknown>;
  difficulty: { level: number; n: number; recent: boolean[] };
};

function load(key: string): Save {
  const empty: Save = { data: {}, difficulty: { level: 0.3, n: 0, recent: [] } };
  try {
    if (params.has("fresh")) localStorage.removeItem(key);
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    return saved ? { ...empty, ...saved } : empty;
  } catch {
    return empty;
  }
}

// ── difficulty ──────────────────────────────────────────────────────────────

const TARGET = 0.85;
const DOWN = 0.1;
// A weighted up/down staircase settles where p·UP = (1−p)·DOWN, i.e. at p = TARGET.
const UP = DOWN * (1 - TARGET) / TARGET;
const WINDOW = 20;

/** Holds the kid near 85% success. Never shown on screen. */
export class Difficulty {
  constructor(private s: Save["difficulty"]) {}

  /** 0 (easiest) … 1 (hardest). */
  get level() {
    return this.s.level;
  }

  /** Success over the last tries, or null before there are any. */
  get rate() {
    const r = this.s.recent;
    return r.length ? r.filter(Boolean).length / r.length : null;
  }

  /** Call once per try: a shot, a jump, a round — whatever the game counts. */
  trial(ok: boolean) {
    const s = this.s;
    const boost = s.n < 10 ? 3 : 1; // find the kid's level fast, then settle
    s.level = Phaser.Math.Clamp(s.level + boost * (ok ? UP : -DOWN), 0, 1);
    s.n++;
    s.recent = [...s.recent, ok].slice(-WINDOW);
    if (ok) lastSuccess = performance.now();
    console.log(
      `[try] ${ok ? "ok" : "miss"} · level ${s.level.toFixed(2)} · ` +
        `${Math.round(this.rate! * 100)}% of last ${s.recent.length}`,
    );
  }

  /** A setting between its easy and its hard value, at the current level. */
  pick(easy: number, hard: number) {
    return easy + (hard - easy) * this.s.level;
  }
}

// ── prizes ──────────────────────────────────────────────────────────────────

let lastSuccess = -Infinity;
let lastPrize = -Infinity;

/** Mark a prize as given. It must follow a successful try; `game run` flags one that doesn't. */
export function prize(name: string) {
  if (lastSuccess <= lastPrize) console.warn(`[prize] ${name} given without a successful try`);
  else console.log(`[prize] ${name}`);
  lastPrize = performance.now();
}

// ── sound ───────────────────────────────────────────────────────────────────

type Tone = { wave: OscillatorType; from: number; to: number; ms: number; gain?: number };
const PRESETS: Record<string, Tone[]> = {
  click: [{ wave: "square", from: 660, to: 660, ms: 40, gain: 0.15 }],
  jump: [{ wave: "square", from: 300, to: 700, ms: 150 }],
  coin: [{ wave: "square", from: 990, to: 990, ms: 70 }, { wave: "square", from: 1320, to: 1320, ms: 160 }],
  kick: [{ wave: "triangle", from: 180, to: 50, ms: 120, gain: 0.5 }],
  hit: [{ wave: "sawtooth", from: 220, to: 80, ms: 180 }],
  miss: [{ wave: "triangle", from: 400, to: 200, ms: 250 }],
  win: [523, 659, 784, 1047].map((f) => ({ wave: "square" as const, from: f, to: f, ms: 110 })),
};

/**
 * Play a sound: the loaded audio with that key if there is one, else a synthesized
 * preset (click, jump, coin, kick, hit, miss, win). Every play is logged.
 */
export function sfx(scene: Phaser.Scene, name: string, config?: Phaser.Types.Sound.SoundConfig) {
  console.log(`[sfx] ${name}`);
  if (scene.cache.audio.exists(name)) {
    scene.sound.play(name, config);
    return;
  }
  const tones = PRESETS[name];
  const ctx = (scene.sound as Phaser.Sound.WebAudioSoundManager).context;
  if (!tones) return console.warn(`[sfx] no sound called ${name}`);
  if (!ctx) return;
  let t = ctx.currentTime;
  for (const tone of tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = tone.wave;
    osc.frequency.setValueAtTime(tone.from, t);
    osc.frequency.exponentialRampToValueAtTime(tone.to, t + tone.ms / 1000);
    gain.gain.setValueAtTime((tone.gain ?? 0.2) * scene.sound.volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + tone.ms / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + tone.ms / 1000);
    t += tone.ms / 1000;
  }
}

// ── boot ────────────────────────────────────────────────────────────────────

export const kit = {
  save: undefined as unknown as Save,
  difficulty: undefined as unknown as Difficulty,
};

/**
 * Leave the boot scene for `key` — or, under `game serve` and `game run`, for the
 * scene a reload interrupted, so a rebuild doesn't send the kid back to the title.
 */
export function next(from: Phaser.Scene, key: string, data?: object) {
  from.scene.start(dev && kit.save.scene ? kit.save.scene : key, data);
}

export type Options = {
  width?: number;
  height?: number;
  background?: string;
  /** Arcade physics gravity, pixels/s². */
  gravity?: number;
  pixelArt?: boolean;
};

/**
 * Start the game. The first scene is the boot scene: it loads, then calls `next()`.
 * Scenes whose key starts with `_` (a HUD, an overlay) are never resumed into.
 */
export function startGame(meta: Meta, scenes: Phaser.Types.Scenes.SceneType[], o: Options = {}) {
  const key = `game:${location.pathname.split("/").filter(Boolean).at(-1) ?? "game"}`;
  kit.save = load(key);
  kit.difficulty = new Difficulty(kit.save.difficulty);
  document.title = `${meta.emoji} ${meta.title}`;

  const seed = params.get("seed");
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    width: o.width ?? 960,
    height: o.height ?? 540,
    backgroundColor: o.background ?? "#1b4332",
    pixelArt: o.pixelArt ?? false,
    banner: false,
    seed: seed ? [seed] : undefined,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    input: { gamepad: true },
    physics: { default: "arcade", arcade: { debug, gravity: { x: 0, y: o.gravity ?? 0 } } },
    scene: scenes,
  });
  Object.assign(globalThis, { game, kit });

  game.events.once(Phaser.Core.Events.READY, () => {
    for (const s of game.scene.getScenes(false).slice(1)) {
      if (s.scene.key.startsWith("_")) continue;
      s.events.on(Phaser.Scenes.Events.CREATE, () => kit.save.scene = s.scene.key);
    }
  });

  let last = "";
  const persist = () => {
    const now = JSON.stringify(kit.save);
    if (now === last) return;
    last = now;
    try {
      localStorage.setItem(key, now);
    } catch { /* private mode: play on without saving */ }
  };
  setInterval(persist, 1000);
  addEventListener("pagehide", persist);

  if (debug) overlay(game);
  return game;
}

function overlay(game: Phaser.Game) {
  const el = document.createElement("pre");
  el.style.cssText =
    "position:fixed;bottom:0;left:0;margin:0;padding:6px 8px;font:12px monospace;" +
    "color:#0f0;background:#000a;pointer-events:none;z-index:9";
  document.body.append(el);
  setInterval(() => {
    const scenes = game.scene.getScenes(true).map((s) => s.scene.key).join(" ");
    const d = kit.difficulty;
    const rate = d.rate === null ? "–" : `${Math.round(d.rate * 100)}%`;
    el.textContent = `${Math.round(game.loop.actualFps)} fps · ${scenes}\n` +
      `level ${d.level.toFixed(2)} · success ${rate}`;
  }, 250);
}
