/**
 * Acoustic echo cancellation via PipeWire's echo-cancel module.
 *
 * Noise suppression cannot get you out of wearing headphones: it is trained to
 * keep speech, and the model's own voice coming back through the speakers *is*
 * speech. Cancelling it needs the playback signal as a reference, which is what
 * this module does — WebRTC's AEC, with its noise suppression and auto gain
 * along for the ride.
 *
 * Loading it creates a source/sink pair without touching the default devices:
 * we capture from the source and play into the sink, and PipeWire wires the
 * sink through to whatever the real output is. The module is unloaded on exit,
 * so the audio graph is left exactly as we found it.
 */

const SOURCE_NAME = "gemini_aec_source";
const SINK_NAME = "gemini_aec_sink";

const AEC_ARGS = [
  "webrtc.noise_suppression=true",
  "webrtc.high_pass_filter=true",
  "webrtc.gain_control=true",
  "webrtc.transient_suppression=true",
].join(" ");

export interface Aec {
  readonly source: string;
  readonly sink: string;
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

async function pactl(...args: string[]): Promise<string> {
  const { success, stdout, stderr } = await new Deno.Command("pactl", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr).trim());
  return new TextDecoder().decode(stdout).trim();
}

/**
 * Unloads any echo-cancel module we left behind previously.
 *
 * A crash skips our cleanup, and loading a second module under the same node
 * names would leave two of them fighting over the graph.
 */
async function unloadStale(): Promise<void> {
  let modules: string;
  try {
    modules = await pactl("list", "short", "modules");
  } catch {
    return;
  }
  for (const line of modules.split("\n")) {
    if (!line.includes(SOURCE_NAME)) continue;
    const id = line.split("\t")[0];
    await pactl("unload-module", id).catch(() => {});
  }
}

/** Loads the module, or returns null with a reason if it isn't available. */
export async function loadAec(): Promise<Aec | { error: string }> {
  await unloadStale();

  let id: string;
  try {
    id = await pactl(
      "load-module",
      "module-echo-cancel",
      `source_name=${SOURCE_NAME}`,
      `sink_name=${SINK_NAME}`,
      "aec_method=webrtc",
      `aec_args=${AEC_ARGS}`,
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  if (!/^\d+$/.test(id)) return { error: `unexpected pactl output: ${id}` };

  const restoreQuantum = await forceQuantum(AEC_QUANTUM);

  let unloaded = false;
  return {
    source: SOURCE_NAME,
    sink: SINK_NAME,
    async unload() {
      if (unloaded) return;
      unloaded = true;
      await pactl("unload-module", id).catch(() => {});
      await restoreQuantum();
    },
  };
}
