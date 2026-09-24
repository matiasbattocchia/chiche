/**
 * tests/app.test.ts — the application layer alone: no socket, no PipeWire.
 *
 * Drives conversation.ts with a recorded server message stream (tests/transport.ts
 * --record, its audio zeroed) on a fake clock, and with hand-made messages for the cases a recording
 * doesn't cover. What comes out is what the user would see and hear: the transcript,
 * the markers, the speaker's bytes, the tool answers.
 *
 *   bun test
 */
import { describe, expect, test } from "bun:test";
import { createConversation, type ConversationIO, DEAF_MIN_LOUD_MS, DEAF_QUIET_MS, LATE_REPLY_MS, STALL_GAP_MS } from "../conversation.ts";
import type { LiveServerMessage } from "@google/genai";

/** A clock that only moves when told; timers fire in order as it advances. */
function fakeClock() {
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  return {
    now: () => t,
    setTimeout(fn: () => void, ms: number) { timers.set(++id, { at: t + ms, fn }); return id; },
    clearTimeout(h: unknown) { timers.delete(h as number); },
    advanceTo(target: number) {
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = due[1].at; due[1].fn();
      }
      t = target;
    },
  };
}

function harness(opts: { mu?: boolean } = {}) {
  const clock = fakeClock();
  const out = { transcript: [] as string[], markers: [] as string[], status: [] as string[], events: [] as string[],
    audioBytes: 0, interrupts: 0, toolResponses: [] as unknown[], handles: [] as string[], closed: 0, lastLoud: null as number | null };
  const io: ConversationIO = {
    speaker: { write: (a) => { out.audioBytes += a.length; }, interrupt: () => { out.interrupts++; } },
    transcribe: (v, text) => out.transcript.push(`${v}:${text}`),
    status: (t) => out.status.push(t),
    vadEvent: (t) => out.markers.push(t),
    metrics: { event: (t) => out.events.push(t), playback: () => {}, sinceLoud: () => out.lastLoud },
    decodeBase64: (d) => Uint8Array.from(Buffer.from(d, "base64")),
    sendToolResponse: (id, name, response) => out.toolResponses.push({ id, name, response }),
    relayInput: (text) => opts.mu ? { output: "enviado a mu" } : { error: "mu no está conectado" },
    saveHandle: (h) => out.handles.push(h),
    closeSession: () => { out.closed++; },
  };
  const conv = createConversation(io, { timers: clock });
  return { conv, clock, out };
}

type Recorded = { t: number; msg: LiveServerMessage };
async function recording(file: string, stretch = 1): Promise<Recorded[]> {
  const lines = (await Bun.file(file).text()).trim().split("\n");
  return lines.map((l) => JSON.parse(l) as Recorded).map((r) => ({ ...r, t: r.t * stretch }));
}
function replay(h: ReturnType<typeof harness>, rec: Recorded[], tailMs = 3000) {
  h.conv.connectionOpened();
  for (const { t, msg } of rec) { h.clock.advanceTo(t); h.conv.handleMessage(msg); }
  h.clock.advanceTo(rec[rec.length - 1].t + tailMs);
}
const audio = (ms: number) => ({ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(ms * 48).toString("base64") } });

describe("a recorded normal reply", () => {
  test("transcript, markers, audio — and no pacing complaints", async () => {
    const h = harness();
    const rec = await recording("tests/fixtures/reply.jsonl");
    replay(h, rec);
    expect(h.out.transcript.some((l) => l.startsWith("user:"))).toBe(true);
    expect(h.out.transcript.filter((l) => l.startsWith("model:")).join("")).toContain("¡Hola");
    expect(h.out.markers.filter((m) => m === "speech start")).toHaveLength(1);
    expect(h.out.markers.some((m) => m.startsWith("speech end"))).toBe(true);
    expect(h.out.markers).toContain("turn complete");
    expect(h.out.audioBytes).toBeGreaterThan(24000 * 2 * 3); // more than 3 s of 24 kHz s16
    expect(h.out.markers.filter((m) => /demorada|lento|tiempo real/.test(m))).toEqual([]);
    expect(h.out.handles.length).toBeGreaterThan(0);
    expect(h.conv.gotMessage).toBe(true);
  });

  test("the same reply 16x slower: stalling, under realtime", async () => {
    const h = harness();
    replay(h, await recording("tests/fixtures/reply.jsonl", 16));
    expect(h.out.markers.some((m) => m.startsWith("servidor entrega lento"))).toBe(true);
    expect(h.out.markers.some((m) => /respuesta a 0\.\dx tiempo real/.test(m))).toBe(true);
  });

  test("a reply that starts late is said to be late, then to have arrived", () => {
    const h = harness();
    h.conv.handleMessage({ serverContent: { inputTranscription: { text: "Hola." } } });
    h.clock.advanceTo(LATE_REPLY_MS * 2);
    h.conv.handleMessage({ serverContent: { modelTurn: { parts: [audio(200)] } } });
    expect(h.out.markers.some((m) => m.startsWith("respuesta demorada"))).toBe(true);
    expect(h.out.markers.some((m) => m.startsWith("respuesta llegó · 5.0s tarde"))).toBe(true);
  });
});

describe("pacing edges", () => {
  test("no stall marker between generationComplete and turnComplete", () => {
    const h = harness();
    h.conv.handleMessage({ serverContent: { inputTranscription: { text: "Hola." } } });
    h.clock.advanceTo(100);
    h.conv.handleMessage({ serverContent: { modelTurn: { parts: [audio(200)] } } });
    h.conv.handleMessage({ serverContent: { generationComplete: true } });
    h.clock.advanceTo(100 + STALL_GAP_MS * 3);
    h.conv.handleMessage({ serverContent: { turnComplete: true } });
    expect(h.out.markers.filter((m) => m.startsWith("servidor"))).toEqual([]);
  });

  test("an interruption ends the reply: speaker flushed, no late marker afterwards", () => {
    const h = harness();
    h.conv.handleMessage({ serverContent: { inputTranscription: { text: "Hola." } } });
    h.clock.advanceTo(200);
    h.conv.handleMessage({ serverContent: { interrupted: true } });
    h.clock.advanceTo(200 + LATE_REPLY_MS * 2);
    expect(h.out.interrupts).toBe(1);
    expect(h.out.markers).toContain("speech detected · barge-in");
    expect(h.out.markers.filter((m) => m.startsWith("respuesta demorada"))).toEqual([]);
    expect(h.conv.userSpeaking).toBe(true);
  });

  test("a silent turn is logged for what it carried", () => {
    const h = harness();
    h.conv.handleMessage({ serverContent: { modelTurn: { parts: [{ text: "…" }] }, turnComplete: true } });
    expect(h.out.events.some((e) => e.startsWith("srv part text"))).toBe(true);
    expect(h.out.audioBytes).toBe(0);
  });
});

describe("tools", () => {
  test("input is answered synchronously; without mu, with the error", () => {
    const h = harness();
    h.conv.handleMessage({ toolCall: { functionCalls: [{ id: "c1", name: "input", args: { text: "hacé un juego" } }] } });
    expect(h.out.toolResponses).toEqual([{ id: "c1", name: "input", response: { error: "mu no está conectado" } }]);
    expect(h.out.events.some((e) => e.startsWith("srv toolCall input"))).toBe(true);
  });
  test("with mu, the ack", () => {
    const h = harness({ mu: true });
    h.conv.handleMessage({ toolCall: { functionCalls: [{ id: "c2", name: "input", args: { text: "x" } }] } });
    expect(h.out.toolResponses[0]).toMatchObject({ response: { output: "enviado a mu" } });
  });
});

describe("deaf session", () => {
  const loud = () => { const b = new Int16Array(160); b.fill(3000); return new Uint8Array(b.buffer); }; // 10 ms at RMS 3000
  const quiet = () => new Uint8Array(320);
  test("speech, then silence, then nothing from the server → the socket is closed", () => {
    const h = harness();
    for (let t = 0; t < DEAF_MIN_LOUD_MS + 100; t += 10) { h.clock.advanceTo(t); h.conv.micChunkSent(loud()); }
    for (let t = DEAF_MIN_LOUD_MS + 100; t < DEAF_MIN_LOUD_MS + DEAF_QUIET_MS + 200; t += 10) { h.clock.advanceTo(t); h.conv.micChunkSent(quiet()); }
    expect(h.out.closed).toBe(1);
    expect(h.out.status.some((s) => s.includes("sesión sorda"))).toBe(true);
  });
  test("a server reaction resets the watch", () => {
    const h = harness();
    for (let t = 0; t < DEAF_MIN_LOUD_MS + 100; t += 10) { h.clock.advanceTo(t); h.conv.micChunkSent(loud()); }
    h.conv.handleMessage({ serverContent: { inputTranscription: { text: "Hola." } } });
    for (let t = DEAF_MIN_LOUD_MS + 100; t < DEAF_MIN_LOUD_MS + DEAF_QUIET_MS + 200; t += 10) { h.clock.advanceTo(t); h.conv.micChunkSent(quiet()); }
    expect(h.out.closed).toBe(0);
  });
});

describe("late while still talking", () => {
  test("a hot mic keeps the late-reply timer from firing", () => {
    const h = harness();
    h.conv.handleMessage({ serverContent: { inputTranscription: { text: "neto" } } });
    h.out.lastLoud = 0.1; // the mic was loud 100 ms ago, and stays so
    h.clock.advanceTo(LATE_REPLY_MS * 3);
    expect(h.out.markers.filter((m) => m.startsWith("respuesta demorada"))).toEqual([]);
    h.out.lastLoud = null; // quiet now: the next check fires
    h.clock.advanceTo(LATE_REPLY_MS * 5);
    expect(h.out.markers.some((m) => m.startsWith("respuesta demorada"))).toBe(true);
  });
});
