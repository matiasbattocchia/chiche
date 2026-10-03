// main.ts — chiche: boot, wiring, the mic's gate, the meters, teardown.
//
// Boot: LANG → liquen (started here, or the one already running) → the mixer unmuted,
// pw-record → Gemini, with INSTRUCTIONS.md as its system instruction when there is one.
// Teardown, on Ctrl-C or SIGTERM: close Gemini, stop the audio, close the door (so the hang-up
// isn't read as unexpected), `liquen stop` and wait for it, close the logs. `--no-liquen` skips
// liquen and the door: the voice alone, to test the audio; `input` calls get an error. `--say-hi`
// has the voice take the first turn. `--vad` leaves the turns to the server's activity
// detection: the gate still decides what is sent, and closing it sends silence. `--fresh`
// starts a new voice session instead of resuming the last run's. `--session <name>` picks the
// conversation (default `mind`): the coding agent's room behind the door (`liquen repl --session
// <name>` shows the same one) and the voice session resumed under that name.

import { encodeHex } from "@std/encoding/hex";
import { dirname, fromFileUrl, join } from "@std/path";
import { TextLineStream } from "@std/streams";
import { Audio, type Device, type Mixer, mixer, unmute, VOICE_RATE, watchMixer } from "./audio.ts";
import { INPUT_TOOL, MODEL, Scheduling, Voice } from "./gemini.ts";
import { keyCode, keyName, Keys } from "./keys.ts";
import { clip, Door, errorOf, headingsOf, isReply, isSaying, textOf, toolUseOf } from "./liquen.ts";
import { Log } from "./log.ts";
import { BOLD, DIM, GREEN, Meter, RED, RESET, Terminal, YELLOW } from "./term.ts";

const ROOT = dirname(fromFileUrl(import.meta.url));
const DATA = join(ROOT, "data");
const LIQUEN_BOOT_MS = 20_000;
/** The meters' refresh. */
const STATUS_MS = 66;

/** Deno colors its output even into a pipe; the timeline is plain text. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const term = new Terminal();
globalThis.addEventListener("unload", () => term.unpin());

// ── language ────────────────────────────────────────────────────────────────

/** `es_AR.UTF-8` → `es-AR`; unset, `C` or `POSIX` → `en-US`. */
export function languageOf(lang: string | undefined): string {
  const bare = (lang ?? "").split(".")[0].split("@")[0];
  if (!bare || bare === "C" || bare === "POSIX") return "en-US";
  return bare.replace("_", "-");
}

/** A language code's English name ("es-AR" → "Spanish (Argentina)"), or the code itself. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code; // not a code Intl knows
  }
}

// ── children ────────────────────────────────────────────────────────────────

/** A long-lived child whose output lines go to `onLine`. */
function child(cmd: string[], cwd: string, onLine: (line: string) => void) {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  for (const stream of [p.stdout, p.stderr]) {
    (async () => {
      for await (
        const line of stream.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream())
      ) {
        const plain = line.replace(ANSI, "");
        if (plain.trim()) onLine(plain);
      }
    })().catch(() => {});
  }
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── boot ────────────────────────────────────────────────────────────────────

const user = Deno.env.get("USER") ?? (await import("node:os")).userInfo().username;
const language = languageOf(Deno.env.get("LANG"));
const apiKey = Deno.env.get("GEMINI_API_KEY");
if (!apiKey) {
  term.error("GEMINI_API_KEY is not set (it goes in .env)");
  Deno.exit(1);
}
const FLAGS = ["--no-liquen", "--say-hi", "--vad", "--fresh"];
const args = [...Deno.args];
/** --session <name>: the conversation, coding agent and voice alike; liquen's default is `mind`. */
const si = args.indexOf("--session");
const sessionName = si >= 0 ? args.splice(si, 2)[1] ?? "" : "mind";
/** --no-liquen: the voice alone, to test the audio. No coding agent. */
const noLiquen = args.includes("--no-liquen");
/** --say-hi: the voice takes the first turn. */
const sayHi = args.includes("--say-hi");
/** --vad: the server's activity detection takes the turns, no activityStart/End. */
const vad = args.includes("--vad");
/** --fresh: a new voice session, not the last run's resumed. */
const fresh = args.includes("--fresh");
const unknown = args.filter((a) => !FLAGS.includes(a));
if (unknown.length) {
  term.error(
    `unknown argument ${unknown.join(" ")} (the ones there are: ${
      FLAGS.join(" ")
    } --session <name>)`,
  );
  Deno.exit(1);
}
// liquen's session names (its session.ts): they go in addresses and paths
const SESSION_NAME = /^[a-z][a-z0-9_-]*$/;
if (!SESSION_NAME.test(sessionName)) {
  const near = sessionName.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "");
  term.error(
    `--session "${sessionName}" can't name a session: it takes only a to z without accents ` +
      `or ñ, digits, - and _, and starts with a letter${
        SESSION_NAME.test(near) ? `. Try --session ${near}` : ""
      }`,
  );
  Deno.exit(1);
}
let pushKey: number | undefined, toggleKey: number | undefined;
try {
  pushKey = keyCode(Deno.env.get("CHICHE_PUSH_KEY") ?? "space");
  toggleKey = keyCode(Deno.env.get("CHICHE_TOGGLE_KEY") ?? "m");
} catch (e) {
  term.error(`CHICHE_PUSH_KEY / CHICHE_TOGGLE_KEY: ${(e as Error).message}`);
  Deno.exit(1);
}
if (pushKey !== undefined && pushKey === toggleKey) {
  term.error("CHICHE_PUSH_KEY and CHICHE_TOGGLE_KEY are the same key");
  Deno.exit(1);
}

const log = await Log.open(ROOT);
/**
 * INSTRUCTIONS.md, when there is one; else the voice has no system instruction. {{LANG}} is the
 * language's English name ("Spanish (Argentina)"): native audio models choose their language and
 * don't take the speech config's code for it, but the system instructions can restrict it
 * (ai.google.dev/gemini-api/docs/live-guide).
 */
const instructions = await Deno.readTextFile(join(ROOT, "INSTRUCTIONS.md")).then(
  (t) => t.replaceAll("{{LANG}}", languageName(language)),
  (e) => {
    if (e instanceof Deno.errors.NotFound) return undefined;
    throw e;
  },
);

// ── the voice's session, across runs ────────────────────────────────────────

/**
 * The voice's session outlives a run: its latest handle is kept here, and the next run resumes
 * it, remembering what was said. Google's session docs: "Resumption tokens are valid for 2 hr
 * after the last sessions termination". A resumed session keeps the system instruction it
 * started with (measured, see gemini.ts), so a changed INSTRUCTIONS.md, input tool, language,
 * model or --vad starts a new one, and so does --fresh. One per --session name, all in one file (log/
 * keeps its folders for the runs).
 */
const SESSIONS = join(ROOT, "log", "sessions.json");
/** The 2 hours, less a margin for the clocks. */
const RESUME_MS = 115 * 60 * 1000;
interface SavedSession {
  handle: string;
  /** When the session was last seen: the latest handle, or the run's end. */
  savedAt: number;
  /** What a resumed session can't change: see above. */
  key: string;
}
const sessionKey = encodeHex(
  await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({ instructions, tool: INPUT_TOOL, language, vad, model: MODEL }),
    ),
  ),
);

function savedSessions(): Record<string, SavedSession> {
  try {
    return JSON.parse(Deno.readTextFileSync(SESSIONS));
  } catch {
    return {};
  }
}

/** The last run's session, when it can be resumed; else why not. */
function lastSession(): { handle: string; ago: number } | { why: string } {
  if (fresh) return { why: "--fresh" };
  const s = savedSessions()[sessionName];
  if (!s) return { why: "no earlier session" };
  const ago = Date.now() - s.savedAt;
  if (s.key !== sessionKey) {
    return { why: "INSTRUCTIONS.md, the input tool, the language or --vad changed" };
  }
  if (ago > RESUME_MS) return { why: `the last one ended ${Math.round(ago / 60_000)} min ago` };
  return { handle: s.handle, ago };
}

let lastHandle: string | undefined;
function saveSession() {
  if (!lastHandle) return;
  const all = savedSessions();
  all[sessionName] = { handle: lastHandle, savedAt: Date.now(), key: sessionKey };
  try {
    Deno.writeTextFileSync(SESSIONS, JSON.stringify(all, null, 2) + "\n");
  } catch (e) {
    log.line("session", `not saved: ${(e as Error).message}`);
  }
}

// ── the conversation, in the timeline ───────────────────────────────────────

/**
 * The conversation's lines go on the timeline as `chat`: what was said, what the voice sent
 * the coding agent and what came back. When the server no longer has a session, their tail is
 * what the new one starts from.
 */
function chat(text: string) {
  log.line("chat", text.replaceAll(/\s*\n\s*/g, " "));
}
term.said = (who, text) => chat(`${who} ${text}`);
log.line("boot", `session ${sessionName}`);

/** The run's session, from its boot line above; a timeline line is `<stamp> <tag> <text>`. */
const SESSION_LINE = /^ *\d+\.\d+ boot +session (\S+)$/m;
const CHAT_LINE = /^ *\d+\.\d+ chat +(.*)$/;
const TAIL_LINES = 150, TAIL_CHARS = 16_000;

/**
 * The last chat lines of this session's runs (the ones log/ keeps, this one too; with --fresh,
 * this one only), oldest first.
 */
async function logTail(): Promise<string | undefined> {
  const base = join(ROOT, "log");
  const runs: string[] = [];
  for await (const e of Deno.readDir(base)) {
    if (e.isDirectory && (!fresh || join(base, e.name) === log.dir)) runs.push(e.name);
  }
  /** Newest run first, each one's lines oldest first. */
  const blocks: string[][] = [];
  let lines = 0, chars = 0;
  for (const run of runs.sort().reverse()) {
    let text: string;
    try {
      text = await Deno.readTextFile(join(base, run, "timeline.log"));
    } catch {
      continue;
    }
    if (text.match(SESSION_LINE)?.[1] !== sessionName) continue;
    const said = text.split("\n").flatMap((l) => l.match(CHAT_LINE)?.[1] ?? []);
    const kept: string[] = [];
    for (let i = said.length - 1; i >= 0; i--) {
      if (lines >= TAIL_LINES || chars + said[i].length > TAIL_CHARS) break;
      kept.unshift(said[i]);
      lines++;
      chars += said[i].length;
    }
    if (kept.length) blocks.push([`[run ${run}]`, ...kept]);
    if (kept.length < said.length) break; // the budget is spent
  }
  return blocks.length ? blocks.reverse().flat().join("\n") : undefined;
}

/** What is up, in boot order; teardown may run before any of it exists. */
const up: {
  liquen?: Deno.ChildProcess;
  door?: Door;
  mixer?: { stop(): void };
  audio?: Audio;
  voice?: Voice;
  keys?: Keys;
  status?: ReturnType<typeof setInterval>;
  updates?: ReturnType<typeof setInterval>;
} = {};
let tearingDown = false;

async function teardown(code = 0) {
  if (tearingDown) return;
  tearingDown = true;
  clearInterval(up.status);
  clearInterval(up.updates);
  term.end();
  term.dim("bye");
  up.keys?.stop();
  await endSession();
  up.voice?.close();
  up.mixer?.stop();
  up.audio?.stop();
  up.door?.close();
  if (up.liquen) {
    log.line("boot", "liquen stop");
    const stop = new Deno.Command("deno", {
      args: ["task", "stop"],
      cwd: ROOT,
      stdout: "null",
      stderr: "piped",
    }).spawn();
    const out = await stop.output();
    const text = new TextDecoder().decode(out.stderr).replace(ANSI, "").trim();
    if (text) log.line("liquen", text);
    await up.liquen.status.catch(() => {});
  }
  log.close();
  term.unpin();
  Deno.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(sig, () => void teardown());
}

// 1. the language is settled above; 2. liquen
log.line("boot", `LANG=${Deno.env.get("LANG")} → ${language}, user ${user}`);
if (vad) {
  term.dim("--vad: the server's activity detection takes the turns");
  log.line("boot", "--vad");
}
if (noLiquen) {
  term.dim("--no-liquen: no coding agent");
  log.line("boot", "--no-liquen");
} else {
  const socket = Door.socket(DATA, user);
  if (await Door.answers(DATA, user)) {
    term.dim(`liquen already runs (${socket}); using it`);
    log.line("boot", "liquen already running");
  } else {
    up.liquen = child(["deno", "task", "start"], ROOT, (l) => log.line("liquen", l));
    const deadline = Date.now() + LIQUEN_BOOT_MS;
    let exited: Deno.CommandStatus | undefined;
    up.liquen.status.then((s) => exited = s);
    while (!(await Door.answers(DATA, user))) {
      if (exited) {
        // a refusal because the org already runs is fine: its door is the one we want
        if (await Door.answers(DATA, user)) break;
        term.error(
          `liquen start exited with ${exited.code} before its door answered; see ${log.dir}/timeline.log`,
        );
        up.liquen = undefined;
        await teardown(1);
      }
      if (Date.now() > deadline) {
        term.error(`no door at ${socket} after ${LIQUEN_BOOT_MS / 1000} s`);
        await teardown(1);
      }
      await sleep(250);
    }
    if (exited) up.liquen = undefined; // it refused: someone else's run, not ours to stop
  }
}

// ── the input tool, wired to the door ───────────────────────────────────────

/**
 * The channel to the voice: the newest `input` call, acknowledged at once and kept open.
 * Nothing maps what the coding agent sends to the call that caused it: the voice sends what it
 * likes, the coding agent answers when it likes, and every line goes through the newest call. An
 * older call gets no more answers and is left open (a function response needs a call id: that
 * is all the call is for).
 */
let channel: string | undefined;
/**
 * The coding agent as the door shows it: idle, or busy and either thinking (the model generates:
 * deltas arrive) or working (its tools run: from a step's first tool use to the next delta).
 * The voice is told each change of state, silently: the word alone. The commands the agent runs
 * are not sent. What it is on is, as notes: each heading of its thinking as it streams in, and
 * what it says between steps; and its answer, as the result.
 */
let state: "idle" | "thinking" | "working" = "idle";
/** The thinking streamed since the step's last tool or text, and how many of its headings went. */
let thinking = "";
let headings = 0;
/** When the coding agent went busy on an input, for the updates. */
let busySince: number | undefined;
/** Whether the coding agent said something final since it went busy: a result, or an error. */
let concluded = false;
/**
 * Whether an input was sent and not yet answered. The door also goes busy with nothing sent:
 * a checkpoint, in the gap after a turn (liquen DESIGN §5). That is housekeeping, not
 * work on an input: no updates count from it, and its end is not a silence to report.
 */
let awaiting = false;
/** The door's last status edge. */
let doorBusy = false;
/** The door hung up on its own: no coding agent until the next run. */
let doorGone = false;
/**
 * While the coding agent is busy and nobody has spoken for this long, an update goes as a
 * WHEN_IDLE answer, so the voice tells the user that both of them are still there.
 */
const UPDATE_QUIET_MS = 30_000;
/** Last time anyone spoke: the mic opening or closing, the voice's audio, a turn completing. */
let lastTalk = performance.now();

/**
 * What a coding agent error means for the work, as the voice hears it; the raw error is the
 * door's line in the log. A 429 is the coding agent's model refusing work: a daily quota used up
 * ("limit: 20 requests per day on Free Tier", measured) refuses every try until the next
 * day, any other clears within minutes.
 */
function trouble(error: string): string {
  const stopped = "it is not working on anything now, and nothing new is coming";
  if (/per ?day/i.test(error)) {
    return "error: the coding agent stopped: its model's quota for today is used up, so it " +
      `can't work again until tomorrow; ${stopped}`;
  }
  if (/\b429\b|RESOURCE_EXHAUSTED/.test(error)) {
    return "error: the coding agent stopped: its model is refusing work for now (too many " +
      `requests); ${stopped}. Sent again in a few minutes, it may work`;
  }
  return `error: the coding agent stopped on a failure (${clip(error, 200)}); ${stopped}`;
}

/** The coding agent stopped on an error. */
function failed(error: string) {
  concluded = true;
  awaiting = false;
  term.dim(`agent error: ${clip(error.replaceAll("\n", " "), 200)}`);
  forward(trouble(error), Scheduling.WHEN_IDLE);
}

/** Answer scheduling that makes the voice speak unless it already has in this answer. */
const unlessSpoken = () => received > 0 ? Scheduling.SILENT : Scheduling.WHEN_IDLE;

/**
 * A line to the voice through the channel, or dropped (work typed in the REPL, say). Shown whole
 * and kept as chat unless `quiet`: the states, which the status row shows instead.
 */
function forward(output: string, scheduling: Scheduling, willContinue = true, quiet = false) {
  const shown = output.trim();
  if (!channel) {
    if (!quiet) term.dim(`(no input call open) ${shown}`);
    return;
  }
  if (!quiet) {
    term.dim(shown);
    chat(output);
  }
  if (!up.voice?.answer({ id: channel, output, scheduling, willContinue })) {
    term.dim("(disconnected; the answer was lost)");
  }
  if (!willContinue) channel = undefined;
}

/** The coding agent changed state; the voice hears of it once, silently. */
function become(next: typeof state) {
  if (state === next) return;
  state = next;
  if (next !== "idle") forward(next, Scheduling.SILENT, true, true);
}

if (!noLiquen) {
  // the coding agent's shell starts in the org's folder
  up.door = await Door.connect(DATA, user, sessionName, join(DATA, "organization"), {
    trace: (d, m) => log.door(d, m),
    event(e) {
      if (toolUseOf(e)) return become("working");
      if (up.door && isSaying(e, up.door.address)) {
        return forward(`note: ${textOf(e)}`, Scheduling.SILENT);
      }
      if (up.door && isReply(e, up.door.address)) {
        concluded = true;
        awaiting = false;
        return forward(`result: ${textOf(e)}`, Scheduling.WHEN_IDLE);
      }
      const error = errorOf(e);
      if (error) return failed(error);
    },
    delta(d) {
      if (d.kind === "error" && d.text) return failed(d.text);
      if (d.kind === "thinking" || d.kind === "text") become("thinking");
      if (d.kind !== "thinking") {
        thinking = "";
        headings = 0;
        return;
      }
      if (!d.text) return;
      // a heading goes out once it is whole: the thinking under it waits for none
      thinking += d.text;
      const all = headingsOf(thinking);
      for (const heading of all.slice(headings)) forward(`note: ${heading}`, Scheduling.SILENT);
      headings = all.length;
    },
    // the door's turn edges; a turn that ended with no result and no error (a silence) is
    // told as one, or the voice goes on telling the user that work is under way
    status(s) {
      doorBusy = s.status === "busy";
      if (s.status === "busy") {
        if (!awaiting) return; // housekeeping (a checkpoint): nothing of the user's runs
        busySince ??= performance.now();
        concluded = false;
        return;
      }
      busySince = undefined;
      const quiet = state !== "idle" && !concluded;
      become("idle");
      if (quiet) {
        forward("idle: the coding agent stopped with nothing to say", Scheduling.WHEN_IDLE);
      }
    },
    hangup(expected) {
      if (expected || tearingDown) return;
      term.error("the door hung up");
      doorGone = true;
      forward("error: the coding agent went away", Scheduling.WHEN_IDLE, false);
    },
  });
}

async function input(callId: string, text: string) {
  // the newer call is the channel from here on; the older one is left open, with nothing
  // more to carry (whether the model minds a call never closed is not measured yet)
  channel = callId;
  term.dim(`input: ${text.trim()}`);
  chat(`input: ${text}`);
  const r = up.door
    ? await up.door.message(text)
    : { ok: false, id: undefined, error: "the coding agent is off (chiche runs with --no-liquen)" };
  if (channel !== callId) return; // cancelled or superseded meanwhile
  // once the voice has spoken this turn, WHEN_IDLE would have it speak again once it's idle
  // (measured: a second answer 0.44 s after the first ended); before it has, WHEN_IDLE is what
  // makes it speak at all (measured: a turn that was only the call, and the user's run
  // log/2026-09-25T17-45-59, where a SILENT "sent" left the user with nothing)
  if (r.ok && typeof r.id === "string") {
    term.dim(`sent (${r.id.slice(-6)})`);
    awaiting = true;
    // sent into a checkpoint: the door is busy already and shows no new edge when the
    // input's turn starts after it, so the wait counts from here
    if (doorBusy) {
      busySince ??= performance.now();
      concluded = false;
    }
    up.voice?.answer({
      id: callId,
      output: "sent",
      scheduling: unlessSpoken(),
      willContinue: true,
    });
  } else {
    term.dim(`not sent: ${r.error}`);
    forward(`error: ${r.error ?? "not sent"}`, unlessSpoken(), false);
  }
}

/**
 * An update while the coding agent is busy, when nobody has spoken for a while
 * (UPDATE_QUIET_MS).
 */
function update() {
  const now = performance.now();
  if (
    busySince === undefined || !channel || open || closing || held || answering ||
    waitingSince !== undefined || up.audio?.playing || now - lastTalk < UPDATE_QUIET_MS
  ) return;
  lastTalk = now; // the next one after another quiet stretch, whether the voice speaks or not
  const s = Math.round((now - busySince) / 1000);
  forward(
    `update: still ${state === "idle" ? "busy" : state}, ${s} s in`,
    Scheduling.WHEN_IDLE,
  );
}

// 3. audio. Two blocks stand between the user and the voice. The mixer's mute (mic and
// speakers) is outside chiche: it clears both at boot, the one thing it does to them, and then
// only shows them. chiche's gate is the other: closed at boot, it follows the last key used
// (push to talk down opens it and up closes it, the toggle flips it), and its opening and
// closing are the user's turn edges (activityStart / End).
const wasMuted = await unmute();
let mix: Mixer = await mixer();
const label = (d: Device) => d.description ? `${d.name} (${d.description})` : d.name;
const volume = (d: Device) =>
  `${Number.isNaN(d.volume) ? "?" : Math.round(d.volume * 100)}%${d.muted ? " muted" : ""}`;
term.line(`mic: ${label(mix.source)}`);
term.line(`speakers: ${label(mix.sink)}`);
term.line(`log: ${log.dir}`);
if (wasMuted.length) {
  term.dim(`unmuted the ${wasMuted.join(" and the ")} (the mixer had them muted)`);
}
log.line("boot", `mic ${label(mix.source)} · speakers ${label(mix.sink)}`);
if (wasMuted.length) log.line("mixer", `unmuted the ${wasMuted.join(" and the ")}`);
up.mixer = watchMixer((m) => {
  const before = mix;
  mix = m;
  for (
    const [what, a, b] of [["mic", before.source, m.source], [
      "speakers",
      before.sink,
      m.sink,
    ]] as const
  ) {
    if (a.name !== b.name) term.line(`${what}: ${label(b)}`);
    else if (a.muted !== b.muted) term.dim(`${what} ${b.muted ? "muted" : "unmuted"} (mixer)`);
  }
  log.line(
    "mixer",
    `mic ${m.source.name} ${volume(m.source)} · speakers ${m.sink.name} ${volume(m.sink)}`,
  );
});

/** The gate. */
let open = false;
/**
 * The gate closed at this moment, and the audio captured up to it is still on its way (see
 * `AudioEvents.chunk`): it is sent, then the turn ends. A stalled capture ends it anyway.
 */
let closing:
  | {
    at: number;
    why: string;
    push: boolean;
    timer: ReturnType<typeof setTimeout>;
    sent: number;
  }
  | undefined;
const TAIL_WAIT_MS = 300;
/**
 * A push-to-talk turn's end waits this long after its tail is sent, and a press before then
 * goes on with the same turn: a user lets go and goes on. In log/2026-09-26T20-26-58 and
 * 22-58-04, of the 20 presses that came after a release and before the voice's answer, 15
 * came within 0.5 s of it, none between 0.5 and 1 s, and 5 at 1.0–1.5 s, as the answer was
 * due (a turn's end to the voice's first audio: median 1.45 s, half of 38 in 1.35–1.8 s).
 * 2 s takes in all 20, and adds 2 s before every answer.
 */
const APPEND_MS = 2_000;
/** A push-to-talk turn whose tail is sent, its end held (APPEND_MS). */
let held: { at: number; timer: ReturnType<typeof setTimeout>; end: () => void } | undefined;
/**
 * --vad: the turn ended, and silence goes in the mic's place until the voice answers. The server
 * ends a turn only on hearing silence: measured 2026-09-25 with a recorded question, streamed
 * zeros got the transcript in 0.6–1.7 s (3 of 3), nothing after it or `audioStreamEnd` got no
 * answer in 12 s (4 of 4). Given up after 10 s, not to stream silence for good.
 */
let silence: { since: number; sent: number } | undefined;
const SILENCE_MAX_MS = 10_000;
/** Chunks sent since the mic last opened. */
let sent = 0;
/** When the user's turn (or the say-hi kick) ended with no answer yet. */
let waitingSince: number | undefined;
/** The voice's answer: under way (between its first content and turnComplete), and its audio. */
let answering = false;
let received = 0, receivedMs = 0;
let link: "connecting" | "live" | "reconnecting" = "connecting";

const chunks = (n: number) => `${n} chunks ${(n * 0.04).toFixed(1)} s`;

/** `push`: the push-to-talk key moved, and a press right after its release goes on with the turn. */
function mic(now: boolean, why: string, push = false) {
  if (now === open) return;
  open = now;
  lastTalk = performance.now();
  if (open) {
    const released = held?.at ?? (closing?.push ? closing.at : undefined);
    if (push && released !== undefined) {
      clearTimeout(held?.timer);
      held = undefined;
      clearTimeout(closing?.timer);
      closing = undefined;
      up.voice?.activityStart(); // does nothing unless the connection is new since the release
      const ms = Math.round(performance.now() - released);
      term.dim(`mic open (${why}), the same turn`);
      log.line("mic", `open (${why}), the same turn, ${ms} ms after the release`);
      return;
    }
    endTurn("the mic opened again"); // a turn still waiting for its tail ends first
    held?.end();
    endSilence("the mic opened");
    sent = 0;
    waitingSince = undefined;
    up.voice?.activityStart();
    term.dim(`mic open (${why})`);
    log.line("mic", `open (${why})`);
  } else {
    closing = {
      at: performance.now(),
      why,
      push,
      timer: setTimeout(() => endTurn(`no capture for ${TAIL_WAIT_MS} ms`), TAIL_WAIT_MS),
      sent,
    };
    log.line("mic", `closed (${why}), sending what was captured until now`);
  }
}

/**
 * The closed gate's tail is sent, or given up `because` of something: the turn ends, or after
 * a push-to-talk release is held to end APPEND_MS later.
 */
function endTurn(because?: string) {
  if (!closing) return;
  clearTimeout(closing.timer);
  const { at, why, push, sent: before } = closing;
  closing = undefined;
  const cut = because ? `, cut short: ${because}` : "";
  const end = () => {
    clearTimeout(held?.timer);
    held = undefined;
    lastTalk = performance.now();
    up.voice?.activityEnd();
    if (up.voice?.connected) {
      waitingSince = performance.now();
      if (vad) silence = { since: waitingSince, sent: 0 };
    }
    term.dim(`mic closed (${why}) · sent ${chunks(sent)}${cut}`);
    log.line(
      "mic",
      `${vad ? "closed, silence follows" : "turn ended"}, sent ${chunks(sent)}, ${
        sent - before
      } after closing${cut}, ${Math.round(performance.now() - at)} ms after the gate closed`,
    );
  };
  if (push && !vad) held = { at, timer: setTimeout(end, APPEND_MS), end };
  else end();
}

/** --vad: the silence after the turn stops, `because` the turn was heard or it won't be. */
function endSilence(because: string) {
  if (!silence) return;
  log.line("mic", `silence stopped (${because}) after ${chunks(silence.sent)}`);
  silence = undefined;
}

/** The voice's first content since the turn ended. */
function answered(what: string) {
  endSilence(`first ${what}`);
  if (waitingSince !== undefined) {
    const ms = Math.round(performance.now() - waitingSince);
    log.line("turn", `first ${what} ${ms} ms after the turn ended`);
    waitingSince = undefined;
  }
  if (!answering) {
    answering = true;
    received = 0;
    receivedMs = 0;
  }
}

up.audio = Audio.start({
  chunk(pcm, at) {
    const sending = open || closing !== undefined;
    const zeros = new Uint8Array(pcm.length);
    if (sending) {
      if (up.voice?.sendAudio(pcm)) sent++;
    } else if (silence) {
      if (performance.now() - silence.since > SILENCE_MAX_MS) {
        endSilence(`no answer in ${SILENCE_MAX_MS / 1000} s`);
      } else if (up.voice?.sendAudio(zeros)) silence.sent++;
    }
    log.micAudio(sending ? pcm : zeros);
    if (closing && at >= closing.at) endTurn();
  },
  window: (w) => log.mic(w),
  died(which, code) {
    term.error(`${which} died (${code})`);
    log.line("audio", `${which} died ${code}`);
  },
});

up.keys = Keys.start({ push: pushKey, toggle: toggleKey }, {
  push(down) {
    const name = keyName(pushKey!);
    log.line("keys", `${name} ${down ? "down" : "up"}`);
    mic(down, down ? name : `${name} released`, true);
  },
  toggle() {
    const name = keyName(toggleKey!);
    log.line("keys", name);
    mic(!open, name);
  },
  quit: () => void teardown(),
});
if (up.keys) {
  const help = [
    pushKey !== undefined && `hold ${keyName(pushKey)} to talk`,
    toggleKey !== undefined && `${keyName(toggleKey)} opens and closes the mic`,
    "the mic starts closed",
  ].filter(Boolean).join(" · ");
  term.line(`keys: ${help}`);
  setTimeout(() => {
    if (up.keys) log.line("keys", up.keys.exact ? "releases reported" : "releases inferred");
  }, 500);
}

// the meters, pinned below everything: what the mic hears and the gate sends, what the voice
// sends back and the speakers play
const micMeter = new Meter(), speakerMeter = new Meter();
function status() {
  const l = up.audio?.levels();
  if (!l) return;
  const now = performance.now();
  const width = Math.max(10, Math.min(32, term.cols - 72));
  const vol = (d: Device) =>
    `${(Number.isNaN(d.volume) ? "?" : String(Math.round(d.volume * 100))).padStart(3)}% ${
      d.muted ? `${RED}${BOLD}muted${RESET}` : "     "
    }`;
  const heard = l.silentFor > 500
    ? `${RED}no capture${RESET}`
    : l.voice
    ? `${BOLD}voice${RESET}     `
    : " ".repeat(10);
  const gate = open
    ? `${GREEN}${BOLD}open  ${RESET}`
    : silence
    ? `${YELLOW}silent${RESET}`
    : `${DIM}closed${RESET}`;
  const doing = link !== "live"
    ? `${RED}${link}${RESET}`
    : open
    ? "listening"
    : waitingSince !== undefined
    ? `${YELLOW}waiting ${((now - waitingSince) / 1000).toFixed(1)} s${RESET}`
    : answering
    ? "answering"
    : up.audio?.playing
    ? "speaking"
    : `${DIM}idle${RESET}`;
  const rows = [
    `mic ${vol(mix.source)} ${micMeter.draw(l.mic, width)} ${
      Meter.db(l.mic)
    } ${heard} │ ${gate} → ${chunks(sent)}`,
    `spk ${vol(mix.sink)} ${speakerMeter.draw(l.speaker, width)} ${Meter.db(l.speaker)} ${
      " ".repeat(10)
    } │ ${doing} ← ${received} chunks ${(receivedMs / 1000).toFixed(1)} s`,
  ];
  // the coding agent's state, here rather than a line per change: it flips between thinking and
  // working at every step
  if (!noLiquen) {
    const busy = busySince === undefined ? "" : ` ${Math.round((now - busySince) / 1000)} s`;
    rows.push(
      `agent ${sessionName} │ ${
        doorGone
          ? `${RED}gone${RESET}`
          : state === "idle"
          ? `${DIM}${awaiting ? "sent, not started" : "idle"}${RESET}`
          : `${state}${busy}`
      }`,
    );
  }
  term.status(rows);
}
term.pin(noLiquen ? 2 : 3);
up.status = setInterval(status, STATUS_MS);
up.updates = setInterval(update, 1000);

/**
 * The run ends, and the session will be resumed: the work still open is answered as stopped
 * (liquen stops with chiche), so the next run's voice isn't left waiting on it, and the handle
 * saved is one taken after that answer, when the server sends one in time.
 */
async function endSession() {
  const v = up.voice;
  if (!v?.connected) return saveSession();
  if (channel) {
    const stopped =
      "stopped: chiche was closed; if the coding agent was working, ask again next time";
    // not shown, the run is over; kept as chat for the tail a lost session gets
    forward(stopped, Scheduling.SILENT, false, true);
    chat(stopped);
    const came = await v.nextHandle(3000);
    log.line(
      "session",
      `the open call answered as stopped; ${
        came ? "a handle came after" : "no handle after, in 3 s"
      }`,
    );
  }
  saveSession();
}

/**
 * A new session where this conversation's was lost (expired, refused by the server, or started
 * over for a changed INSTRUCTIONS.md): what was said before comes back from the log, as context
 * first thing after the instructions. --fresh means no past before the run.
 */
async function sendTail() {
  const tail = await logTail();
  if (!tail || !up.voice) return;
  up.voice.context(
    "(Not a turn, nothing to answer: this conversation's earlier voice session can't be " +
      "resumed, so here is the end of its log. 🧒 is the user, 🗣️ is you, `input:` " +
      "what you sent the coding agent, and the other lines what it sent back.)\n\n" + tail,
  );
  const n = tail.split("\n").length;
  term.dim(`the voice session was lost; it gets the last ${n} lines of the log`);
  log.line("session", `sent the log's tail as context: ${n} lines, ${tail.length} chars`);
}

// 5. Gemini
const last = lastSession();
/** The voice picked up the last run's session. */
let resumed = false;
if ("why" in last) log.line("session", `new: ${last.why}`);
else log.line("session", `resuming the one seen ${Math.round(last.ago / 1000)} s ago`);
up.voice = await Voice.start({
  apiKey,
  language,
  systemInstruction: instructions,
  vad,
  resume: "handle" in last ? last.handle : undefined,
  on: {
    trace: (d, m) => log.gemini(d, m),
    connected(how) {
      link = "live";
      if (how === "resumed") resumed = true;
      const minutes = "ago" in last ? Math.max(1, Math.round(last.ago / 60_000)) : 0;
      term.dim(
        {
          new: `gemini connected (${language})${
            up.voice ? ": a new session" : "why" in last ? `: a new session, ${last.why}` : ""
          }`,
          resumed: `gemini resumed the last session, from ${minutes} min ago (--fresh: a new one)`,
          reconnected: "gemini reconnected",
        }[how],
      );
      // up.voice is unset while Voice.start runs: the rest is for a connection later in the run
      if (!up.voice) return;
      void (async () => {
        if (how === "new") {
          // the session was lost mid-run: the open call went with it, and the past is the log's
          channel = undefined;
          await sendTail();
        }
        // a new connection knows no activity: if the mic is open, the turn is on
        if (open) up.voice?.activityStart();
      })();
    },
    resumeRefused(reason) {
      term.dim(
        `${up.voice ? "the voice session" : "the last session"} can't be resumed (${reason}); ` +
          "starting a new one",
      );
      log.line("session", `refused: ${reason}`);
    },
    handle(h) {
      lastHandle = h;
      saveSession();
    },
    goAway(timeLeft) {
      term.dim(`gemini GoAway${timeLeft ? ` (${timeLeft})` : ""}`);
      up.audio?.flush();
    },
    reconnecting(reason, delayMs) {
      link = "reconnecting";
      endSilence("reconnecting");
      waitingSince = undefined;
      answering = false;
      term.dim(`gemini ${reason}; reconnecting in ${delayMs} ms`);
      up.audio?.flush();
    },
    setupFailed(reason) {
      term.error(`gemini setup failed: ${reason}`);
      void teardown(1);
    },
    audio(pcm) {
      answered("audio");
      lastTalk = performance.now();
      received++;
      receivedMs += pcm.length / 2 / VOICE_RATE * 1000;
      log.voiceAudio(pcm);
      up.audio?.play(pcm);
    },
    interrupted() {
      log.line("gem", "interrupted → flush");
      answering = false;
      up.audio?.flush();
    },
    inputTranscript(t, finished) {
      endSilence("the transcript came");
      term.say("🧒", t, finished);
    },
    outputTranscript(t, finished) {
      answered("transcript");
      term.say("🗣️", t, finished);
    },
    turnComplete() {
      term.end();
      lastTalk = performance.now();
      if (answering) {
        log.line(
          "turn",
          `received ${received} chunks, ${(receivedMs / 1000).toFixed(2)} s of voice`,
        );
        answering = false;
      } else if (waitingSince !== undefined) {
        term.dim("(the turn ended with no answer)");
        log.line("turn", "turnComplete with no answer");
        waitingSince = undefined;
      }
    },
    toolCall(call) {
      answered("tool call");
      if (call.name !== "input" || typeof call.args.text !== "string") {
        up.voice?.answer({
          id: call.id,
          output: `error: unknown tool ${call.name}`,
          scheduling: Scheduling.WHEN_IDLE,
          willContinue: false,
        });
        return;
      }
      void input(call.id, call.args.text);
    },
    toolCallCancelled(ids) {
      if (channel && ids.includes(channel)) channel = undefined;
      term.dim(`input cancelled (${ids.length})`);
    },
  },
});
if (!resumed && !fresh) await sendTail();
// an open activity would hold the answer until it ends: the kick goes only while the mic is closed
if (sayHi && !open) {
  up.voice.sendText(
    resumed
      ? "(The session resumed after a break: take the first turn.)"
      : "(The session just started: take the first turn.)",
  );
  waitingSince = performance.now();
}
if (open) up.voice.activityStart(); // opened before the session existed
