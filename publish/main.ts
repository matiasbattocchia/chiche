// deno task publish — a project at https://rubi.games: built, its files and card put in the SITE
// namespace the rubi Worker serves from. Nothing else is touched, and the index is the cards
import { encodeBase64 } from "@std/encoding";
import { basename, extname, join, relative, resolve } from "@std/path";

const HERE = import.meta.dirname!;
const PROJECTS = join(HERE, "..", "data", "shared", "projects");
const CONFIG = join(HERE, "wrangler.jsonc");
const SITE = "https://rubi.games";

const HELP = `deno task publish — the projects at ${SITE}

  deno task publish                  what is published
  deno task publish <project>...     build each and put it there, replacing what it had
  deno task publish --remove <name>  take it off the site
  deno task publish --site           deploy the Worker (publish/worker.ts), after a change to it

A project is a folder in data/shared/projects (or a path to one), with a card.json:
{ "emoji": "🏓", "title": "Pong", "description": "a line about it" }`;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function fail(msg: string): never {
  console.error(msg);
  Deno.exit(1);
}

/** wrangler, with the org's API keys kept out of it */
async function wrangler(...args: string[]) {
  const env = Deno.env.toObject();
  delete env.GEMINI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  const out = await new Deno.Command("deno", {
    args: ["run", "-A", "--no-lock", "npm:wrangler@4.137.0", ...args, "-c", CONFIG],
    cwd: HERE,
    clearEnv: true,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  if (!out.success) {
    fail(`wrangler ${args[0]} ${args[1] ?? ""}: ${new TextDecoder().decode(out.stderr).trim()}`);
  }
  return text;
}

const kv = (...args: string[]) => wrangler("kv", ...args, "--binding", "SITE", "--remote");

async function keys(prefix: string): Promise<string[]> {
  const out = await kv("key", "list", "--prefix", prefix);
  return (JSON.parse(out.slice(out.indexOf("["))) as { name: string }[]).map((k) => k.name);
}

async function bulk(verb: "put" | "delete", items: unknown[]) {
  if (!items.length) return;
  const file = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(file, JSON.stringify(items));
    await kv("bulk", verb, file, ...(verb === "delete" ? ["--force"] : []));
  } finally {
    await Deno.remove(file);
  }
}

async function files(dir: string, root = dir): Promise<string[]> {
  const all: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    const path = join(dir, e.name);
    if (e.isDirectory) all.push(...await files(path, root));
    else if (e.isFile) all.push(relative(root, path));
  }
  return all;
}

async function publish(arg: string) {
  const dir = arg.includes("/") ? resolve(arg) : join(PROJECTS, arg);
  const name = basename(dir);
  if (!/^[\w.-]+$/.test(name)) fail(`${name}: a name for a URL is letters, digits, _, - and .`);
  const card = await Deno.readTextFile(join(dir, "card.json")).then(JSON.parse, () => null);
  if (!["emoji", "title", "description"].every((k) => typeof card?.[k] === "string")) {
    fail(`${dir}/card.json: { "emoji": "…", "title": "…", "description": "…" }`);
  }

  // a relative base, so the build works under /<name>/
  const out = await Deno.makeTempDir({ prefix: `publish-${name}-` });
  try {
    const build = await new Deno.Command("deno", {
      args: ["task", "build", "--base=./", `--outDir=${out}`, "--emptyOutDir"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!build.success) {
      const d = new TextDecoder();
      fail(
        `${name}: the build failed, nothing published\n${d.decode(build.stdout)}${
          d.decode(build.stderr)
        }`,
      );
    }
    const paths = await files(out);
    const put = await Promise.all(paths.map(async (p) => ({
      key: `file:${name}/${p}`,
      value: encodeBase64(await Deno.readFile(join(out, p))),
      base64: true,
      metadata: { type: TYPES[extname(p).toLowerCase()] ?? "application/octet-stream" },
    })));
    const old = await keys(`file:${name}/`);
    await bulk("put", put);
    const fresh = new Set(put.map((p) => p.key));
    await bulk("delete", old.filter((k) => !fresh.has(k)));
    // the card last: the index shows the project once its files are there
    const { emoji, title, description } = card;
    const published = new Date().toISOString();
    await bulk("put", [{
      key: `card:${name}`,
      value: "",
      metadata: { emoji, title, description, published },
    }]);
    console.log(`${emoji} ${title}: ${SITE}/${name}/ (${paths.length} files)`);
  } finally {
    await Deno.remove(out, { recursive: true }).catch(() => {});
  }
}

const [first, ...rest] = Deno.args;
if (first === "-h" || first === "--help" || first === "help") console.log(HELP);
else if (first === "--site") {
  const out = await wrangler("deploy");
  console.log(out.trim().split("\n").filter((l) => /https:|Uploaded|Deployed/.test(l)).join("\n"));
} else if (first === "--remove") {
  if (!rest.length) fail("deno task publish --remove <name>");
  for (const name of rest) {
    const card = (await keys(`card:${name}`)).filter((k) => k === `card:${name}`);
    if (!card.length) fail(`${name} isn't published`);
    // the card first: the index stops showing it before its files go
    await bulk("delete", card);
    await bulk("delete", await keys(`file:${name}/`));
    console.log(`${name}: off ${SITE}`);
  }
} else if (first === undefined) {
  const names = (await keys("card:")).map((k) => k.slice(5));
  console.log(names.length ? names.map((n) => `${SITE}/${n}/`).join("\n") : "nothing published");
} else for (const arg of Deno.args) await publish(arg);
