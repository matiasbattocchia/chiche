/**
 * conversation.ts — agent 1's side of the session, with nothing attached.
 *
 * Everything the app does with a server message or a mic chunk lives here, behind an
 * `io` the caller provides: the speaker, the transcript, the metrics log, the tool
 * relay, the socket. No runtime API, no globals — so tests/app.ts can drive it with a
 * recorded message stream and a fake clock, and the same code runs under Deno or Bun.
 */

import type { LiveServerMessage } from "@google/genai";

export interface ConversationIO {
  speaker: { write(audio: Uint8Array): void; interrupt(): void };
  transcribe(voice: "user" | "model", text: string): void;
  /** One dimmed `· line` of the harness's own. */
  status(text: string): void;
  /** One dimmed `[marker]` line. */
  vadEvent(text: string): void;
  metrics: {
    event(text: string): void;
    playback(audio: Uint8Array): void;
    /** Seconds since the last loud mic chunk, null before any. */
    sinceLoud(): number | null;
  };
  decodeBase64(data: string): Uint8Array;
  /** Answer a tool call — synchronously, an unanswered one stalls the model. */
  sendToolResponse(id: string | undefined, name: string | undefined, response: Record<string, unknown>): void;
  /** One `input` call's text → the tool's response. */
  relayInput(text: string): Record<string, unknown>;
  /** A new resumption handle arrived. */
  saveHandle(handle: string): void;
  /** Close the socket: the reconnect loop takes it from there. */
  closeSession(): void;
}

/** Time, injectable: tests replay a recording without waiting for it. */
export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ConversationOptions {
  /** Push to talk: the start/end markers are the keypresses, not the server's guesses. */
  ptt: boolean;
  timers?: Timers;
}

// --- Reply pacing ---
//
// The server sometimes delivers a reply late, or slower than realtime, with nothing
// of ours in the loop (tests/transport.ts reproduces it 1 run in 5). It has to be
// visible, or every slow session gets blamed on the audio path.

/** A reply not started this long after your speech was transcribed is "late". */
export const LATE_REPLY_MS = 2500;
/** A gap this long between audio chunks mid-reply is a stall. */
export const STALL_GAP_MS = 1500;
/** Under this much audio, the realtime ratio says nothing. */
export const MIN_JUDGED_REPLY_MS = 1000;

// --- Deaf sessions ---
//
// A session can go deaf without any signal: the server sheds load and ignores every
// audio frame from setup on, or the connection half-opens mid-run and our sends land
// nowhere — no error, no close, no transcription either way. Detected by pairing
// what we send with what comes back: a stretch of speech-level audio, then silence
// long enough for any endpointing to have fired, and still nothing from the server.
// Reconnecting is the fix for the half-open case and costs nothing in the other.

const LOUD_RMS = 1000;
/** Speech this long would have drawn a transcription… */
export const DEAF_MIN_LOUD_MS = 2000;
/** …within this much silence after it, at any latency seen in practice. */
export const DEAF_QUIET_MS = 5000;

const KNOWN_MESSAGE_KEYS = ["serverContent", "toolCall", "sessionResumptionUpdate", "usageMetadata"];
const KNOWN_CONTENT_KEYS = [
  "modelTurn", "interrupted", "inputTranscription", "interimInputTranscription",
  "outputTranscription", "generationComplete", "turnComplete",
];

export interface Conversation {
  handleMessage(message: LiveServerMessage): void;
  /** Every mic chunk that was sent: feeds the deaf-session watch. */
  micChunkSent(chunk: Uint8Array): void;
  /** A fresh socket: per-connection state starts over. */
  connectionOpened(): void;
  /** Whether the current connection said anything at all; a silent one means a bad resume. */
  readonly gotMessage: boolean;
  /** Set while the model believes the user's turn is open. */
  userSpeaking: boolean;
}

export function createConversation(io: ConversationIO, opts: ConversationOptions): Conversation {
  const { ptt } = opts;
  const timers: Timers = opts.timers ?? {
    now: () => performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as number),
  };

  let userSpeaking = false;
  let gotMessage = false;

  // reply pacing
  let replyDueAt: number | null = null;
  let replyStartedAt: number | null = null;
  let lastAudioAt = 0;
  let replyAudioMs = 0;
  let replyChunks = 0;
  let stallTimer: unknown;

  function armStallTimer(delay: number, text: () => string) {
    timers.clearTimeout(stallTimer);
    stallTimer = timers.setTimeout(() => {
      io.metrics.event(`· ${text()}`);
      io.vadEvent(text());
    }, delay);
  }

  /**
   * Your turn was heard: the reply's clock starts. The transcript arrives in fragments
   * while you are still talking, so "late" is measured from your last loud mic chunk,
   * not from the fragment — the timer keeps re-arming while the mic is hot.
   */
  function expectReply() {
    if (replyStartedAt !== null) return;
    replyDueAt = timers.now();
    const check = () => {
      const quietMs = (io.metrics.sinceLoud() ?? Infinity) * 1000;
      if (quietMs < LATE_REPLY_MS) {
        timers.clearTimeout(stallTimer);
        stallTimer = timers.setTimeout(check, LATE_REPLY_MS - quietMs);
        return;
      }
      const text = `respuesta demorada · ${(Math.min(quietMs, timers.now() - replyDueAt!) / 1000).toFixed(1)}s sin audio`;
      io.metrics.event(`· ${text}`);
      io.vadEvent(text);
    };
    timers.clearTimeout(stallTimer);
    stallTimer = timers.setTimeout(check, LATE_REPLY_MS);
  }

  function noteReplyAudio(ms: number) {
    const now = timers.now();
    if (replyStartedAt === null) {
      replyStartedAt = now;
      if (replyDueAt !== null && now - replyDueAt >= LATE_REPLY_MS) {
        io.vadEvent(`respuesta llegó · ${((now - replyDueAt) / 1000).toFixed(1)}s tarde`);
      }
      replyAudioMs = 0;
      replyChunks = 0;
    }
    lastAudioAt = now;
    replyAudioMs += ms;
    replyChunks++;
    armStallTimer(STALL_GAP_MS, () => `servidor entrega lento · ${((timers.now() - lastAudioAt) / 1000).toFixed(1)}s sin audio`);
  }

  /** The turn ended: report a reply that came in slower than it plays. A reply cut
   *  short by a barge-in is too little to judge. */
  function replyEnded() {
    timers.clearTimeout(stallTimer);
    if (replyStartedAt !== null && replyChunks > 1 && replyAudioMs >= MIN_JUDGED_REPLY_MS) {
      const streamS = (lastAudioAt - replyStartedAt) / 1000;
      const ratio = replyAudioMs / 1000 / Math.max(streamS, 0.001);
      if (ratio < 1) {
        const text = `respuesta a ${ratio.toFixed(1)}x tiempo real · ${(replyAudioMs / 1000).toFixed(1)}s de audio en ${streamS.toFixed(1)}s`;
        io.metrics.event(`· ${text}`);
        io.vadEvent(text);
      }
    }
    replyDueAt = null;
    replyStartedAt = null;
  }

  // deaf watch
  let loudSinceReactionMs = 0;
  let lastLoudAt = 0;
  let deafDetected = false;

  function micChunkSent(chunk: Uint8Array) {
    if (deafDetected || chunk.byteOffset % 2 !== 0) return;
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength >> 1);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < samples.length; i += 8, n++) sum += samples[i] * samples[i];
    const now = timers.now();
    if (Math.sqrt(sum / n) >= LOUD_RMS) {
      loudSinceReactionMs += chunk.byteLength / 32; // 16 kHz s16 mono: 32 bytes per ms
      lastLoudAt = now;
      return;
    }
    if (loudSinceReactionMs >= DEAF_MIN_LOUD_MS && now - lastLoudAt >= DEAF_QUIET_MS) {
      deafDetected = true;
      io.metrics.event("· sesión sorda detectada");
      io.status("hablaste y el servidor no reaccionó — sesión sorda, reconectando…");
      io.closeSession();
    }
  }

  function handleMessage(message: LiveServerMessage) {
    gotMessage = true;
    // Anything outside the handled fields is worth a line: a quiet session has to
    // show what the server was sending instead of speech.
    const odd = Object.keys(message).filter((k) => !KNOWN_MESSAGE_KEYS.includes(k));
    if (odd.length) io.metrics.event(`srv msg ${odd.join(",")}`);
    if (message.serverContent || message.toolCall) loudSinceReactionMs = 0;
    const resumption = message.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) io.saveHandle(resumption.newHandle);

    if (message.goAway) {
      io.status(`la conexión cierra en ${message.goAway.timeLeft ?? "instantes"}, reconectando…`);
    }

    for (const call of message.toolCall?.functionCalls ?? []) {
      const text = String((call.args as { text?: unknown })?.text ?? "");
      io.metrics.event(`srv toolCall ${call.name} ${JSON.stringify(text).slice(0, 80)}`);
      // Answer even a malformed call, and synchronously: an unanswered one stalls the model.
      io.sendToolResponse(call.id, call.name, io.relayInput(text));
    }

    const content = message.serverContent;
    if (!content) return;
    const oddContent = Object.keys(content).filter((k) => !KNOWN_CONTENT_KEYS.includes(k));
    if (oddContent.length) io.metrics.event(`srv content ${oddContent.join(",")}`);

    // A single event can carry audio and a transcript at once, so every field gets
    // processed rather than stopping at the first hit.
    const interrupted = content.interrupted === true;
    if (interrupted) {
      io.speaker.interrupt();
      replyEnded();
      io.metrics.event("srv interrupted");
      if (!ptt) {
        io.vadEvent("speech detected · barge-in");
        userSpeaking = true;
      }
    } else {
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          const audio = io.decodeBase64(part.inlineData.data);
          io.speaker.write(audio);
          io.metrics.playback(audio);
          noteReplyAudio(audio.length / 48);
          io.metrics.event(`srv audio ${(audio.length / 48).toFixed(0)}ms`);
        } else {
          // A turn with no audio in it: say what it carried instead (text, thought…).
          io.metrics.event(`srv part ${Object.keys(part).join(",")} ${JSON.stringify(part.text ?? "").slice(0, 80)}`);
        }
      }
    }

    const inputText = content.inputTranscription?.text ?? content.interimInputTranscription?.text;
    if (inputText) {
      io.metrics.event(`srv input ${JSON.stringify(inputText)}`);
      if (content.inputTranscription?.text) expectReply();
      // Under --ptt we already printed an exact start marker on the keypress.
      if (!userSpeaking && !ptt) {
        io.vadEvent("speech start");
        userSpeaking = true;
      }
      io.transcribe("user", inputText);
    }

    if (content.outputTranscription?.text) {
      io.metrics.event(`srv output ${JSON.stringify(content.outputTranscription.text)}`);
      if (userSpeaking && !ptt) {
        // The gap between your last loud window and the model's first word: the
        // endpointing latency as you experience it.
        const s = io.metrics.sinceLoud();
        io.vadEvent(`speech end${s === null ? "" : ` · respuesta +${s.toFixed(1)}s`}`);
        userSpeaking = false;
      }
      io.transcribe("model", content.outputTranscription.text);
    }

    if (content.generationComplete) {
      // Nothing more is coming until turnComplete: the gap after this isn't a stall.
      timers.clearTimeout(stallTimer);
      io.metrics.event("srv generation complete");
      io.vadEvent("generation complete");
    }
    if (content.turnComplete) {
      replyEnded();
      io.metrics.event("srv turn complete");
      io.vadEvent("turn complete");
      if (!ptt) userSpeaking = false;
    }
  }

  return {
    handleMessage,
    micChunkSent,
    connectionOpened() {
      gotMessage = false;
      loudSinceReactionMs = 0;
      deafDetected = false;
    },
    get gotMessage() {
      return gotMessage;
    },
    get userSpeaking() {
      return userSpeaking;
    },
    set userSpeaking(v: boolean) {
      userSpeaking = v;
    },
  };
}
