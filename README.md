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

The tool is deliberately blocking and answers immediately with mu's door ack: async
function calling is not supported on this model, so a call left hanging stalls the
session. Push to talk is the default here — an open mic bills 25 tokens/second of
silence, and it would race the injected turns.

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
