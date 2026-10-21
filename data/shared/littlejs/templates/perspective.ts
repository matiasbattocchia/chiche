// A 2D view with depth: the ground seen from in front and going away (a table from where you sit,
// a road ahead, a room from its door), drawn with 2D shapes. Each thing has a place `x` (across),
// `z` (its distance: 0 the near edge, 1 the far edge, more beyond it) and `h` (its height), and
// drawn things go through `toScreen` and `scaleAt`. Size goes with 1/distance, as through a
// camera: the far half of the ground looks smaller than the near half, and lines go straight to
// one vanishing point. Evenly spaced things are placed at evenly spaced `z`; nothing needs its own
// shrinking.

import { type Color, drawPoly, vec2, type Vector2 } from "littlejsengine";

export class Perspective {
  // the size at distance z is 1 / (1 + k·z), farScale at z = 1
  readonly k: number;
  /** Where the lines into the distance meet, in world space. */
  readonly vanish: Vector2;

  /** `near`: where the ground's near edge middle is drawn, in world space. `farY`: the y its far
   *  edge is drawn at. `farScale`: how big things at the far edge look next to the near edge
   *  (.3: a long table seen from one end; .7: a short one, or seen from high up). */
  constructor(
    readonly near: Vector2,
    readonly farY: number,
    readonly farScale = .3,
  ) {
    this.k = 1 / farScale - 1;
    this.vanish = vec2(near.x, (farY - farScale * near.y) / (1 - farScale));
  }

  /** How big something at distance `z` is drawn, 1 at the near edge. */
  scaleAt(z: number): number {
    return 1 / (1 + this.k * z);
  }

  /** Where `x` across, `z` away and `h` up is drawn, in world space. */
  toScreen(x: number, z: number, h = 0): Vector2 {
    const s = this.scaleAt(z);
    return vec2(
      this.vanish.x + x * s,
      this.vanish.y + (this.near.y - this.vanish.y + h) * s,
    );
  }

  /** How far up the screen distance `z` is drawn: 0 the near edge, 1 the far edge, evenly on
   *  screen. What the player moves over the ground (an aim, a marker) and the tolerances it is
   *  compared with go in these terms, so it moves as fast near as far: `depthAt` turns it into a
   *  distance. */
  onScreen(z: number): number {
    return (1 - this.scaleAt(z)) / (1 - this.farScale);
  }

  /** The distance drawn at `r` up the screen: `onScreen` the other way. */
  depthAt(r: number): number {
    return (1 / (1 - (1 - this.farScale) * r) - 1) / this.k;
  }

  /** The corners of a flat piece of ground (a floor, a tablecloth, a tile) at height `h`. */
  quad(x0: number, z0: number, x1: number, z1: number, h = 0): Vector2[] {
    return [
      this.toScreen(x0, z0, h),
      this.toScreen(x1, z0, h),
      this.toScreen(x1, z1, h),
      this.toScreen(x0, z1, h),
    ];
  }

  /** Draws a flat piece of ground at height `h`. */
  drawGround(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    color: Color,
    h = 0,
  ) {
    drawPoly(this.quad(x0, z0, x1, z1, h), color);
  }
}

/** Sorts what is drawn so that the farthest goes first and the near covers it:
 *  `things.sort(farFirst)` before drawing them. */
export function farFirst(a: { z: number }, b: { z: number }): number {
  return b.z - a.z;
}
