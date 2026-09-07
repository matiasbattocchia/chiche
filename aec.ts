/**
 * Acoustic echo cancellation via PipeWire's echo-cancel module.
 *
 * Noise suppression cannot get you out of wearing headphones: it is trained to
 * keep speech, and the model's own voice coming back through the speakers *is*
 * speech. Cancelling it needs the playback signal as a reference, which is what
 * this module does — WebRTC's AEC, with its noise suppression and auto gain
 * along for the ride.
 *
 * The module runs in a PipeWire process of our own (`pipewire -c aec.conf`), not
 * inside pipewire-pulse: see aec.conf for why. It creates a source/sink pair
 * without touching the default devices: we capture from the source and play into
 * the sink, and PipeWire wires the sink through to whatever the real output is.
 * The process is killed on exit, so the audio graph is left exactly as we found it.
 */

import { mkdir } from "node:fs/promises";

/** Node names declared in aec.conf. */
const SOURCE_NAME = "gemini_aec_source";
const SINK_NAME = "gemini_aec_sink";

const CONF = new URL("aec.conf", import.meta.url);
const CONF_PATH = decodeURIComponent(CONF.pathname);
const LOG_FILE = "data/aec.log";

export interface Aec {
  readonly source: string;
  readonly sink: string;
  /** Resolves if the module's process dies on its own — the AEC is gone from then on. */
  readonly died: Promise<string>;
  unload(): Promise<void>;
}

/**
 * The WebRTC canceller works in 10 ms blocks and the module feeds it graph-quantum-
 * sized buffers: any other quantum garbles the capture, and a mic-side driver running
 * at a different quantum than the sink-side one makes the module drop half the capture
 * after playback. Only the global force pins every driver, so it is set for the run
 * and put back afterwards — the same lifecycle as the module itself.
 */
const AEC_QUANTUM = 480;

/** Runs a command to completion; null when it fails or isn't there. */
async function run(cmd: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

const pwMetadata = (...args: string[]) => run(["pw-metadata", "-n", "settings", ...args]);

/** Forces the graph quantum; returns a restorer for the previous value. */
async function forceQuantum(frames: number): Promise<() => Promise<void>> {
  const before = (await pwMetadata())?.match(/clock\.force-quantum' value:'(\d+)'/)?.[1] ?? "0";
  await pwMetadata("0", "clock.force-quantum", String(frames));
  return async () => {
    await pwMetadata("0", "clock.force-quantum", before);
  };
}

/** True once the module's source is in the graph. */
async function sourcePresent(): Promise<boolean> {
  return ((await run(["pactl", "list", "short", "sources"])) ?? "").includes(SOURCE_NAME);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Kills the process a previous run left behind.
 *
 * A crash skips our cleanup, and a second module under the same node names would
 * leave two of them fighting over the graph. The daemon knows its clients by the
 * config they run and the pid the kernel vouched for, so no pid file to trust.
 */
async function killStale(): Promise<void> {
  let clients: { properties?: Record<string, string> }[];
  try {
    clients = JSON.parse((await run(["pactl", "-f", "json", "list", "clients"])) ?? "[]");
  } catch {
    return;
  }
  for (const { properties: p = {} } of clients) {
    if (p["config.name"] !== CONF_PATH || !p["pipewire.sec.pid"]) continue;
    try {
      process.kill(parseInt(p["pipewire.sec.pid"], 10), "SIGTERM");
    } catch { /* gone already */ }
    await sleep(200);
  }
}

/** Raises the module, or returns null with a reason if it isn't available. */
export async function loadAec(): Promise<Aec | { error: string }> {
  await killStale();

  let child: Bun.Subprocess<"ignore", "ignore", "pipe">;
  try {
    await mkdir("data", { recursive: true });
    child = Bun.spawn(["pipewire", "-c", CONF_PATH], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const log = Bun.file(LOG_FILE).writer();
    (async () => {
      for await (const chunk of child.stderr) log.write(chunk);
      await log.end();
    })().catch(() => {});
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  let unloaded = false;
  // Never settles after our own unload: only an unasked-for death is news.
  const died: Promise<string> = child.exited.then((code) => {
    if (unloaded) return new Promise<string>(() => {});
    const how = child.signalCode ? `señal ${child.signalCode}` : `código ${code}`;
    return `el proceso del módulo murió (${how}) — ver ${LOG_FILE}`;
  });

  // The nodes take a moment to appear; a config error shows as the process exiting.
  for (let i = 0; i < 40 && !(await sourcePresent()); i++) {
    const gone = await Promise.race([died, sleep(100).then(() => null)]);
    if (gone !== null) return { error: gone };
  }
  if (!(await sourcePresent())) {
    unloaded = true;
    child.kill("SIGTERM");
    return { error: `${SOURCE_NAME} nunca apareció — ver ${LOG_FILE}` };
  }

  const restoreQuantum = await forceQuantum(AEC_QUANTUM);

  return {
    source: SOURCE_NAME,
    sink: SINK_NAME,
    died,
    async unload() {
      if (unloaded) return;
      unloaded = true;
      child.kill("SIGTERM");
      await child.exited;
      await restoreQuantum();
    },
  };
}
