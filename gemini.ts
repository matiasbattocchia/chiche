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
  /**
   * The session is up and takes input. `new`: one with no past, at the start or after
   * `resumeRefused`; `resumed`: the session a handle from an earlier run named; `reconnected`:
   * this run's.
   */
  connected(how: "new" | "resumed" | "reconnected"): void;
  /**
   * The server closed a connection resuming a session before its setup completed: that session
   * is gone (expired, unknown, or broken on the server), and a new one starts instead. Measured
   * 2026-09-26: after a 1007 mid-run, 34 of 34 resumptions of its handle closed 1011 "Internal
   * error encountered", and a new session came up at once.
   */
  resumeRefused(reason: string): void;
  /** A handle that resumes the session as it is now. */
  handle(handle: string): void;
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
  /** Absent: the session has none. */
  systemInstruction?: string;
  /**
   * The server's automatic activity detection takes the turns; `activityStart`/`activityEnd` do
   * nothing (the signals "can only be sent if automatic activity detection is disabled").
   */
  vad: boolean;
  /**
   * A session to resume, from an earlier run. Measured 2026-09-25: a resumed session recalls
   * what was said (4 of 4) but keeps its first system instruction, ignoring the one sent with
   * the handle (3 of 3); an unknown handle is closed 1008 "Requested entity was not found".
   */
  resume?: string;
  on: VoiceEvents;
}

export const INPUT_TOOL = {
  name: "input",
  description: "Send a message to the coding agent. It always takes input, even while the " +
    "agent is working: messages queue up, and the agent picks them up at its next step " +
    "without stopping what it is doing.",
  behavior: Behavior.NON_BLOCKING,
  parameters: {
    type: Type.OBJECT,
    properties: {
      text: {
        type: Type.STRING,
        description: "The task, decision or question, as a message to the coding agent.",
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
  /** This connection resumes #handle's session. */
  #resuming = false;
  #handleWaiters: (() => void)[] = [];
  #everConnected = false;
  /** Set up, and `connected` not yet told: it waits for #session, see #connect. */
  #setUp?: "new" | "resumed" | "reconnected";
  #closing = false;
  #attempt = 0;
  /** Bumped per connection attempt: callbacks of an older connection are ignored. */
  #gen = 0;
  #timer?: ReturnType<typeof setTimeout>;

  private constructor(o: VoiceOptions) {
    this.#o = o;
    this.#ai = new GoogleGenAI({ apiKey: o.apiKey });
    this.#handle = o.resume;
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
   * The mic opened: the user's turn starts. Automatic activity detection is off, so these two
   * are the only turn edges the server knows (the SDK: "the client must send activity
   * signals"). Interrupts the voice if it was speaking (ActivityHandling's default).
   */
  activityStart() {
    if (!this.connected || this.#active || this.#o.vad) return;
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

  /**
   * Text as the user's, to be read and not answered: context. The skill's migration notes for
   * 3.8: client content "is supported throughout the entire session lifecycle with explicit
   * roles", and "if you send content without `turn_complete`, the server waits for subsequent
   * messages before responding". Measured 2026-09-26: no answer in the 6 s after it (6 of 6),
   * and the next realtime text was answered from it (3 of 3; 0 of 3 without it).
   */
  context(text: string) {
    if (!this.connected) return;
    const turns = [{ role: "user", parts: [{ text }] }];
    this.#o.on.trace("send", { clientContent: { turns, turnComplete: false } });
    this.#session!.sendClientContent({ turns, turnComplete: false });
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

  /** Resolves on the next new handle, or after `ms`: whether one came. */
  nextHandle(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.#handleWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  close() {
    this.#closing = true;
    this.#gen++;
    clearTimeout(this.#timer);
    this.#session?.close();
    this.#session = undefined;
  }

  async #connect(): Promise<void> {
    const gen = ++this.#gen;
    const config = {
      responseModalities: [Modality.AUDIO],
      ...(this.#o.systemInstruction === undefined ? {} : {
        systemInstruction: { parts: [{ text: this.#o.systemInstruction }] },
      }),
      speechConfig: { languageCode: this.#o.language },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: { handle: this.#handle },
      // push to talk: the mic opening and closing mark the turn (activityStart / activityEnd);
      // with `vad`, left out: the server's detection is on by default
      ...(this.#o.vad ? {} : {
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      }),
      tools: [{ functionDeclarations: [INPUT_TOOL] }],
    };
    this.#o.on.trace("send", {
      setup: {
        model: MODEL,
        ...config,
        ...(config.systemInstruction ? { systemInstruction: "<INSTRUCTIONS.md>" } : {}),
      },
    });
    // the SDK holds every server message until setupComplete and delivers them, setupComplete
    // first, before connect() returns: #message runs (and sets #ready) while `session` is still
    // undefined, so nothing below the await may reset #ready
    this.#ready = false;
    this.#active = false; // a new connection starts outside any activity
    this.#resuming = this.#handle !== undefined;
    this.#setUp = undefined;
    // a close before setupComplete leaves connect() pending forever (measured with an unknown
    // handle): the refusal comes from here instead
    let refused!: (reason: string) => void;
    const closedFirst = new Promise<string>((r) => refused = r);
    try {
      const session = await Promise.race([
        this.#ai.live.connect({
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
              const reason = `closed${e.code ? ` ${e.code}` : ""}${
                e.reason ? `: ${e.reason}` : ""
              }`;
              this.#session = undefined;
              if (!this.#ready) return refused(reason);
              this.#ready = false;
              this.#reconnect(reason);
            },
          },
        }),
        closedFirst,
      ]);
      if (typeof session === "string") return this.#refused(session);
      if (this.#gen !== gen) return session.close(); // closed or replaced while connecting
      this.#session = session;
      this.#tellConnected();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (!this.#everConnected) return this.#refused(reason);
      return this.#reconnect(reason);
    }
  }

  /**
   * The server closed before setupComplete. Resuming, a new session starts (see
   * `resumeRefused`); a new session refused at the start is fatal, later it is retried.
   */
  #refused(reason: string): Promise<void> | void {
    if (this.#resuming) {
      this.#handle = undefined;
      this.#o.on.resumeRefused(reason);
      return this.#connect();
    }
    if (!this.#everConnected) return this.#o.on.setupFailed(reason);
    this.#reconnect(reason);
  }

  /**
   * `connected` once the session takes input: setupComplete arrives before connect() returns
   * (see #connect), and whatever `connected` sends would be dropped without #session.
   */
  #tellConnected() {
    const how = this.#setUp;
    if (!how || !this.connected) return;
    this.#setUp = undefined;
    this.#o.on.connected(how);
  }

  #message(m: LiveServerMessage) {
    const on = this.#o.on;
    on.trace("recv", m);
    if (m.setupComplete) {
      this.#setUp = !this.#resuming ? "new" : this.#everConnected ? "reconnected" : "resumed";
      this.#ready = true;
      this.#everConnected = true;
      this.#attempt = 0;
      this.#tellConnected();
    }
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
      this.#handle = m.sessionResumptionUpdate.newHandle;
      on.handle(this.#handle);
      for (const w of this.#handleWaiters.splice(0)) w();
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
