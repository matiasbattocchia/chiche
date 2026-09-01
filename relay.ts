/**
 * relay.ts — two agents, one microphone.
 *
 * Agent 1 is the voice: the Live API model, which listens, interprets, and speaks. Agent 2
 * is mu, the builder, which does the work. They never hear each other verbatim. Agent 1
 * decides what to ask for and says it in its own words through the `input` tool; mu's work
 * comes back and agent 1 decides what of it is worth saying out loud. Nothing is dictated
 * and nothing is read aloud — the point of the arrangement is the interpretation at both
 * ends.
 *
 * The channel between them is one tool and two kinds of injection:
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
 *   --test      agent 1 alone: mu is never raised, and `input` answers that it is not
 *               running. For working on the voice half — audio, keys, interpretation —
 *               without spending a builder's tokens on it.
 *   --vad       automatic voice activity detection instead of push to talk. Push to talk
 *               is the default here: an open mic bills 25 tokens per second of silence,
 *               and it would race the injected turns for the user's turn.
 *   --no-aec    skip echo cancellation and use the default devices directly
 */
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
import { dim, onSignals, out, startAudio, transcript } from "./shell.ts";

const MODEL = "gemini-3.1-flash-live-preview";
const VOICE = "Kore";

const SYSTEM_INSTRUCTION =
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

const TEST = Deno.args.includes("--test");
const VAD = Deno.args.includes("--vad");
const PTT = !VAD;
const AEC = !Deno.args.includes("--no-aec");

const KEY_SPACE = 32;
const KEY_Q = 113;
const KEY_C = 99;
const KEY_M = 109;

const { transcribe, status } = transcript({ user: "vos  › ", model: "voz › " });

// --- Session state ---

let session: Session | null = null;
let running = true;
let muted = false;
let talking = false;

/**
 * Agent 1 has ONE conversation, the way mu's log gives agent 2 one: the resumption
 * handle is persisted and reloaded, so a restart resumes rather than starting over —
 * and a tool response outliving its socket still lands in the same logical session.
 */
const HANDLE_FILE = "data/relay/handle";
let resumptionHandle: string | undefined;
try {
  resumptionHandle = (await Deno.readTextFile(HANDLE_FILE)).trim() || undefined;
} catch { /* first run */ }

function saveHandle(handle: string) {
  resumptionHandle = handle;
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
  if (TEST) return { error: "modo prueba: mu no está corriendo, nada se ejecutó" };
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

function handleMessage(message: LiveServerMessage) {
  gotMessage = true;
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

  if (content.interrupted) rig.speaker.interrupt();
  else {
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) rig.speaker.write(decodeBase64(part.inlineData.data));
    }
  }

  const inputText = content.inputTranscription?.text ?? content.interimInputTranscription?.text;
  if (inputText) transcribe("user", inputText);
  if (content.outputTranscription?.text) transcribe("model", content.outputTranscription.text);
}

// --- Push to talk ---

function setTalking(on: boolean) {
  if (!PTT || on === talking || !session) return;
  if (on) {
    talking = true;
    rig.speaker.interrupt(); // talking over the model is a barge-in
    session.sendRealtimeInput({ activityStart: {} });
  } else {
    // Flush the buffered tail while `talking` still lets it through the mic guard.
    rig.mic.flush();
    talking = false;
    session.sendRealtimeInput({ activityEnd: {} });
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
      systemInstruction: SYSTEM_INSTRUCTION,
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: { handle: resumptionHandle },
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
    if (holdSupported()) setTalking(pressed);
    else if (pressed) setTalking(!talking);
    return;
  }

  if (!pressed) return;
  if (event.code === KEY_M) {
    muted = !muted;
    status(muted ? "micrófono en silencio" : "micrófono abierto");
  } else if (event.code === KEY_SPACE) {
    rig.speaker.interrupt();
  }
}

// --- Teardown ---

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  mu?.close(); // detaching is what ends mu: its daemon reaps itself a linger later
  await rig.stop();
  restoreKeyboard();
  if (Deno.stdin.isTerminal()) Deno.stdin.setRaw(false);
}

// --- Startup ---

const rig = await startAudio(AEC, (chunk) => {
  if (!session) return;
  if (PTT ? !talking : muted) return;
  session.sendRealtimeInput({
    audio: { data: encodeBase64(chunk), mimeType: "audio/pcm;rate=16000" },
  });
}, (error) => status(`sin cancelación de eco: ${error}`));

onSignals(cleanup);

out(dim(`relay · ${MODEL}${TEST ? " · sin mu" : " + mu"}\n`));

// Raising mu's daemon can take a moment; the voice comes up regardless, so it can explain
// the failure out loud instead of the terminal explaining it to nobody.
if (TEST) {
  status("modo prueba — mu no arranca; solo la voz");
} else {
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

setTimeout(() => {
  out(dim(
    PTT
      ? holdSupported()
        ? "hablá manteniendo espacio · q: salir\n"
        : "espacio abre y cierra el turno (la terminal no reporta el soltado) · q: salir\n"
      : "m: silenciar · espacio: interrumpir · q: salir\n",
  ));
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
  if (PTT && talking) session.sendRealtimeInput({ activityStart: {} });
  while (backlog.length > 0) inject(backlog.shift()!);
  gotMessage = false;
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
