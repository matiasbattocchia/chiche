/**
 * Raw audio capture and playback via PipeWire subprocesses.
 *
 * The Live API speaks mono PCM s16le: 16 kHz in, 24 kHz out. PipeWire handles
 * resampling to and from the hardware's native 48 kHz.
 */

/** 40 ms at 16 kHz mono s16 = 1280 bytes, the chunk size the docs recommend. */
const FRAME_BYTES = 1280;

/**
 * How long a partial frame may sit before being sent anyway. The pipe delivers
 * ~20 ms per read, so one frame interval (2× that) of silence means the
 * producer has genuinely stalled, not just jittered.
 */
const FLUSH_MS = 40;

export interface Mic {
  /** Sends any buffered partial frame immediately (e.g. before closing a turn). */
  flush(): void;
  stop(): Promise<void>;
}

/**
 * Starts microphone capture and hands back 16 kHz chunks as they arrive.
 *
 * Reads (~640 bytes each at 20 ms pipe latency) are coalesced into full
 * FRAME_BYTES frames; at most one partial frame is ever held back, and only
 * for FLUSH_MS after reads stall before a timeout sends it anyway. Nothing is filtered
 * in this pipe: the app has no echo cancellation, and expects headphones.
 */
export function startMic(
  onChunk: (chunk: Uint8Array) => void,
  { target }: { target?: string } = {},
): Mic {
  const record = Bun.spawn([
    "pw-record",
    ...(target ? ["--target", target] : []),
    "--rate", "16000",
    "--channels", "1",
    "--format", "s16",
    "--latency", "10ms",
    "--raw",
    "-",
  ], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });

  /** Partial frame carried over between reads; fresh per capture session. */
  let pending = new Uint8Array(0);
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  // A throwing consumer must not unwind the read loop or a timer, or the mic
  // goes silent for the rest of the run.
  const emit = (chunk: Uint8Array) => {
    try {
      onChunk(chunk);
    } catch { /* dropped chunk */ }
  };

  const flush = () => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    // Emit whole samples only. A read can end on an odd byte, and an odd-length chunk
    // shifts every following sample the server concatenates by one byte — the audio
    // turns to noise until the next odd chunk happens to realign it. Hold the stray
    // byte back for the next read to complete the sample.
    const even = pending.length - (pending.length % 2);
    if (even === 0) return;
    const tail = pending.subarray(0, even);
    pending = pending.subarray(even);
    emit(tail);
  };

  (async () => {
    for await (const buf of record.stdout) {
      clearTimeout(flushTimer);
      let data = buf;
      if (pending.length > 0) {
        data = new Uint8Array(pending.length + buf.length);
        data.set(pending);
        data.set(buf, pending.length);
      }
      let i = 0;
      for (; i + FRAME_BYTES <= data.length; i += FRAME_BYTES) {
        emit(data.subarray(i, i + FRAME_BYTES));
      }
      pending = data.subarray(i);
      if (pending.length > 0) flushTimer = setTimeout(flush, FLUSH_MS);
    }
    flush();
  })().catch(() => {});

  return {
    flush,
    async stop() {
      record.kill("SIGTERM");
      await record.exited;
    },
  };
}

/** One write to the stream: 20 ms at 24 kHz s16 mono. */
const SLICE_MS = 20;
const SLICE_BYTES = SLICE_MS * 48;
/**
 * How far ahead of the playhead the stream is kept fed. Bytes handed to pw-play cannot
 * be taken back, so this is also the most that plays out after an interruption; and
 * it must cover the ticker's jitter, or the stream underruns and crackles.
 */
const LEAD_MS = 200;
const TICK_MS = 10;
const SILENCE = new Uint8Array(SLICE_BYTES);

/**
 * Playback on one `pw-play` that lives for the whole run.
 *
 * The stream is opened once and never closed, paused or replaced: a ticker keeps it fed
 * LEAD_MS ahead of the playhead, with the model's audio when there is some queued and
 * with silence otherwise, so the sink never suspends and the stream never underruns.
 *
 * Because only LEAD_MS is ever in flight, an interruption is just dropping the queue:
 * what is already handed over plays out, silence follows, and the stream goes on as if
 * nothing happened. No process is killed and the next reply starts on a warm stream.
 */
export class Speaker {
  #proc: Bun.Subprocess<"pipe", "ignore", "ignore">;
  #sink: { write(chunk: Uint8Array): number; flush(): number | Promise<number>; end(): void };
  #queue: Uint8Array[] = [];
  #ticker: ReturnType<typeof setInterval>;
  /** The stream's timeline, ms: where the bytes written so far end. */
  #writtenUntil = 0;
  /** Where the *model's* bytes written so far end — silence past this point. */
  #audioUntil = 0;

  constructor({ target }: { target?: string } = {}) {
    this.#proc = Bun.spawn([
      "pw-play",
      ...(target ? ["--target", target] : []),
      "--rate", "24000",
      "--channels", "1",
      "--format", "s16",
      "--latency", "10ms",
      "--raw",
      "-",
    ], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    this.#sink = this.#proc.stdin;
    this.#ticker = setInterval(() => this.#tick(), TICK_MS);
    this.#tick();
  }

  write(chunk: Uint8Array): void {
    this.#queue.push(chunk);
  }

  /** Whether the model's audio should be coming out right now — what the mic may pick up. */
  get playing(): boolean {
    return this.#queue.length > 0 || performance.now() < this.#audioUntil;
  }

  /** Drops everything not yet handed over; what is (at most LEAD_MS) plays out. */
  interrupt(): void {
    this.#queue.length = 0;
  }

  close(): void {
    clearInterval(this.#ticker);
    this.#queue.length = 0;
    try {
      this.#sink.end();
    } catch { /* already gone */ }
    this.#proc.kill("SIGTERM");
  }

  /** Feeds the stream up to LEAD_MS ahead: queued audio first, silence when there is none. */
  #tick(): void {
    const now = performance.now();
    // Behind the playhead means the pipe ran dry (a stall, a suspended laptop): restart
    // the lead from now rather than pouring in a backlog that would play late.
    if (this.#writtenUntil < now) this.#writtenUntil = now;
    let wrote = false;
    while (this.#writtenUntil - now < LEAD_MS) {
      const slice = this.#next();
      try {
        this.#sink.write(slice ?? SILENCE);
      } catch {
        return; // pw-play is gone; close() is on its way
      }
      wrote = true;
      this.#writtenUntil += (slice ?? SILENCE).length / 48;
      if (slice) this.#audioUntil = this.#writtenUntil;
    }
    if (wrote) void this.#sink.flush();
  }

  /** Up to one slice of queued audio, or null when the queue is empty. */
  #next(): Uint8Array | null {
    const head = this.#queue[0];
    if (!head) return null;
    if (head.length <= SLICE_BYTES) {
      this.#queue.shift();
      return head;
    }
    this.#queue[0] = head.subarray(SLICE_BYTES);
    return head.subarray(0, SLICE_BYTES);
  }
}
