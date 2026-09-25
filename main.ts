// main.ts — chiche: boot, wiring, the mic's gate, the meters, teardown.
//
// Boot: LANG → liquen (started here, or the one already running) → game serve (the kid's
// window) → the mixer unmuted, pw-record → Gemini. Teardown, on Ctrl-C or SIGTERM: close
// Gemini, stop the audio, close the door (so the hang-up isn't read as unexpected), `liquen
// stop` and wait for it, stop game serve, close the logs. `--no-liquen` skips liquen, the door
// and game serve: the voice alone, to test the audio; `input` calls get an error. `--say-hi`
// has the voice take the first turn. `--vad` leaves the turns to the server's activity
// detection: the gate still decides what is sent, and closing it sends silence.

import { dirname, fromFileUrl, join } from "@std/path";
import { TextLineStream } from "@std/streams";
import { Audio, type Device, type Mixer, mixer, unmute, VOICE_RATE, watchMixer } from "./audio.ts";
import { Scheduling, Voice } from "./gemini.ts";
import { keyCode, keyName, Keys } from "./keys.ts";
import { clip, Door, errorOf, isReply, toolUseOf } from "./liquen.ts";
import { Log } from "./log.ts";
import { BOLD, DIM, GREEN, Meter, RED, RESET, Terminal, YELLOW } from "./term.ts";

const ROOT = dirname(fromFileUrl(import.meta.url));
const DATA = join(ROOT, "data");
const GAME = join(DATA, "organization", "bin", "game");
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

async function stopChild(p: Deno.ChildProcess | undefined, graceMs = 5000) {
  if (!p) return;
  try {
    p.kill("SIGTERM");
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      p.kill("SIGKILL");
    } catch { /* gone */ }
  }, graceMs);
  await p.status.catch(() => {});
  clearTimeout(timer);
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
const FLAGS = ["--no-liquen", "--say-hi", "--vad"];
/** --no-liquen: the voice alone, to test the audio. No builder, no game window. */
const noLiquen = Deno.args.includes("--no-liquen");
/** --say-hi: the voice takes the first turn. */
const sayHi = Deno.args.includes("--say-hi");
/** --vad: the server's activity detection takes the turns, no activityStart/End. */
const vad = Deno.args.includes("--vad");
const unknown = Deno.args.filter((a) => !FLAGS.includes(a));
if (unknown.length) {
  term.error(`unknown argument ${unknown.join(" ")} (the ones there are: ${FLAGS.join(" ")})`);
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
const instructions = (await Deno.readTextFile(join(ROOT, "INSTRUCTIONS.md"))).replaceAll(
  "{{LANG}}",
  language,
);

/** What is up, in boot order; teardown may run before any of it exists. */
const up: {
  liquen?: Deno.ChildProcess;
  serve?: Deno.ChildProcess;
  door?: Door;
  mixer?: { stop(): void };
  audio?: Audio;
  voice?: Voice;
  keys?: Keys;
  status?: ReturnType<typeof setInterval>;
} = {};
let tearingDown = false;

async function teardown(code = 0) {
  if (tearingDown) return;
  tearingDown = true;
  clearInterval(up.status);
  term.end();
  term.dim("bye");
  up.keys?.stop();
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
  await stopChild(up.serve);
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
  term.dim("--no-liquen: no builder, no game window");
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

/** An open `input` call: its Gemini id, and the door message id once `message` replied. */
interface Call {
  id: string;
  messageId?: string;
}
const calls: Call[] = [];
const newest = () => calls.at(-1);
const closeCall = (c: Call) => {
  const i = calls.indexOf(c);
  if (i >= 0) calls.splice(i, 1);
};

/** An answer to the newest open call, or dropped (work typed in the REPL, say). */
function forward(what: string, output: string, scheduling: Scheduling, willContinue = true) {
  const c = newest();
  if (!c) {
    term.dim(`(no input call open) ${what}: ${clip(output, 80)}`);
    return;
  }
  term.dim(`${what}: ${clip(output.replaceAll("\n", " "), 100)}`);
  if (!up.voice?.answer({ id: c.id, output, scheduling, willContinue })) {
    term.dim("(disconnected; the answer was lost)");
  }
  if (!willContinue) closeCall(c);
}

if (!noLiquen) {
  up.door = await Door.connect(DATA, user, {
    trace: (d, m) => log.door(d, m),
    event(e) {
      const use = toolUseOf(e);
      if (use) return forward("progress", `working: ${use.name} ${use.input}`, Scheduling.SILENT);
      if (up.door && isReply(e, up.door.address)) {
        const text = (e.parts ?? []).filter((p) => p.type !== "data").map((p) => p.text).join(" ");
        return forward("result", text, Scheduling.WHEN_IDLE);
      }
      const error = errorOf(e);
      if (error) return forward("error", `error: ${error}`, Scheduling.WHEN_IDLE);
    },
    delta(d) {
      if (d.kind === "error" && d.text) forward("error", `error: ${d.text}`, Scheduling.WHEN_IDLE);
      // thinking and text deltas are dropped: the reply arrives as an event
    },
    status(s) {
      if (s.status !== "idle" || s.after === undefined) return;
      for (const c of [...calls]) {
        if (c.messageId !== undefined && c.messageId <= s.after) {
          term.dim(`finished (${c.messageId.slice(-6)})`);
          up.voice?.answer({
            id: c.id,
            output: "",
            scheduling: Scheduling.SILENT,
            willContinue: false,
          });
          closeCall(c);
        }
      }
    },
    hangup(expected) {
      if (expected || tearingDown) return;
      term.error("the door hung up");
      for (const c of calls.splice(0)) {
        up.voice?.answer({
          id: c.id,
          output: "error: the builder went away",
          scheduling: Scheduling.WHEN_IDLE,
          willContinue: false,
        });
      }
    },
  });
}

async function input(callId: string, text: string) {
  const c: Call = { id: callId };
  calls.push(c);
  term.dim(`input: ${clip(text.replaceAll("\n", " "), 120)}`);
  const r = up.door
    ? await up.door.message(text)
    : { ok: false, id: undefined, error: "the builder is off (chiche runs with --no-liquen)" };
  if (!calls.includes(c)) return; // cancelled meanwhile
  if (r.ok && typeof r.id === "string") {
    c.messageId = r.id;
    term.dim(`sent (${r.id.slice(-6)})`);
    up.voice?.answer({
      id: c.id,
      output: "sent",
      scheduling: Scheduling.SILENT,
      willContinue: true,
    });
  } else {
    term.dim(`not sent: ${r.error}`);
    up.voice?.answer({
      id: c.id,
      output: `error: ${r.error ?? "not sent"}`,
      // without a builder, once the voice has spoken this turn: WHEN_IDLE would have it speak
      // again once it's idle (measured: a second answer 0.44 s after the first ended). Before
      // it has, WHEN_IDLE is what makes it speak at all (measured: a turn that was only the call)
      scheduling: !up.door && received > 0 ? Scheduling.SILENT : Scheduling.WHEN_IDLE,
      willContinue: false,
    });
    closeCall(c);
  }
}

// 3. the kid's window
if (!noLiquen) {
  up.serve = child([GAME, "serve"], ROOT, (l) => {
    log.line("game", l);
    term.dim(`game: ${l}`);
  });
}

// 4. audio. Two blocks stand between the child and the voice. The mixer's mute (mic and
// speakers) is outside chiche: it clears both at boot, the one thing it does to them, and then
// only shows them. chiche's gate is the other: closed at boot, it follows the last key used
// (push to talk down opens it and up closes it, the toggle flips it), and its opening and
// closing are the child's turn edges (activityStart / End).
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
  | { at: number; why: string; timer: ReturnType<typeof setTimeout>; sent: number }
  | undefined;
const TAIL_WAIT_MS = 300;
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
/** When the child's turn (or the say-hi kick) ended with no answer yet. */
let waitingSince: number | undefined;
/** The voice's answer: under way (between its first content and turnComplete), and its audio. */
let answering = false;
let received = 0, receivedMs = 0;
let link: "connecting" | "live" | "reconnecting" = "connecting";

const chunks = (n: number) => `${n} chunks ${(n * 0.04).toFixed(1)} s`;

function mic(now: boolean, why: string) {
  if (now === open) return;
  open = now;
  if (open) {
    endTurn("the mic opened again"); // a turn still waiting for its tail ends first
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
      timer: setTimeout(() => endTurn(`no capture for ${TAIL_WAIT_MS} ms`), TAIL_WAIT_MS),
      sent,
    };
    log.line("mic", `closed (${why}), sending what was captured until now`);
  }
}

/** The closed gate's tail is sent, or given up `because` of something: the turn ends. */
function endTurn(because?: string) {
  if (!closing) return;
  clearTimeout(closing.timer);
  const { why, sent: before } = closing;
  closing = undefined;
  up.voice?.activityEnd();
  if (up.voice?.connected) {
    waitingSince = performance.now();
    if (vad) silence = { since: waitingSince, sent: 0 };
  }
  const cut = because ? `, cut short: ${because}` : "";
  term.dim(`mic closed (${why}) · sent ${chunks(sent)}${cut}`);
  log.line(
    "mic",
    `${vad ? "closed, silence follows" : "turn ended"}, sent ${chunks(sent)}, ${
      sent - before
    } after closing${cut}`,
  );
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
    mic(down, down ? name : `${name} released`);
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
  const state = link !== "live"
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
  term.status([
    `mic ${vol(mix.source)} ${micMeter.draw(l.mic, width)} ${
      Meter.db(l.mic)
    } ${heard} │ ${gate} → ${chunks(sent)}`,
    `spk ${vol(mix.sink)} ${speakerMeter.draw(l.speaker, width)} ${Meter.db(l.speaker)} ${
      " ".repeat(10)
    } │ ${state} ← ${received} chunks ${(receivedMs / 1000).toFixed(1)} s`,
  ]);
}
term.pin(2);
up.status = setInterval(status, STATUS_MS);

// 5. Gemini
up.voice = await Voice.start({
  apiKey,
  language,
  systemInstruction: instructions,
  vad,
  on: {
    trace: (d, m) => log.gemini(d, m),
    connected(resumed) {
      link = "live";
      term.dim(resumed ? "gemini reconnected" : `gemini connected (${language})`);
      // a new connection knows no activity: if the mic is open, the turn is on
      if (resumed && open) up.voice?.activityStart();
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
      for (const c of [...calls]) if (ids.includes(c.id)) closeCall(c);
      term.dim(`input cancelled (${ids.length})`);
    },
  },
});
// an open activity would hold the answer until it ends: the kick goes only while the mic is closed
if (sayHi && !open) {
  up.voice.sendText("(The session just started: take the first turn.)");
  waitingSince = performance.now();
}
if (open) up.voice.activityStart(); // opened before the session existed
