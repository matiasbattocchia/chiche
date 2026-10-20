// Runs in every page before the page's own scripts: what the user does there goes to the
// console as `[user] …`, so `playwright-cli console` reads it next to the page's own output.
(() => {
  const log = (...what) => console.info("[user]", ...what);
  const name = (el) => {
    if (!(el instanceof Element)) return String(el);
    const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
    const id = el.id ? `#${el.id}` : "";
    return `${el.tagName.toLowerCase()}${id}${text ? ` "${text.slice(0, 40)}"` : ""}`;
  };
  addEventListener("click", (e) => log("click", name(e.target)), true);
  addEventListener("change", (e) => log("change", name(e.target), e.target.value ?? ""), true);
  addEventListener("submit", (e) => log("submit", name(e.target)), true);
  // every key by its code (Space, KeyW, ArrowUp), the names a game reads, once per press:
  // what is typed into a field shows as its change, and a held key does not repeat
  const typing = (el) =>
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable);
  addEventListener("keydown", (e) => {
    if (e.repeat || (typing(e.target) && e.key.length === 1)) return;
    log("key", e.code || e.key, name(e.target));
  }, true);
  addEventListener("popstate", () => log("back/forward", location.href));
  addEventListener("hashchange", () => log("hash", location.href));
  addEventListener("DOMContentLoaded", () => log("load", location.href));
  // a gamepad, which sends no events but its connecting: each button once per press, by its
  // index (what gamepadWasPressed reads) and its name on an Xbox pad, and each stick when it
  // points somewhere new, as one of eight directions
  const BUTTONS = "A B X Y LB RB LT RT View Menu L3 R3 Up Down Left Right Xbox".split(" ");
  const was = new Map();
  let polling = false;
  const direction = (x, y) => {
    if (Math.hypot(x, y) < .5) return "";
    const way = ["right", "down-right", "down", "down-left", "left", "up-left", "up", "up-right"];
    return way[(Math.round(Math.atan2(y, x) / (Math.PI / 4)) + 8) % 8];
  };
  const poll = () => {
    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;
      const before = was.get(pad.index) ?? { buttons: [], sticks: [] };
      const now = {
        buttons: pad.buttons.map((b) => b.pressed),
        sticks: [0, 2].filter((a) => a + 1 < pad.axes.length)
          .map((a) => direction(pad.axes[a], pad.axes[a + 1])),
      };
      now.buttons.forEach((down, i) => {
        if (down && !before.buttons[i]) {
          log("pad", `button ${i}`, pad.mapping == "standard" ? BUTTONS[i] ?? "" : "");
        }
      });
      now.sticks.forEach((way, i) => {
        if (way && way != before.sticks[i]) log("pad", `stick ${i}`, way);
      });
      was.set(pad.index, now);
    }
    requestAnimationFrame(poll);
  };
  addEventListener("gamepadconnected", (e) => {
    log("pad connected", e.gamepad.id);
    if (!polling) requestAnimationFrame(poll);
    polling = true;
  });
  addEventListener("gamepaddisconnected", (e) => {
    log("pad disconnected", e.gamepad.id);
    was.delete(e.gamepad.index);
  });
})();
