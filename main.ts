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
 *   --ptt       push to talk: no automatic VAD, you open and close the turn. The default
 *               is an open mic; --ptt spares the 25 tokens/second an open mic bills for
 *               silence, and narrows the race between your turn and the injected ones.
 *   --no-aec    skip echo cancellation and use the default devices directly
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
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { holdSupported, readKeys, restoreKeyboard } from "./keys.ts";
import { connectMu, type Mu, type MuUpdate } from "./mu.ts";
import { openMetrics } from "./metrics.ts";
import { dim, onSignals, out, preflight, startAudio, transcript } from "./shell.ts";

const MODEL = "gemini-3.1-flash-live-preview";
const VOICE = "Kore";

const SOLO_INSTRUCTION =
  "Sos un asistente conversacional por voz. Hablá siempre en español, con un tono cercano " +
  "y natural. Tus respuestas son habladas: mantenelas breves, sin listas ni markdown, como " +
  "en una conversación real. Si no entendés algo, preguntá en lugar de suponer.";

const MU_INSTRUCTION =
  "Sos la voz de un equipo de dos. Vos interpretás; mu, tu compañero, construye.\n\n" +
  "Hablás siempre en español, en tono cercano y natural. Tus respuestas son habladas: " +
  "breves, sin listas ni markdown.\n\n" +
  "Cuando el usuario quiere que se haga algo, se lo pedís a mu con la herramienta input. " +
  "No repitas literalmente lo que dijo el usuario: entendé qué quiere y escribilo como una " +
  "instrucción clara. input devuelve enseguida y no es la respuesta de mu, que llega " +
  "después. Mientras mu trabaja podés mandarle más instrucciones: lo van guiando.\n\n" +
  "Las líneas que empiezan con [mu] son el sistema contándote qué está pasando del otro " +
  "lado: nunca son el usuario hablando. Las que dicen 'trabajando' son para que sepas que " +
  "mu sigue ocupado; no las anuncies solas, usalas si el usuario pregunta por qué tarda. " +
  "Cuando llega la respuesta de mu, contala con tus palabras: quedate con lo que al " +
  "usuario le importa y dejá afuera el detalle técnico salvo que lo pida.\n\n" +
  "Si no entendés qué quiere el usuario, preguntale antes de molestar a mu.";

const MU = !Deno.args.includes("--no-mu");
const PTT = Deno.args.includes("--ptt");
const AEC = !Deno.args.includes("--no-aec");

/**
 * Print voice-activity markers. Outside push-to-talk they are derived from the turn
 * signals the server sends (`explicitVadSignal` only exists on Vertex); under --ptt the
 * start and end markers are exact, because we send them ourselves.
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
/** Set while the model believes the user's turn is open. */
let userSpeaking = false;

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
    resumptionHandle = (await Deno.readTextFile(HANDLE_FILE)).trim() || undefined;
  } catch { /* first run */ }
}

function saveHandle(handle: string) {
  resumptionHandle = handle;
  if (!MU) return;
  Deno.mkdir("data/relay", { recursive: true })
    .then(() => Deno.writeTextFile(HANDLE_FILE, handle))
    .catch(() => {});
}

async function dropHandle(reason: string) {
  status(`${reason} — empiezo una conversación nueva`);
  resumptionHandle = undefined;
  await Deno.remove(HANDLE_FILE).catch(() => {});
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

/** Whether the current connection said anything at all; a silent one means a bad resume. */
let gotMessage = false;

// A session can go deaf without any signal: the server sheds load and ignores every
// audio frame from setup on, or the connection half-opens mid-run and our sends land
// nowhere — no error, no close, no transcription either way. Detected by pairing
// what we send with what comes back: a stretch of speech-level audio, then silence
// long enough for any endpointing to have fired, and still nothing from the server.
// Reconnecting is the fix for the half-open case and costs nothing in the other.
let loudSinceReactionMs = 0;
let lastLoudAt = 0;
let deafDetected = false;

const LOUD_RMS = 1000;
/** Speech this long would have drawn a transcription… */
const DEAF_MIN_LOUD_MS = 2000;
/** …within this much silence after it, at any latency seen in practice. */
const DEAF_QUIET_MS = 5000;

function watchForDeafSession(chunk: Uint8Array) {
  if (deafDetected || chunk.byteOffset % 2 !== 0) return;
  const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength >> 1);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < samples.length; i += 8, n++) sum += samples[i] * samples[i];
  const now = performance.now();
  if (Math.sqrt(sum / n) >= LOUD_RMS) {
    loudSinceReactionMs += chunk.byteLength / 32; // 16 kHz s16 mono: 32 bytes per ms
    lastLoudAt = now;
    return;
  }
  if (loudSinceReactionMs >= DEAF_MIN_LOUD_MS && now - lastLoudAt >= DEAF_QUIET_MS) {
    deafDetected = true;
    metrics.event("· sesión sorda detectada");
    status("hablaste y el servidor no reaccionó — sesión sorda, reconectando…");
    session?.close();
  }
}

function handleMessage(message: LiveServerMessage) {
  gotMessage = true;
  if (message.serverContent || message.toolCall) loudSinceReactionMs = 0;
  const resumption = message.sessionResumptionUpdate;
  if (resumption?.resumable && resumption.newHandle) saveHandle(resumption.newHandle);

  if (message.goAway) {
    status(`la conexión cierra en ${message.goAway.timeLeft ?? "instantes"}, reconectando…`);
  }

  for (const call of message.toolCall?.functionCalls ?? []) {
    const text = String((call.args as { text?: unknown })?.text ?? "");
    // Answer even a malformed call, and synchronously: an unanswered one stalls the model.
    session?.sendToolResponse({
      functionResponses: [{ id: call.id, name: call.name, response: relayInput(text) }],
    });
  }

  const content = message.serverContent;
  if (!content) return;

  // A single event can carry audio and a transcript at once, so every field gets
  // processed rather than stopping at the first hit.
  const interrupted = content.interrupted === true;
  if (interrupted) {
    rig.speaker.interrupt();
    metrics.event("srv interrupted");
    if (!PTT) {
      vadEvent("speech detected · barge-in");
      userSpeaking = true;
    }
  } else {
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        const audio = decodeBase64(part.inlineData.data);
        rig.speaker.write(audio);
        metrics.event(`srv audio ${(audio.length / 48).toFixed(0)}ms`);
      }
    }
  }

  const inputText = content.inputTranscription?.text ?? content.interimInputTranscription?.text;
  if (inputText) {
    metrics.event(`srv input ${JSON.stringify(inputText)}`);
    // Under --ptt we already printed an exact start marker on the keypress.
    if (!userSpeaking && !PTT) {
      vadEvent("speech start");
      userSpeaking = true;
    }
    transcribe("user", inputText);
  }

  if (content.outputTranscription?.text) {
    metrics.event(`srv output ${JSON.stringify(content.outputTranscription.text)}`);
    if (userSpeaking && !PTT) {
      // The gap between your last loud window and the model's first word: the
      // endpointing latency as you experience it.
      vadEvent(`speech end${sinceLoud(" · respuesta ")}`);
      userSpeaking = false;
    }
    transcribe("model", content.outputTranscription.text);
  }

  if (content.generationComplete) {
    metrics.event("srv generation complete");
    vadEvent("generation complete");
  }
  if (content.turnComplete) {
    metrics.event("srv turn complete");
    vadEvent("turn complete");
    if (!PTT) userSpeaking = false;
  }
}

/** `" · respuesta +1.9s"`: time since the mic was last loud, or nothing if it never was. */
function sinceLoud(label: string): string {
  const s = metrics.sinceLoud();
  return s === null ? "" : `${label}+${s.toFixed(1)}s`;
}

// --- Push to talk ---

/**
 * Opens or closes the user's turn. With automatic VAD disabled the server has no idea
 * when we start or stop speaking, so these activity signals are the turn boundaries.
 */
function setTalking(on: boolean) {
  if (!PTT || on === talking || !session) return;
  if (on) {
    talking = true;
    rig.speaker.interrupt(); // talking over the model is a barge-in
    session.sendRealtimeInput({ activityStart: {} });
    metrics.event("ptt activity start");
    vadEvent("activity start");
  } else {
    // Flush the buffered tail while `talking` still lets it through the mic guard.
    rig.mic.flush();
    talking = false;
    session.sendRealtimeInput({ activityEnd: {} });
    metrics.event("ptt activity end");
    vadEvent("activity end");
  }
}

// --- Connection ---

const apiKey = Deno.env.get("GEMINI_API_KEY");
if (!apiKey) {
  console.error("falta GEMINI_API_KEY (mise lo carga desde .env).");
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
      // A bare string here breaks the session silently on the web build:
      // setup completes but the server never answers anything after it.
      systemInstruction: { parts: [{ text: MU ? MU_INSTRUCTION : SOLO_INSTRUCTION }] },
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
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
      ...(PTT ? { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } : {}),
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
  metrics.close();
  restoreKeyboard();
  if (Deno.stdin.isTerminal()) Deno.stdin.setRaw(false);
}

// --- Startup ---

await preflight(status);
status(`métricas de audio → ${METRICS_FILE}`);
const rig = await startAudio(AEC, (chunk) => {
  const sent = session !== null && !(PTT ? !talking : muted);
  metrics.frame(chunk, sent, rig.speaker.playing);
  if (!sent) return;
  session!.sendRealtimeInput({
    audio: { data: encodeBase64(chunk), mimeType: "audio/pcm;rate=16000" },
  });
  watchForDeafSession(chunk);
}, (error) => status(`sin cancelación de eco: ${error}`));

onSignals(cleanup);

out(dim(`Live API · ${MODEL}${MU ? " + mu" : ""}\n`));

// Raising mu's daemon can take a moment; the voice comes up regardless, so it can explain
// the failure out loud instead of the terminal explaining it to nobody.
if (MU) {
  try {
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
        : "espacio abre y cierra el turno (la terminal no reporta el soltado) · q: salir\n"
      : "m: silenciar · espacio: interrumpir · q: salir\n",
  ));
  if (!rig.aec) {
    out(dim("Sin cancelación de eco: usá auriculares, o el modelo se escucha a sí mismo.\n"));
  }
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
  // A reconnect mid-turn needs the open turn re-announced.
  if (PTT && talking) session.sendRealtimeInput({ activityStart: {} });
  while (backlog.length > 0) inject(backlog.shift()!);
  gotMessage = false;
  loudSinceReactionMs = 0;
  deafDetected = false;
  await Promise.race([closed, keys]);
  session?.close();
  session = null;
  rig.speaker.interrupt();
  // A resume the server accepts at the socket but hangs up on without a word is the
  // other face of a stale handle; keeping it would reconnect into the same hangup.
  if (running && resumptionHandle && !gotMessage) {
    await dropHandle("la conversación guardada ya no sirve");
  }
}

await cleanup();
out("\n" + dim("listo.\n"));
Deno.exit(0);
