---
kind: skill
description: Art, sound and fonts for the org's games — the library (`game assets`): searching
  it, looking at what it has, importing more, and when to draw or synthesize instead.
---
# Game assets

Only assets we are free to publish: **CC0**, **MIT** or **OFL**, or made by us (drawn in
code, synthesized). No sprites ripped from existing games, no "free for personal use", no
attribution-required licenses unless the credit shows in the game.

## The library

`games/assets/` is the library every game draws from, like a music program's sound library:
a core set to start with, and packs imported to go beyond. `game assets` lists its packs.

- **Core** (`game assets import core`, already in place):
  - Microsoft's Fluent emoji in 3D (about 1,100): animals, food, faces, people, sports,
    vehicles and places. Friendly, and figures the child knows.
  - Kenney's New Platformer Pack (a hero in five colors that walks, jumps and gets hit,
    enemies, tiles, backgrounds), Toon Characters, Animal Pack, UI Pack and Game Icons.
  - Kenney's Interface Sounds and Impact Sounds.
  - The fonts Fredoka (round, for titles) and Andika (made for children learning to read).
- **Search** by what you need, in English: `game assets search penguin`, `game assets search
  button round --kind image`, `game assets search footstep --kind sound`. Each result says
  what it is, its size (pixels, or seconds for a sound) and its files. The images come
  with a contact sheet: `aread` it and choose by looking, never by name alone ("character"
  in the platformer pack is an alien in a space helmet).
- **Use**: `game assets use <slug> <file>...` copies files into the game's `assets/`, with
  their license, and prints the line that loads each one. Load them in the boot scene's
  `preload()`. A game ships only its own `assets/`, so it stays self-contained.
- **Beyond the library**: `game assets import kenney <pack>` brings in any kenney.nl pack
  (CC0) by the name in its URL: `fetch https://kenney.nl/assets` to browse them. `game
  assets import fluent <group or emoji>` adds more emoji (Objects, Symbols). `game assets
  import font <family>` adds a Google Fonts family.

The library leaves out files whose names say nothing (`jingles_NES09`, `tile_0042`): nobody
could choose them. `--opaque` imports them anyway; an image you can still judge by looking,
a sound you can't.

## Choosing

- **One look per game.** Fluent's 3D emoji and Kenney's flat drawings don't mix well:
  pick one family for the characters and things, and keep to it. UI and icons can differ.
- **Sizes vary.** Fluent emoji are 256×256, Kenney sprites about 64 to 128: `setScale` or
  `setDisplaySize` so things read at a five-year-old's size.
- **Frames**: an entry with several files named `_a`, `_b` (walk, climb) is an animation.
  Load each file and make it with `this.anims.create({ key, frames: [{ key: "walk_a" },
  { key: "walk_b" }], frameRate: 8, repeat: -1 })`.
- **Drawn in code**: Phaser `Graphics` plus `generateTexture` in the boot scene. Shapes,
  stars, balls, simple characters. Good enough for a first version, and often for the last.
- **Sound**: the kit's `sfx()` has built-in sounds, and `makeSound` makes new ones (the
  `game-sound` skill). The library's sounds are for what a synth can't do: footsteps, a
  glass, a punch. You can't hear any of them, so choose by name and length, and ask the
  child how it sounds.

Keep games small: a few hundred KB of assets each. Every game on the site is rebuilt on
each publish, though only changed files upload.
