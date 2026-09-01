# Voice REPL

A terminal voice agent on the [Gemini Live API](https://ai.google.dev/gemini-api/docs/live).
Talk into the microphone, hear the reply, and watch both sides of the
conversation transcribed live. The agent speaks Spanish.

## Requirements

- [mise](https://mise.jdx.dev) — pins Deno and loads `.env`
- PipeWire (`pw-record`, `pw-play`, `pactl`)
- A `.env` with `GEMINI_API_KEY=…`

```sh
mise trust && mise install
```

## Usage

```sh
deno task start    # echo cancellation on, default devices
deno task ptt      # push to talk
deno task raw      # no echo cancellation (use headphones)
```

Keys: `m` mute · `space` interrupt the model · `q` quit.
Under `--ptt`, space holds to talk — or toggles, if the terminal doesn't report
key releases.

Echo cancellation loads PipeWire's `module-echo-cancel` for the run and unloads
it on exit, leaving the audio graph as it found it. It binds to whatever the
default sink is at startup, so switch devices *before* starting.

## Two agents (`relay.ts`)

An experiment: the voice model interprets, [mu](../new) builds. They never hear each
other verbatim.

```sh
deno task relay        # voice + mu, push to talk
deno task relay:test   # the voice alone — mu is never raised
```

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
injected turns. Push to talk is the default here — an open mic bills 25 tokens/second of
silence, and it would race the injected turns.

Each agent has one conversation, not one per run. mu's is its log; the voice model's is
the Live API session, whose resumption handle is persisted under `data/relay/` and
reloaded on start — a restart resumes where it left off, falling back to a fresh
conversation when the server no longer honors the saved handle.

Requires `ANTHROPIC_API_KEY` in `.env` for mu, and `@mu/` in the import map pointing at a
local mu checkout (standing in for the `@mu/core` JSR package it is not yet published as).
mu's daemon is raised on demand and reaps itself ~30s after the REPL detaches.

## Layout

| file | |
| --- | --- |
| `main.ts` | session, transcripts, keybindings, reconnect loop |
| `relay.ts` | the two-agent mode: voice ↔ mu |
| `mu.ts` | mu attach client, flattened to activity / final / error |
| `audio.ts` | `pw-record` capture and `pw-play` playback |
| `aec.ts` | echo-cancel module lifecycle |
| `keys.ts` | stdin reader, kitty keyboard protocol for key releases |

## Notes

- Audio is mono PCM s16le: 16 kHz in, 24 kHz out.
- The import map points at the SDK's **web** build. The Node build goes through
  npm `ws` on Deno's Node TLS shim, which panics on teardown.
- Sessions survive the API's ~10-minute connection resets via resumption
  handles, and the 15-minute cap via sliding-window context compression.
