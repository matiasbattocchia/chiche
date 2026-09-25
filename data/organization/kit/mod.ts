// The kit every game starts from: boot, saving, adaptive difficulty, sound, prizes and
// the debug overlay. `game build` bundles it into each game, so a published game stands
// alone.
import Phaser from "phaser";
import { sfxr } from "jsfxr";

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
/** Under `game serve` and `game test`: a reload resumes the scene it left. */
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

// a starting point to tune by watching the child, not a proven rate for children (the 85%
// comes from Wilson et al. 2019, about machine learners on two-choice tasks)
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
    lastOk = ok;
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

let lastOk = false;

/**
 * Mark a prize as given. It must follow a successful try, and one success may earn several
 * (a star, and fireworks every fifth); `game test` flags a prize after a miss or before any try.
 */
export function prize(name: string) {
  if (!lastOk) console.warn(`[prize] ${name} given without a successful try`);
  else console.log(`[prize] ${name}`);
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
  laser: [{ wave: "square", from: 1400, to: 350, ms: 110, gain: 0.12 }],
  win: [523, 659, 784, 1047].map((f) => ({ wave: "square" as const, from: f, to: f, ms: 110 })),
};

// Retro sounds made by jsfxr (public domain), each generated once from the jsfxr generator
// it is named after and pinned here, so a game always sounds the same. `makeSound` adds a
// game's own.
const RETRO: Record<string, string> = {
  pickup: "34T6PkyRDVe6wn3crXSkvRP58zuygRN6q9wv2Crh2bG1CetMB1w9E3fn7ZmMsRe47jWigyFnqfxM1zq5XpZE2WLkQaHHrHBGGhyNRJ1ZrrFD83NCQZFRmoA2K",
  zap: "57uBnWhFGX99q4XEM56Lrr6srNWtiwWMNreuoGm1tST56PXA3cSG4E8qBmkhurnPvFuTVFU2JvhAVo4WRNkiryYft2ZZ8wH6ZRZpE74acAEUpt4NNRG9jZFxs",
  explosion: "7BMHBGPaUa2U4LWYV5XX7pbPgQxqPkeGhc7XwnUYn6tD5h6jtTdp7gaQeCWS5YZmnFTADYGowF6Ad9Nk6x6J47DYDDA729iZby7XQ6zSdd8xnPhNSYhb9kNPR",
  powerup: "34T6Pkig4V7WYfizsNPxriJ3BBcGTNJSrQ4fYRYiQzEmyHR3cDkJPnjEmxsRbWhe7VfSGTCFNzBb7RDZ4QpMBz5uqunZVkxoCSsvjHQcumyTR619jZNiKwRhZ",
  hurt: "11111HABDo7hw6oKCMBr1MVdmDiD4g3tYFUNGmtqoS2DzbAJpjMT4qVhtBscsK2DffpXgaDRJm7CLE4sd1Qe4pxfkX3aPQQcLY1f74hjvUiCq577BU2e8fgB",
  blip: "11111Eri68hfHrjD1FwVtwiTs5aVogxoT4mek4vBMzgKSuzx6RgyXi7XUvrRewdXVxmYn2UHELp6beDU9qqgLHroFptVs7a1wjxFtBraGizVAoBSXv3AqQUP",
};
// jsfxr's sounds peak anywhere from 0.3 to 0.9; each is scaled to this, near the tones' 0.2
const RETRO_PEAK = 0.3;
const rendered = new Map<string, { buffer: AudioBuffer; gain: number }>();

/** jsfxr settings (the `game-sound` skill says what each does); unset ones keep jsfxr's defaults. */
export type SoundSettings = { wave_type?: 0 | 1 | 2 | 3 } & { [setting: `p_${string}`]: number };

/**
 * A game's own sound, played with `sfx(scene, name)` like the built-in ones. Make it once,
 * outside any scene; the `game-sound` skill says how to design it without hearing it.
 */
export function makeSound(name: string, settings: SoundSettings) {
  // encoding and decoding fills in jsfxr's defaults for the settings left out
  RETRO[name] = sfxr.b58encode(settings);
  rendered.delete(name);
}

/**
 * Play a sound: the loaded audio with that key if there is one, else one made with
 * `makeSound`, else a built-in one. Synthesized tones: click, jump, coin, kick, hit, miss,
 * laser, win. Retro (jsfxr): pickup, zap, explosion, powerup, hurt, blip. Made and built-in
 * sounds vary their pitch a little on each play, so a repeated sound doesn't grate. Every
 * play is logged.
 */
export function sfx(scene: Phaser.Scene, name: string, config?: Phaser.Types.Sound.SoundConfig) {
  console.log(`[sfx] ${name}`);
  if (scene.cache.audio.exists(name)) {
    scene.sound.play(name, config);
    return;
  }
  const tones = PRESETS[name];
  const ctx = (scene.sound as Phaser.Sound.WebAudioSoundManager).context;
  if (!tones && !RETRO[name]) return console.warn(`[sfx] no sound called ${name}`);
  if (!ctx) return;
  // Math.random, not Phaser's RND: sound must not shift a seeded game's randomness
  const pitch = 1 + (Math.random() - 0.5) * 0.1;
  if (RETRO[name]) {
    let sound = rendered.get(name);
    if (!sound) {
      // the code holds the sound's shape; volume and rate are sfxr.generate()'s defaults
      const params = { ...sfxr.b58decode(RETRO[name]), sound_vol: 0.25, sample_rate: 44100, sample_size: 8 };
      const buffer = sfxr.toWebAudio(params, ctx).buffer as AudioBuffer;
      const peak = buffer.getChannelData(0).reduce((top, v) => Math.max(top, Math.abs(v)), 0);
      sound = { buffer, gain: peak ? RETRO_PEAK / peak : 0 };
      rendered.set(name, sound);
    }
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = sound.buffer;
    src.playbackRate.value = pitch;
    gain.gain.value = sound.gain * scene.sound.volume;
    src.connect(gain).connect(ctx.destination);
    src.start();
    return;
  }
  let t = ctx.currentTime;
  for (const tone of tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = tone.wave;
    osc.frequency.setValueAtTime(tone.from * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(tone.to * pitch, t + tone.ms / 1000);
    gain.gain.setValueAtTime((tone.gain ?? 0.2) * scene.sound.volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + tone.ms / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + tone.ms / 1000);
    t += tone.ms / 1000;
  }
}

// ── juice ───────────────────────────────────────────────────────────────────
// Small effects that make a game feel alive, one call each. The `game-juice` skill says
// when to use which.

type Thing = Phaser.GameObjects.GameObject & Phaser.GameObjects.Components.Transform;
const squashing = new WeakMap<Thing, { tween: Phaser.Tweens.Tween; x: number; y: number }>();

/** Appear with a little overshoot, from nothing to its current scale. */
export function pop(target: Thing, ms = 300) {
  const { scaleX, scaleY } = target;
  target.setScale(0);
  return target.scene.tweens.add({ targets: target, scaleX, scaleY, duration: ms, ease: "Back.easeOut" });
}

/** Squashed flat for an instant, then springs back: a landing, a bump, a press. */
export function squash(target: Thing, amount = 0.25, ms = 180) {
  const before = squashing.get(target);
  if (before?.tween.isPlaying()) {
    before.tween.stop();
    target.setScale(before.x, before.y);
  }
  const { scaleX: x, scaleY: y } = target;
  target.setScale(x * (1 + amount), y * (1 - amount));
  const tween = target.scene.tweens.add({ targets: target, scaleX: x, scaleY: y, duration: ms, ease: "Back.easeOut" });
  squashing.set(target, { tween, x, y });
  return tween;
}

/** Shake the screen: a crash, a big hit. Small and short by default. */
export function shake(scene: Phaser.Scene, strength = 0.008, ms = 150) {
  scene.cameras.main.shake(ms, strength);
}

/** Flash the screen with a color: a big success. At most one every half second or so. */
export function flash(scene: Phaser.Scene, color = 0xffffff, ms = 150) {
  const c = Phaser.Display.Color.IntegerToRGB(color);
  scene.cameras.main.flash(ms, c.r, c.g, c.b);
}

/** A burst of particles from (x, y): a catch, a pop, a win. Without a texture, round dots. */
export function burst(
  scene: Phaser.Scene,
  x: number,
  y: number,
  o: { texture?: string; tint?: number; count?: number; speed?: number } = {},
) {
  if (!o.texture && !scene.textures.exists("kit:dot")) {
    const g = scene.add.graphics();
    g.fillStyle(0xffffff).fillCircle(8, 8, 8);
    g.generateTexture("kit:dot", 16, 16).destroy();
  }
  const speed = o.speed ?? 300;
  const particles = scene.add.particles(x, y, o.texture ?? "kit:dot", {
    speed: { min: speed * 0.4, max: speed },
    scale: { start: 1, end: 0 },
    lifespan: 700,
    emitting: false,
    ...(o.tint === undefined ? {} : { tint: o.tint }),
  });
  particles.explode(o.count ?? 16);
  scene.time.delayedCall(800, () => particles.destroy());
  return particles;
}

/** Freeze the action for a moment on impact (hit stop), then carry on: 40 to 80 ms. */
export function hitStop(scene: Phaser.Scene, ms = 60) {
  const world = scene.physics?.world;
  world?.pause();
  scene.tweens.pauseAll();
  // real time: the scene's own clock keeps going, and a timer on it would too
  setTimeout(() => {
    if (!scene.sys.isActive()) return;
    world?.resume();
    scene.tweens.resumeAll();
  }, ms);
}

/** A soft glow around something to catch or to reach. */
export function glow(
  target: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite | Phaser.GameObjects.Text,
  color = 0xffffff,
  strength = 4,
) {
  if (target.scene.renderer.type !== Phaser.WEBGL) return;
  target.enableFilters();
  return target.filters!.internal.addGlow(color, strength, 0);
}

// ── boot ────────────────────────────────────────────────────────────────────

export const kit = {
  save: undefined as unknown as Save,
  difficulty: undefined as unknown as Difficulty,
};

/**
 * Leave the boot scene for `key` — or, under `game serve` and `game test`, for the
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
