// Cambios: tiempo en cancha para fútbol infantil. TypeScript puro, sin dependencias.
//
// El reloj del partido tiene su propio play/pausa. Un jugador suma minutos solo cuando
// está en cancha Y el partido corre: en el entretiempo se congelan todos, y al reanudar
// siguen los mismos que estaban adentro.

type Player = { id: string; name: string; num: number; ms: number; on: boolean };
type State = { players: Player[]; match: { ms: number; running: boolean }; since: number };

const KEY = "cambios.v2";
const st: State = load();

function load(): State {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "");
    if (s?.players && s?.match) return s;
  } catch { /* primera vez */ }
  return { players: [], match: { ms: 0, running: false }, since: Date.now() };
}

// Suma el tiempo corrido desde `since` a quien corresponde, y guarda.
function settle(now = Date.now()) {
  if (st.match.running) {
    const d = now - st.since;
    st.match.ms += d;
    for (const p of st.players) if (p.on) p.ms += d;
  }
  st.since = now;
  localStorage.setItem(KEY, JSON.stringify(st));
}

const elapsed = (now: number) => (st.match.running ? now - st.since : 0);
const played = (p: Player, now: number) => p.ms + (p.on ? elapsed(now) : 0);
const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function change(fn: () => void) { settle(); fn(); settle(); render(); }

function $(sel: string) { return document.querySelector(sel) as HTMLElement; }
const list = $("#list");
const nameIn = $("#name") as HTMLInputElement;
const numIn = $("#num") as HTMLInputElement;

$("#add").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameIn.value.trim();
  const num = parseInt(numIn.value, 10);
  if (!name || isNaN(num)) return;
  change(() => st.players.push({ id: crypto.randomUUID(), name, num, ms: 0, on: false }));
  nameIn.value = ""; numIn.value = ""; nameIn.focus();
});

$("#matchBtn").addEventListener("click", () => change(() => { st.match.running = !st.match.running; }));
$("#allOff").addEventListener("click", () => change(() => st.players.forEach((p) => (p.on = false))));
$("#reset").addEventListener("click", () => {
  if (!confirm("¿Nuevo partido? Todos los tiempos vuelven a 0:00.")) return;
  change(() => {
    st.match = { ms: 0, running: false };
    for (const p of st.players) { p.ms = 0; p.on = false; }
  });
});

// Una fila por jugador, reutilizada entre renders para que los botones no parpadeen.
const rows = new Map<string, { el: HTMLElement; time: HTMLElement; btn: HTMLButtonElement }>();

function row(p: Player) {
  let r = rows.get(p.id);
  if (r) return r;
  const el = document.createElement("li");
  el.innerHTML = `<span class="num"></span><span class="name"></span><span class="time"></span>
    <button class="play"></button><button class="del" title="Quitar">✕</button>`;
  (el.querySelector(".num") as HTMLElement).textContent = String(p.num);
  (el.querySelector(".name") as HTMLElement).textContent = p.name;
  const btn = el.querySelector(".play") as HTMLButtonElement;
  btn.addEventListener("click", () => change(() => { p.on = !p.on; }));
  el.querySelector(".del")!.addEventListener("click", () => {
    if (!confirm(`¿Quitar a ${p.name}?`)) return;
    change(() => { st.players = st.players.filter((q) => q.id !== p.id); });
    el.remove(); rows.delete(p.id);
  });
  r = { el, time: el.querySelector(".time") as HTMLElement, btn };
  rows.set(p.id, r);
  return r;
}

function render() {
  const now = Date.now();
  $("#matchTime").textContent = fmt(st.match.ms + elapsed(now));
  $("#matchBtn").textContent = st.match.running ? "⏸ Pausa" : st.match.ms ? "▶ Seguir" : "▶ Empezar";
  $("#match").classList.toggle("running", st.match.running);

  const sorted = [...st.players].sort((a, b) => played(b, now) - played(a, now) || a.num - b.num);
  sorted.forEach((p, i) => {
    const r = row(p);
    r.time.textContent = fmt(played(p, now));
    r.btn.textContent = p.on ? "⏸" : "▶";
    r.btn.title = p.on ? "Sale de la cancha" : "Entra a la cancha";
    r.el.classList.toggle("paused", !p.on);
    if (list.children[i] !== r.el) list.insertBefore(r.el, list.children[i] ?? null);
  });
  const on = st.players.filter((p) => p.on).length;
  $("#count").textContent = `${on} en cancha · ${st.players.length} jugadores`;
  $("#empty").hidden = st.players.length > 0;
}

render();
setInterval(render, 500);
