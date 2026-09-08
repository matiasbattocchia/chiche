#!/bin/bash
# run.sh — the Pipecat bot with our echo cancellation: raise the AEC process (aec.conf),
# pin the quantum, start the bot, move its PyAudio streams onto the AEC nodes, and put
# everything back on exit.
set -u
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
mkdir -p "$ROOT/data"
pipewire -c "$ROOT/aec.conf" > "$ROOT/data/aec.log" 2>&1 &
AEC=$!
for i in $(seq 1 40); do pactl list short sources 2>/dev/null | grep -q gemini_aec_source && break; sleep 0.1; done
pw-metadata -n settings 0 clock.force-quantum 480 > /dev/null
cleanup() { kill "$AEC" 2>/dev/null; pw-metadata -n settings 0 clock.force-quantum 0 > /dev/null; }
trap cleanup EXIT
trap '[ -n "${BOT:-}" ] && pkill -INT -P "$BOT"; kill -INT "${BOT:-0}" 2>/dev/null' INT TERM
uv run bot.py "$@" &
BOT=$!
# PyAudio opens the default nodes; move the bot's streams onto the AEC's once they exist
moved=0
for i in $(seq 1 200); do
  for kind in source-output sink-input; do
    for id in $(pactl -f json list ${kind}s | python3 -c 'import json,sys;s=sys.stdin.read();[print(o["index"]) for o in json.loads(s or "[]") if "python" in (o.get("properties",{}).get("application.process.binary","") + o.get("properties",{}).get("application.name",""))]'); do
      target=$([ "$kind" = source-output ] && echo gemini_aec_source || echo gemini_aec_sink)
      pactl move-$kind "$id" "$target" && moved=$((moved+1))
    done
  done
  [ "$moved" -ge 2 ] && break; sleep 0.1
done
echo "· eco: $moved streams del bot movidos a gemini_aec_source / gemini_aec_sink" >&2
wait "$BOT"
