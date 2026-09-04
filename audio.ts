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
 * for FLUSH_MS before a timeout sends it anyway. Noise suppression, when there
 * is any, comes from the echo-cancel module upstream (see aec.ts) rather than
 * from a filter in this pipe.
 */
export function startMic(
  onChunk: (chunk: Uint8Array) => void,
  { target }: { target?: string } = {},
): Mic {
  const record = new Deno.Command("pw-record", {
    args: [
      ...(target ? ["--target", target] : []),
      "--rate", "16000",
      "--channels", "1",
      "--format", "s16",
      "--latency", "20ms",
      "--raw",
      "-",
    ],
    stdout: "piped",
    stderr: "null",
  }).spawn();

  /** Partial frame carried over between reads; fresh per capture session. */
  let pending = new Uint8Array(0);
  let flushTimer: number | undefined;

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
    if (pending.length === 0) return;
    const tail = pending;
    pending = new Uint8Array(0);
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
      try {
        record.kill("SIGTERM");
      } catch { /* already gone */ }
      await record.status.catch(() => {});
    },
  };
}

/** 40 ms at 24 kHz s16 mono; what the idle stream is fed. */
const KEEPALIVE_MS = 40;
const KEEPALIVE_BYTES = KEEPALIVE_MS * 48;

/**
 * Playback queue on top of an always-running `pw-play`.
 *
 * The stream is never left starving: while there is nothing to play it is fed
 * silence, so the sink never suspends and the stream never underruns between
 * turns — both of which crackle through the first moments of the next reply.
 *
 * On barge-in, emptying the queue is not enough: bytes already handed to
 * pw-play would keep playing. So `interrupt()` kills the process and starts a
 * fresh one, primed with silence, ready for the next reply.
 */
export class Speaker {
  /** PipeWire node to play into; the default sink when unset. */
  #target?: string;
  #proc: Deno.ChildProcess | null = null;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #queue: Uint8Array[] = [];
  #pumping = false;
  #keepalive: number | undefined;
  /** Bumped on every interruption to invalidate an in-flight write. */
  #generation = 0;
  /** When the audio handed over so far runs out, by its byte count (24 kHz s16). */
  #playUntil = 0;

  constructor({ target }: { target?: string } = {}) {
    this.#target = target;
    this.#spawn();
  }

  write(chunk: Uint8Array): void {
    const now = performance.now();
    this.#playUntil = Math.max(now, this.#playUntil) + chunk.length / 48;
    this.#stopKeepalive();
    this.#queue.push(chunk);
    if (!this.#pumping) void this.#pump();
  }

  /** Whether sound should be coming out right now — what the mic may pick up. */
  get playing(): boolean {
    return performance.now() < this.#playUntil;
  }

  /** Drops everything pending and stops playback immediately. */
  interrupt(): void {
    this.#queue.length = 0;
    this.#generation++;
    this.#playUntil = 0;
    this.#reset();
    this.#spawn();
  }

  close(): void {
    this.#queue.length = 0;
    this.#generation++;
    this.#playUntil = 0;
    this.#reset();
  }

  async #pump(): Promise<void> {
    this.#pumping = true;
    try {
      while (this.#queue.length > 0) {
        const generation = this.#generation;
        this.#spawn();
        const chunk = this.#queue.shift()!;
        try {
          await this.#writer!.write(chunk);
        } catch {
          // pw-play died (interrupted, or an error): drop it and carry on.
          if (generation === this.#generation) this.#reset();
        }
      }
    } finally {
      this.#pumping = false;
      this.#startKeepalive();
    }
  }

  #startKeepalive(): void {
    if (this.#keepalive !== undefined) return;
    this.#keepalive = setInterval(() => {
      // An empty queue is not an idle stream: audio arrives in bursts ahead of
      // playback and sits in the pipe, and silence appended behind it would land
      // mid-phrase. Only feed the stream once everything handed over has played out.
      if (this.playing || this.#pumping || this.#queue.length > 0 || !this.#writer) return;
      this.#writer.write(new Uint8Array(KEEPALIVE_BYTES)).catch(() => {});
    }, KEEPALIVE_MS);
  }

  #stopKeepalive(): void {
    clearInterval(this.#keepalive);
    this.#keepalive = undefined;
  }

  #spawn(): void {
    if (this.#proc) return;
    this.#proc = new Deno.Command("pw-play", {
      args: [
        ...(this.#target ? ["--target", this.#target] : []),
        "--rate", "24000",
        "--channels", "1",
        "--format", "s16",
        "--latency", "40ms",
        "--raw",
        "-",
      ],
      stdin: "piped",
      stdout: "null",
      stderr: "null",
    }).spawn();
    this.#writer = this.#proc.stdin.getWriter();
    this.#startKeepalive();
  }

  #reset(): void {
    this.#stopKeepalive();
    const proc = this.#proc;
    const writer = this.#writer;
    this.#proc = null;
    this.#writer = null;
    try {
      writer?.releaseLock();
    } catch { /* a write was in flight */ }
    try {
      proc?.kill("SIGKILL");
    } catch { /* already gone */ }
    proc?.status.catch(() => {});
  }
}
