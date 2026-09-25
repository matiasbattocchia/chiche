---
kind: skill
description: Making a game's own sound effects with the kit's makeSound (jsfxr settings) —
  what each setting does in Hz and seconds, recipes, and how the child's ears tune them.
---
# Game sounds

The kit's built-in sounds cover the common events (`sfx()` lists them). When a game needs a
sound they don't have — the dragon's sneeze, a splash, the silly noise the child asked for —
make it:

```ts
import { makeSound, sfx } from "kit";

makeSound("sneeze", { wave_type: 3, p_base_freq: 0.6, p_env_sustain: 0.1, p_env_decay: 0.3 });
// later, in a scene
sfx(this, "sneeze");
```

`makeSound` goes at the top level of `main.ts`, once. Settings you leave out keep jsfxr's
defaults; the kit scales every sound to the same loudness and varies its pitch a little on
each play. Name the sound for what it should sound like.

## You can't hear it: the child can

You design a sound from the numbers below, and you can check that it plays (`game test`
logs `[sfx] <name>` on every play, and warns about a name it doesn't know), but not how it
sounds. The child is your ears:

1. Make the sound from a recipe or the settings, `game build`.
2. Your answer says there's a new sound, when it plays, and what it should sound like ("the
   sneeze plays when the dragon eats a pepper: a short hiss"). The voice asks the child to
   play until they hear it.
3. What comes back is their words for it: "suena como un pato", "más gordo", "más largo".
   Change one or two settings in that direction (the table at the end), build, and ask
   again.

Games are committed as you go, so a version they liked better is in `git log`.

## The settings

Each setting is a number from 0 to 1; the signed ones go from -1 to 1. The formulas are
jsfxr's own (`sfxr.js`, at 44100 Hz).

**Wave** (`wave_type`): 0 square (beepy, retro), 1 sawtooth (buzzy, brassy), 2 sine (soft
and pure: bells, whistles), 3 noise (no pitch: explosions, splashes, steps, wind).

**Pitch**
- `p_base_freq`: the starting pitch, 3528 × (v² + 0.001) Hz: 0.1 is 39 Hz (a rumble), 0.2
  is 145, 0.35 is 436 (the A a piano tunes to), 0.5 is 886, 0.7 is 1730, 1 is 3530. For
  noise it is how rough or hissy: low rumbles, high hisses.
- `p_freq_ramp` (signed): the slide, about 636 × v³ octaves per second, up when positive,
  down when negative: 0.1 drifts (0.6 octaves/s), 0.25 slides (10), 0.35 whooshes (27).
- `p_freq_limit`: the lowest a falling slide goes, on the same scale as `p_base_freq`; the
  sound ends when it gets there. Without it, a falling sound drops into a growl.
- `p_freq_dramp` (signed): the slide speeds up (positive) or slows down.
- `p_vib_strength`, `p_vib_speed`: vibrato, a wobble of ± v × 50% in pitch, about 69 × v²
  times a second: wobbly, warbly, cartoonish.
- `p_arp_mod` (signed), `p_arp_speed`: one jump in pitch partway through. Positive jumps up,
  by × 1 / (1 − 0.9 × v²): 0.5 is a major third, 0.6 a fifth, 0.74 an octave; negative
  jumps down. It happens 0.45 × (1 − speed)² seconds in: 0.6 is 0.07 s, 0.4 is 0.16 s.
- `p_repeat_speed`: restarts the pitch (slide and jump included) every 0.45 × (1 − v)²
  seconds: 0.5 is 0.11 s. A trill, a ratchet, a coin's double ding.

**Length and loudness over time**: the sound is attack, then sustain, then decay; each lasts
2.27 × v² seconds: 0.1 is 0.02 s, 0.2 is 0.09, 0.3 is 0.2, 0.5 is 0.57, 0.66 is 1.
- `p_env_attack`: fading in; 0 starts at once, like almost every game sound.
- `p_env_sustain`: holding.
- `p_env_punch`: the sustain starts up to 1 + 2 × v louder and settles: a thump at the
  start. Up to 0.3 stays clean; more can clip.
- `p_env_decay`: fading out.

**Color**
- `p_duty`, `p_duty_ramp` (signed): square wave only. 0 is a hollow full square; toward 1
  it gets thinner and more nasal. The ramp sweeps it.
- `p_lpf_freq`: low-pass filter. 1 is off; lower is darker and muffled. `p_lpf_ramp`
  (signed) closes it over time when negative (a boom fading into a rumble), opens it when
  positive. `p_lpf_resonance`: a ringing edge at the cutoff.
- `p_hpf_freq`: high-pass filter. 0 is off; higher cuts the low end: thin, tinny, far away.
  `p_hpf_ramp` (signed) sweeps it.
- `p_pha_offset`, `p_pha_ramp` (signed): flanger, a swirly, jet-like sheen.

## Recipes

Rendered and measured (length, pitch over time), not heard: starting points for the child
to tune.

| sound | settings | measured |
|---|---|---|
| ding | `wave_type: 2, p_base_freq: 0.6, p_env_sustain: 0.05, p_env_punch: 0.3, p_env_decay: 0.55` | 0.7 s at 1270 Hz |
| falling whistle | `wave_type: 2, p_base_freq: 0.6, p_freq_limit: 0.25, p_freq_ramp: -0.25, p_env_sustain: 0.4, p_env_decay: 0.3` | 0.25 s, 1070 → 270 Hz |
| boing | `wave_type: 0, p_duty: 0.3, p_base_freq: 0.25, p_freq_ramp: 0.25, p_vib_strength: 0.4, p_vib_speed: 0.5, p_env_sustain: 0.2, p_env_decay: 0.3` | 0.3 s, rising 280 → 1450 Hz with a wobble |
| yay | `wave_type: 0, p_duty: 0.4, p_base_freq: 0.4, p_arp_mod: 0.5, p_arp_speed: 0.6, p_env_sustain: 0.25, p_env_decay: 0.3` | 0.35 s, 560 Hz, up a third at 0.07 s |
| fart | `wave_type: 1, p_base_freq: 0.12, p_vib_strength: 0.4, p_vib_speed: 0.7, p_env_sustain: 0.3, p_env_decay: 0.3, p_lpf_freq: 0.5` | 0.4 s, about 55 Hz, wobbling |
| splash | `wave_type: 3, p_base_freq: 0.6, p_env_sustain: 0.1, p_env_punch: 0.4, p_env_decay: 0.45, p_lpf_freq: 0.7, p_lpf_ramp: -0.3, p_hpf_freq: 0.2` | 0.5 s of hiss, darkening |
| thud | `wave_type: 3, p_base_freq: 0.1, p_env_sustain: 0.05, p_env_punch: 0.6, p_env_decay: 0.2, p_lpf_freq: 0.4` | 0.1 s, low and muffled |

jsfxr's generators roll random settings for a kind of sound (pickupCoin, laserShoot,
explosion, powerUp, hitHurt, jump, blipSelect, click). In `organization/`, this prints one
to start from:

```sh
deno eval 'import { sfxr } from "jsfxr"; const { oldParams, sound_vol, sample_rate, sample_size, ...s } = sfxr.generate("jump"); console.log(JSON.stringify(s))'
```

Copy the numbers into `makeSound`: the generator gives a different sound on every call.

## The child's words

| they say | change |
|---|---|
| lower, fatter, bigger ("más grave", "más gordo") | `p_base_freq` down |
| higher, thinner, smaller ("más finito") | `p_base_freq` up |
| longer, shorter | `p_env_sustain` and `p_env_decay` up or down |
| it should go up, go down | `p_freq_ramp` positive or negative |
| wobbly, silly | `p_vib_strength` and `p_vib_speed` up |
| softer, rounder | `wave_type: 2`, or `p_lpf_freq` down |
| louder, stronger | `p_env_punch` up (every sound is scaled to the same peak, so punch is what adds weight) |
| like water, wind, steps, a crash | `wave_type: 3` |
| like a robot, a video game | `wave_type: 0` |

When their words don't fit the table ("suena raro"), ask as a choice of two: higher or lower,
longer or shorter.
