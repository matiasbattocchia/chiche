/**
 * tests/audio.ts — the PipeWire layer alone: no API, no app.
 *
 * Raises the echo-cancel process exactly as aec.ts does (aec.conf, quantum 480),
 * plays a far-end clip into its sink with pw-play at the app's rate and captures
 * its source with pw-record at the app's rate — plus the raw master, for reference.
 * Then it measures what the app can't see: echo residual per window, echo delay,
 * whether the far end even dominated the window (else "suppression" means nothing),
 * every driver's quantum, xruns, and whether the process survived.
 *
 *   bun tests/audio.ts [null|speaker] [seconds=20]
 *
 *   null     deterministic: far end into a null sink, near end = its monitor, so the
 *            "echo" is a perfect copy. Silent. Tests the module, the quantum, the process.
 *   speaker  acoustic: the real speaker and mic. Tests the whole rig. Makes sound.
 */
import { $ } from "bun";

const MODE = (process.argv[2] ?? "null") as "null" | "speaker";
const SECONDS = parseInt(process.argv[3] ?? "20", 10);
const FAR = "tests/fixtures/far.raw"; // 24 kHz s16 mono, what pw-play gets in the app
const SOURCE = "gemini_aec_source", SINK = "gemini_aec_sink", NULL_SINK = "aec_test_null";
const QUANTUM = 480;
const OUT = "data/audio-test";
await $`mkdir -p ${OUT}`.quiet();

const sleep = (ms: number) => Bun.sleep(ms);
const pactl = async (...a: string[]) => (await $`pactl ${a}`.quiet().nothrow()).text();
const forceQuantum = (q: number) => $`pw-metadata -n settings 0 clock.force-quantum ${q}`.quiet();

// --- the rig, as aec.ts raises it, with the targets this mode needs ---
let conf = await Bun.file("aec.conf").text();
if (MODE === "null") {
  await pactl("load-module", "module-null-sink", `sink_name=${NULL_SINK}`);
  conf = conf.replace("source.props = {", `capture.props = { target.object = ${NULL_SINK} stream.capture.sink = true }\n            playback.props = { target.object = ${NULL_SINK} }\n            source.props = {`);
}
const confPath = `${OUT}/aec.conf`;
await Bun.write(confPath, conf);
const daemonLog = Bun.file(`${OUT}/aec.log`).writer();
const daemon = Bun.spawn(["pipewire", "-c", `${process.cwd()}/${confPath}`], { stdout: "ignore", stderr: "pipe" });
(async () => { for await (const c of daemon.stderr) daemonLog.write(c); daemonLog.end(); })();
for (let i = 0; i < 40 && !(await pactl("list", "short", "sources")).includes(SOURCE); i++) await sleep(100);
if (!(await pactl("list", "short", "sources")).includes(SOURCE)) { console.error("the AEC source never appeared"); daemon.kill(); process.exit(1); }
await forceQuantum(QUANTUM);
const master = MODE === "null" ? `${NULL_SINK}.monitor` : (await pactl("get-default-source")).trim();
// a monitor is captured by naming the sink and asking for its sink side
const rawTarget = MODE === "null" ? ["--target", NULL_SINK, "-P", "{ stream.capture.sink = true }"] : ["--target", master];

// --- streams, exactly the app's ---
const aecRec = Bun.spawn(["pw-record", "--target", SOURCE, "--rate", "16000", "--channels", "1", "--format", "s16", "--latency", "10ms", "--raw", `${OUT}/aec.raw`], { stdout: "ignore", stderr: "ignore" });
const rawRec = Bun.spawn(["pw-record", ...rawTarget, "--rate", "16000", "--channels", "1", "--format", "s16", "--latency", "10ms", "--raw", `${OUT}/raw.raw`], { stdout: "ignore", stderr: "ignore" });
await sleep(500);
const t0 = performance.now();
const play = Bun.spawn(["pw-play", "--target", SINK, "--rate", "24000", "--channels", "1", "--format", "s16", "--latency", "10ms", "--raw", FAR], { stdout: "ignore", stderr: "ignore" });
// sample the graph while it plays
const samples: string[] = [];
const sampler = setInterval(async () => {
  const top = (await $`pw-top -b -n 2`.quiet().nothrow()).text().split("\n");
  const second = top.slice(top.findLastIndex((l) => l.startsWith("S   ID")) + 1);
  const drivers = second.filter((l) => /^R/.test(l)).map((l) => l.trim().split(/\s+/)).filter((f) => f[2] !== "0").map((f) => `${f[f.length - 1].replace(/.*HiFi__/, "")}@${f[2]}`);
  samples.push(`${((performance.now() - t0) / 1000).toFixed(0)}s ${drivers.join(" ")}`);
}, 2000);
await Promise.race([play.exited, sleep(SECONDS * 1000)]);
clearInterval(sampler);
play.kill(); await sleep(300); aecRec.kill(); rawRec.kill();
const alive = daemon.exitCode === null;
await forceQuantum(0);
daemon.kill(); await daemon.exited;
if (MODE === "null") for (const l of (await pactl("list", "short", "modules")).split("\n")) if (l.includes(NULL_SINK)) await pactl("unload-module", l.split("\t")[0]);

// --- analysis ---
const s16 = async (p: string) => { const b = new Int16Array(await Bun.file(p).arrayBuffer()); const f = new Float32Array(b.length); for (let i = 0; i < b.length; i++) f[i] = b[i] / 32768; return f; };
const aec = await s16(`${OUT}/aec.raw`), raw = await s16(`${OUT}/raw.raw`);
const far24 = await s16(FAR); const far = new Float32Array(Math.floor(far24.length * 2 / 3)); for (let i = 0; i < far.length; i++) far[i] = far24[Math.floor(i * 1.5)];
const sr = 16000, W = 2 * sr, L = sr, D = 4; // 2 s windows, lags to 1 s, lag search at 4 kHz
const db = (x: Float32Array, a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return 10 * Math.log10(s / (b - a) + 1e-12); };
const dec = (x: Float32Array, a: number, n: number) => { const o = new Float32Array(Math.floor(n / D)); for (let i = 0; i < o.length; i++) o[i] = x[a + i * D]; return o; };
const rows: string[] = []; const good: number[] = []; let delay = -1;
const n = Math.min(aec.length, raw.length);
for (let s = 0; s + W + L < n; s += W) {
  // the far end lags the capture by the (unknown) start offset: search lag in [0, 1 s]
  const f = dec(far, s, W), m = dec(raw, s, W + L);
  let fm = 0; for (const v of f) fm += v; fm /= f.length; let fe = 0; for (let i = 0; i < f.length; i++) { f[i] -= fm; fe += f[i] * f[i]; }
  let best = 0, bestLag = 0;
  for (let lag = 0; lag < L / D; lag += 2) { let c = 0, me = 0; for (let i = 0; i < f.length; i++) { c += f[i] * m[i + lag]; me += m[i + lag] * m[i + lag]; } const ncc = c / (Math.sqrt(fe * me) + 1e-9); if (ncc > best) { best = ncc; bestLag = lag; } }
  const sup = db(raw, s, s + W) - db(aec, s, s + W);
  const farDominated = best >= 0.4;
  if (farDominated) { good.push(sup); delay = bestLag * D * 1000 / sr; }
  rows.push(`${(s / sr).toFixed(0).padStart(3)}s raw ${db(raw, s, s + W).toFixed(0).padStart(4)} → aec ${db(aec, s, s + W).toFixed(0).padStart(4)} dBFS  sup ${sup.toFixed(0).padStart(3)} dB  ncc ${best.toFixed(2)}${farDominated ? "" : "  (near-end dominated)"}`);
}
const log = await Bun.file(`${OUT}/aec.log`).text();
const xruns = (log.match(/XRun!/g) ?? []).length;
const mean = good.length ? good.reduce((a, b) => a + b) / good.length : NaN;
console.log(`audio · ${MODE} · ${(n / sr).toFixed(1)}s captured · master ${master}`);
for (const r of rows) console.log("  " + r);
console.log(`  drivers: ${samples.join(" | ")}`);
console.log(`\n  suppression (far-dominated windows): mean ${mean.toFixed(0)} dB, min ${Math.min(...good).toFixed(0)} dB · echo delay ${delay.toFixed(0)} ms · xruns ${xruns} · process ${alive ? "alive" : "DIED"}`);
// only the ALSA drivers must sit at 480: streams run at their own rate (pw-record@160 is 10 ms of 16 kHz)
const driversOff = samples.flatMap((s) => s.split(" ").filter((d) => /__(source|sink)@/.test(d) && !d.endsWith(`@${QUANTUM}`)));
const pass = alive && good.length > 0 && mean >= 25 && driversOff.length === 0;
if (driversOff.length) console.log(`  drivers off ${QUANTUM}: ${[...new Set(driversOff)].join(" ")}`);
console.log(`  ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
