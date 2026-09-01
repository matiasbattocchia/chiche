/**
 * Audio REPL on top of the Gemini Live API.
 *
 * Talk into the microphone and hear the reply, while both sides of the
 * conversation are transcribed live to the terminal.
 *
 *   --ptt      push to talk: no automatic VAD, you open and close the turn
 *   --no-aec   skip echo cancellation and use the default devices directly
 */
// The import map points at the SDK's *web* build (`@google/genai/web`), which
// uses the platform's native WebSocket. The default Node build goes through the
// npm `ws` package on Deno's Node TLS shim, and tearing that socket down on
// quit panics Deno 2.7.14 (ext/node/ops/tls_wrap.rs, unwrap on None).
import {
  GoogleGenAI,
  Modality,
  ThinkingLevel,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { type Mic, Speaker, startMic } from "./audio.ts";
import { type Aec, loadAec } from "./aec.ts";
import { holdSupported, readKeys, restoreKeyboard } from "./keys.ts";

const MODEL = "gemini-3.1-flash-live-preview";
const VOICE = "Kore";
const SYSTEM_INSTRUCTION =
  "Sos un asistente conversacional por voz. Hablá siempre en español, con un " +
  "tono cercano y natural. Tus respuestas son habladas: mantenelas breves, sin " +
  "listas ni markdown, como en una conversación real. Si no entendés algo, " +
  "preguntá en lugar de suponer.";

const PTT = Deno.args.includes("--ptt");
/** Echo cancellation is on by default: it is what makes speakers usable. */
const AEC = !Deno.args.includes("--no-aec");

/**
 * Print voice-activity markers.
 *
 * `explicitVadSignal` — and the `voiceActivityDetectionSignal` events it would
 * produce — only exists on Vertex / Gemini Enterprise Agent Platform; with a
 * Developer API key the SDK throws outright. Outside push-to-talk these markers
 * are derived from the turn signals the server does send: the first input
 * transcription, `interrupted`, `generationComplete` and `turnComplete`. Under
 * `--ptt` the start and end markers are exact, because we send them ourselves.
 */
const SHOW_VAD_EVENTS = true;

const KEY_SPACE = 32;
const KEY_M = 109;
const KEY_Q = 113;
const KEY_C = 99;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const italic = (s: string) => `\x1b[3m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const encoder = new TextEncoder();
const out = (s: string) => Deno.stdout.writeSync(encoder.encode(s));

// --- Session state ---

let session: Session | null = null;
/** Latest resumption handle; the server resets the connection every ~10 min. */
let resumptionHandle: string | undefined;
let muted = false;
let running = true;
/** Set while the model believes the user's turn is open. */
let userSpeaking = false;
/** Push-to-talk only: whether the key is currently held (or toggled on). */
let talking = false;

// `let` with definite assignment: initialized once at startup, after the AEC
// module load it depends on; a signal handler may read it before then.
// deno-lint-ignore prefer-const
let speaker!: Speaker;
let mic: Mic | null = null;
let aec: Aec | null = null;

// --- Transcript rendering ---

/** Who spoke last, so we can break the line when the turn flips. */
let lastVoice: "user" | "model" | "status" | null = null;

function transcribe(voice: "user" | "model", text: string) {
  if (voice !== lastVoice) {
    if (lastVoice !== null) out("\n");
    out(voice === "user" ? dim("you  › ") : cyan("gemini › "));
    lastVoice = voice;
  }
  out(voice === "user" ? italic(dim(text)) : text);
}

function status(text: string) {
  if (lastVoice !== null) out("\n");
  out(dim(`· ${text}\n`));
  lastVoice = "status";
}

function vadEvent(text: string) {
  if (!SHOW_VAD_EVENTS) return;
  if (lastVoice !== null) out("\n");
  out(dim(`  [${text}]\n`));
  lastVoice = "status";
}

// --- Server messages ---

function handleMessage(message: LiveServerMessage) {
  const resumption = message.sessionResumptionUpdate;
  if (resumption?.resumable && resumption.newHandle) {
    resumptionHandle = resumption.newHandle;
  }

  if (message.goAway) {
    status(`connection closing in ${message.goAway.timeLeft ?? "moments"}, reconnecting…`);
  }

  const content = message.serverContent;
  if (!content) return;

  // On Gemini 3.1 a single event can carry audio and a transcript at once, so
  // every field gets processed rather than stopping at the first hit.
  const interrupted = content.interrupted === true;
  if (interrupted) {
    speaker.interrupt();
    if (!PTT) {
      vadEvent("speech detected · barge-in");
      userSpeaking = true;
    }
  }

  if (!interrupted) {
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) speaker.write(decodeBase64(part.inlineData.data));
    }
  }

  const inputText = content.inputTranscription?.text ??
    content.interimInputTranscription?.text;
  if (inputText) {
    // Under --ptt we already printed an exact start marker on the keypress.
    if (!userSpeaking && !PTT) {
      vadEvent("speech start");
      userSpeaking = true;
    }
    transcribe("user", inputText);
  }

  if (content.outputTranscription?.text) {
    if (userSpeaking && !PTT) {
      vadEvent("speech end");
      userSpeaking = false;
    }
    transcribe("model", content.outputTranscription.text);
  }

  if (content.generationComplete) vadEvent("generation complete");
  if (content.turnComplete) {
    vadEvent("turn complete");
    if (!PTT) userSpeaking = false;
  }
}

// --- Push to talk ---

/**
 * Opens or closes the user's turn.
 *
 * With automatic VAD disabled the server has no idea when we start or stop
 * speaking, so these activity signals are the turn boundaries.
 */
function setTalking(on: boolean) {
  if (!PTT || on === talking || !session) return;
  if (on) {
    talking = true;
    speaker.interrupt(); // talking over the model is a barge-in
    session.sendRealtimeInput({ activityStart: {} });
    vadEvent("activity start");
  } else {
    // Flush the buffered tail while `talking` still lets it through the mic
    // guard, so the last partial frame lands inside the turn.
    mic?.flush();
    talking = false;
    session.sendRealtimeInput({ activityEnd: {} });
    vadEvent("activity end");
  }
}

// --- Connection ---

const apiKey = Deno.env.get("GEMINI_API_KEY");
if (!apiKey) {
  console.error("GEMINI_API_KEY is missing (mise loads it from .env).");
  Deno.exit(1);
}
const ai = new GoogleGenAI({ apiKey });

function connect(): Promise<{ session: Session; closed: Promise<void> }> {
  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  return ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: SYSTEM_INSTRUCTION,
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Without compression the session dies after 15 minutes of audio.
      contextWindowCompression: { slidingWindow: {} },
      // Lets us carry context across the server's periodic WebSocket resets.
      sessionResumption: { handle: resumptionHandle },
      ...(PTT
        ? { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } }
        : {}),
    },
    callbacks: {
      onmessage: handleMessage,
      onerror: (e: ErrorEvent) => status(`error: ${e.message}`),
      onclose: () => resolveClosed(),
    },
  }).then((session) => ({ session, closed }));
}

// --- Keys ---

/** Returns true to quit. */
function onKey(event: { code: number; ctrl: boolean; type: string }): boolean | void {
  if (event.type === "repeat") return;
  const pressed = event.type === "press";

  if (event.code === KEY_C && event.ctrl) return true;
  if (event.code === KEY_Q && pressed) return true;

  if (PTT) {
    if (event.code !== KEY_SPACE) return;
    // With release events we get real hold-to-talk; without them, space toggles.
    if (holdSupported()) setTalking(pressed);
    else if (pressed) setTalking(!talking);
    return;
  }

  if (!pressed) return;
  if (event.code === KEY_M) {
    muted = !muted;
    status(muted ? "mic muted" : "mic live");
  } else if (event.code === KEY_SPACE) {
    speaker.interrupt();
    status("playback stopped");
  }
}

// --- Teardown ---

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  await mic?.stop();
  speaker?.close();
  // Always last: the module can only go once nothing is capturing from it.
  await aec?.unload();
  restoreKeyboard();
  if (Deno.stdin.isTerminal()) Deno.stdin.setRaw(false);
}

// Raw mode means Ctrl+C arrives as a keystroke, not a signal — but an external
// kill still has to unload the PipeWire module rather than leak it.
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;
for (const [signal, num] of Object.entries(SIGNALS)) {
  Deno.addSignalListener(signal as keyof typeof SIGNALS, async () => {
    await cleanup();
    Deno.exit(128 + num);
  });
}

// --- Startup ---

if (AEC) {
  const result = await loadAec();
  if ("error" in result) {
    status(`echo cancellation unavailable: ${result.error}`);
  } else {
    aec = result;
  }
}

speaker = new Speaker({ target: aec?.sink });

mic = startMic((chunk) => {
  if (!session) return;
  if (PTT ? !talking : muted) return;
  session.sendRealtimeInput({
    audio: { data: encodeBase64(chunk), mimeType: "audio/pcm;rate=16000" },
  });
}, { target: aec?.source });

out(
  dim(`Live API · ${MODEL}\n`) +
    dim(
      aec
        ? "echo cancellation: on · noise suppression: webrtc\n"
        : "echo cancellation: off · noise suppression: off\n",
    ),
);

const keys = readKeys(onKey, { wantHold: PTT }).then(() => {
  running = false;
});

// The kitty handshake needs a moment to settle before we can describe the keys.
setTimeout(() => {
  if (PTT) {
    out(dim(
      holdSupported()
        ? "push to talk: hold space · q: quit\n"
        : "push to talk: space toggles (terminal reports no key-release) · q: quit\n",
    ));
  } else {
    out(dim("m: mute · space: interrupt · q: quit\n"));
    if (!aec) {
      out(dim("No echo cancellation: wear headphones, or the model hears itself.\n"));
    }
  }
}, 300);

while (running) {
  let closed: Promise<void>;
  try {
    ({ session, closed } = await connect());
  } catch (e) {
    status(`could not connect: ${e instanceof Error ? e.message : e}`);
    break;
  }
  status(resumptionHandle ? "session resumed" : "connected — start talking");
  // A reconnect mid-turn needs the open turn re-announced.
  if (PTT && talking) session.sendRealtimeInput({ activityStart: {} });
  await Promise.race([closed, keys]);
  session?.close();
  session = null;
  speaker.interrupt();
}

await cleanup();
out("\n" + dim("bye.\n"));
Deno.exit(0);
