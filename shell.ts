/**
 * shell.ts — the app's terminal shell, kept apart from the conversation logic.
 *
 * The ANSI helpers, the transcript state machine, signal handling, and the audio rig
 * (AEC → speaker + mic) with its one valid teardown order.
 */

import { type Aec, loadAec } from "./aec.ts";
import { type Mic, Speaker, startMic } from "./audio.ts";

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const italic = (s: string) => `\x1b[3m${s}\x1b[0m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const encoder = new TextEncoder();
export const out = (s: string) => Deno.stdout.writeSync(encoder.encode(s));

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
    const { success, stdout } = await new Deno.Command("pactl", {
      args,
      stdout: "piped",
      stderr: "null",
    }).output();
    return success ? new TextDecoder().decode(stdout).trim() : null;
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
 * Reports the default source and sink — the endpoints the whole audio path
 * (echo-cancel included) will bind to — with their volumes. WirePlumber
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

// --- Signals ---

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;

/**
 * Runs `cleanup` and exits 128+signum on the signals raw mode doesn't turn into keys —
 * an external kill still has to unload the PipeWire module rather than leak it.
 */
export function onSignals(cleanup: () => Promise<void>) {
  for (const [signal, num] of Object.entries(SIGNALS)) {
    Deno.addSignalListener(signal as keyof typeof SIGNALS, async () => {
      await cleanup();
      Deno.exit(128 + num);
    });
  }
}

// --- Audio rig ---

export interface AudioRig {
  speaker: Speaker;
  mic: Mic;
  /** Null when declined or unavailable; the caller words its own warning. */
  aec: Aec | null;
  /** Capture, playback, then the AEC module — the only order that works. */
  stop(): Promise<void>;
}

/** Loads AEC (when wanted), then raises the speaker and mic against its nodes. */
export async function startAudio(
  wantAec: boolean,
  onChunk: (chunk: Uint8Array) => void,
  onAecError: (error: string) => void,
): Promise<AudioRig> {
  let aec: Aec | null = null;
  if (wantAec) {
    const result = await loadAec();
    if ("error" in result) onAecError(result.error);
    else {
      aec = result;
      // The module's own death is silent otherwise: pw-record just reattaches to
      // the raw mic, and the model starts hearing itself.
      aec.died.then(onAecError);
    }
  }
  const speaker = new Speaker({ target: aec?.sink });
  const mic = startMic(onChunk, { target: aec?.source });
  return {
    speaker,
    mic,
    aec,
    async stop() {
      await mic.stop();
      speaker.close();
      await aec?.unload();
    },
  };
}
