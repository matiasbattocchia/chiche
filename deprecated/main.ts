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
 *                       ack, and the send happens in the background. The tool is declared
 *                       BLOCKING on purpose — gemini-3.8-live defaults to async function
 *                       calling, whose one response per call is the wrong shape here:
 *                       inputs and outputs don't pair 1:1 (lines sent while mu is busy
 *                       steer it; one instruction can yield many messages), so nothing of
 *                       mu's — not even a delivery failure — comes back as the tool
 *                       result. All of it enters agent 1's context directly, out of band.
 *
 *   activity            `sendClientContent` with turnComplete:false — context accrues and
 *                       NOTHING is generated. Agent 1 learns mu is compiling, and stays
 *                       quiet about it until asked ("¿por qué tarda?" — "seguí esperando").
 *                       Stamped with seconds since the work began, since agent 1 has no
 *                       clock and cannot otherwise tell a fresh build from a stuck one.
 *
 *   final / error       the same, with turnComplete:true — which is what makes it speak —
 *                       but only onto a free floor: held while the model speaks, accrued
 *                       while the user does. See `flushNews`.
 *
 * Injected turns carry the `user` role because it is the only role available: `model`
 * would be forging agent 1's own voice, and there is no mid-session `system` turn. The
 * `[mu]` envelope and the system instruction are what keep the harness distinct from the
 * human inside that one role.
 *
 *   --no-mu     agent 1 alone, with no tools at all: a plain spoken assistant, which
 *               doubles as the test bench for the audio half
 *   --ptt       you gate the microphone yourself, with the keyboard's mic-mute key.
 *               This app does nothing for it: a muted PipeWire source hands `pw-record`
 *               exact zeros without interrupting the stream, so the server goes on
 *               receiving audio, hears silence, and closes your turn on its own. The
 *               flag only shortens the silence window it waits for, because a key
 *               release is a sharper end of turn than a pause for breath.
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
  Behavior,
  Type,
} from "@google/genai";
import { readKeys, restoreKeyboard } from "./keys.ts";
import type { Mu, MuUpdate } from "./mu.ts";
import { createConversation } from "./conversation.ts";
import { mkdir, rm } from "node:fs/promises";
import { openMetrics } from "./metrics.ts";
import { dim, onSignals, out, preflight, startAudio, toggleSourceMute, transcript } from "./shell.ts";

const MODEL = "gemini-3.8-live";
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
 * When the current stretch of mu's work began: the `input` call that started it, or the
 * first activity line if mu was steered from its own REPL instead. Cleared by whatever
 * ends the stretch. Agent 1 has no clock of its own, so without this it cannot tell a
 * build that just started from one that has been stuck for two minutes.
 */
let muSince: number | null = null;

/** mu's answers and failures waiting for the model to finish speaking. */
const news: string[] = [];

/**
 * Hands one update to agent 1.
 *
 * `turnComplete` is the whole distinction between an event and a message: false accrues
 * context in silence, true asks for a reply. Activity is always false — it costs tokens,
 * not speech — and goes out at once. News waits for the floor: see `flushNews`.
 */
function inject(update: MuUpdate) {
  if (!session) {
    backlog.push(update);
    return;
  }
  if (update.kind !== "activity") {
    muSince = null;
    news.push(update.kind === "error" ? `[mu] falló: ${update.text}` : `[mu] respondió: ${update.text}`);
    flushNews();
    return;
  }
  muSince ??= performance.now();
  const elapsed = ((performance.now() - muSince) / 1000).toFixed(0);
  session.sendClientContent({
    turns: [{ role: "user", parts: [{ text: `[mu] trabajando (${elapsed}s) — ${update.text}` }] }],
    turnComplete: false,
  });
}

/**
 * Sends held news, if the floor allows it; called on every change of who is talking.
 *
 * `turnComplete:true` "unconditionally interrupts active model generation" (the 3.8 docs),
 * so while the model speaks, news is held back entirely and goes out when its turn
 * completes. While the user speaks, it goes out with turnComplete:false: asking for a
 * reply over them would have VAD cancel and discard it at their next word, whereas
 * accrued it is simply there when their turn closes, and the one reply covers both.
 */
function flushNews() {
  if (!session || news.length === 0 || conv.modelSpeaking) return;
  session.sendClientContent({
    turns: news.splice(0).map((text) => ({ role: "user", parts: [{ text }] })),
    turnComplete: !conv.userSpeaking,
  });
}

/**
 * One `input` call: ack the tool on the spot, fire the send, walk away.
 *
 * The tool response is protocol, not information — the call is BLOCKING, so an unanswered
 * one stalls the session, and inputs and outputs don't pair 1:1 anyway (follow-up lines
 * steer a busy mu; one instruction can yield many messages).
 * Everything real, delivery failure included, travels the injection channel.
 */
function relayInput(text: string): Record<string, unknown> {
  if (!mu) return { error: "mu no está conectado" };
  if (!text) return { error: "faltó el texto de la instrucción" };
  muSince ??= performance.now();
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
  floorChanged: flushNews,
});


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
      // Only the thinking models take this; gemini-3.8-live hangs the setup, silently,
      // when it is present — its thinking lives in the -extended-thinking variant.
      ...(MODEL.includes("gemini-3.1") || MODEL.includes("thinking")
        ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }
        : {}),
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
              // 3.8 defaults to NON_BLOCKING, where the model talks on and an unscheduled
              // response cuts in on it. Blocking, the model pauses for the instant ack.
              behavior: Behavior.BLOCKING,
              description:
                "Manda trabajo a la construcción: algo para crear, cambiar o arreglar, o una " +
                "decisión que tu cliente acaba de tomar. Devuelve enseguida y su resultado no " +
                "dice nada del trabajo: lo que pase llega después, por su cuenta, al registro. " +
                "Si ya hay algo en curso, más llamadas lo van guiando. No la uses para " +
                "preguntas sobre el avance ni para charla: eso lo contestás vos.",
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

  if (!pressed) return;
  if (event.code === KEY_M) {
    // The same mute the keyboard's mic key does: the source hands pw-record zeros and
    // the capture stream never stops, so the server hears silence and closes the turn.
    metrics.event("tecla mute toggle");
    toggleSourceMute().then((muted) =>
      status(muted === null ? "no pude silenciar el micrófono" : muted ? "micrófono en silencio" : "micrófono abierto")
    );
  } else if (event.code === KEY_SPACE) {
    // Local only: under automatic VAD nothing tells the server to stop. The queue is
    // dropped and the rest of this turn's audio is discarded as it arrives.
    rig.speaker.interrupt();
    conv.discardReply();
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
const rig = startAudio((chunk) => {
  const sent = session !== null;
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

// Nothing needs key releases now that the mic key does the gating, so the kitty
// handshake is not worth asking for.
const keys = readKeys(onKey, { wantHold: false }).then(() => {
  running = false;
});

// The kitty handshake needs a moment to settle before we can describe the keys.
setTimeout(() => {
  out(dim(
    PTT
      ? "silenciá el micrófono con la tecla del teclado · espacio: interrumpir · q: salir\n"
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
  conv.connectionOpened();
  while (backlog.length > 0) inject(backlog.shift()!);
  flushNews();
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
