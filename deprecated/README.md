# chiche

A terminal voice agent on the [Gemini Live API](https://ai.google.dev/gemini-api/docs/live).
Talk into the microphone, hear the reply, and watch both sides of the
conversation transcribed live. The agent speaks Spanish.

## Requirements

- [mise](https://mise.jdx.dev) — pins Bun (and Deno, which mu still runs on) and loads `.env`
- PipeWire (`pw-record`, `pw-play`, `pactl`)
- **Headphones.** There is no echo cancellation; on speakers the model hears itself.
- A `.env` with `GEMINI_API_KEY=…`

```sh
mise trust && mise install && bun install
```

## Usage

```sh
bun start                  # two agents: voice + mu — open mic
bun start --no-mu          # the voice alone, no tools — the audio test bench
bun start --ptt            # push to talk
```

One app, one task; flags combine. `--no-mu` leaves the voice with no tools at all.

Keys: `m` toggle the system mic mute (the same one the keyboard's mic key flips) · `space` cut playback · `q` quit.

Under `--ptt` **you** gate the microphone, with the keyboard's own mic-mute key. The
app does nothing for it and needs no keybinding: muting a PipeWire source hands
`pw-record` exact zeros without interrupting the stream, so the server keeps receiving
audio, hears silence, and closes your turn by itself. The key works whatever window has
focus, because the desktop owns it, not this app.

The flag only shortens the silence window the server waits for, since a keypress is a
sharper end of turn than a pause for breath. Everything else is identical to the open
mic.

The app captures from and plays to the default PipeWire devices, so switch devices
*before* starting. The preflight lines name them, with their volumes.

## Two agents

An experiment: the voice model interprets, [mu](../new) builds. They never hear each
other verbatim.

Agent 1 sends work through an `input` tool and mu's output comes back out of band,
injected as `[mu]` turns. `turnComplete:false` accrues mu's activity — tool calls,
thinking, failures — as context that generates nothing, so agent 1 knows the build is
still running without narrating it; each line is stamped with seconds since the work
began, because the model has no clock and would otherwise not tell a fresh build from a
stuck one. mu's final answer arrives with `turnComplete:true`, which is what makes it
speak, in its own words rather than reading the transcript out — but only onto a free
floor. While the model speaks it is held back, because `turnComplete:true`
unconditionally interrupts generation, and goes out when the model's turn completes.
While you speak it accrues like activity and your own turn brings it out, since a reply
requested over you would be discarded at your next word.

The tool is fire and forget: it answers on the spot with a canned ack and the send
happens in the background. It is declared `BLOCKING` on purpose: gemini-3.8-live defaults
to async function calling, which pairs one response to one call and lets the model talk
on while it waits — the wrong shape for mu, and an unscheduled response cuts in on that
speech. Inputs and outputs don't pair 1:1 — lines sent while
mu is busy steer it, one instruction can yield many messages — so nothing of mu's, not
even a delivery failure, travels as a tool result; it all enters agent 1's context as
injected turns.

Each agent has one conversation, not one per run. mu's is its log; the voice model's is
the Live API session, whose resumption handle is persisted under `data/relay/` and
reloaded on start — a restart resumes where it left off, falling back to a fresh
conversation when the server no longer honors the saved handle.

A parallel repl — `deno task mu` in the mu project, in another terminal — attaches to the same daemon:
it paints the full transcript the voice flattens, and it steers — lines typed there enter
the same conversation, and mu's replies to them are spoken by the voice too. It is also
where an approval card can be answered if one ever fires.

Requires `ANTHROPIC_API_KEY` in `.env` for mu, and `@mu/` in the import map pointing at a
local mu checkout (standing in for the `@mu/core` JSR package it is not yet published as).
mu's daemon is raised on demand and reaps itself ~30s after the REPL detaches.

## Layout

| file | |
| --- | --- |
| `main.ts` | the app: session, keybindings, reconnect loop, the tool + injections |
| `mu.ts` | mu attach client, flattened to activity / final / error |
| `metrics.ts` | the audio timeline (`data/audio.log`): mic level vs. server events |
| `shell.ts` | terminal shell: transcript, signals, the audio rig |
| `audio.ts` | `pw-record` capture and `pw-play` playback |
| `keys.ts` | stdin reader, kitty keyboard protocol for key releases |

## Debugging endpointing

Every run rewrites `data/audio.log`: the mic level per 250 ms window (dBFS, peak, a
running noise floor, a bar, and whether the speaker was playing) interleaved with every
server event — transcriptions, audio, `interrupted`, turn boundaries — plus key presses
and connection status. The terminal's `[speech end · respuesta +1.4s]` marker is the
gap between your last loud window and the model's first word.

Two recordings sit beside the log on the same clock: `data/mic.wav` is exactly what
was sent to the API (16 kHz, silence where
the mic was muted) and `data/voz.wav` is the model's audio as it arrived (24 kHz). A
transcript that reads nothing like what you said gets settled by ear — seek to the
log's timestamp.

To tell the two suspects apart: if the `voz` flag keeps firing after you stop talking,
the room (or the mic chain) never goes quiet and the server's VAD is right to wait —
fix the audio path. If the level drops to the floor and the server still sits on it,
that latency is the API's.

## Notes

- No echo cancellation, by decision. PipeWire's `module-echo-cancel` was tried for a
  week (see the history on the `pipecat` branch): it lives inside the graph, so it
  inherits the quantum, the driver pairing and rtkit's realtime budget, and any of
  the three going wrong drops capture silently. The next attempt, if any, is an
  in-process canceller (WebRTC AEC3 or SpeexDSP over `bun:ffi`) fed our own playback
  as the far-end reference, so the audio backend only moves bytes.
- The metrics summary line (`mic entregó Xs en Ys`) is the capture health check:
  anything under 100% means samples were lost before reaching the server.
- `thinkingConfig` is only for the models that think. `gemini-3.8-live` hangs the
  setup silently when it is present — no error, no close, the connect just never
  completes — because its thinking lives in the `-extended-thinking` variant. The
  same trap caught the 2.5 models with the Gemini 3 fields.
- A muted PipeWire source yields exact zeros, and the capture stream survives the
  mute: 3 s of `pw-record` across a mute transition came back full length, loud in
  the first half and all-zero in the second. That is the whole of push to talk, and
  why the app has no gate of its own.
- Hybrid VAD buys us nothing, measured. The documented `audioStreamEnd` is meant to
  finalise a turn without waiting for the silence window, but a muted mic already
  feeds the server digital silence, and at a 200 ms window its own detection fires
  first. Sending `audioStreamEnd` instead produced no transcript and no reply at all.
- Interim transcripts do not exist on the voice models. Measured on both
  `gemini-3.1-flash-live-preview` and `gemini-3.8-live`: zero
  `interimInputTranscription` messages, in automatic and manual activity modes alike.
  Only `gemini-3.5-transcribe-live` emits them, and it refuses an audio response, so
  live captions would mean a second session fed the same microphone.
- Audio is mono PCM s16le: 16 kHz in, 24 kHz out.
- The import map points at the SDK's **web** build. The Node build goes through
  npm `ws` on Deno's Node TLS shim, which panics on teardown.
- Sessions survive the API's ~10-minute connection resets via resumption
  handles, and the 15-minute cap via sliding-window context compression.
