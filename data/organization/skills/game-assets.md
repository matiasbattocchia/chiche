---
kind: skill
description: Art, sound and music for the org's games — which sources are allowed,
  how to fetch and credit them, and when to draw or synthesize instead.
---
# Game assets

Only assets we are free to publish: **CC0**, or made by us (drawn in code, synthesized,
generated). No sprites ripped from existing games, no "free for personal use", no
attribution-required licenses unless the credit shows in the game.

## Where from

- **Kenney** (kenney.nl): hundreds of CC0 packs, both 2D and audio, in one coherent
  style that suits young children: platformer, sports, animals, UI, fonts, sound
  effects. The first place to look. A pack's page links a zip; `fetch -o pack.zip <url>`
  and `unzip`.
- **OpenGameArt** (opengameart.org): mixed licenses. Filter for CC0 and check each file.
- **Drawn in code**: Phaser `Graphics` plus `generateTexture` in the boot scene.
  Shapes, stars, balls, simple characters. Good enough for a first version, and often
  for the last one.
- **Sound**: the kit's `sfx()` synth covers click, jump, coin, kick, hit, miss and win.
  For more, Kenney's audio packs, or add a preset to `PRESETS` in `kit/mod.ts`.

## Where they go

- The shared library `games/assets/<pack>/` keeps whole packs, fetched once. Every pack
  gets a line in `games/assets/CREDITS.md`: the name, URL, license, and date fetched.
- A game copies only the files it uses into its own `<slug>/assets/`. The build ships
  that folder and nothing else, so the game stays self-contained.
- Load assets in the boot scene's `preload()` with `this.load.image(key, "assets/…")`.
  The path is relative to the game's page. A 404 shows up in `game run`'s ERRORS.

Keep assets small: PNG sprites and sprite sheets, OGG or MP3 audio, a few hundred KB
per game: every game on the site is rebuilt on each publish, though only changed
files upload.
