// The game's controls: one game, played on a phone first, and on the laptop's keyboard and with
// a gamepad too. Moving is the arrows and WASD, a gamepad's stick or cross, and on a phone what
// the genre's scheme says; an action is a key, a gamepad button and a button on the phone, read
// together. The actions are Space and X, and C and Z when a third and a fourth are justified.

import {
  drawCircle,
  drawRect,
  drawTextScreen,
  gamepadDpad,
  gamepadIsDown,
  gamepadStick,
  gamepadWasPressed,
  isTouchDevice,
  keyDirection,
  keyIsDown,
  keyWasPressed,
  lastInputDevice,
  mainCanvas,
  mainCanvasSize,
  mouseIsDown,
  mousePos,
  mousePosScreen,
  mouseWasPressed,
  rgb,
  setTouchGamepadAnalog,
  setTouchGamepadButtonCount,
  setTouchGamepadDisplayTime,
  setTouchGamepadEnable,
  setTouchGamepadSize,
  vec2,
  type Vector2,
} from "littlejsengine";

/** How a phone plays the game, which its genre picks:
 *  - `pad`: a cross under the left thumb and the action buttons under the right, held sideways
 *  - `point`: one finger, upright: a tap is where to go or what to act on, a finger held down
 *    drags, and the action buttons are tapped
 *  - `tap`: upright, the whole screen is the first action; with a second, the left half is it */
export type Scheme = "pad" | "point" | "tap";

/** The actions' keys, in order: the first is the main one. */
export const ACTION_KEYS = ["Space", "KeyX", "KeyC", "KeyZ"];

const SIZE = 130; // the touch gamepad's size, in the page's pixels: big, for small fingers

let scheme: Scheme = "pad";
let icons: string[] = [];
let pressOnButton = false; // the finger now down went down on an action button

/** In `gameInit`: the genre's scheme, and an icon for each action, the main one first. */
export function controlsInit(controlsScheme: Scheme, actionIcons: string[]) {
  scheme = controlsScheme;
  icons = actionIcons.slice(0, 4);
  if (scheme == "pad") {
    setTouchGamepadEnable(true); // shows on a touch device only
    setTouchGamepadAnalog(false); // a cross: four clear directions
    setTouchGamepadButtonCount(icons.length);
    setTouchGamepadDisplayTime(0); // always on screen
    setTouchGamepadSize(SIZE);
  }
}

/** Where the player moves, length 0 to 1: the arrows or WASD, a gamepad's stick or cross, the
 *  touch cross. The `point` scheme's finger is not here: it is `pointerPressed`/`pointerHeld`. */
export function moveInput(): Vector2 {
  const keys = keyDirection();
  if (keys.lengthSquared()) return keys;
  const stick = gamepadStick(0);
  if (stick.lengthSquared()) return stick;
  return gamepadDpad();
}

/** Was action `i` (0 the main one) pressed this frame: its key, its button or its touch. */
export function actionPressed(i: number): boolean {
  return keyWasPressed(ACTION_KEYS[i]) || gamepadWasPressed(i) ||
    (mouseWasPressed(0) && touchedAction() == i);
}

/** Is action `i` held down: its key, its button or its touch. */
export function actionDown(i: number): boolean {
  return keyIsDown(ACTION_KEYS[i]) || gamepadIsDown(i) ||
    (mouseIsDown(0) && touchedAction() == i);
}

/** `point`: where a tap or a click landed this frame, in world space, unless it was on an action
 *  button. */
export function pointerPressed(): Vector2 | undefined {
  if (scheme != "point" || !mouseWasPressed(0)) return;
  pressOnButton = touchedAction() >= 0;
  return pressOnButton ? undefined : mousePos.copy();
}

/** `point`: where the finger or the mouse is while it is held down, in world space, unless it
 *  went down on an action button. */
export function pointerHeld(): Vector2 | undefined {
  if (scheme != "point" || !mouseIsDown(0)) return;
  if (mouseWasPressed(0)) pressOnButton = touchedAction() >= 0;
  return pressOnButton ? undefined : mousePos.copy();
}

/** In `gameRenderPost`: each action's icon on its button, at the bottom right (`tap`: the second
 *  at the bottom left), with its key drawn beside it while the keyboard is what plays. On a phone
 *  with `pad` the buttons are the touch gamepad's, so only the icons are drawn on them. */
export function drawControls() {
  const keyboard = !isTouchDevice || lastInputDevice == "keyboard";
  icons.forEach((icon, i) => {
    const { pos, radius } = button(i);
    const down = actionDown(i);
    if (scheme != "pad" || !isTouchDevice) {
      drawCircle(
        pos,
        radius * 2,
        rgb(0, 0, 0, down ? .45 : .3),
        radius * .08,
        rgb(1, 1, 1, .8),
        false,
        true,
      );
    }
    drawTextScreen(icon, pos, radius * (down ? 1.15 : 1));
    if (keyboard) drawKey(i, pos.add(vec2(-radius, -radius)), radius * .8);
  });
}

// a key cap: Space wide and blank, as on the keyboard, the others with their letter
function drawKey(i: number, pos: Vector2, size: number) {
  const space = i == 0;
  const capSize = vec2(space ? size * 2.4 : size, size);
  const at = space ? pos.add(vec2(size * .7, 0)) : pos;
  drawRect(at, capSize.add(vec2(size * .2)), rgb(.2, .2, .2), 0, false, true);
  drawRect(at, capSize, rgb(.95, .95, .95), 0, false, true);
  if (!space) {
    drawTextScreen(ACTION_KEYS[i].slice(3), at, size * .8, rgb(.1, .1, .1));
  }
}

// action i's button, in canvas pixels: where the touch gamepad puts its button i (a single big
// one, or a cluster: 0 below, 1 right, 2 left, 3 above), and `tap`'s second at the bottom left
function button(i: number) {
  const k = mainCanvasSize.x / (mainCanvas.getBoundingClientRect().width || 1);
  const s = SIZE * k, w = mainCanvasSize.x, h = mainCanvasSize.y;
  if (scheme == "tap") {
    return { pos: vec2(i ? s : w - s, h - s), radius: s / 3 };
  }
  if (icons.length == 1) return { pos: vec2(w - s, h - s), radius: s / 2 };
  const center = vec2(w - s, h - s - (icons.length < 4 ? s / 4 : 0));
  const side = [vec2(0, 1), vec2(1, 0), vec2(-1, 0), vec2(0, -1)][i];
  return { pos: center.add(side.scale(s / 2)), radius: s / 4 };
}

// the action whose touch is where the pointer is now, or -1: `point` its button, `tap` its half
function touchedAction(): number {
  if (scheme == "pad") return -1; // the touch gamepad's buttons are gamepad buttons
  if (scheme == "tap") {
    return icons.length > 1 && mousePosScreen.x < mainCanvasSize.x / 2 ? 1 : 0;
  }
  let near = -1, best = Infinity;
  icons.forEach((_, i) => {
    const { pos, radius } = button(i);
    const d = pos.distance(mousePosScreen) / radius;
    if (d < 1.4 && d < best) [near, best] = [i, d];
  });
  return near;
}
