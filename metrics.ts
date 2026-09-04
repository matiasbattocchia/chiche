/**
 * metrics.ts — the audio timeline, for debugging endpointing.
 *
 * One log per run with two interleaved columns: what the mic sends (level per
 * window against a running noise floor, and whether the speaker was playing at the
 * time) and every server event as it arrives. Endpointing questions — did the VAD
 * hang because the room never went quiet, or did the room go quiet and the server
 * sit on it — are answered by reading the columns side by side.
 */

/** Aggregation window; 4 lines a second is readable and still shows word gaps. */
const WINDOW_MS = 250;
/** 16 kHz s16 mono. */
const BYTES_PER_MS = 32;
/** Windows kept to estimate the noise floor: the quietest of the last 10 s. */
const FLOOR_WINDOWS = 40;
/**
 * A window counts as voice when it clears both: this far above the floor, and an
 * absolute level — noise suppression can push the floor so low that breathing clears
 * the relative test alone.
 */
const LOUD_ABOVE_FLOOR_DB = 12;
const LOUD_MIN_DB = -45;

const BAR_MIN_DB = -60;
const BAR_WIDTH = 30;

export interface Metrics {
  /** One mic frame, sent or withheld; aggregated into windows before logging. */
  frame(chunk: Uint8Array, sent: boolean, playing: boolean): void;
  event(text: string): void;
  /** Seconds since the mic last rose clearly above the noise floor; null if never. */
  sinceLoud(): number | null;
  close(): void;
}

const dbfs = (rms: number) => rms > 0 ? 20 * Math.log10(rms / 32768) : -Infinity;
const fmtDb = (db: number) => isFinite(db) ? db.toFixed(1).padStart(6) : "  -inf";

export function openMetrics(path: string): Metrics {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) Deno.mkdirSync(dir, { recursive: true });
  const file = Deno.openSync(path, { write: true, create: true, truncate: true });
  const encoder = new TextEncoder();
  const start = performance.now();
  const now = () => (performance.now() - start) / 1000;
  const line = (s: string) => file.writeSync(encoder.encode(`${now().toFixed(3).padStart(8)} ${s}\n`));

  // Current window.
  let sumSq = 0;
  let count = 0;
  let peak = 0;
  let windowBytes = 0;
  let anySent = false;
  let anyWithheld = false;
  let anyPlaying = false;

  const history: number[] = [];
  let lastLoudAt: number | null = null;

  const flush = () => {
    const rms = count ? Math.sqrt(sumSq / count) : 0;
    const level = dbfs(rms);
    const peakDb = dbfs(peak);
    history.push(level);
    if (history.length > FLOOR_WINDOWS) history.shift();
    const floor = Math.min(...history);
    const loud = level > floor + LOUD_ABOVE_FLOOR_DB && level > LOUD_MIN_DB;
    if (loud) lastLoudAt = now();

    const fill = Math.round(Math.max(0, Math.min(1, (level - BAR_MIN_DB) / -BAR_MIN_DB)) * BAR_WIDTH);
    const bar = "▮".repeat(fill).padEnd(BAR_WIDTH);
    const flags = [
      loud ? "voz" : "   ",
      anyPlaying ? "reproduciendo" : "             ",
      anyWithheld && !anySent ? "silenciado" : anyWithheld ? "parcial" : "",
    ].join(" ");
    line(`mic ${fmtDb(level)} dBFS  pico ${fmtDb(peakDb)}  piso ${fmtDb(floor)}  ${bar} ${flags}`.trimEnd());

    sumSq = 0;
    count = 0;
    peak = 0;
    windowBytes = 0;
    anySent = anyWithheld = anyPlaying = false;
  };

  return {
    frame(chunk, sent, playing) {
      if (chunk.byteOffset % 2 === 0) {
        const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength >> 1);
        for (let i = 0; i < samples.length; i++) {
          const s = samples[i];
          sumSq += s * s;
          const a = Math.abs(s);
          if (a > peak) peak = a;
        }
        count += samples.length;
      }
      windowBytes += chunk.byteLength;
      if (sent) anySent = true;
      else anyWithheld = true;
      if (playing) anyPlaying = true;
      if (windowBytes >= WINDOW_MS * BYTES_PER_MS) flush();
    },
    event(text) {
      line(text);
    },
    sinceLoud() {
      return lastLoudAt === null ? null : now() - lastLoudAt;
    },
    close() {
      if (count > 0) flush();
      file.close();
    },
  };
}
