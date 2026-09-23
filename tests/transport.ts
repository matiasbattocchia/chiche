/**
 * tests/transport.ts — the WebSocket layer alone: no microphone, no speaker.
 *
 * Connects with the app's exact session config, streams a recorded 16 kHz "hola"
 * at real-time pace (10 ms chunks, like audio.ts), then keeps sending silence and
 * records every server message with a timestamp and size. What it measures is
 * exactly what the app can't separate from the audio path:
 *
 *   time to first audio, chunk cadence, total audio received, empty turns,
 *   goAway/errors — and bytes per second actually arriving on the socket.
 *
 *   bun tests/transport.ts [runs=3] [fixture=tests/fixtures/hola.raw]
 */
import { GoogleGenAI, type LiveServerMessage, Modality, ThinkingLevel } from "@google/genai/web";

const MODEL = process.env.MODEL ?? "gemini-3.1-flash-live-preview";
const RUNS = parseInt(process.argv[2] ?? "3", 10);
const FIXTURE = process.argv[3] ?? "tests/fixtures/session0-12.raw";
/** `--record <file>`: every server message as JSONL {t, msg}, t in ms since connect — tests/app.ts replays it. */
const RECORD = process.argv.includes("--record") ? process.argv[process.argv.indexOf("--record") + 1] : null;
const CHUNK = 320; // 10 ms of 16 kHz s16 mono, the app's send cadence
const TAIL_S = 20; // silence after the clip, waiting for the reply to finish
const INSTRUCTION = (await Bun.file("INSTRUCTIONS.md").text()).trim();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error("falta GEMINI_API_KEY"); process.exit(1); }
const ai = new GoogleGenAI({ apiKey });
const clip = new Uint8Array(await Bun.file(FIXTURE).arrayBuffer());

interface Run {
  connectMs: number; firstInputMs: number | null; firstAudioMs: number | null; lastAudioMs: number | null;
  audioMs: number; chunks: number; outputs: string[]; inputs: string[]; events: string[];
  gaps: number[]; bytesPerSecond: number[]; turnsWithoutAudio: number;
}

async function once(i: number): Promise<Run> {
  const r: Run = { connectMs: 0, firstInputMs: null, firstAudioMs: null, lastAudioMs: null, audioMs: 0, chunks: 0,
    outputs: [], inputs: [], events: [], gaps: [], bytesPerSecond: [], turnsWithoutAudio: 0 };
  const t0 = performance.now(); const now = () => performance.now() - t0;
  const recorded: string[] = [];
  let turnHadAudio = false, done = false, bytesThisSecond = 0;
  let lastInputAt: number | null = null, turnFirstAudio: number | null = null, turnLastAudio = 0, turnAudioMs = 0;
  const turns: string[] = [];
  const meter = setInterval(() => { r.bytesPerSecond.push(bytesThisSecond); bytesThisSecond = 0; }, 1000);
  const connectTimeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("connect timed out after 30 s")), 30000));
  const session = await Promise.race([connectTimeout, ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: INSTRUCTION }] },
      // languageCode, like thinkingLevel, is a Gemini 3 field: a 2.5 setup carrying it never completes
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } }, ...(MODEL.includes("gemini-3") ? { languageCode: "es-AR" } : {}) },
      // thinkingLevel is for the models that think: 2.5 and gemini-3.8-live both hang the
      // setup silently when it is present, and 3.8's thinking lives in its own variant.
      ...(MODEL.includes("gemini-3.1") || MODEL.includes("thinking")
        ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }
        : {}),
      inputAudioTranscription: {}, outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: {},
      realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 700 } },
    },
    callbacks: {
      onmessage: (m: LiveServerMessage) => {
        bytesThisSecond += JSON.stringify(m).length;
        if (RECORD) recorded.push(JSON.stringify({ t: Math.round(now()), msg: m }));
        const c = m.serverContent;
        const t = now();
        for (const p of c?.modelTurn?.parts ?? []) {
          if (p.inlineData?.data) {
            const ms = p.inlineData.data.length * 3 / 4 / 48;
            if (r.firstAudioMs === null) r.firstAudioMs = t; else r.gaps.push(t - r.lastAudioMs!);
            r.lastAudioMs = t; r.audioMs += ms; r.chunks++; turnHadAudio = true;
            if (turnFirstAudio === null) turnFirstAudio = t;
            turnLastAudio = t; turnAudioMs += ms;
          } else r.events.push(`${t.toFixed(0)}ms part:${Object.keys(p).join(",")}`);
        }
        if (c?.inputTranscription?.text) { if (r.firstInputMs === null) r.firstInputMs = t; r.inputs.push(c.inputTranscription.text); lastInputAt = t; }
        if (c?.outputTranscription?.text) r.outputs.push(c.outputTranscription.text);
        if (c?.interrupted) r.events.push(`${t.toFixed(0)}ms interrupted`);
        if (c?.turnComplete || c?.interrupted) {
          if (turnFirstAudio !== null) {
            const stream = (turnLastAudio - turnFirstAudio) / 1000, late = lastInputAt === null ? NaN : (turnFirstAudio - lastInputAt) / 1000;
            turns.push(`${(turnFirstAudio / 1000).toFixed(0)}s: late ${late.toFixed(1)}s · ${(turnAudioMs / 1000).toFixed(1)}s audio in ${stream.toFixed(1)}s (${stream > 0.5 ? (turnAudioMs / 1000 / stream).toFixed(1) + "x" : "—"})${c?.interrupted ? " ✂" : ""}`);
          }
          turnFirstAudio = null; turnAudioMs = 0;
        }
        if (c?.turnComplete) { if (!turnHadAudio) r.turnsWithoutAudio++; turnHadAudio = false; r.events.push(`${t.toFixed(0)}ms turnComplete`); }
        if (c?.generationComplete) done = true;
        if (m.toolCall) r.events.push(`${t.toFixed(0)}ms toolCall`);
        if (m.goAway) r.events.push(`${t.toFixed(0)}ms goAway ${m.goAway.timeLeft}`);
        r.events.push(`${t.toFixed(0)}ms ${Object.keys(m).join(",")}`); const odd: string[] = [];
        if (odd.length) r.events.push(`${t.toFixed(0)}ms msg:${odd.join(",")}`);
      },
      onerror: (e) => r.events.push(`${now().toFixed(0)}ms error ${e.message}`),
      onclose: (e) => r.events.push(`${now().toFixed(0)}ms close ${e.code} ${e.reason}`),
    },
  })]);
  r.connectMs = now();
  // real-time pacing: one 10 ms chunk per 10 ms, then silence
  const silence = new Uint8Array(CHUNK);
  const total = Math.ceil(clip.length / CHUNK) + TAIL_S * 100;
  const start = performance.now();
  for (let k = 0; k < total; k++) {
    const off = k * CHUNK;
    const buf = off < clip.length ? clip.subarray(off, Math.min(off + CHUNK, clip.length)) : silence;
    session.sendRealtimeInput({ audio: { data: Buffer.from(buf).toString("base64"), mimeType: "audio/pcm;rate=16000" } });
    const due = start + (k + 1) * 10;
    const wait = due - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    if (done && off >= clip.length && now() - (r.lastAudioMs ?? 0) > 2000) break;
    done = false;
  }
  clearInterval(meter);
  session.close();
  if (turns.length) console.log(`   turns:\n     ${turns.join("\n     ")}`);
  if (RECORD) await Bun.write(RECORD.replace(/\.jsonl$/, "") + (RUNS > 1 ? `.${i}` : "") + ".jsonl", recorded.join("\n") + "\n");
  return r;
}

const fmt = (ms: number | null) => ms === null ? "  —  " : `${(ms / 1000).toFixed(2)}s`;
console.log(`transport · ${MODEL} · clip ${(clip.length / 32000).toFixed(1)}s · ${RUNS} runs`);
for (let i = 1; i <= RUNS; i++) {
  let r: Run;
  try { r = await once(i); } catch (e) { console.log(`\n#${i} failed: ${e instanceof Error ? e.message : e}`); continue; }
  const g = r.gaps.length ? r.gaps.slice().sort((a, b) => a - b) : [0];
  const streamS = r.firstAudioMs !== null ? (r.lastAudioMs! - r.firstAudioMs) / 1000 : 0;
  console.log(`\n#${i} connect ${fmt(r.connectMs)} · input heard ${fmt(r.firstInputMs)} · first audio ${fmt(r.firstAudioMs)} · audio ${(r.audioMs / 1000).toFixed(1)}s in ${r.chunks} chunks over ${streamS.toFixed(1)}s (${streamS > 0 ? (r.audioMs / 1000 / streamS).toFixed(1) : "—"}x realtime) · gap p50 ${g[Math.floor(g.length / 2)].toFixed(0)}ms max ${g[g.length - 1].toFixed(0)}ms · empty turns ${r.turnsWithoutAudio}`);
  console.log(`   in:  ${JSON.stringify(r.inputs.join(""))}`);
  console.log(`   out: ${JSON.stringify(r.outputs.join("").slice(0, 100))}`);
  console.log(`   bytes/s: ${r.bytesPerSecond.map((b) => (b / 1024).toFixed(0)).join(" ")}`);
  if (r.events.length) console.log(`   events: ${r.events.slice(0, 8).join(" · ")}`);
}
process.exit(0);
