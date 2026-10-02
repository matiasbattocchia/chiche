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
  addEventListener("keydown", (e) => {
    if (e.key.length > 1) log("key", e.key, name(e.target));
  }, true);
  addEventListener("popstate", () => log("back/forward", location.href));
  addEventListener("hashchange", () => log("hash", location.href));
  addEventListener("DOMContentLoaded", () => log("load", location.href));
})();
