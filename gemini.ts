// gemini.ts — the Live session: setup, reconnection, and the `input` tool.
//
// Sources for every setting here: the gemini-live-api-dev skill (Google's gemini-skills
// 2.1.0) and the @google/genai 2.24.0 types. Model gemini-3.8-live, audio out, input and
// output transcription, context window compression, session resumption. No thinkingConfig
// (not supported on gemini-3.8-live); proactive audio left alone (always on).
//
// The one tool, `input({text})`, is NON_BLOCKING: its call stays open and liquen's work
// comes back as several answers to it (`willContinue`). Scheduling: SILENT only adds to
// context, WHEN_IDLE prompts output without interrupting, INTERRUPT cuts in (never used).

import {
  Behavior,
  FunctionResponseScheduling,
  GoogleGenAI,
  type LiveServerMessage,
  Modality,
  type Session,
  Type,
} from "@google/genai";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";

export const MODEL = "gemini-3.8-live";
export { FunctionResponseScheduling as Scheduling };

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Answer {
  id: string;
  output: string;
  scheduling: FunctionResponseScheduling;
  willContinue: boolean;
}

export interface VoiceEvents {
  connected(resumed: boolean): void;
  goAway(timeLeft?: string): void;
  reconnecting(reason: string, delayMs: number): void;
  /** The first connection never came up: bad config, bad key. Fatal. */
  setupFailed(reason: string): void;
  /** 24 kHz s16 mono, as received. */
  audio(pcm: Uint8Array): void;
  interrupted(): void;
  inputTranscript(text: string, finished: boolean): void;
  outputTranscript(text: string, finished: boolean): void;
  turnComplete(): void;
  toolCall(call: ToolCall): void;
  toolCallCancelled(ids: string[]): void;
  trace(direction: "send" | "recv", message: unknown): void;
}

export interface VoiceOptions {
  apiKey: string;
  /** BCP-47, e.g. es-AR. */
  language: string;
  systemInstruction: string;
  on: VoiceEvents;
}

const INPUT_TOOL = {
  name: "input",
  description: "Send work to the builder. The call stays open: notes on what it is doing " +
    "arrive as it goes, then its result when it has something to show or a question to ask. " +
    "Nothing is done until a result arrives.",
  behavior: Behavior.NON_BLOCKING,
  parameters: {
    type: Type.OBJECT,
    properties: {
      text: {
        type: Type.STRING,
        description: "The task, decision or question, as a message to the builder.",
      },
    },
    required: ["text"],
  },
};

export class Voice {
  #ai: GoogleGenAI;
  #o: VoiceOptions;
  #session?: Session;
  #ready = false;
  /** An activityStart was sent on this connection and no activityEnd yet. */
  #active = false;
  #handle?: string;
  #everConnected = false;
  #closing = false;
  #attempt = 0;
  /** Bumped per connection attempt: callbacks of an older connection are ignored. */
  #gen = 0;
  #timer?: ReturnType<typeof setTimeout>;

  private constructor(o: VoiceOptions) {
    this.#o = o;
    this.#ai = new GoogleGenAI({ apiKey: o.apiKey });
  }

  static async start(o: VoiceOptions): Promise<Voice> {
    const v = new Voice(o);
    await v.#connect();
    return v;
  }

  get connected() {
    return this.#ready && this.#session !== undefined;
  }

  /** 16 kHz s16 mono. Dropped while disconnected: returns whether it was sent. */
  sendAudio(pcm: Uint8Array): boolean {
    if (!this.connected) return false;
    this.#o.on.trace("send", { audio: pcm.length });
    this.#session!.sendRealtimeInput({
      audio: { data: encodeBase64(pcm), mimeType: "audio/pcm;rate=16000" },
    });
    return true;
  }

  /**
   * The mic opened: the child's turn starts. Automatic activity detection is off, so these two
   * are the only turn edges the server knows (the SDK: "the client must send activity
   * signals"). Interrupts the voice if it was speaking (ActivityHandling's default).
   */
  activityStart() {
    if (!this.connected || this.#active) return;
    this.#active = true;
    this.#o.on.trace("send", { activityStart: {} });
    this.#session!.sendRealtimeInput({ activityStart: {} });
  }

  /** The mic closed: the turn ends now, no endpointing wait. */
  activityEnd() {
    if (!this.connected || !this.#active) return;
    this.#active = false;
    this.#o.on.trace("send", { activityEnd: {} });
    this.#session!.sendRealtimeInput({ activityEnd: {} });
  }

  /**
   * Text as the user's, to be answered now. Measured 2026-09-25: it gets an answer outside an
   * activity (6 of 6 spoke within 1–4 s) and none inside one (0 of 3, over 12 s).
   */
  sendText(text: string) {
    if (!this.connected) return;
    this.#o.on.trace("send", { text });
    this.#session!.sendRealtimeInput({ text });
  }

  /** One answer to an open `input` call. Returns false when disconnected (the answer is lost). */
  answer(a: Answer): boolean {
    if (!this.connected) return false;
    const functionResponses = [{
      id: a.id,
      name: INPUT_TOOL.name,
      response: { output: a.output },
      scheduling: a.scheduling,
      willContinue: a.willContinue,
    }];
    this.#o.on.trace("send", { toolResponse: { functionResponses } });
    this.#session!.sendToolResponse({ functionResponses });
    return true;
  }

  close() {
    this.#closing = true;
    this.#gen++;
    clearTimeout(this.#timer);
    this.#session?.close();
    this.#session = undefined;
  }

  async #connect() {
    const gen = ++this.#gen;
    const config = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: this.#o.systemInstruction }] },
      speechConfig: { languageCode: this.#o.language },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: { handle: this.#handle },
      // push to talk: the mic opening and closing mark the turn (activityStart / activityEnd)
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      tools: [{ functionDeclarations: [INPUT_TOOL] }],
    };
    this.#o.on.trace("send", {
      setup: { model: MODEL, ...config, systemInstruction: "<INSTRUCTIONS.md>" },
    });
    // the SDK holds every server message until setupComplete and delivers them, setupComplete
    // first, before connect() returns: #message runs (and sets #ready) while `session` is still
    // undefined, so nothing below the await may reset #ready
    this.#ready = false;
    this.#active = false; // a new connection starts outside any activity
    try {
      const session = await this.#ai.live.connect({
        model: MODEL,
        config,
        callbacks: {
          onmessage: (m) => {
            if (this.#gen === gen) this.#message(m);
          },
          onerror: (e) => this.#o.on.trace("recv", { error: e.message ?? String(e) }),
          onclose: (e) => {
            this.#o.on.trace("recv", { close: { code: e.code, reason: e.reason } });
            if (this.#gen !== gen) return; // an old connection, already replaced
            const reason = `closed${e.code ? ` ${e.code}` : ""}${e.reason ? `: ${e.reason}` : ""}`;
            this.#session = undefined;
            if (!this.#ready && !this.#everConnected) return this.#o.on.setupFailed(reason);
            this.#ready = false;
            this.#reconnect(reason);
          },
        },
      });
      if (this.#gen === gen) this.#session = session;
      else session.close(); // closed or replaced while connecting
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (!this.#everConnected) return this.#o.on.setupFailed(reason);
      return this.#reconnect(reason);
    }
  }

  #message(m: LiveServerMessage) {
    const on = this.#o.on;
    on.trace("recv", m);
    if (m.setupComplete) {
      const resumed = this.#everConnected;
      this.#ready = true;
      this.#everConnected = true;
      this.#attempt = 0;
      on.connected(resumed);
    }
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
      this.#handle = m.sessionResumptionUpdate.newHandle;
    }
    if (m.goAway) {
      on.goAway(m.goAway.timeLeft);
      // the server is about to hang up: get ahead of it, with the latest handle
      const s = this.#session;
      this.#gen++; // its close is expected: not a reason to reconnect twice
      this.#session = undefined;
      this.#ready = false;
      s?.close();
      this.#reconnect("GoAway", 0);
    }
    const c = m.serverContent;
    if (c) {
      if (c.interrupted) on.interrupted();
      for (const part of c.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) on.audio(decodeBase64(part.inlineData.data));
      }
      if (c.inputTranscription?.text) {
        on.inputTranscript(c.inputTranscription.text, c.inputTranscription.finished ?? false);
      }
      if (c.outputTranscription?.text) {
        on.outputTranscript(c.outputTranscription.text, c.outputTranscription.finished ?? false);
      }
      if (c.turnComplete) on.turnComplete();
    }
    for (const fc of m.toolCall?.functionCalls ?? []) {
      if (fc.id && fc.name) on.toolCall({ id: fc.id, name: fc.name, args: fc.args ?? {} });
    }
    if (m.toolCallCancellation?.ids?.length) on.toolCallCancelled(m.toolCallCancellation.ids);
  }

  #reconnect(reason: string, delay?: number) {
    if (this.#closing) return;
    const wait = delay ?? BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)];
    this.#attempt++;
    this.#o.on.reconnecting(reason, wait);
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#connect(), wait);
  }
}
