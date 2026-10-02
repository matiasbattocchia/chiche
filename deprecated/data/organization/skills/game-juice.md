---
kind: skill
description: Making a game feel alive — the kit's effects (pop, squash, shake, flash, burst,
  hitStop, glow, sfx) and when each one fits, plus Phaser 4 filters for the look.
---
# Juice

A game where things only move and vanish feels dead; the same game where every action
answers back feels alive. Game designers call that answer *juice*: easing, squash and
stretch, particles, flashes, shake, sound on everything ("Juice it or lose it", Jonasson &
Purho, GDC Europe 2012; "The art of screenshake", Nijman, 2013). For a five-year-old it is
also how they know what happened: they can't read "+1", they see it and hear it.

Add juice from the first rough try: it costs a line per event, and a rough game with juice
is more fun to play than a pretty one without.

## Every event answers

For each thing that happens in the game, pick an answer from the kit (`import { … } from
"kit"`):

| event | answer |
|---|---|
| something appears (a star, an enemy, a button) | `pop(obj)` |
| landing, bumping, a button pressed | `squash(obj)` + `sfx(this, "jump")` or `"click"` |
| catching, collecting | `burst(this, x, y, { tint })` + `sfx(this, "coin")` or `"pickup"` |
| a hit, a crash | `hitStop(this)` + `shake(this)` + `sfx(this, "hit")`, `"hurt"` or `"explosion"` |
| a big success (a prize, a level) | `flash(this, color)` + `burst` with more `count` + `sfx(this, "win")` or `"powerup"` |
| a miss | `sfx(this, "miss")` and nothing bigger: a miss is never a punishment |
| something worth grabbing | `glow(obj, color)` |

`sfx()` lists every built-in sound by name: the name says what it sounds like. They vary their
pitch a little on each play, so the hundredth coin doesn't grate. For an event none of them
fits, make one: the `game-sound` skill.

## Motion

- Tweens with an ease, never linear: `"Back.easeOut"` to arrive, `"Sine.easeInOut"` to
  float, `"Bounce.easeOut"` to drop. `game docs tweens` has them all.
- Things that wait for the child breathe: a slow scale or bob with `yoyo: true, repeat: -1`.
- The camera can follow, zoom in on a win, pan to what matters: `game docs cameras`.

## Look

Phaser 4's filters run on the GPU and show up in `game test`'s screenshots, so you can check
them (`game docs filters-and-postfx`, `game docs v4-new-features`):

- `this.cameras.main.filters.internal.addVignette()`: soft dark edges, the eye goes to the
  middle.
- `obj.enableFilters()`, then `obj.filters!.internal.addShadow()`: a shadow under characters
  lifts them off the background.
- A gradient sky instead of a flat color: `game docs v4-new-features` (Gradient).
- `addWipe()` on the camera for a change of scene.

## Limits

- Shake and flash are short and small; the defaults are enough. A five-year-old should never
  be startled.
- Never flash more than three times a second: faster flashing can trigger seizures in
  photosensitive people (WCAG 2.2, success criterion 2.3.1).
- Juice follows the child's actions. Things that happen on their own stay calm, so the
  child's successes stand out.
- Look at every effect in a `game test` screenshot before calling it done.
