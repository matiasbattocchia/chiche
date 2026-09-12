/**
 * main.ts — two agents, one microphone.
 *
 * Talk into the microphone and hear the reply, while both sides of the conversation are
 * transcribed live to the terminal. That is agent 1, the voice; by default agent 2 is
 * raised beside it: mu, the builder. They never hear each other verbatim. Agent 1
 * decides what to ask for and says it in its own words through the `input` tool; mu's work
 * comes back and agent 1 decides what of it is worth saying out loud. Nothing is dictated
 * and nothing is read aloud — the point of the arrangement is the interpretation at both
 * ends. The channel between them is one tool and two kinds of injection:
 *
 *   input(text)         fire and forget: the tool is answered on the spot with a canned
 *                       ack, and the send happens in the background. Async function
 *                       calling is not supported on this model — the docs are explicit —
 *                       so the call must never be left hanging; and inputs and outputs
 *                       don't pair 1:1 anyway (lines sent while mu is busy steer it; one
 *                       instruction can yield many messages), so nothing of mu's — not
 *                       even a delivery failure — comes back as the tool result. All of
 *                       it enters agent 1's context directly, out of band.
 *
 *   activity            `sendClientContent` with turnComplete:false — context accrues and
 *                       NOTHING is generated. Agent 1 learns mu is compiling, and stays
 *                       quiet about it until asked ("¿por qué tarda?" — "seguí esperando").
 *
 *   final / error       the same, with turnComplete:true, which is what makes it speak.
 *
 * Injected turns carry the `user` role because it is the only role available: `model`
 * would be forging agent 1's own voice, and there is no mid-session `system` turn. The
 * `[mu]` envelope and the system instruction are what keep the harness distinct from the
 * human inside that one role.
 *
 *   --no-mu     agent 1 alone, with no tools at all: a plain spoken assistant, which
 *               doubles as the test bench for the audio half
 *   --ptt       push to talk: space gates the microphone. The stream never stops — while
 *               the key is up the server hears silence, so its own activity detection
 *               still finds the turn boundaries and still transcribes as you speak. What
 *               the key buys is a quiet room: the model never hears its own reply or
 *               your keyboard, and barge-in is a deliberate press.
 *
 * There is no echo cancellation: wear headphones, or the model hears itself.
 */
// The import map points at the SDK's *web* build (`@google/genai/web`), which uses the
// platform's native WebSocket. The default Node build goes through the npm `ws` package on
// Deno's Node TLS shim, and tearing that socket down on quit panics Deno 2.7.14.
import {
  GoogleGenAI,
  type LiveServerMessage,
  Modality,
  type Session,
  ThinkingLevel,
  Type,
} from "@google/genai";
import { holdSupported, readKeys, restoreKeyboard } from "./keys.ts";
import type { Mu, MuUpdate } from "./mu.ts";
import { createConversation } from "./conversation.ts";
import { mkdir, rm } from "node:fs/promises";
import { openMetrics } from "./metrics.ts";
import { dim, onSignals, out, preflight, startAudio, transcript } from "./shell.ts";

const MODEL = "gemini-3.1-flash-live-preview";
const VOICE = "Kore";
const LANGUAGE = "es-AR";
const ARGS = process.argv.slice(2);
const MU = !ARGS.includes("--no-mu");
const PTT = ARGS.includes("--ptt");

/**
 * Silence the server's VAD waits for before committing the end of your turn. The
 * default is close to 2 s. With an open mic this sits above a natural mid-sentence
 * pause and leaves the reply's first word around 1.5 s after you stop, generation
 * included. Under --ptt the key release is the end of the turn and what follows is
 * digital silence, so the window only has to be long enough for the server to notice.
 */
const VAD_SILENCE_MS = PTT ? 200 : 700;

/**
 * Agent 1's system instruction, read from INSTRUCTIONS.md beside the source at startup.
 * Blank (or missing) means the session runs with no system instruction at all — the same
 * file whether or not mu is beside it.
 */
const INSTRUCTION = (await Bun.file(new URL("INSTRUCTIONS.md", import.meta.url)).text().catch(() => "")).trim();


/**
 * Print voice-activity markers, derived from the turn signals the server sends
 * (`explicitVadSignal` only exists on Vertex). Under --ptt the key presses print too.
 */
const SHOW_VAD_EVENTS = true;

const KEY_SPACE = 32;
const KEY_M = 109;
const KEY_Q = 113;
const KEY_C = 99;

const t = transcript({ user: "vos  › ", model: "voz › " });
const { transcribe } = t;
/** Status lines also go to the metrics log, so connects and reconnects sit on the timeline. */
function status(text: string) {
  metrics.event(`· ${text}`);
  t.status(text);
}

function vadEvent(text: string) {
  if (SHOW_VAD_EVENTS) t.vadEvent(text);
}

// --- Session state ---

let session: Session | null = null;
let running = true;
let muted = false;
/** Push-to-talk only: whether the key is currently held (or toggled on). */
let talking = false;
/** Push-to-talk only: what the server hears while the key is up — one silent frame. */
const SILENCE = new Uint8Array(1280);

/**
 * With mu along, each agent has ONE conversation, the way mu's log gives agent 2 one: the
 * resumption handle is persisted and reloaded, so a restart resumes rather than starting
 * over — and a tool response outliving its socket still lands in the same logical session.
 * Solo runs stay ephemeral.
 */
const HANDLE_FILE = "data/relay/handle";
/** Rewritten every run: the mic timeline against the server's events. */
const METRICS_FILE = "data/audio.log";
const metrics = openMetrics(METRICS_FILE);
let resumptionHandle: string | undefined;
if (MU) {
  try {
    resumptionHandle = (await Bun.file(HANDLE_FILE).text()).trim() || undefined;
  } catch { /* first run */ }
}

function saveHandle(handle: string) {
  resumptionHandle = handle;
  if (!MU) return;
  mkdir("data/relay", { recursive: true })
    .then(() => Bun.write(HANDLE_FILE, handle))
    .catch(() => {});
}

async function dropHandle(reason: string) {
  status(`${reason} — empiezo una conversación nueva`);
  resumptionHandle = undefined;
  await rm(HANDLE_FILE, { force: true }).catch(() => {});
}

let mu: Mu | null = null;

/** Updates that arrived while the socket was down, replayed on reconnect. */
const backlog: MuUpdate[] = [];

// --- The channel to mu ---

/**
 * Hands one update to agent 1.
 *
 * `turnComplete` is the whole distinction between an event and a message: false accrues
 * context in silence, true asks for a reply. Activity is therefore free — it costs tokens,
 * not speech.
 */
function inject(update: MuUpdate) {
  if (!session) {
    backlog.push(update);
    return;
  }
  const text = update.kind === "activity"
    ? `[mu] trabajando — ${update.text}`
    : update.kind === "error"
    ? `[mu] falló: ${update.text}`
    : `[mu] respondió: ${update.text}`;
  session.sendClientContent({
    turns: [{ role: "user", parts: [{ text }] }],
    turnComplete: update.kind !== "activity",
  });
}

/**
 * One `input` call: ack the tool on the spot, fire the send, walk away.
 *
 * The tool response is protocol, not information — this model has no async function
 * calling, so an unanswered call stalls the session, and inputs and outputs don't pair
 * 1:1 anyway (follow-up lines steer a busy mu; one instruction can yield many messages).
 * Everything real, delivery failure included, travels the injection channel.
 */
function relayInput(text: string): Record<string, unknown> {
  if (!mu) return { error: "mu no está conectado" };
  if (!text) return { error: "faltó el texto de la instrucción" };
  mu.send(text).then(
    (r) => {
      if (!r.ok) {
        inject({ kind: "error", text: `la puerta rechazó la instrucción: ${r.error ?? "sin motivo"}` });
      }
    },
    (e) => {
      inject({
        kind: "error",
        text: `no pude entregarle la instrucción a mu: ${e instanceof Error ? e.message : e}`,
      });
    },
  );
  return { output: "enviado a mu" };
}

// --- Server messages ---

const conv = createConversation({
  speaker: {
    write: (audio) => rig.speaker.write(audio),
    interrupt: () => rig.speaker.interrupt(),
  },
  transcribe,
  status,
  vadEvent,
  metrics,
  decodeBase64: (data) => Uint8Array.from(Buffer.from(data, "base64")),
  sendToolResponse(id, name, response) {
    session?.sendToolResponse({ functionResponses: [{ id, name, response }] });
  },
  relayInput,
  saveHandle,
  closeSession: () => session?.close(),
});


// --- Push to talk ---

/**
 * Opens or closes the microphone gate. The server is not told: it keeps receiving audio
 * either way — the room, or silence — and its activity detection ends the turn on its
 * own, VAD_SILENCE_MS after the key goes up.
 */
function setTalking(on: boolean) {
  if (!PTT || on === talking) return;
  if (on) {
    talking = true;
    rig.speaker.interrupt(); // talking over the model is a barge-in
    metrics.event("ptt mic abierto");
    vadEvent("mic abierto");
  } else {
    // Flush the buffered tail while `talking` still lets it through the gate.
    rig.mic.flush();
    talking = false;
    metrics.event("ptt mic cerrado");
    vadEvent("mic cerrado");
  }
}

// --- Connection ---

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("falta GEMINI_API_KEY (mise lo carga desde .env).");
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey });

function connect(): Promise<{ session: Session; closed: Promise<void> }> {
  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  return ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      // A bare string here breaks the session silently on the web build:
      // setup completes but the server never answers anything after it.
      ...(INSTRUCTION ? { systemInstruction: { parts: [{ text: INSTRUCTION }] } } : {}),
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
        // The input transcription guesses a language per utterance and drifts; the
        // model itself listens to the audio, so a wrong guess is cosmetic — this hint
        // is the one lever the API offers to steady it.
        languageCode: LANGUAGE,
      },
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Without compression the session dies after 15 minutes of audio.
      contextWindowCompression: { slidingWindow: {} },
      // Lets us carry context across the server's periodic WebSocket resets.
      sessionResumption: { handle: resumptionHandle },
      ...(MU
        ? {
          tools: [{
            functionDeclarations: [{
              name: "input",
              description:
                "Le manda una instrucción a mu, el agente que construye. Devuelve enseguida y " +
                "su resultado no dice nada de mu: lo que mu haga llega después, por su cuenta. " +
                "Si mu está ocupado, más llamadas a input lo van guiando.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  text: {
                    type: Type.STRING,
                    description: "La instrucción, escrita por vos, no la frase del usuario.",
                  },
                },
                required: ["text"],
              },
            }],
          }],
        }
        : {}),
      realtimeInputConfig: {
        automaticActivityDetection: { silenceDurationMs: VAD_SILENCE_MS },
      },
    },
    callbacks: {
      onmessage: conv.handleMessage,
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
    metrics.event(muted ? "tecla mute" : "tecla unmute");
    status(muted ? "micrófono en silencio" : "micrófono abierto");
  } else if (event.code === KEY_SPACE) {
    rig.speaker.interrupt();
    status("reproducción cortada");
  }
}

// --- Teardown ---

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  mu?.close(); // detaching is what ends mu: its daemon reaps itself a linger later
  await rig.stop();
  out(dim(`· ${metrics.close()}
`));
  restoreKeyboard();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

// --- Startup ---

await preflight(status);
status(`métricas → ${METRICS_FILE} · grabación → data/mic.wav, data/voz.wav`);
const rig = startAudio((mic) => {
  // Under --ptt the gate swaps the room for silence but the stream goes on: the server's
  // activity detection needs to hear the quiet to close your turn.
  const gated = PTT && !talking;
  const chunk = gated ? SILENCE.subarray(0, mic.length) : mic;
  const sent = session !== null && !muted;
  metrics.frame(chunk, sent, rig.speaker.playing);
  if (!sent) return;
  session!.sendRealtimeInput({
    audio: { data: Buffer.from(chunk).toString("base64"), mimeType: "audio/pcm;rate=16000" },
  });
  conv.micChunkSent(chunk);
});

onSignals(cleanup);

out(dim(`Live API · ${MODEL}${MU ? " + mu" : ""}\n`));

// Raising mu's daemon can take a moment; the voice comes up regardless, so it can explain
// the failure out loud instead of the terminal explaining it to nobody.
if (MU) {
  try {
    // Loaded only when wanted: mu's client pulls in the mu project's own graph.
    const { connectMu } = await import("./mu.ts");
    mu = await connectMu(inject);
    status(`mu conectado · agente ${mu.agent}`);
    // On an unasked-for hangup the handle is dead weight: dropping it makes `input`
    // answer "mu no está conectado" honestly instead of acking sends that go nowhere.
    // (mu.ts already injects the hangup itself, so the voice can say what happened.)
    mu.hangup.then(() => {
      mu = null;
    });
  } catch (e) {
    status(`mu no respondió: ${e instanceof Error ? e.message : e}`);
  }
}

const keys = readKeys(onKey, { wantHold: PTT }).then(() => {
  running = false;
});

// The kitty handshake needs a moment to settle before we can describe the keys.
setTimeout(() => {
  out(dim(
    PTT
      ? holdSupported()
        ? "hablá manteniendo espacio · q: salir\n"
        : "espacio abre y cierra el micrófono (la terminal no reporta el soltado) · q: salir\n"
      : "m: silenciar · espacio: interrumpir · q: salir\n",
  ));
  out(dim("Sin cancelación de eco: usá auriculares, o el modelo se escucha a sí mismo.\n"));
}, 300);

while (running) {
  let closed: Promise<void>;
  try {
    ({ session, closed } = await connect());
  } catch (e) {
    // A handle the server no longer honors must not wedge the loop: retry fresh once.
    if (resumptionHandle) {
      await dropHandle("no pude retomar la conversación guardada");
      continue;
    }
    status(`no pude conectar: ${e instanceof Error ? e.message : e}`);
    break;
  }
  status(resumptionHandle ? "conversación retomada" : "conectado — hablá");
  while (backlog.length > 0) inject(backlog.shift()!);
  conv.connectionOpened();
  await Promise.race([closed, keys]);
  session?.close();
  session = null;
  rig.speaker.interrupt();
  // A resume the server accepts at the socket but hangs up on without a word is the
  // other face of a stale handle; keeping it would reconnect into the same hangup.
  if (running && resumptionHandle && !conv.gotMessage) {
    await dropHandle("la conversación guardada ya no sirve");
  }
}

await cleanup();
out("\n" + dim("listo.\n"));
process.exit(0);
