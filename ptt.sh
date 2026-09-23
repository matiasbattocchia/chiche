#!/bin/sh
# ptt.sh — the microphone key, routed to the voice app when it is running.
#
# The terminal only receives keys while it is focused, so the in-app space bar stops
# working the moment you switch to anything else. Sway grabs the key globally and runs
# this, which signals the app wherever it is: SIGUSR1 for the key going down, SIGUSR2
# for it coming up. The app turns that pair into hold-to-talk, and a short tap into a
# latch (see main.ts).
#
# With no app running the key keeps its ThinkPad meaning, so muting the microphone from
# the keyboard still works when you are not in a conversation. Only the press falls back;
# the release must stay silent or every press would toggle twice.
#
# Sway, in ~/.config/sway/config:
#   bindsym --no-repeat XF86AudioMicMute exec ~/vibes/ptt.sh down
#   bindsym --release   XF86AudioMicMute exec ~/vibes/ptt.sh up

PID_FILE="${XDG_RUNTIME_DIR:-/tmp}/vibes-ptt.pid"
pid=$(cat "$PID_FILE" 2>/dev/null)

# `kill -0` is the liveness test: a stale file from a crashed run must not swallow the key.
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  case "$1" in
    down) kill -USR1 "$pid" ;;
    up)   kill -USR2 "$pid" ;;
  esac
elif [ "$1" = down ]; then
  exec wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle
fi
