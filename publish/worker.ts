// rubi's Worker: the projects in the SITE namespace, and an index drawn from their cards on each
// visit. A project is its files, `file:<name>/<path>` with their type in the metadata, and its
// card, `card:<name>` with the card in the metadata; `deno task publish` writes both

type Card = { emoji: string; title: string; description: string; published: string };
type KV = {
  getWithMetadata<M>(
    key: string,
    type: "arrayBuffer",
  ): Promise<{ value: ArrayBuffer | null; metadata: M | null }>;
  list<M>(opts: { prefix: string; cursor?: string }): Promise<{
    keys: { name: string; metadata?: M }[];
    list_complete: boolean;
    cursor?: string;
  }>;
};

export default {
  async fetch(req: Request, env: { SITE: KV }): Promise<Response> {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    if (path === "/") return index(env.SITE);
    const [, name, ...rest] = path.split("/");
    if (!rest.length) {
      // /pong is the project, /favicon.ico a file nobody published
      if (name.includes(".")) return new Response("not found", { status: 404 });
      return Response.redirect(new URL(`/${name}/`, url).href, 301);
    }
    const file = rest.join("/") || "index.html";
    const { value, metadata } = await env.SITE.getWithMetadata<{ type: string }>(
      `file:${name}/${file}`,
      "arrayBuffer",
    );
    if (!value) return new Response("not found", { status: 404 });
    return new Response(value, {
      headers: {
        "content-type": metadata?.type ?? "application/octet-stream",
        // Vite names what it bundles by its hash: a new build is a new name
        "cache-control": file.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      },
    });
  },
};

async function index(site: KV) {
  const cards: (Card & { name: string })[] = [];
  let cursor: string | undefined;
  do {
    const page = await site.list<Card>({ prefix: "card:", cursor });
    for (const k of page.keys) if (k.metadata) cards.push({ ...k.metadata, name: k.name.slice(5) });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  cards.sort((a, b) => b.published.localeCompare(a.published));
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🎮 Juegos</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🎮</text></svg>">
<style>
  body { margin: 0; min-height: 100vh; background: #081c15; color: #fff; font-family: system-ui, sans-serif; }
  h1 { text-align: center; font-size: 56px; margin: 32px 16px; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 20px; padding: 0 20px 40px; }
  a { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 24px 16px; border-radius: 24px;
      background: #2d6a4f; color: inherit; text-decoration: none; text-align: center; }
  a:hover { background: #40916c; transform: scale(1.03); }
  span { font-size: 96px; line-height: 1; }
  b { font-size: 28px; }
  i { font-style: normal; opacity: .8; }
</style></head>
<body><h1>🎮 Juegos</h1><main>
${
    cards.map((c) =>
      `<a href="./${encodeURIComponent(c.name)}/"><span>${esc(c.emoji)}</span><b>${
        esc(c.title)
      }</b><i>${esc(c.description)}</i></a>`
    ).join("\n")
  }
</main></body></html>
`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}
