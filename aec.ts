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

/** Node names declared in aec.conf. */
const SOURCE_NAME = "gemini_aec_source";
const SINK_NAME = "gemini_aec_sink";

const CONF = new URL("aec.conf", import.meta.url);
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

async function pwMetadata(...args: string[]): Promise<string | null> {
  try {
    const { success, stdout } = await new Deno.Command("pw-metadata", {
      args: ["-n", "settings", ...args],
      stdout: "piped",
      stderr: "null",
    }).output();
    return success ? new TextDecoder().decode(stdout) : null;
  } catch {
    return null;
  }
}

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
  try {
    const { stdout } = await new Deno.Command("pactl", {
      args: ["list", "short", "sources"],
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(stdout).includes(SOURCE_NAME);
  } catch {
    return false;
  }
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
    const { stdout } = await new Deno.Command("pactl", {
      args: ["-f", "json", "list", "clients"],
      stdout: "piped",
      stderr: "null",
    }).output();
    clients = JSON.parse(new TextDecoder().decode(stdout));
  } catch {
    return;
  }
  for (const { properties: p = {} } of clients) {
    if (p["config.name"] !== CONF.pathname || !p["pipewire.sec.pid"]) continue;
    await new Deno.Command("kill", { args: ["-TERM", p["pipewire.sec.pid"]], stderr: "null" })
      .output().catch(() => {});
    await sleep(200);
  }
}

/** Raises the module, or returns null with a reason if it isn't available. */
export async function loadAec(): Promise<Aec | { error: string }> {
  await killStale();

  let child: Deno.ChildProcess;
  try {
    await Deno.mkdir("data", { recursive: true });
    const log = await Deno.open(LOG_FILE, { write: true, create: true, truncate: true });
    child = new Deno.Command("pipewire", {
      args: ["-c", CONF.pathname],
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).spawn();
    child.stderr.pipeTo(log.writable).catch(() => {});
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  let unloaded = false;
  // Never settles after our own unload: only an unasked-for death is news.
  const died: Promise<string> = child.status.then((s) => {
    if (unloaded) return new Promise<string>(() => {});
    const how = s.signal ? `señal ${s.signal}` : `código ${s.code}`;
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
      try {
        child.kill("SIGTERM");
        await child.status;
      } catch { /* already gone */ }
      await restoreQuantum();
    },
  };
}
