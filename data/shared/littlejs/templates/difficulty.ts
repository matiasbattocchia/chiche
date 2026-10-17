// Adaptive difficulty: the game says how each try went, and the level moves so that about 85% of
// the tries go well. Up a little after each success and down more after each failure, the two
// balance where 85% succeed: hard enough to mean something, easy enough to keep playing. The level
// is kept between visits, under the game's name.

import { clamp, lerp, readSaveData, writeSaveData } from "littlejsengine";

export class Difficulty {
  /** 0 the easiest, 1 the hardest. */
  level: number;
  /** How the recent tries went, 0 to 1: it settles near `target`. */
  rate: number;

  /** `name`: the game's, for its save data. `step`: how far a failure moves the level down. */
  constructor(
    readonly name: string,
    readonly target = .85,
    readonly step = .2,
  ) {
    const saved = readSaveData(name + ".difficulty", { level: 0 });
    this.level = clamp(Number(saved.level) || 0);
    this.rate = target;
  }

  /** One try: `ok` when it went well (a gap jumped, a wave held, a board solved). */
  record(ok: boolean) {
    const t = this.target;
    this.level = clamp(this.level + this.step * (ok ? 1 - t : -t));
    this.rate = lerp(this.rate, ok ? 1 : 0, .1);
    writeSaveData(this.name + ".difficulty", { level: this.level });
  }

  /** A value between its easiest and its hardest, at the current level. */
  at(easiest: number, hardest: number): number {
    return lerp(easiest, hardest, this.level);
  }
}
