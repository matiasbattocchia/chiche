# Voice REPL

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

Keys: `m` mute · `space` interrupt the model · `q` quit.
Under `--ptt`, space holds to talk — or toggles, if the terminal doesn't report
key releases.

The app captures from and plays to the default PipeWire devices, so switch devices
*before* starting. The preflight lines name them, with their volumes.

## Two agents

An experiment: the voice model interprets, [mu](../new) builds. They never hear each
other verbatim.

Agent 1 sends work through an `input` tool and mu's output comes back out of band,
injected as `[mu]` turns. `turnComplete:false` accrues mu's activity — tool calls,
thinking, failures — as context that generates nothing, so agent 1 knows the build is
still running without narrating it; mu's final answer arrives with `turnComplete:true`,
which is what makes it speak, in its own words rather than reading the transcript out.

The tool is fire and forget: it answers on the spot with a canned ack (async function
calling is not supported on this model, and a call left hanging stalls the session) and
the send happens in the background. Inputs and outputs don't pair 1:1 — lines sent while
mu is busy steer it, one instruction can yield many messages — so nothing of mu's, not
even a delivery failure, travels as a tool result; it all enters agent 1's context as
injected turns. The default is an open mic; `--ptt` spares the 25 tokens/second an open
mic bills for silence, and narrows the race between your turn and the injected ones.

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
- Audio is mono PCM s16le: 16 kHz in, 24 kHz out.
- The import map points at the SDK's **web** build. The Node build goes through
  npm `ws` on Deno's Node TLS shim, which panics on teardown.
- Sessions survive the API's ~10-minute connection resets via resumption
  handles, and the 15-minute cap via sliding-window context compression.
