// log.ts — the per-run timeline and recordings. One folder per run under log/, the last
// 10 kept: timeline.log (one clock for everything), mic.wav (16 kHz, as sent) and voz.wav
// (24 kHz, as received), both aligned to that clock so a moment in the timeline is the
// same moment in either recording.

import { join } from "@std/path";

const KEEP = 10;
const MIC_RATE = 16000;
const VOICE_RATE = 24000;

/** A 250 ms window of the mic, as audio.ts measures it. */
export interface MicWindow {
  /** RMS level and peak, dBFS. */
  level: number;
  peak: number;
  /** The running noise floor, dBFS. */
  floor: number;
  /** A chunk in it read as voice. */
  voice: boolean;
  /** Exact zeros throughout: a muted source, or a Bluetooth profile switch. */
  zeros: boolean;
  /** What the speakers were playing at its end, dBFS, if anything. */
  speaker?: number;
  /** How far behind real time the capture is, ms (bytes received vs the clock). */
  behind: number;
}

/** A WAV file written as the audio comes: the header is patched with the sizes at close. */
class Wav {
  #file: Deno.FsFile;
  #bytes = 0;
  #rate: number;

  constructor(file: Deno.FsFile, rate: number) {
    this.#file = file;
    this.#rate = rate;
    this.#file.writeSync(header(rate, 0));
  }

  /** Seconds of audio written so far. */
  get seconds() {
    return this.#bytes / 2 / this.#rate;
  }

  write(pcm: Uint8Array) {
    let at = 0;
    while (at < pcm.length) at += this.#file.writeSync(pcm.subarray(at));
    this.#bytes += pcm.length;
  }

  /** Pad with silence up to `seconds` on the clock. */
  padTo(seconds: number) {
    const missing = Math.floor((seconds - this.seconds) * this.#rate) * 2;
    if (missing > 0) this.write(new Uint8Array(missing));
  }

  close() {
    this.#file.seekSync(0, Deno.SeekMode.Start);
    this.#file.writeSync(header(this.#rate, this.#bytes));
    this.#file.close();
  }
}

function header(rate: number, dataBytes: number) {
  const b = new ArrayBuffer(44);
  const v = new DataView(b);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(b);
}

export class Log {
  readonly dir: string;
  #t0 = performance.now();
  #timeline: Deno.FsFile;
  #mic: Wav;
  #voice: Wav;
  #closed = false;

  private constructor(dir: string, timeline: Deno.FsFile, mic: Wav, voice: Wav) {
    this.dir = dir;
    this.#timeline = timeline;
    this.#mic = mic;
    this.#voice = voice;
  }

  static async open(root: string): Promise<Log> {
    const base = join(root, "log");
    await Deno.mkdir(base, { recursive: true });
    const runs: string[] = [];
    for await (const e of Deno.readDir(base)) if (e.isDirectory) runs.push(e.name);
    for (const old of runs.sort().slice(0, Math.max(0, runs.length - (KEEP - 1)))) {
      await Deno.remove(join(base, old), { recursive: true }).catch(() => {});
    }
    const dir = join(base, new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
    await Deno.mkdir(dir, { recursive: true });
    const open = (name: string) =>
      Deno.openSync(join(dir, name), { write: true, create: true, truncate: true });
    return new Log(
      dir,
      open("timeline.log"),
      new Wav(open("mic.wav"), MIC_RATE),
      new Wav(open("voz.wav"), VOICE_RATE),
    );
  }

  /** Seconds since the run started: the one clock. */
  get now() {
    return (performance.now() - this.#t0) / 1000;
  }

  /** One line on the timeline, stamped with the clock. */
  line(tag: string, text: string) {
    if (this.#closed) return;
    const stamp = this.now.toFixed(3).padStart(9);
    this.#timeline.writeSync(new TextEncoder().encode(`${stamp} ${tag.padEnd(6)} ${text}\n`));
  }

  /** A message to or from Gemini. Audio payloads are replaced by their size. */
  gemini(direction: "send" | "recv", message: unknown) {
    this.line(`gem:${direction === "send" ? "→" : "←"}`, JSON.stringify(message, trimAudio));
  }

  /** A line to or from liquen's door. */
  door(direction: "send" | "recv", message: unknown) {
    this.line(`door:${direction === "send" ? "→" : "←"}`, JSON.stringify(message));
  }

  mic(w: MicWindow) {
    const flags = [
      w.zeros && "zeros",
      w.voice && "voice",
      w.speaker !== undefined && `speaker ${w.speaker.toFixed(1)}`,
      w.behind > 100 && `behind ${Math.round(w.behind)}ms`,
    ].filter(Boolean).join(" ");
    this.line(
      "mic",
      `${w.level.toFixed(1)} dBFS peak ${w.peak.toFixed(1)} floor ${w.floor.toFixed(1)} ${flags}`,
    );
  }

  /** Mic audio as sent (zeros while the mic is closed), on the clock. */
  micAudio(pcm: Uint8Array) {
    if (this.#closed) return;
    // capture is continuous, so the clock only pads a real gap (a stalled pw-record)
    if (this.now - this.#mic.seconds > 0.5) this.#mic.padTo(this.now);
    this.#mic.write(pcm);
  }

  /** The voice as received, placed at the moment it arrived. */
  voiceAudio(pcm: Uint8Array) {
    if (this.#closed) return;
    this.#voice.padTo(this.now);
    this.#voice.write(pcm);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#timeline.close();
    this.#mic.close();
    this.#voice.close();
  }
}

/** JSON.stringify replacer: base64 audio becomes its byte count. */
function trimAudio(key: string, value: unknown) {
  if (key === "data" && typeof value === "string" && value.length > 256) {
    return `<${Math.round(value.length * 3 / 4)} bytes>`;
  }
  return value;
}
