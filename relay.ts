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
 *   input(text)         a plain BLOCKING tool that returns the moment mu's door acks.
 *                       Async function calling is not supported on this model — the docs
 *                       are explicit — so the call must never be left hanging. mu's actual
 *                       output is not the tool result; it arrives later, out of band.
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
import { type Mic, Speaker, startMic } from "./audio.ts";
import { type Aec, loadAec } from "./aec.ts";
import { holdSupported, readKeys, restoreKeyboard } from "./keys.ts";
import { connectMu, type Mu, type MuUpdate } from "./mu.ts";

const MODEL = "gemini-3.1-flash-live-preview";
const VOICE = "Kore";

const SYSTEM_INSTRUCTION =
  "Sos la voz de un equipo de dos. Vos interpretás; mu, tu compañero, construye.\n\n" +
  "Hablás siempre en español, en tono cercano y natural. Tus respuestas son habladas: " +
  "breves, sin listas ni markdown.\n\n" +
  "Cuando el usuario quiere que se haga algo, se lo pedís a mu con la herramienta input. " +
  "No repitas literalmente lo que dijo el usuario: entendé qué quiere y escribilo como una " +
  "instrucción clara. input devuelve enseguida — es solo el acuse de mu, no su respuesta.\n\n" +
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

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const italic = (s: string) => `\x1b[3m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const encoder = new TextEncoder();
const out = (s: string) => Deno.stdout.writeSync(encoder.encode(s));

// --- Session state ---

let session: Session | null = null;
let resumptionHandle: string | undefined;
let running = true;
let muted = false;
let talking = false;

let speaker!: Speaker;
let mic: Mic | null = null;
let aec: Aec | null = null;
let mu: Mu | null = null;

/** Updates that arrived while the socket was down, replayed on reconnect. */
const backlog: MuUpdate[] = [];

// --- Transcript ---

let lastVoice: "user" | "model" | "status" | null = null;

function transcribe(voice: "user" | "model", text: string) {
  if (voice !== lastVoice) {
    if (lastVoice !== null) out("\n");
    out(voice === "user" ? dim("vos  › ") : cyan("voz › "));
    lastVoice = voice;
  }
  out(voice === "user" ? italic(dim(text)) : text);
}

function status(text: string) {
  if (lastVoice !== null) out("\n");
  out(dim(`· ${text}\n`));
  lastVoice = "status";
}

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

async function relayInput(text: string): Promise<Record<string, unknown>> {
  if (TEST) return { error: "modo prueba: mu no está corriendo, nada se ejecutó" };
  if (!mu) return { error: "mu no está conectado" };
  const r = await mu.send(text);
  return r.ok ? { output: "recibido por mu" } : { error: r.error ?? "la puerta lo rechazó" };
}

// --- Server messages ---

function handleMessage(message: LiveServerMessage) {
  const resumption = message.sessionResumptionUpdate;
  if (resumption?.resumable && resumption.newHandle) resumptionHandle = resumption.newHandle;

  if (message.goAway) {
    status(`la conexión cierra en ${message.goAway.timeLeft ?? "instantes"}, reconectando…`);
  }

  for (const call of message.toolCall?.functionCalls ?? []) {
    const text = String((call.args as { text?: unknown })?.text ?? "");
    // Answer even a malformed call: an unanswered one stalls the model on this API.
    relayInput(text).then((response) => {
      session?.sendToolResponse({
        functionResponses: [{ id: call.id, name: call.name, response }],
      });
    });
  }

  const content = message.serverContent;
  if (!content) return;

  if (content.interrupted) speaker.interrupt();
  else {
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) speaker.write(decodeBase64(part.inlineData.data));
    }
  }

  const inputText = content.inputTranscription?.text ?? content.interimInputTranscription?.text;
  if (inputText) transcribe("user", inputText);
  if (content.outputTranscription?.text) transcribe("model", content.outputTranscription.text);
}

// --- Push to talk ---

function setTalking(on: boolean) {
  if (!PTT || on === talking || !session) return;
  talking = on;
  if (on) {
    speaker.interrupt(); // talking over the model is a barge-in
    session.sendRealtimeInput({ activityStart: {} });
  } else {
    mic?.flush(); // the tail of the last word is still buffered
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
            "Le pasa una instrucción a mu, el agente que construye. Devuelve enseguida, " +
            "con el acuse de mu — su respuesta llega después, por su cuenta.",
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
    speaker.interrupt();
  }
}

// --- Teardown ---

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  mu?.close(); // detaching is what ends mu: its daemon reaps itself a linger later
  await mic?.stop();
  speaker?.close();
  await aec?.unload(); // last: the module only goes once nothing captures from it
  restoreKeyboard();
  if (Deno.stdin.isTerminal()) Deno.stdin.setRaw(false);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  Deno.addSignalListener(signal, async () => {
    await cleanup();
    Deno.exit(130);
  });
}

// --- Startup ---

if (AEC) {
  const result = await loadAec();
  if ("error" in result) status(`sin cancelación de eco: ${result.error}`);
  else aec = result;
}

speaker = new Speaker({ target: aec?.sink });
mic = startMic((chunk) => {
  if (!session) return;
  if (PTT ? !talking : muted) return;
  session.sendRealtimeInput({
    audio: { data: encodeBase64(chunk), mimeType: "audio/pcm;rate=16000" },
  });
}, { target: aec?.source });

out(dim(`relay · ${MODEL}${TEST ? " · sin mu" : " + mu"}\n`));

// Raising mu's daemon can take a moment; the voice comes up regardless, so it can explain
// the failure out loud instead of the terminal explaining it to nobody.
if (TEST) {
  status("modo prueba — mu no arranca; solo la voz");
} else {
  try {
    mu = await connectMu(inject);
    status(`mu conectado · agente ${mu.agent}`);
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
    status(`no pude conectar: ${e instanceof Error ? e.message : e}`);
    break;
  }
  status(resumptionHandle ? "sesión retomada" : "conectado — hablá");
  if (PTT && talking) session.sendRealtimeInput({ activityStart: {} });
  while (backlog.length > 0) inject(backlog.shift()!);
  await Promise.race([closed, keys]);
  session?.close();
  session = null;
  speaker.interrupt();
}

await cleanup();
out("\n" + dim("listo.\n"));
Deno.exit(0);
