# chiche — plan

A voice agent (`gemini-3.8-live`) that talks with a five-year-old about the games they make, working
in tandem with a liquen coding agent that builds them. Deno, run locally, never deployed.

Rules for whoever implements this:

- No claim about how the Live API behaves without a source or a measurement on `gemini-3.8-live`.
  Sources: the `gemini-live-api-dev` skill (Google's `google-gemini/gemini-skills`, installed as a
  plugin), the docs it links, and the `@google/genai` 2.24.0 type definitions. Unverified claims are
  listed under **Measure first**.
- `deprecated/` is a scrapped first attempt. Don't read it or reuse it: this plan replaces it.
- liquen is at `../liquen` (JSR `@liquen/liquen` 0.1.54). Its door protocol is documented at the top
  of `src/door.ts`.

## State

Done (2026-09-24): everything below is implemented and boots end to end (liquen up, door tailing,
the game window open, mic captured, Gemini connected, clean teardown). Measurements 1, 2, 4, 5 and 6
are answered under **Measure first**; 3 is open and waits for a real run with the mic. Not yet
exercised with a real conversation: the `input` flow through liquen with the voice (only the door
and the Gemini halves separately).

Local note: liquen 0.1.54 refused to boot on this machine's `data/log/log.db` (from an older liquen:
`table locks has no column named seen`); the column was added by hand.

## Order of work

1. `bin/game`: `game test`, the whole-`dist/` swap, the new `game serve`; then the docs. Checkable
   on its own with `game build`, `game test` and `game serve`.
2. `log.ts` and `audio.ts`. Measure 5.
3. `gemini.ts` without tools: talk to it, read the logs. Measure 6.
4. `liquen.ts`: against `liquen start`, send a message, watch events and `idle`.
5. The `input` tool, wiring 3 and 4. Measure 1–4.
6. `main.ts`: boot, teardown, terminal.

## Files

| File              | Does                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`         | boot, wiring, the mic's gate, the meters, teardown                                                                                     |
| `term.ts`         | the terminal: scrolling lines, the pinned transcript and meter rows                                                                    |
| `keys.ts`         | push to talk and the toggle, read from chiche's terminal                                                                               |
| `gemini.ts`       | the Live session: setup, reconnection, the `input` tool                                                                                |
| `audio.ts`        | the two PipeWire processes, their levels, and the mixer                                                                                |
| `liquen.ts`       | the door client: speaks liquen's door protocol directly                                                                                |
| `log.ts`          | the per-run timeline and recordings                                                                                                    |
| `INSTRUCTIONS.md` | the voice's system instruction; `{{LANG}}` is filled in at boot                                                                        |
| `deno.jsonc`      | liquen's tasks (from its scaffold) + `@google/genai` + `chiche`: `deno run -A --env-file=.env main.ts` (`GEMINI_API_KEY` is in `.env`) |

## Boot and teardown

Boot, in order:

1. Read `LANG`. `es_AR.UTF-8` → `es-AR`; unset, `C` or `POSIX` → `en-US`.
2. `liquen start` as a long-lived child. Poll `data/agents/<user>/door.sock` until it answers (up to
   ~20 s). If `liquen start` refuses because the org is already running, connect to that one.
3. `game serve` as a child; it opens the child's browser window (see **The game on screen**).
4. Unmute the default mic and speakers, then `pw-record` (`pw-play` waits for the first voice).
5. Connect to Gemini.

Teardown (Ctrl-C, SIGTERM): close Gemini, stop the audio processes, close the door connection (so
the hang-up isn't read as unexpected), `liquen stop` and wait for it, stop `game serve`, close the
logs.

`deno task chiche --no-liquen` skips steps 2 and 3 (no builder, no game window): the voice alone, to
test the audio. An `input` call gets an error answer ("the builder is off"): `WHEN_IDLE` if the
voice hasn't spoken yet in that answer, else `SILENT`. Measured 2026-09-25: after spoken words, a
`WHEN_IDLE` error had the voice answer a second time 0.44 s after the first ended; before any, a
`SILENT` one left a say-hi turn that was only the call with no voice at all.

`deno task chiche --say-hi`: the voice takes the first turn. Once connected, with the mic still
closed, chiche sends `sendRealtimeInput({ text })` asking for the first turn. Measured 2026-09-25
with chiche's setup: outside an activity the voice spoke in 1–4 s (6 of 6, realtime text and a
`sendClientContent` user turn alike; the latter once called `input` twice); inside an open activity
with room noise flowing, nothing in 12 s (0 of 3).

`deno task chiche --vad`: the server's automatic activity detection takes the turns (the setup
leaves `realtimeInputConfig` out, so detection is on; `activityStart`/`activityEnd` aren't sent).
The gate still decides what is sent and still waits for its tail. Closing it sends silence (exact
zeros) in the mic's place until the transcript or the voice's first content arrives, 10 s at most.
The server ends a turn only on hearing silence: measured 2026-09-25 with the user's recorded
question (`log/2026-09-25T17-25-24`, 24.3–30.4 s), streamed zeros got the transcript in 0.58, 0.60
and 1.7 s and the voice in 0.9–2.5 s; `audioStreamEnd` then nothing (2 of 2), and nothing at all (2
of 2), got no transcript and no answer in 12 s. The same question in the user's run, with
`activityEnd`, got its transcript in 1.5 s. With the mic left open, room noise can hold the turn
open for seconds (see "VAD and activity signals" below), and the speakers reach an open mic.

## Audio

- Capture: `pw-record`, 16 kHz s16 mono on stdout (the skill's input format,
  `audio/pcm;rate=16000`), opened once for the whole run. Playback: `pw-play`, 24 kHz s16 mono on
  stdin (the skill's output format), spawned when the first voice audio arrives and kept until a
  flush kills it.
- **Why playback starts late:** opening a Bluetooth headset's mic switches it from A2DP to its
  headset profile, and an idle `pw-play` (open, no data) during that switch stalls the capture:
  0.25–0.5 s of zeros, then nothing, which reads as muted. Measured 2026-09-25 on Galaxy Buds2 Pro,
  from A2DP: `pw-record` alone 3 of 3 fine; with `pw-play` fed data 3 of 3 fine; with an idle
  `pw-play` 2 of 2 stalled, and chiche's `Audio` (which spawned `pw-play` at boot) 4 of 4 stalled,
  as in two of the user's runs. After the switch an idle `pw-play` is harmless (2 of 2), and with
  `pw-play` spawned on the first voice `Audio` captured 3 of 3.
- No echo cancellation. The mic is the gate: the child opens it, talks and closes it; the model
  answers while it is closed.
- **Two blocks**, independent:
  - The mixer's mute, of the mic and of the speakers (`audio.ts`), is outside chiche. At boot chiche
    unmutes both default devices (`wpctl set-mute … 0`), the one thing it does to them. From then on
    it only watches (`pactl subscribe`, then `wpctl get-volume`) and shows volume and mute; a muted
    device is the user's to unmute. Measured 2026-09-25 on Galaxy Buds2 Pro: a muted source delivers
    exact zeros (2 s), unmuted 28633 of 31375 samples were non-zero.
  - chiche's gate (`main.ts`) decides whether audio is sent. It starts closed, and it follows the
    last key used: push to talk down opens it and up closes it, the toggle flips it. Opening sends
    `activityStart`, closing `activityEnd`. While it is open every capture chunk is sent, zeros
    included. An open mic is an open turn: nothing is answered until it closes (the user's run
    `log/2026-09-25T16-28-21`, and the say-hi measurement below), hence closed at boot.
  - Closing waits for its tail. A Bluetooth mic delivers 128 ms at a time, whatever pw-record's
    `--latency` (Galaxy Buds2 Pro, 2026-09-25: 100, 40 and 20 ms alike), so at the key's release up
    to 128 ms of speech is still on its way; cutting there lost the last syllable (the user's run
    `log/2026-09-25T17-25-24`: the window after the release read as voice). Each chunk is dated back
    from its read's arrival; the gate keeps sending until the chunk that reaches the release, then
    sends `activityEnd` (300 ms at most, for a stalled capture). The device's own latency isn't
    counted. Opening again before that ends the waiting turn first.
- A Bluetooth mic delivers exact zeros for its first second, unmuted, while it switches profile
  (Galaxy Buds2 Pro, 2026-09-25: 1.06–1.32 s in 3 runs). The mic windows flag exact zeros (`zeros`),
  so a muted source or that switch reads as such in the timeline.
- **Keys** (`keys.ts`), read from chiche's terminal, raw while it runs (Ctrl-C arrives as a key):
  `CHICHE_PUSH_KEY` (default `space`) and `CHICHE_TOGGLE_KEY` (default `m`), each a single
  character, `space`, or `none`. Releases come from the kitty keyboard protocol (flags 1|2|8,
  `CSI code;mods:event u`) where the terminal takes it (foot does); elsewhere a held key is seen
  through its auto-repeat and its release is the repeat stopping (700 ms before the first repeat,
  150 ms after the last). Focus reports release every held key when the terminal loses focus. The
  timeline says which (`keys releases reported / inferred`).
- **Turn edges:** automatic activity detection is off
  (`realtimeInputConfig.automaticActivityDetection.disabled`, the SDK: "the client must send
  activity signals"); the mic opening sends `activityStart`, closing sends `activityEnd`, so the
  turn ends once the mic has closed and its tail is sent, with no endpointing wait. A reconnect with
  the mic open sends a fresh `activityStart`. Measured 2026-09-24 with automatic detection: a mute
  right after the last word left the turn open (no transcript, no answer) until the next unmute,
  since the server never heard the silence after the words; `audioStreamEnd` alone did not end it.
- **VAD and activity signals don't mix on one connection:** the setup "will apply for the duration
  of the streaming session", and the signals "can only be sent if automatic activity detection is
  disabled" (SDK 2.24.0 types). Measured 2026-09-25: resuming with the handle and automatic
  detection on works (the context carried over, VAD took the turns), so switching modes mid-run
  would be a reconnect; `--vad` picks one for the run. Server VAD on an open mic (speech, then room
  noise at about −55 dBFS) put 2 to 14 s between the last word and the input transcript.
- **Open problem, measured 2026-09-25:** after `activityEnd` the answer sometimes doesn't come. The
  same recorded question, nothing sent after `activityEnd`: 2 of 5 runs got nothing within 15 s; in
  8 more, 4 had nothing after 2 s. When it comes, the transcript arrives in 0.35–0.7 s and the voice
  in 0.8–1.6 s. The turn isn't lost: the next audio brings it out. No variant fixed it: silence
  after `activityEnd` (1 of 5 stalled), silence before it (4 of 5), an empty second activity 2 s
  later (of the 4 stalled, 1 answered at 5 s, 1 at 16 s, 2 never). A real run
  (`log/2026-09-25T15-06-10`) got no answer to its last 4 turns; replaying its mic with its timing,
  3 of 4 fresh sessions stalled for 1–4 turns, one of them without instructions or tool, so the
  stall isn't ours. When a stall ended, the transcript sometimes held only part of the stalled
  speech.
- `serverContent.interrupted` → flush playback: kill `pw-play`; the next voice spawns it again.
- Barge-in over the model's voice isn't supported: an open mic hears the speakers.
- **No transcript while the child speaks.** `LiveServerContent.interimInputTranscription` exists
  (SDK 2.24.0 types: "low latency transcription updated while the user is speaking"), and the SDK
  hands the server's JSON through as it comes (Gemini API path, `Object.assign`), so what the
  timeline logs is what the server sent. `gemini-3.8-live` sent none in any run, nor anything else
  while the mic was open but `interrupted` over a playing answer; the input transcript arrived
  0.37–0.54 s after `activityEnd` in the runs of 16:18–16:28 and 1.5–3.7 s in the user's run
  `log/2026-09-25T17-25-24`, always 0.7–1.1 s before the first answer. Same code and setup, so the
  server's; `thinking_level` is not supported on `gemini-3.8-live` (migration guide). The docs
  describe interim transcription only for `gemini-3.5-transcribe-live`; a second session on it would
  double the audio sent, and transcribe what a different model heard, so no.

## Gemini session

- `@google/genai` (npm, pinned to 2.24.0), for its types.
- Setup: `model: gemini-3.8-live`, `responseModalities: [AUDIO]`, `systemInstruction` =
  `INSTRUCTIONS.md` with `{{LANG}}` replaced, `speechConfig.languageCode` from `LANG`, default
  voice, input and output transcription on, context window compression on, session resumption on. No
  `thinkingConfig` (the skill: not supported on `gemini-3.8-live`); proactive audio left alone (the
  skill: always on, setting it errors).
- The child speaks first. `INSTRUCTIONS.md` tells the voice to start by asking the builder which
  games exist, then offer to keep working on one or start a new one.
- **Reconnection:** on GoAway or an unexpected close, reconnect with the latest resumption handle,
  with backoff. The audio processes keep running; mic frames are dropped while disconnected;
  playback is flushed. A setup error (bad config, bad key) prints and exits.

## The `input` tool

One tool, `input({text})`, declared `NON_BLOCKING`. Its call stays open, and liquen's work comes
back as several answers to it (`FunctionResponse.willContinue`, `@google/genai` 2.24.0 types:
"turning the function call into a generator"). Scheduling values from the same types: `SILENT` only
adds to context, `WHEN_IDLE` prompts output without interrupting, `INTERRUPT` cuts in (never used).

| Door                                 | Answer to the open `input` call                                   |
| ------------------------------------ | ----------------------------------------------------------------- |
| `message` replies `{ok, id}`         | ack `{output: "sent"}`, `SILENT`, `willContinue: true`; keep `id` |
| `message` replies `ok: false`        | the error, `WHEN_IDLE`, `willContinue: false`                     |
| `tool_use` event                     | progress: tool name + clipped input, `SILENT`                     |
| the builder's reply (below)          | result, `WHEN_IDLE`                                               |
| `error` event or delta, door hang-up | the error, `WHEN_IDLE`                                            |
| `status: idle` with `after >= id`    | empty answer, `SILENT`, `willContinue: false`                     |

- A `status: idle` closes every open call whose message id it has reached.
- Results go to the newest open call. With no call open (for example work typed in the REPL), they
  are dropped.
- Thinking deltas are dropped.
- `sendClientContent` is not used for any of this: with `turnComplete: true` it interrupts
  unconditionally, and without it nothing is generated (the skill).

## The liquen door (`liquen.ts`)

Newline-separated JSON over `data/agents/<user>/door.sock`, where `<user>` is the OS username
(liquen's rule). Source: `../liquen/src/door.ts`. Requests are answered in order; a line with `ok`
is a reply, anything else a push.

- `{op: "tail"}` once after connecting; from then on the door pushes `{event}`, `{delta}` and
  `{status}` lines.
- `{op: "message", text, sender: {address: <user>, name: <user>}}` per `input` call → `{ok, id}`.
- Session: `mind`, the default (no `session` field). Shared with the REPL.
- **The builder's reply:** an event with `type: "message"`, `payload.turn_id` set,
  `envelope.conversation.address == "mind@<user>"`, `extra.silence` not true, and non-empty text.
- **Finished:** `{status: "idle", after}` with `after >= id` (UUIDv7 ids compare as strings).
- No approvals: every tool is allowed, and approval requests are ignored.

## The game on screen

`game serve` stays a dev server. It builds nothing, it watches the games' `dist/` folders instead of
the sources, and it drives the child's browser itself through Playwright.

- **Only `game build` writes `dist/`.** `game run` becomes `game test` (it plays the game headless
  and reports; `run` sounded like serving) and builds into a temporary folder, so the builder's test
  runs never touch what the child's window serves. Renamed in `bin/game`, `kit/mod.ts`,
  `organization.md`, `skills/game-debugging.md` and `skills/game-assets.md`. What it does is
  unchanged: serve the build privately on a random port, open it in headless Chromium with a fresh
  profile (WebGL through SwiftShader, autoplay allowed), wait for `window.game.isBooted`, play the
  `--keys` script, take screenshots, and report errors, console output, fps, active scenes,
  difficulty and `--eval` results. Exit 1 on errors.
- **`dist/` is replaced whole, and only on success.** `build()` bundles into a temporary folder next
  to `dist/`; if the bundle succeeds, it renames the old `dist/` aside, renames the new one in, and
  deletes the old. A failed build leaves `dist/` as it was. (Today it deletes `dist/` before
  bundling.) Linux `rename` can't replace a non-empty directory, hence two renames; the gap between
  them is one system call.
- **Serving:** every game's `dist/` at `/<slug>/`, the game list at `/`, `__DEV__` injected. No
  build at start: whatever is in `dist/` is what the child can play.
- **The browser:** at start, `game serve` launches a headed Chromium with Playwright and opens `/`.
  That window is the child's screen. If it's closed, the next restart opens it again.
  - A full Chromium: `GAME_CHROMIUM`, else `/usr/bin/chromium`, else Playwright's cached
    `chromium-*`. Never `chrome-headless-shell`, which can't open a window (`game test` may keep
    using it).
  - A persistent profile (`launchPersistentContext`) in `.browser/` at the project root,
    git-ignored, so `kit.save` survives chiche restarts.
  - `--autoplay-policy=no-user-gesture-required`, so sounds play without a click.
  - An app window (`--app=<url>`): no address bar or tabs, but a normal window for the compositor.
    Not `--kiosk`: it goes fullscreen, and on sway that hides chiche's terminal.
- **The restart:** `game serve` watches `games/*/dist`. When a game's `dist/` is swapped in:
  `page.goto("/<slug>/")`, which also reloads when it's already there, resuming from `kit.save`. The
  swap's events are collapsed into one restart per game.
- The page's reload script (`/__reload`) goes away: Playwright navigates and reloads.
- chiche starts `game serve` at boot and stops it at exit, which also closes the window.
- `organization.md` and `skills/game-debugging.md`: `game build <slug>` is how a change reaches the
  child's screen, including the first time a game is chosen; the builder runs it when a change is
  ready to be seen. `game serve` is chiche's, not the builder's.

## Terminal

Lines scroll; the bottom three rows are pinned (a scroll region, `term.ts`).

Lines, one per thing:

- At boot: the capture source and the playback sink in use, by name and description (the PipeWire
  defaults `pw-record` and `pw-play` attach to), the log folder of the run, and which of them chiche
  unmuted.
- The keys, once at boot.
- A default device that changes, and a mute that changes (`mic muted (mixer)`).
- Mic open / closed, on every change, with the key that did it; closing adds what was sent.
- Transcripts of both sides, once each ends, and `(the turn ended with no answer)`.
- One dim line per liquen event forwarded to the voice (ack, progress, result, error, finished), and
  per Gemini connection change (connected, GoAway, reconnecting).

Pinned rows, redrawn every 66 ms:

- The transcript under way, its tail. It joins the lines when it ends, so the scrolling area only
  gets whole lines: redrawing the pinned rows saves and restores the cursor, which mid-line can lose
  a pending wrap.
- `mic`: volume and mute from the mixer; a level meter (−80 to 0 dBFS, falls at 30 dB/s, holds its
  peak 1.5 s) and the level; `voice` when a chunk reads as voice (8 dB over the running floor and
  above −55 dBFS), `no capture` when none came for 500 ms (a stalled `pw-record`); the gate, and the
  chunks sent since it last opened.
- `spk`: volume and mute; the meter of what the speakers are playing now (the queued voice's levels
  in 20 ms blocks, placed on the clock where it plays); the turn's state (`listening`, `waiting N s`
  since the turn ended with nothing back yet, `answering`, `speaking` while queued audio plays out,
  `idle`, or the connection's); the chunks received in the voice's last answer.

## Language

- `INSTRUCTIONS.md`: "Speak the language of the locale `{{LANG}}`".
- `organization.md`: the child speaks "the language `$LANG` names"; the builder's shell inherits
  `LANG` (`config.jsonc` leaves `organization.locale` unset).

## Logging

One folder per run under `log/`, the last 10 kept. `log/` and `.browser/` go in `.gitignore`.

- `timeline.log`: one clock. Mic windows of 250 ms (level and peak in dBFS, running noise floor,
  `voice` and `zeros` flags, the speakers' level while playing, capture falling behind real time)
  interleaved with every Gemini and door message, sent and received. Per turn: what was sent when
  the mic closed, how long until the voice's first content
  (`turn first audio 812 ms after the turn
  ended`), and what it received at `turnComplete`. Every
  mixer change (`mixer`).
- `mic.wav` (16 kHz, as sent, silence while the mic is closed) and `voz.wav` (24 kHz, as received),
  aligned to the same clock.
- Size: about 80 KB/s, ~290 MB per hour.

## Measure first

Each answered from the logs of a run, before anything is built on it. Measured on 2026-09-24 against
`gemini-3.8-live` with a headless script (text in, audio and transcription out, the `input` tool
declared as in `gemini.ts`):

1. Where `scheduling` goes: the docs' JS example puts it inside `response`, the SDK types put it on
   `FunctionResponse`. **Measured: the field.** On `FunctionResponse`, three `SILENT` answers
   produced no speech and the `WHEN_IDLE` one was spoken. Inside `response` it is ignored: every
   answer made the model talk ("Dale, ahí le pregunto").
2. Whether `willContinue` works on `gemini-3.8-live`. **Measured: yes.** One call took four answers
   over 20 s (`willContinue: true` ×3, then `false`) with no error and no close.
3. Whether `WHEN_IDLE` waits while the child is talking, or only for the model's own speech. If it
   talks over the child, hold results while the mic is unmuted. **Inconclusive.** The only "child"
   available headless was the model's own speech resampled to 16 kHz; streaming it wedged the
   session (no input transcription, and no answer afterwards even to a text question), so it says
   nothing about real speech. Answer it from the timeline of a real run: a `result` line while `mic`
   windows say `voice`, followed by `gem:←` audio. `main.ts` does not hold results yet.
4. Whether an open `input` call survives session resumption. **Measured: yes.** A call opened on one
   connection, answered `WHEN_IDLE` on the resumed one (same call id), was spoken; closing it there
   raised no error.
5. Whether a muted PipeWire source delivers exact zeros. **Measured: yes**, over 2 s with the mute
   key on (61,440 bytes, every sample 0), and again over a 30 s chiche run (every 250 ms window at
   −100 dBFS). Not yet measured: the transition while toggling.
6. Whether the Node build of `@google/genai` runs cleanly under Deno 2.9.6. **Measured: yes.** Deno
   prints a warning that it ignored the package's build scripts (lifecycle scripts need a
   `node_modules` directory); nothing in the Live client needs them.

## Not now

- An elapsed-time clock or `estado` tool for "¿cómo va?".
- A `cancel` tool.
- Richer progress from liquen than `tool_use` events.
- Changes to liquen (`liquen up`, a log for the ephemeral daemon, current state in the `tail`
  reply).
