/**
 * shell.ts — the app's terminal shell, kept apart from the conversation logic.
 *
 * The ANSI helpers, the transcript state machine, signal handling, and the audio rig
 * (speaker + mic) with its teardown order.
 *
 * There is no echo cancellation: the app expects headphones. PipeWire's echo-cancel
 * module was tried and dropped — it lives inside the graph and inherits its quantum,
 * driver pairing and realtime budget, which took a week without a reliable result. An
 * in-process canceller fed our own playback as the far-end reference is the next step,
 * when it comes.
 */

import { type Mic, Speaker, startMic } from "./audio.ts";

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const italic = (s: string) => `\x1b[3m${s}\x1b[0m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

export const out = (s: string) => { process.stdout.write(s); };

// --- Transcript ---

export interface Transcript {
  /** One voice's next piece of text; breaks the line whenever the voice flips. */
  transcribe(voice: "user" | "model", text: string): void;
  /** One dimmed `· line` of the harness's own. */
  status(text: string): void;
  /** One dimmed `[marker]` line. */
  vadEvent(text: string): void;
}

/** The interleaved transcript. Labels are the full prefixes, e.g. `"you  › "`. */
export function transcript(labels: { user: string; model: string }): Transcript {
  let lastVoice: "user" | "model" | "status" | null = null;
  return {
    transcribe(voice, text) {
      if (voice !== lastVoice) {
        if (lastVoice !== null) out("\n");
        out(voice === "user" ? dim(labels.user) : cyan(labels.model));
        lastVoice = voice;
      }
      out(voice === "user" ? italic(dim(text)) : text);
    },
    status(text) {
      if (lastVoice !== null) out("\n");
      out(dim(`· ${text}\n`));
      lastVoice = "status";
    },
    vadEvent(text) {
      if (lastVoice !== null) out("\n");
      out(dim(`  [${text}]\n`));
      lastVoice = "status";
    },
  };
}

// --- Preflight ---

async function pactl(args: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(["pactl", ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

interface PactlEndpoint {
  name: string;
  mute?: boolean;
  volume?: Record<string, { value_percent?: string }>;
}

/** `"<node name> · 100%"`, flagging mutes and (for the mic) low volume. */
async function describeDefault(kind: "source" | "sink"): Promise<string | null> {
  const def = await pactl([`get-default-${kind}`]);
  if (!def) return null;
  const list = await pactl(["-f", "json", "list", `${kind}s`]);
  let node: PactlEndpoint | undefined;
  try {
    node = (JSON.parse(list ?? "") as PactlEndpoint[]).find((n) => n.name === def);
  } catch { /* fall through to the bare name */ }
  if (!node) return def;
  const percents = Object.values(node.volume ?? {})
    .map((v) => parseInt(v.value_percent ?? "", 10))
    .filter((p) => !isNaN(p));
  const pct = percents.length ? Math.max(...percents) : null;
  let line = `${def} · ${pct === null ? "¿?" : `${pct}%`}`;
  if (node.mute) line += " · ¡SILENCIADO!";
  else if (kind === "source" && pct !== null && pct < 75) line += " · ¡volumen bajo!";
  return line;
}

/**
 * Reports the default source and sink — the endpoints the audio path binds to —
 * with their volumes. WirePlumber
 * restores per-node volume and mute from saved state, so a quiet or muted
 * endpoint can predate the run and go unnoticed.
 */
export async function preflight(status: (text: string) => void): Promise<void> {
  const [source, sink] = await Promise.all([
    describeDefault("source"),
    describeDefault("sink"),
  ]);
  if (source) status(`mic: ${source}`);
  if (sink) status(`salida: ${sink}`);
}

/** Toggles the default source's mute; the new state, or null when pactl failed. */
export async function toggleSourceMute(): Promise<boolean | null> {
  if ((await pactl(["set-source-mute", "@DEFAULT_SOURCE@", "toggle"])) === null) return null;
  const state = await pactl(["get-source-mute", "@DEFAULT_SOURCE@"]);
  return state === null ? null : /yes/.test(state);
}

// --- Signals ---

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;

/**
 * Runs `cleanup` and exits 128+signum on the signals raw mode doesn't turn into keys —
 * an external kill still has to stop the capture and playback processes and restore
 * the terminal.
 */
export function onSignals(cleanup: () => Promise<void>) {
  for (const [signal, num] of Object.entries(SIGNALS)) {
    process.on(signal, async () => {
      await cleanup();
      process.exit(128 + num);
    });
  }
}

// --- Audio rig ---

export interface AudioRig {
  speaker: Speaker;
  mic: Mic;
  /** Capture first, then playback. */
  stop(): Promise<void>;
}

/** Raises the speaker and mic against the default devices. */
export function startAudio(onChunk: (chunk: Uint8Array) => void): AudioRig {
  const speaker = new Speaker();
  const mic = startMic(onChunk);
  return {
    speaker,
    mic,
    async stop() {
      await mic.stop();
      speaker.close();
    },
  };
}
