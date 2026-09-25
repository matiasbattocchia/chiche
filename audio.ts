// audio.ts — the two PipeWire processes, their levels, and the mixer. pw-record captures 16 kHz
// s16 mono on its stdout, opened once for the whole run. pw-play takes 24 kHz s16 mono on its
// stdin, spawned when there is voice to play and kept until a flush: an idle pw-play while a
// Bluetooth headset switches to its headset profile (which opening the mic triggers) stalls the
// capture (measured). There is no echo cancellation.
//
// The mixer (the default devices' volume and mute) is outside chiche: `unmute` clears both mutes
// at boot, the one thing chiche does to it, and `watchMixer` reports every change after that.

import type { MicWindow } from "./log.ts";

export const MIC_RATE = 16000;
export const VOICE_RATE = 24000;
/** One capture chunk: 40 ms. */
const CHUNK_BYTES = MIC_RATE * 2 * 40 / 1000;
/** One measurement window: 250 ms. */
const WINDOW_MS = 250;
/** Playback is metered in blocks of 20 ms. */
const PLAY_BLOCK = VOICE_RATE * 20 / 1000;
/** A chunk counts as voice this far above the noise floor, and above this level. */
const VOICE_OVER_FLOOR_DB = 8;
const VOICE_MIN_DB = -55;

export interface AudioEvents {
  /** Every capture chunk (40 ms), as the mic delivered it. */
  chunk(pcm: Uint8Array): void;
  window(w: MicWindow): void;
  /** A process died on its own. */
  died(which: "pw-record" | "pw-play", code: number | null): void;
}

/** What the meters read: see `Audio.levels`. */
export interface Levels {
  /** The loudest mic chunk since the last read (the last chunk's if none arrived), dBFS. */
  mic: number;
  /** Any of those chunks read as voice. */
  voice: boolean;
  /** Milliseconds since the last capture chunk: a stalled pw-record shows here. */
  silentFor: number;
  /** What the speakers are (probably) playing now, dBFS; -100 when nothing. */
  speaker: number;
}

export class Audio {
  #on: AudioEvents;
  #record?: Deno.ChildProcess;
  #play?: Deno.ChildProcess;
  #writer?: WritableStreamDefaultWriter<Uint8Array>;
  #writes: Promise<void> = Promise.resolve();
  #stopping = false;
  /** The clock moment the queued playback runs out. */
  #playUntil = 0;
  /** The queued playback's levels, one per block, with the moment each block ends. */
  #queued: { end: number; level: number }[] = [];
  #micMax = -100;
  #micLast = -100;
  #micVoice = false;
  #lastChunk = performance.now();

  private constructor(on: AudioEvents) {
    this.#on = on;
  }

  static start(on: AudioEvents): Audio {
    const a = new Audio(on);
    a.#startRecord();
    return a;
  }

  /** Whether the speakers are (probably) still playing what was queued. */
  get playing() {
    return performance.now() < this.#playUntil;
  }

  /** The meters' reading; the mic's part starts over with each read. */
  levels(): Levels {
    const now = performance.now();
    const l = {
      // chunks come every 40 ms, reads whenever: a read between two gets the last one
      mic: this.#micMax > -100 ? this.#micMax : this.#micLast,
      voice: this.#micVoice,
      silentFor: now - this.#lastChunk,
      speaker: this.#speakerAt(now),
    };
    this.#micMax = -100;
    this.#micVoice = false;
    return l;
  }

  /** Queue voice audio (24 kHz s16 mono) for the speakers. */
  play(pcm: Uint8Array) {
    const now = performance.now();
    let at = Math.max(now, this.#playUntil);
    const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
    for (let i = 0; i < s.length; i += PLAY_BLOCK) {
      const block = s.subarray(i, i + PLAY_BLOCK);
      at += block.length / VOICE_RATE * 1000;
      this.#queued.push({ end: at, level: rmsDb(block) });
    }
    this.#playUntil = at;
    if (!this.#play && !this.#stopping) this.#startPlay();
    const w = this.#writer;
    if (!w) return;
    this.#writes = this.#writes.then(() => w.write(pcm)).catch(() => {});
  }

  /** Drop everything queued for the speakers: kill pw-play; the next voice spawns it again. */
  flush() {
    this.#playUntil = 0;
    this.#queued = [];
    const p = this.#play;
    this.#play = undefined;
    this.#writer = undefined;
    this.#writes = Promise.resolve();
    if (p) {
      try {
        p.kill("SIGKILL");
      } catch { /* gone */ }
    }
  }

  stop() {
    this.#stopping = true;
    for (const p of [this.#record, this.#play]) {
      try {
        p?.kill("SIGTERM");
      } catch { /* gone */ }
    }
  }

  #speakerAt(now: number) {
    let i = 0;
    while (i < this.#queued.length && this.#queued[i].end < now) i++;
    if (i) this.#queued.splice(0, i);
    return this.#queued[0]?.level ?? -100;
  }

  #startPlay() {
    const p = new Deno.Command("pw-play", {
      args: ["--rate", String(VOICE_RATE), "--channels", "1", "--format", "s16", "--raw", "-"],
      stdin: "piped",
      stdout: "null",
      stderr: "null",
    }).spawn();
    this.#play = p;
    this.#writer = p.stdin.getWriter();
    p.status.then((s) => {
      if (this.#play === p && !this.#stopping) {
        this.#play = undefined;
        this.#writer = undefined;
        this.#on.died("pw-play", s.code);
      }
    });
  }

  #startRecord() {
    const p = new Deno.Command("pw-record", {
      args: ["--rate", String(MIC_RATE), "--channels", "1", "--format", "s16", "--raw", "-"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    this.#record = p;
    p.status.then((s) => {
      if (!this.#stopping) this.#on.died("pw-record", s.code);
    });
    this.#pump(p.stdout).catch(() => {});
  }

  async #pump(stdout: ReadableStream<Uint8Array>) {
    let carry = new Uint8Array(0);
    let started: number | undefined;
    let received = 0;
    // the window's accumulators
    let sumSq = 0, peak = 0, samples = 0, windowStart = 0, zeros = true, voice = false;
    let floor = -60;
    for await (const piece of stdout) {
      let buf = carry.length ? concat(carry, piece) : piece;
      while (buf.length >= CHUNK_BYTES) {
        const chunk = buf.slice(0, CHUNK_BYTES);
        buf = buf.subarray(CHUNK_BYTES);
        const now = performance.now();
        started ??= now;
        this.#lastChunk = now;
        received += chunk.length;
        const s = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
        let chunkSq = 0;
        for (let i = 0; i < s.length; i++) {
          const v = s[i];
          chunkSq += v * v;
          const a = Math.abs(v);
          if (a > peak) peak = a;
        }
        sumSq += chunkSq;
        samples += s.length;
        if (chunkSq) zeros = false;
        const level = dbfs(Math.sqrt(chunkSq / s.length) / 32768);
        const isVoice = level > floor + VOICE_OVER_FLOOR_DB && level > VOICE_MIN_DB;
        this.#micLast = level;
        if (level > this.#micMax) this.#micMax = level;
        if (isVoice) this.#micVoice = voice = true;
        this.#on.chunk(chunk);
        if (now - windowStart >= WINDOW_MS) {
          windowStart = now;
          const level = dbfs(Math.sqrt(sumSq / Math.max(1, samples)) / 32768);
          // exact zeros are a muted source or a Bluetooth profile switch (measured), not a floor
          if (!zeros) floor = Math.min(floor + 0.25, level); // rises slowly, drops at once
          this.#on.window({
            level,
            peak: dbfs(peak / 32768),
            floor,
            voice,
            zeros,
            speaker: this.playing ? this.#speakerAt(now) : undefined,
            behind: (now - started) - received / 2 / MIC_RATE * 1000,
          });
          sumSq = 0;
          peak = 0;
          samples = 0;
          zeros = true;
          voice = false;
        }
      }
      carry = buf.slice();
    }
  }
}

function dbfs(x: number) {
  return x <= 0 ? -100 : Math.max(-100, 20 * Math.log10(x));
}

function rmsDb(s: Int16Array) {
  let sq = 0;
  for (let i = 0; i < s.length; i++) sq += s[i] * s[i];
  return dbfs(Math.sqrt(sq / Math.max(1, s.length)) / 32768);
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// ── the mixer ───────────────────────────────────────────────────────────────

/** A default device as the mixer has it. */
export interface Device {
  name: string;
  description: string;
  /** 1 is 100 %. */
  volume: number;
  muted: boolean;
}

export interface Mixer {
  source: Device;
  sink: Device;
}

async function run(cmd: string, ...args: string[]) {
  const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "null" }).output();
  return new TextDecoder().decode(out.stdout).trim();
}

const descriptions = new Map<string, string>();

async function describe(kind: "sources" | "sinks", name: string) {
  if (!descriptions.has(name)) {
    try {
      const list = JSON.parse(await run("pactl", "--format=json", "list", kind)) as {
        name: string;
        description: string;
      }[];
      for (const x of list) descriptions.set(x.name, x.description);
    } catch { /* no description */ }
  }
  return descriptions.get(name) ?? "";
}

async function device(kind: "sources" | "sinks"): Promise<Device> {
  const source = kind === "sources";
  const [name, vol] = await Promise.all([
    run("pactl", source ? "get-default-source" : "get-default-sink"),
    run("wpctl", "get-volume", source ? "@DEFAULT_AUDIO_SOURCE@" : "@DEFAULT_AUDIO_SINK@"),
  ]);
  // "Volume: 0.59" or "Volume: 0.59 [MUTED]"
  const volume = Number(vol.match(/Volume: ([\d.]+)/)?.[1] ?? NaN);
  return { name, description: await describe(kind, name), volume, muted: vol.includes("[MUTED]") };
}

/** The default mic and speakers, their volume and mute, as PipeWire has them now. */
export async function mixer(): Promise<Mixer> {
  const [source, sink] = await Promise.all([device("sources"), device("sinks")]);
  return { source, sink };
}

/** Clear the default mic's and speakers' mute. Returns which of them were muted. */
export async function unmute(): Promise<("mic" | "speakers")[]> {
  const m = await mixer();
  const was: ("mic" | "speakers")[] = [];
  if (m.source.muted) was.push("mic");
  if (m.sink.muted) was.push("speakers");
  await Promise.all([
    m.source.muted && run("wpctl", "set-mute", "@DEFAULT_AUDIO_SOURCE@", "0"),
    m.sink.muted && run("wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "0"),
  ]);
  return was;
}

/** Call `changed` with the mixer after every change to a device or the defaults. */
export function watchMixer(changed: (m: Mixer) => void): { stop(): void } {
  const p = new Deno.Command("pactl", { args: ["subscribe"], stdout: "piped", stderr: "null" })
    .spawn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  const check = async () => {
    const m = await mixer();
    const key = JSON.stringify(m);
    if (key !== last) {
      last = key;
      changed(m);
    }
  };
  (async () => {
    const lines = p.stdout.pipeThrough(new TextDecoderStream());
    for await (const text of lines) {
      // "Event 'change' on source #57": a burst while a slider moves, one check after it
      if (!/on (source|sink|server|card)\b/.test(text)) continue;
      clearTimeout(timer);
      timer = setTimeout(() => void check().catch(() => {}), 150);
    }
  })().catch(() => {});
  void check().catch(() => {});
  return {
    stop() {
      clearTimeout(timer);
      try {
        p.kill("SIGTERM");
      } catch { /* gone */ }
    },
  };
}
