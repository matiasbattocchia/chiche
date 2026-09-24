# chiche — plan

A voice agent (`gemini-3.8-live`) that talks with a five-year-old about the games they
make, working in tandem with a liquen coding agent that builds them. Deno, run locally,
never deployed.

Rules for whoever implements this:

- No claim about how the Live API behaves without a source or a measurement on
  `gemini-3.8-live`. Sources: the `gemini-live-api-dev` skill (Google's
  `google-gemini/gemini-skills`, installed as a plugin), the docs it links, and the
  `@google/genai` 2.24.0 type definitions. Unverified claims are listed under
  **Measure first**.
- `deprecated/` is a scrapped first attempt. Don't read it or reuse it: this plan replaces
  it.
- liquen is at `../liquen` (JSR `@liquen/liquen` 0.1.54). Its door protocol is documented
  at the top of `src/door.ts`.

## State

Done: `deno.jsonc` (liquen's scaffold), `INSTRUCTIONS.md` (the `input` flow, the opening,
`{{LANG}}`), `organization.md` made language-agnostic, `Dockerfile` and `entrypoint.sh`
removed. Everything else below is to do.

## Order of work

1. `bin/game`: `game test`, the whole-`dist/` swap, the new `game serve`; then the docs.
   Checkable on its own with `game build`, `game test` and `game serve`.
2. `log.ts` and `audio.ts`. Measure 5.
3. `gemini.ts` without tools: talk to it, read the logs. Measure 6.
4. `liquen.ts`: against `liquen start`, send a message, watch events and `idle`.
5. The `input` tool, wiring 3 and 4. Measure 1–4.
6. `main.ts`: boot, teardown, terminal.

## Files

| File | Does |
|---|---|
| `main.ts` | boot, wiring, terminal, teardown |
| `gemini.ts` | the Live session: setup, reconnection, the `input` tool |
| `audio.ts` | the two PipeWire processes and mute detection |
| `liquen.ts` | the door client: speaks liquen's door protocol directly |
| `log.ts` | the per-run timeline and recordings |
| `INSTRUCTIONS.md` | the voice's system instruction; `{{LANG}}` is filled in at boot |
| `deno.jsonc` | liquen's tasks (from its scaffold) + `@google/genai` + `chiche`: `deno run -A --env-file=.env main.ts` (`GEMINI_API_KEY` is in `.env`) |

## Boot and teardown

Boot, in order:

1. Read `LANG`. `es_AR.UTF-8` → `es-AR`; unset, `C` or `POSIX` → `en-US`.
2. `liquen start` as a long-lived child. Poll `data/agents/<user>/door.sock` until it
   answers (up to ~20 s). If `liquen start` refuses because the org is already running,
   connect to that one.
3. `game serve` as a child; it opens the child's browser window (see **The game on
   screen**).
4. `pw-record` and `pw-play`.
5. Connect to Gemini.

Teardown (Ctrl-C, SIGTERM): close Gemini, stop the audio processes, close the door
connection (so the hang-up isn't read as unexpected), `liquen stop` and wait for it, stop
`game serve`, close the logs.

## Audio

- Opened once for the whole run; nothing connects or disconnects per turn.
- Capture: `pw-record`, 16 kHz s16 mono on stdout (the skill's input format,
  `audio/pcm;rate=16000`). Playback: `pw-play`, 24 kHz s16 mono on stdin (the skill's
  output format).
- No echo cancellation. The system mic-mute key is the gate: the child unmutes, talks and
  mutes; the model answers while the mic is muted.
- **Mute detection:** a capture chunk that is all zeros means muted; the first non-zero
  chunk means unmuted. Zero chunks are not sent. The first zero chunk after sound sends one
  `audioStreamEnd` (the skill: send it "when the mic is paused").
- `serverContent.interrupted` → flush playback: kill `pw-play` and spawn it again.
- Barge-in over the model's voice isn't supported: an unmuted mic hears the speakers.

## Gemini session

- `@google/genai` (npm, pinned to 2.24.0), for its types.
- Setup: `model: gemini-3.8-live`, `responseModalities: [AUDIO]`, `systemInstruction` =
  `INSTRUCTIONS.md` with `{{LANG}}` replaced, `speechConfig.languageCode` from `LANG`,
  default voice, input and output transcription on, context window compression on,
  session resumption on. No `thinkingConfig` (the skill: not supported on
  `gemini-3.8-live`); proactive audio left alone (the skill: always on, setting it
  errors).
- The child speaks first. `INSTRUCTIONS.md` tells the voice to start by asking the builder
  which games exist, then offer to keep working on one or start a new one.
- **Reconnection:** on GoAway or an unexpected close, reconnect with the latest resumption
  handle, with backoff. The audio processes keep running; mic frames are dropped while
  disconnected; playback is flushed. A setup error (bad config, bad key) prints and exits.

## The `input` tool

One tool, `input({text})`, declared `NON_BLOCKING`. Its call stays open, and liquen's work
comes back as several answers to it (`FunctionResponse.willContinue`, `@google/genai`
2.24.0 types: "turning the function call into a generator"). Scheduling values from the
same types: `SILENT` only adds to context, `WHEN_IDLE` prompts output without interrupting,
`INTERRUPT` cuts in (never used).

| Door | Answer to the open `input` call |
|---|---|
| `message` replies `{ok, id}` | ack `{output: "sent"}`, `SILENT`, `willContinue: true`; keep `id` |
| `message` replies `ok: false` | the error, `WHEN_IDLE`, `willContinue: false` |
| `tool_use` event | progress: tool name + clipped input, `SILENT` |
| the builder's reply (below) | result, `WHEN_IDLE` |
| `error` event or delta, door hang-up | the error, `WHEN_IDLE` |
| `status: idle` with `after >= id` | empty answer, `SILENT`, `willContinue: false` |

- A `status: idle` closes every open call whose message id it has reached.
- Results go to the newest open call. With no call open (for example work typed in the
  REPL), they are dropped.
- Thinking deltas are dropped.
- `sendClientContent` is not used for any of this: with `turnComplete: true` it interrupts
  unconditionally, and without it nothing is generated (the skill).

## The liquen door (`liquen.ts`)

Newline-separated JSON over `data/agents/<user>/door.sock`, where `<user>` is the OS
username (liquen's rule). Source: `../liquen/src/door.ts`. Requests are answered in order;
a line with `ok` is a reply, anything else a push.

- `{op: "tail"}` once after connecting; from then on the door pushes `{event}`, `{delta}`
  and `{status}` lines.
- `{op: "message", text, sender: {address: <user>, name: <user>}}` per `input` call →
  `{ok, id}`.
- Session: `mind`, the default (no `session` field). Shared with the REPL.
- **The builder's reply:** an event with `type: "message"`, `payload.turn_id` set,
  `envelope.conversation.address == "mind@<user>"`, `extra.silence` not true, and
  non-empty text.
- **Finished:** `{status: "idle", after}` with `after >= id` (UUIDv7 ids compare as
  strings).
- No approvals: every tool is allowed, and approval requests are ignored.

## The game on screen

`game serve` stays a dev server. It builds nothing, it watches the games' `dist/` folders
instead of the sources, and it drives the child's browser itself through Playwright.

- **Only `game build` writes `dist/`.** `game run` becomes `game test` (it plays the game
  headless and reports; `run` sounded like serving) and builds into a temporary folder, so
  the builder's test runs never touch what the child's window serves. Renamed in `bin/game`,
  `kit/mod.ts`, `organization.md`, `skills/game-debugging.md` and `skills/game-assets.md`.
  What it does is unchanged: serve the build privately on a random port, open it in
  headless Chromium with a fresh profile (WebGL through SwiftShader, autoplay allowed),
  wait for `window.game.isBooted`, play the `--keys` script, take screenshots, and report
  errors, console output, fps, active scenes, difficulty and `--eval` results. Exit 1 on
  errors.
- **`dist/` is replaced whole, and only on success.** `build()` bundles into a temporary
  folder next to `dist/`; if the bundle succeeds, it renames the old `dist/` aside, renames
  the new one in, and deletes the old. A failed build leaves `dist/` as it was. (Today it
  deletes `dist/` before bundling.) Linux `rename` can't replace a non-empty directory,
  hence two renames; the gap between them is one system call.
- **Serving:** every game's `dist/` at `/<slug>/`, the game list at `/`, `__DEV__`
  injected. No build at start: whatever is in `dist/` is what the child can play.
- **The browser:** at start, `game serve` launches a headed Chromium with Playwright and
  opens `/`. That window is the child's screen. If it's closed, the next restart opens it
  again.
  - A full Chromium: `GAME_CHROMIUM`, else `/usr/bin/chromium`, else Playwright's cached
    `chromium-*`. Never `chrome-headless-shell`, which can't open a window (`game test`
    may keep using it).
  - A persistent profile (`launchPersistentContext`) in `.browser/` at the project root,
    git-ignored, so `kit.save` survives chiche restarts.
  - `--autoplay-policy=no-user-gesture-required`, so sounds play without a click.
  - Kiosk mode (`--kiosk`): no address bar or tabs, hard to leave by accident.
- **The restart:** `game serve` watches `games/*/dist`. When a game's `dist/` is swapped
  in: `page.goto("/<slug>/")`, which also reloads when it's already there, resuming from
  `kit.save`. The swap's events are collapsed into one restart per game.
- The page's reload script (`/__reload`) goes away: Playwright navigates and reloads.
- chiche starts `game serve` at boot and stops it at exit, which also closes the window.
- `organization.md` and `skills/game-debugging.md`: `game build <slug>` is how a change
  reaches the child's screen, including the first time a game is chosen; the builder
  runs it when a change is ready to be seen. `game serve` is chiche's, not the builder's.

## Terminal

Minimal, one line per thing:

- At boot: the capture source and the playback sink in use, by name and description (the
  PipeWire defaults `pw-record` and `pw-play` attach to), and the log folder of the run.
- Mic muted / unmuted, on every change.
- Live transcripts of both sides (input and output transcription).
- One dim line per liquen event forwarded to the voice (ack, progress, result, error,
  finished), and per Gemini connection change (connected, GoAway, reconnecting).

## Language

- `INSTRUCTIONS.md`: "Speak the language of the locale `{{LANG}}`".
- `organization.md`: the child speaks "the language `$LANG` names"; the builder's shell
  inherits `LANG` (`config.jsonc` leaves `organization.locale` unset).

## Logging

One folder per run under `log/`, the last 10 kept. `log/` and `.browser/` go in
`.gitignore`.

- `timeline.log`: one clock. Mic windows of 250 ms (level and peak in dBFS, running noise
  floor, voice / playing / muted flags, capture falling behind real time) interleaved
  with every Gemini and door message, sent and received.
- `mic.wav` (16 kHz, as sent, silence where withheld) and `voz.wav` (24 kHz, as received),
  aligned to the same clock.
- Size: about 80 KB/s, ~290 MB per hour.

## Measure first

Each answered from the logs of a run, before anything is built on it:

1. Where `scheduling` goes: the docs' JS example puts it inside `response`, the SDK types
   put it on `FunctionResponse`.
2. Whether `willContinue` works on `gemini-3.8-live`.
3. Whether `WHEN_IDLE` waits while the child is talking, or only for the model's own
   speech. If it talks over the child, hold results while the mic is unmuted.
4. Whether an open `input` call survives session resumption. If not, pick a fallback for
   results that arrive after a reconnect.
5. Whether a muted PipeWire source delivers exact zeros (record ~10 s while toggling the
   mute key).
6. Whether the Node build of `@google/genai` runs cleanly under Deno 2.9.6.

## Not now

- An elapsed-time clock or `estado` tool for "¿cómo va?".
- A `cancel` tool.
- Richer progress from liquen than `tool_use` events.
- Changes to liquen (`liquen up`, a log for the ephemeral daemon, current state in the
  `tail` reply).
