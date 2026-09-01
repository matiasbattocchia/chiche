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

## Layout

| file | |
| --- | --- |
| `main.ts` | session, transcripts, keybindings, reconnect loop |
| `audio.ts` | `pw-record` capture and `pw-play` playback |
| `aec.ts` | echo-cancel module lifecycle |
| `keys.ts` | stdin reader, kitty keyboard protocol for key releases |

## Notes

- Audio is mono PCM s16le: 16 kHz in, 24 kHz out.
- The import map points at the SDK's **web** build. The Node build goes through
  npm `ws` on Deno's Node TLS shim, which panics on teardown.
- Sessions survive the API's ~10-minute connection resets via resumption
  handles, and the 15-minute cap via sliding-window context compression.
