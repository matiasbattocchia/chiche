// main.ts
var KEY = "cambios.v2";
var st = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "");
    if (s?.players && s?.match) return s;
  } catch {
  }
  return {
    players: [],
    match: {
      ms: 0,
      running: false
    },
    since: Date.now()
  };
}
function settle(now = Date.now()) {
  if (st.match.running) {
    const d = now - st.since;
    st.match.ms += d;
    for (const p of st.players) if (p.on) p.ms += d;
  }
  st.since = now;
  localStorage.setItem(KEY, JSON.stringify(st));
}
var elapsed = (now) => st.match.running ? now - st.since : 0;
var played = (p, now) => p.ms + (p.on ? elapsed(now) : 0);
var fmt = (ms) => {
  const s = Math.floor(ms / 1e3);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
function change(fn) {
  settle();
  fn();
  settle();
  render();
}
function $(sel) {
  return document.querySelector(sel);
}
var list = $("#list");
var nameIn = $("#name");
var numIn = $("#num");
$("#add").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameIn.value.trim();
  const num = parseInt(numIn.value, 10);
  if (!name || isNaN(num)) return;
  change(() => st.players.push({
    id: crypto.randomUUID(),
    name,
    num,
    ms: 0,
    on: false
  }));
  nameIn.value = "";
  numIn.value = "";
  nameIn.focus();
});
$("#matchBtn").addEventListener("click", () => change(() => {
  st.match.running = !st.match.running;
}));
$("#allOff").addEventListener("click", () => change(() => st.players.forEach((p) => p.on = false)));
$("#reset").addEventListener("click", () => {
  if (!confirm("\xBFNuevo partido? Todos los tiempos vuelven a 0:00.")) return;
  change(() => {
    st.match = {
      ms: 0,
      running: false
    };
    for (const p of st.players) {
      p.ms = 0;
      p.on = false;
    }
  });
});
var rows = /* @__PURE__ */ new Map();
function row(p) {
  let r = rows.get(p.id);
  if (r) return r;
  const el = document.createElement("li");
  el.innerHTML = `<span class="num"></span><span class="name"></span><span class="time"></span>
    <button class="play"></button><button class="del" title="Quitar">\u2715</button>`;
  el.querySelector(".num").textContent = String(p.num);
  el.querySelector(".name").textContent = p.name;
  const btn = el.querySelector(".play");
  btn.addEventListener("click", () => change(() => {
    p.on = !p.on;
  }));
  el.querySelector(".del").addEventListener("click", () => {
    if (!confirm(`\xBFQuitar a ${p.name}?`)) return;
    change(() => {
      st.players = st.players.filter((q) => q.id !== p.id);
    });
    el.remove();
    rows.delete(p.id);
  });
  r = {
    el,
    time: el.querySelector(".time"),
    btn
  };
  rows.set(p.id, r);
  return r;
}
function render() {
  const now = Date.now();
  $("#matchTime").textContent = fmt(st.match.ms + elapsed(now));
  $("#matchBtn").textContent = st.match.running ? "\u23F8 Pausa" : st.match.ms ? "\u25B6 Seguir" : "\u25B6 Empezar";
  $("#match").classList.toggle("running", st.match.running);
  const sorted = [
    ...st.players
  ].sort((a, b) => played(b, now) - played(a, now) || a.num - b.num);
  sorted.forEach((p, i) => {
    const r = row(p);
    r.time.textContent = fmt(played(p, now));
    r.btn.textContent = p.on ? "\u23F8" : "\u25B6";
    r.btn.title = p.on ? "Sale de la cancha" : "Entra a la cancha";
    r.el.classList.toggle("paused", !p.on);
    if (list.children[i] !== r.el) list.insertBefore(r.el, list.children[i] ?? null);
  });
  const on = st.players.filter((p) => p.on).length;
  $("#count").textContent = `${on} en cancha \xB7 ${st.players.length} jugadores`;
  $("#empty").hidden = st.players.length > 0;
}
render();
setInterval(render, 500);
