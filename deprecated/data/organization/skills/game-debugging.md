---
kind: skill
description: Seeing a game work — game test's steps, eval, saved state and screenshots;
  reading its report; the child's screen; the ?debug, ?seed and ?fresh switches.
---
# Debugging games

`game test <slug>` builds the game into a private temporary folder (the child's `dist/`
is untouched), opens it in headless Chromium, plays the steps you give it, and reports. Sound plays, as the child would hear it. The report comes in this
order:

- the renderer, fps and running scenes; the difficulty (level, success rate, tries)
- **ERRORS**: uncaught exceptions with stacks, `console.error`, files that 404. Any of
  them makes the run exit 1.
- **warnings**: including `[prize] … given without a successful try`, which is a
  design bug: fix it like an error.
- **console**: every log in order, with repeats collapsed as `×N`. The kit logs
  `[sfx]`, `[try]` and `[prize]`, so you can see what the child would hear and earn.
- **eval**: your `--eval` expressions, as JSON (cycles cut, three levels deep).
- **screenshots**: `aread` them. `shot` steps take extra ones mid-run.

## Steps

`--keys` takes one space-separated string, run in order after the game boots:

```sh
game test futbol --keys "Space wait:300 Right:800 shot Space" --for 2
#   Space        tap          Right:800   hold 800 ms (Left/Right/Up/Down, Space, Enter, KeyA…)
#   wait:300     pause        click:480,300   click at game coordinates (960×540)
#   shot         screenshot now
```

`--for` is how long to keep watching after the last step (default 2 s).

## Starting where the bug is

Don't play through the title to reach level 5. Give the save you want:

```sh
game test futbol --state '{"scene":"Play","data":{"level":5},"difficulty":{"level":0.8,"n":30,"recent":[]}}'
```

The boot scene's `next()` resumes into `scene`. `--eval "kit.save"` prints the current
save, a good starting point to copy from.

## Looking inside

```sh
game test futbol --eval "game.scene.getScene('Play').state" --eval "kit.difficulty.rate"
game test futbol --query "debug=1"      # physics bodies drawn + overlay (fps, scenes, level)
game test futbol --query "seed=7"       # same random numbers every run
```

`?fresh=1` drops the save, for the child's browser too. `console.log` your own events
(a goal, a pickup) rather than per-frame values: the report is for reading.

## The child's screen

`game serve` (port 7357) is chiche's: it serves every game's `dist/` at `/<slug>/` in a
browser window of its own and restarts a game there when its `dist/` changes. It builds
nothing. `game build <slug>` is the only thing that writes `dist/`, so it is the one step
that puts a change in front of the child: the window navigates to the game and resumes
the scene and the save. A failed build leaves the old `dist/` in place and the window
alone. Only syntax errors stop a build; type errors don't, so run `game check` and
`game test` before you build a change the child is going to see.
