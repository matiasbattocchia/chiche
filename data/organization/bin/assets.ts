// game assets — the library every game draws art, sound and fonts from: a core set to start
// with (`import core`), imports from free sources to go beyond. Each pack is a folder under
// assets/ with a pack.json that names every asset, so the builder finds them by words.
import { chromium } from "npm:playwright-core@1.63.0";
import { exists, walk } from "jsr:@std/fs@1";
import { basename, dirname, extname, join, relative } from "jsr:@std/path@1";

type Kind = "image" | "sound" | "font";

/** One asset: a file, or the frames or variants that share a name (walk_a, walk_b; click_001…). */
interface Entry {
  name: string;
  kind: Kind;
  files: string[]; // relative to assets/
  tags: string[];
  size?: string; // 256×256, 0.4 s
  glyph?: string; // the emoji it is
}

/** assets/<id>/pack.json */
interface Pack {
  id: string;
  title: string;
  source: string;
  license: string;
  fetched: string;
  entries: Entry[];
  opaque: number; // files left out because their names say nothing
}

interface Env {
  games: string;
  /** organization/assets: the packs, beside the kit, shared by every game */
  library: string;
  chromium: () => Promise<string>;
}

// What every game can start from: characters, animals, food, places, tiles, UI, sounds, and
// two fonts made for young readers. Everything is CC0, MIT or OFL.
const CORE = [
  ["kenney", "new-platformer-pack", "toon-characters", "animal-pack", "ui-pack", "game-icons", "interface-sounds", "impact-sounds"],
  ["fluent", "Animals & Nature", "Food & Drink", "Smileys & Emotion", "People & Body", "Activities", "Travel & Places"],
  ["font", "Fredoka", "Andika"],
];

export const HELP = `  game assets                the library: its packs, what each has, its license
  game assets search <words> [--kind image|sound|font] [--pack <id>] [--limit <n>]
                             the assets whose names and tags match, best first, and a
                             contact sheet of the images: aread it to see them
  game assets use <slug> <file>...
                             copy library files into <slug>/assets/, with their license
  game assets import core    the core library, what every game can start from
  game assets import kenney <pack>...   kenney.nl packs (CC0), by the name in their URL
  game assets import fluent <group|emoji>...
                             Microsoft's Fluent emoji in 3D (MIT): a group like "Objects",
                             or one emoji by name like "teddy bear"
  game assets import font <family>...   a Google Fonts family (OFL)
      --opaque               also keep files whose name says nothing beyond their pack
                             (jingles_NES09): left out by default, nobody can choose them`;

// ── words ───────────────────────────────────────────────────────────────────

function words(s: string) {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)|(\d)([A-Za-z])/g, "$1$3 $2$4")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function singular(w: string) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Words that name a file's format or role, never what it shows or sounds like. */
const GENERIC = new Set([
  "tile", "sprite", "sheet", "spritesheet", "image", "img", "sound", "sfx", "audio", "music",
  "jingle", "song", "track", "loop", "file", "asset", "default", "double", "sample", "preview",
  "png", "ogg", "wav", "mp3", "new", "pack", "kenney", "and", "the",
]);

/** Folders that sort files by format or size, not by what they are. */
const STRUCTURAL = new Set(["png", "sprite", "audio", "default", "double", "1x", "2x", "font", "sound"]);

/** Sounds sharing one name: Kenney's are variations of one sound (maximize_001…009). */
const MAX_VARIANTS = 12;

/** A frame or variant marker at the end of a name: walk_a, click_005, share2. */
const isMarker = (w: string) => /^\d+$/.test(w) || w.length === 1;

// ── files ───────────────────────────────────────────────────────────────────

function kindOf(file: string): Kind | undefined {
  const ext = extname(file).toLowerCase();
  if (ext === ".png") return "image";
  if ([".ogg", ".wav", ".mp3"].includes(ext)) return "sound";
  if ([".ttf", ".otf"].includes(ext)) return "font";
}

/** A PNG's width×height, or an Ogg Vorbis sound's length. */
async function sizeOf(path: string, kind: Kind) {
  const bytes = await Deno.readFile(path);
  const view = new DataView(bytes.buffer);
  if (kind === "image" && bytes.length > 24) return `${view.getUint32(16)}×${view.getUint32(20)}`;
  if (kind === "sound" && extname(path) === ".ogg") {
    const text = new TextDecoder("latin1").decode(bytes);
    const head = text.indexOf("\x01vorbis"), last = text.lastIndexOf("OggS");
    if (head < 0 || last < 0) return;
    const rate = view.getUint32(head + 12, true);
    const samples = Number(view.getBigInt64(last + 6, true));
    return rate ? `${(samples / rate).toFixed(1)} s` : undefined;
  }
}

async function download(url: string, to: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  await Deno.mkdir(dirname(to), { recursive: true });
  await Deno.writeFile(to, new Uint8Array(await r.arrayBuffer()));
}

async function getText(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return await r.text();
}

async function readPacks(env: Env) {
  const packs: Pack[] = [];
  const root = env.library;
  if (!(await exists(root))) return packs;
  for await (const e of Deno.readDir(root)) {
    const file = join(root, e.name, "pack.json");
    if (e.isDirectory && await exists(file)) packs.push(JSON.parse(await Deno.readTextFile(file)));
  }
  return packs.sort((a, b) => a.id.localeCompare(b.id));
}

/** Write a pack and the credits for the whole library. */
async function savePack(env: Env, pack: Pack) {
  const root = env.library;
  await Deno.writeTextFile(join(root, pack.id, "pack.json"), JSON.stringify(pack, null, 1) + "\n");
  const rows = (await readPacks(env)).map((p) => `| ${p.title} (${p.id}) | ${p.source} | ${p.license} | ${p.fetched} |`);
  await Deno.writeTextFile(join(root, "CREDITS.md"), `# Credits

Every pack in this folder: name, source, license, date fetched. \`game assets import\` writes
it; each pack's LICENSE.txt is its license text.

| pack | source | license | fetched |
|---|---|---|---|
${rows.join("\n")}
`);
  const files = pack.entries.reduce((n, e) => n + e.files.length, 0);
  const kinds = count(pack.entries.map((e) => e.kind));
  const n = pack.entries.length;
  console.log(`${pack.id}: ${n} asset${n > 1 ? "s" : ""} (${kinds}), ${files} file${files > 1 ? "s" : ""}` +
    (pack.opaque ? `; ${pack.opaque} files left out, their names say nothing (--opaque keeps them)` : ""));
}

function count(xs: string[]) {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].map(([k, n]) => `${n} ${k}${n > 1 ? "s" : ""}`).join(", ");
}

const today = () => new Date().toISOString().slice(0, 10);

// ── import: kenney ──────────────────────────────────────────────────────────

/**
 * A kenney.nl pack: its page links the zip. Kept: PNG, sound and font files, one size of
 * each (Default over Double, 2x over 1x, X over X HD), the pack's License.txt. Left out: vector copies,
 * sprite sheets (the single sprites are there), previews, and files with opaque names.
 */
async function importKenney(env: Env, slug: string, opaque: boolean) {
  const page = await getText(`https://kenney.nl/assets/${slug}`);
  const zip = page.match(new RegExp(`https://kenney\\.nl/media/pages/assets/${slug}/[^"']+\\.zip`))?.[0];
  if (!zip) throw new Error(`no download on https://kenney.nl/assets/${slug}: is that the pack's name in its URL?`);
  const title = (page.match(/<meta property='og:title' content='([^']+)'/)?.[1] ?? slug)
    .replace(/\s*(&middot;|·|\|).*$/, "").replace(/^Kenney\s*/i, "");

  const tmp = await Deno.makeTempDir({ prefix: "game-assets-" });
  try {
    await download(zip, join(tmp, "pack.zip"));
    const unzip = await new Deno.Command("unzip", { args: ["-q", "-o", join(tmp, "pack.zip"), "-d", join(tmp, "x")] }).output();
    if (!unzip.success) throw new Error(`unzip failed: ${new TextDecoder().decode(unzip.stderr)}`);
    const src = join(tmp, "x");

    const all: string[] = [];
    for await (const f of walk(src, { includeDirs: false })) all.push(relative(src, f.path));
    const dirs = new Set(all.flatMap((f) => dirname(f).split("/")));
    const drop = new Set<string>();
    if (dirs.has("Default") && dirs.has("Double")) drop.add("Double");
    if (dirs.has("1x") && dirs.has("2x")) drop.add("1x");
    for (const d of dirs) if (d.endsWith(" HD") && dirs.has(d.slice(0, -3))) drop.add(d);
    const keep = all.filter((f) => {
      const parts = dirname(f).split("/");
      return kindOf(f) && dirname(f) !== "." &&
        !parts.some((p) => drop.has(p) || /^(vector|spritesheets?|tilesheets?|tilemap)$/i.test(p));
    });

    const id = `kenney-${slug}`;
    const dest = join(env.library,id);
    await Deno.remove(dest, { recursive: true }).catch(() => {});
    await Deno.mkdir(dest, { recursive: true });
    const license = all.find((f) => /^license\.txt$/i.test(basename(f)));
    if (license) await Deno.copyFile(join(src, license), join(dest, "LICENSE.txt"));

    const packWords = [...words(slug), ...words(title)].map(singular);
    const groups = new Map<string, { name: string[]; tags: string[]; files: string[]; kind: Kind }>();
    let left = 0;
    for (const f of keep.sort()) {
      const folderWords = dirname(f).split("/").flatMap(words).map(singular);
      const name = words(basename(f, extname(f)));
      if (name.length > 1 && isMarker(name.at(-1)!)) name.pop();
      // a word that only repeats the pack or the folder, even shortened (pizzi, pizzicato)
      const said = [...packWords, ...folderWords];
      const meaning = name.map(singular).filter((w) =>
        !isMarker(w) && !GENERIC.has(w) &&
        !said.some((s) => s === w || (w.length >= 3 && s.startsWith(w)))
      );
      if (!meaning.length && !opaque) {
        left++;
        continue;
      }
      const key = `${dirname(f)}/${name.join(" ")}`;
      const g = groups.get(key) ?? {
        name,
        tags: [...new Set(folderWords.filter((w) => !STRUCTURAL.has(w) && !GENERIC.has(w)))],
        files: [],
        kind: kindOf(f)!,
      };
      g.files.push(join(id, f));
      groups.set(key, g);
      await Deno.mkdir(join(dest, dirname(f)), { recursive: true });
      await Deno.copyFile(join(src, f), join(dest, f));
    }

    const entries: Entry[] = [];
    for (const g of groups.values()) {
      // a name more than a dozen sounds share tells none of them apart (jingles_NES01…17)
      if (g.kind === "sound" && g.files.length > MAX_VARIANTS && !opaque) {
        left += g.files.length;
        for (const f of g.files) await Deno.remove(join(env.library,f));
        continue;
      }
      entries.push({
        name: g.name.join(" "),
        kind: g.kind,
        files: g.files,
        tags: g.tags,
        size: await sizeOf(join(env.library,g.files[0]), g.kind),
      });
    }
    if (!entries.length) {
      await Deno.remove(dest, { recursive: true });
      return console.log(`${id}: nothing kept; ${left} files left out, their names say nothing (--opaque keeps them)`);
    }
    await savePack(env, { id, title: `Kenney ${title.replace(/^Kenney\s*/i, "")}`, source: `https://kenney.nl/assets/${slug}`, license: "CC0 1.0", fetched: today(), entries, opaque: left });
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

// ── import: fluent ──────────────────────────────────────────────────────────

const FLUENT = "https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/";

interface FluentMeta { folder: string; cldr: string; glyph: string; group: string; keywords: string[]; png: string }

/**
 * Every Fluent emoji's metadata and 3D PNG path, fetched once (1,600 small files) and kept
 * in the pack as index.json: later imports and group names read it from there.
 */
async function fluentIndex(dest: string): Promise<FluentMeta[]> {
  const cached = join(dest, "index.json");
  if (await exists(cached)) return JSON.parse(await Deno.readTextFile(cached));
  console.log("fluent: reading the emoji list (once, about 30 s)");
  const tree = JSON.parse(await getText("https://api.github.com/repos/microsoft/fluentui-emoji/git/trees/main?recursive=1"));
  const png = new Map<string, string>();
  for (const e of tree.tree as { path: string }[]) {
    const m = e.path.match(/^assets\/([^/]+)\/(?:Default\/)?3D\/[^/]+\.png$/);
    if (m) png.set(m[1], e.path);
  }
  const folders = [...png.keys()];
  const index: FluentMeta[] = [];
  for (let i = 0; i < folders.length; i += 32) {
    index.push(...await Promise.all(folders.slice(i, i + 32).map(async (folder) => {
      const m = JSON.parse(await getText(`${FLUENT}assets/${encodeURIComponent(folder)}/metadata.json`));
      return { folder, cldr: m.cldr ?? folder.toLowerCase(), glyph: m.glyph ?? "", group: m.group ?? "", keywords: m.keywords ?? [], png: png.get(folder)! };
    })));
  }
  await Deno.mkdir(dest, { recursive: true });
  await Deno.writeTextFile(cached, JSON.stringify(index));
  return index;
}

async function importFluent(env: Env, wanted: string[]) {
  const id = "fluent-emoji";
  const dest = join(env.library,id);
  const index = await fluentIndex(dest);
  const groups = [...new Set(index.map((m) => m.group))].sort();
  const chosen = new Map<string, FluentMeta>();
  for (const w of wanted) {
    const lw = w.toLowerCase();
    const hits = index.filter((m) => m.group.toLowerCase() === lw || m.cldr.toLowerCase() === lw);
    if (!hits.length) throw new Error(`fluent: no group or emoji called "${w}". Groups: ${groups.join(", ")}`);
    for (const m of hits) chosen.set(m.folder, m);
  }

  const pack: Pack = (await exists(join(dest, "pack.json")))
    ? JSON.parse(await Deno.readTextFile(join(dest, "pack.json")))
    : { id, title: "Microsoft Fluent Emoji (3D)", source: "https://github.com/microsoft/fluentui-emoji", license: "MIT", fetched: today(), entries: [], opaque: 0 };
  if (!(await exists(join(dest, "LICENSE.txt")))) await download(`${FLUENT}LICENSE`, join(dest, "LICENSE.txt"));
  const have = new Set(pack.entries.map((e) => e.name));
  const todo = [...chosen.values()].filter((m) => !have.has(m.cldr));
  for (let i = 0; i < todo.length; i += 16) {
    await Promise.all(todo.slice(i, i + 16).map(async (m) => {
      const file = `${words(m.cldr).join("_")}.png`;
      await download(FLUENT + m.png.split("/").map(encodeURIComponent).join("/"), join(dest, file));
      pack.entries.push({
        name: m.cldr,
        kind: "image",
        files: [join(id, file)],
        tags: [...new Set([...m.keywords.flatMap(words), ...words(m.group)].filter((w) => !GENERIC.has(w)))],
        size: await sizeOf(join(dest, file), "image"),
        glyph: m.glyph,
      });
    }));
  }
  pack.entries.sort((a, b) => a.name.localeCompare(b.name));
  pack.fetched = today();
  await savePack(env, pack);
}

// ── import: font ────────────────────────────────────────────────────────────

/** A Google Fonts family from its GitHub repo: the upright files and the license. */
async function importFont(env: Env, family: string) {
  const dir = family.toLowerCase().replace(/\s+/g, "");
  let files: { name: string; download_url: string }[] | undefined;
  let license = "";
  for (const [folder, name] of [["ofl", "OFL 1.1"], ["apache", "Apache 2.0"], ["ufl", "Ubuntu Font Licence"]]) {
    const r = await fetch(`https://api.github.com/repos/google/fonts/contents/${folder}/${dir}`);
    if (r.ok) {
      files = await r.json();
      license = name;
      break;
    }
  }
  if (!files) throw new Error(`font: no Google Fonts family "${family}"`);
  const id = `font-${dir}`;
  const dest = join(env.library,id);
  await Deno.remove(dest, { recursive: true }).catch(() => {});
  const fonts = files.filter((f) => kindOf(f.name) === "font" && !/italic/i.test(f.name));
  const entries: Entry[] = [];
  for (const f of fonts) {
    // a variable font's axes are in its name (Fredoka[wdth,wght].ttf): not for a URL
    const file = f.name.replace(/\[.*?\]/g, "");
    await download(f.download_url, join(dest, file));
    entries.push({ name: words(basename(file, extname(file))).join(" "), kind: "font", files: [join(id, file)], tags: ["font", ...words(family)] });
  }
  const text = files.find((f) => /^(OFL|LICENSE)\.txt$/i.test(f.name));
  if (text) await download(text.download_url, join(dest, "LICENSE.txt"));
  const meta = files.find((f) => f.name === "METADATA.pb");
  if (meta) {
    const category = (await getText(meta.download_url)).match(/category: "(\w+)"/)?.[1]?.toLowerCase();
    if (category) for (const e of entries) e.tags.push(category);
  }
  await savePack(env, { id, title: family, source: `https://fonts.google.com/specimen/${family.replace(/\s+/g, "+")}`, license, fetched: today(), entries, opaque: 0 });
}

// ── search ──────────────────────────────────────────────────────────────────

/** Files in one folder as one line: character_yellow_walk_{a,b}.png. */
function compact(files: string[]) {
  if (files.length === 1) return files[0];
  const dir = dirname(files[0]), ext = extname(files[0]);
  if (!files.every((f) => dirname(f) === dir && extname(f) === ext)) return files.join(" ");
  const names = files.map((f) => basename(f, ext));
  let prefix = names[0];
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  prefix = prefix.slice(0, Math.max(prefix.search(/[_\-\s][^_\-\s]*$/) + 1, 0));
  return `${dir}/${prefix}{${names.map((n) => n.slice(prefix.length)).join(",")}}${ext}`;
}

async function search(env: Env, args: string[]) {
  const query: string[] = [];
  let kind: string | undefined, packId: string | undefined, limit = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--kind") kind = args[++i];
    else if (args[i] === "--pack") packId = args[++i];
    else if (args[i] === "--limit") limit = Number(args[++i]);
    else query.push(...words(args[i]).map(singular));
  }
  if (!query.length) throw new Error("game assets search <words>");
  const packs = await readPacks(env);
  if (!packs.length) throw new Error("the library is empty: `game assets import core`");

  const hits: { e: Entry; score: number; matched: number }[] = [];
  for (const p of packs) {
    if (packId && p.id !== packId) continue;
    for (const e of p.entries) {
      if (kind && e.kind !== kind) continue;
      const name = words(e.name).map(singular), tags = e.tags.map(singular);
      let matched = 0, score = 0;
      for (const q of query) {
        const like = (w: string) => w === q || (q.length >= 3 && w.startsWith(q));
        if (name.some(like)) (matched++, score += name.includes(q) ? 3 : 2);
        else if (tags.some(like)) (matched++, score += 1);
      }
      if (matched) hits.push({ e, score, matched });
    }
  }
  hits.sort((a, b) => b.matched - a.matched || b.score - a.score || a.e.name.length - b.e.name.length);
  const top = hits.slice(0, limit);
  if (!top.length) {
    return console.log(`nothing matches "${query.join(" ")}". Try other words for it: a kind ("animal"), a
kind of it ("t-rex" for dinosaur), in English. Beyond the library: kenney.nl/assets lists
Kenney's packs (\`fetch\` the page), \`game assets import kenney <pack>\` brings one in.`);
  }

  top.forEach(({ e }, i) => {
    const what = [e.kind, e.size, e.files.length > 1 ? `${e.files.length} files` : ""].filter(Boolean).join(", ");
    const name = words(e.name);
    const tags = e.tags.filter((t) => !name.includes(t)).slice(0, 5).join(", ");
    console.log(`${String(i + 1).padStart(2)}. ${e.glyph ? e.glyph + " " : ""}${e.name} (${what})${tags ? ` · ${tags}` : ""}\n    ${compact(e.files)}`);
  });
  if (hits.length > limit) console.log(`… ${hits.length - limit} more (--limit)`);

  const images = top.map((h, i) => ({ ...h, n: i + 1 })).filter((h) => h.e.kind === "image");
  if (images.length) {
    const sheet = await contactSheet(env, images.map((h) => ({ n: h.n, name: h.e.name, file: h.e.files[0] })), query.join("-"));
    console.log(`\ncontact sheet: ${sheet}`);
  }
}

/** The images side by side, numbered like the list: a picture of the choices to aread. */
async function contactSheet(env: Env, items: { n: number; name: string; file: string }[], label: string) {
  const root = env.library;
  const cells = await Promise.all(items.map(async (it) => {
    const b64 = btoa(Array.from(await Deno.readFile(join(root, it.file)), (c) => String.fromCharCode(c)).join(""));
    return `<figure><div><img src="data:image/png;base64,${b64}"></div><figcaption>${it.n}. ${it.name}</figcaption></figure>`;
  }));
  const html = `<style>
  body { margin: 0; padding: 8px; font: 14px system-ui; background: #fff; display: flex; flex-wrap: wrap; gap: 8px; width: 944px; }
  figure { margin: 0; width: 148px; }
  div { height: 128px; display: flex; align-items: center; justify-content: center;
        background: repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0 / 16px 16px; }
  img { max-width: 128px; max-height: 128px; }
  figcaption { height: 34px; overflow: hidden; text-align: center; }
</style>${cells.join("")}`;
  const browser = await chromium.launch({ executablePath: await env.chromium() });
  const page = await browser.newPage({ viewport: { width: 960, height: 200 } });
  await page.setContent(html);
  const out = join(root, ".sheets", `${label.slice(0, 60) || "sheet"}.png`);
  await Deno.mkdir(dirname(out), { recursive: true });
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  return relative(Deno.cwd(), out);
}

// ── use ─────────────────────────────────────────────────────────────────────

/** Copy library files into a game, with each pack's license beside them. */
async function use(env: Env, slug: string | undefined, files: string[]) {
  if (!slug || !files.length) throw new Error("game assets use <slug> <file>...");
  const game = join(env.games, slug);
  if (!(await exists(join(game, "main.ts")))) throw new Error(`no game called ${slug}`);
  const root = env.library;
  for (const f of files) {
    const rel = relative(root, join(root, f.replace(/^assets\//, "")));
    const src = join(root, rel);
    if (rel.startsWith("..") || !(await exists(src))) throw new Error(`no ${rel} in the library`);
    const pack = rel.split("/")[0];
    const to = join(game, "assets", basename(rel));
    await Deno.mkdir(dirname(to), { recursive: true });
    await Deno.copyFile(src, to);
    if (await exists(join(root, pack, "LICENSE.txt"))) {
      await Deno.mkdir(join(game, "assets", "licenses"), { recursive: true });
      await Deno.copyFile(join(root, pack, "LICENSE.txt"), join(game, "assets", "licenses", `${pack}.txt`));
    }
    const key = basename(rel, extname(rel));
    const load = { image: "image", sound: "audio", font: "font" }[kindOf(rel)!];
    const then = load === "font" ? `, then fontFamily: "${key}"` : "";
    console.log(`${slug}/assets/${basename(rel)}   this.load.${load}("${key}", "assets/${basename(rel)}")${then}`);
  }
}

// ── overview ────────────────────────────────────────────────────────────────

async function overview(env: Env) {
  const packs = await readPacks(env);
  if (!packs.length) return console.log("the library is empty: `game assets import core`");
  for (const p of packs) {
    console.log(`${p.id.padEnd(28)} ${count(p.entries.map((e) => e.kind)).padEnd(30)} ${p.license.padEnd(8)} ${p.title}`);
  }
  console.log("\n`game assets search <words>` finds assets by name and tag; `game help` has the rest");
}

// ── main ────────────────────────────────────────────────────────────────────

export async function assets(args: string[], env: Env) {
  const [verb, ...rest] = args;
  const opaque = rest.includes("--opaque");
  const names = rest.filter((a) => a !== "--opaque");
  try {
    if (!verb) return await overview(env);
    if (verb === "search") return await search(env, rest);
    if (verb === "use") return await use(env, rest[0], rest.slice(1));
    if (verb !== "import") throw new Error(`game assets: unknown verb ${verb}\n\n${HELP}`);
    const [source, ...what] = names;
    const jobs = source === "core" ? CORE : [[source, ...what]];
    for (const [src, ...items] of jobs) {
      if (!items.length) throw new Error(`game assets import ${src ?? "<source>"} <what>...\n\n${HELP}`);
      if (src === "kenney") for (const slug of items) await importKenney(env, slug, opaque);
      else if (src === "fluent") await importFluent(env, items);
      else if (src === "font") for (const family of items) await importFont(env, family);
      else throw new Error(`game assets import: no source ${src}; kenney, fluent, font or core`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    Deno.exit(1);
  }
}
