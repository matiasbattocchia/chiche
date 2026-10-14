import {
  box2d,
  box2dInit,
  Box2dObject,
  Box2dStaticObject,
  Box2dTargetJoint,
  drawLine,
  drawTextScreen,
  engineInit,
  GRAY,
  hsl,
  mainCanvasSize,
  mousePos,
  mouseWasPressed,
  mouseWasReleased,
  rand,
  randColor,
  randInCircle,
  randInt,
  RED,
  setCameraScale,
  setCanvasClearColor,
  setDebugWatermark,
  setGravity,
  vec2,
} from "littlejsengine";

// engine settings
setDebugWatermark(false);

///////////////////////////////////////////////////////////////////////////////
// game state
let mouseJoint;
let groundObject;

///////////////////////////////////////////////////////////////////////////////
async function gameInit() {
  // setup box2d first!
  await box2dInit();

  // setup world
  setCanvasClearColor(hsl(0, 0, .9));
  setCameraScale(32);
  mouseJoint = 0;
  setGravity(vec2(0, -50));

  // create ground object
  groundObject = new Box2dStaticObject(vec2(-8));
  groundObject.color = GRAY;
  groundObject.addBox(vec2(100, 2));

  // add some random objects
  for (let i = 50; i--;) {
    const pos = randInCircle(5);
    const color = randColor();
    const o = new Box2dObject(pos, vec2(), undefined, 0, color);
    randInt(2) ? o.addCircle(rand(1, 2)) : o.addRandomPoly(rand(1, 2));
  }
}

///////////////////////////////////////////////////////////////////////////////
function gameUpdate() {
  // mouse joint controls
  if (mouseJoint) {
    // update mouse joint
    mouseJoint.setTarget(mousePos);
    if (mouseWasReleased(0)) {
      // release object
      mouseJoint = mouseJoint.destroy();
    }
  } else if (mouseWasPressed(0)) {
    // grab object under the cursor
    const object = box2d.pointCast(mousePos);
    if (object) {
      mouseJoint = new Box2dTargetJoint(object, groundObject, mousePos);
    }
  }
}

///////////////////////////////////////////////////////////////////////////////
function gameUpdatePost() {
  // called after physics and objects are updated
}

///////////////////////////////////////////////////////////////////////////////
function gameRender() {
  // called before objects are rendered
}

///////////////////////////////////////////////////////////////////////////////
function gameRenderPost() {
  // draw a title
  drawTextScreen(
    "Box2D Physics", // text
    vec2(mainCanvasSize.x / 2, 70), // position
    80, // size
    hsl(0, 0, 1), // color
    6, // outline size
    hsl(0, 0, 0), // outline color
  );

  // draw the mouse joint line
  mouseJoint && drawLine(mousePos, mouseJoint.getAnchorB(), .2, RED);
}

///////////////////////////////////////////////////////////////////////////////
// Startup LittleJS Engine
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost);
