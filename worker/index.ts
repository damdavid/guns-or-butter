/**
 * Records each game start in D1 and renders them at /reports. Everything else is the
 * static site, served from the assets binding.
 */

// The slice of the Workers runtime used here, so wrangler's types are not a dependency.
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Env {
  DB: { prepare(sql: string): D1Statement };
  ASSETS: { fetch(request: Request): Promise<Response> };
}

interface Start {
  started_at: string;
  nation: string;
  continent: string;
  level: string;
  original_caps: number;
  ip: string | null;
}

const LEVELS = new Set(["beginner", "intermediate", "expert"]);
// Names are typed freely by players and the endpoint is public.
const MAX_NAME = 64;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/start" && request.method === "POST") return recordStart(request, env);
    if (pathname === "/reports" || pathname === "/reports/") return reports(request, env);
    return env.ASSETS.fetch(request);
  },
};

async function recordStart(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const name = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, MAX_NAME) : "");
  const nation = name(body?.nation);
  const continent = name(body?.continent);
  const level = String(body?.level);
  if (!nation || !continent || !LEVELS.has(level)) return new Response(null, { status: 400 });
  await env.DB.prepare(
    "INSERT INTO game_starts (nation, continent, level, original_caps, ip) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(nation, continent, level, body?.caps === true ? 1 : 0, request.headers.get("CF-Connecting-IP"))
    .run();
  return new Response(null, { status: 204 });
}

async function reports(request: Request, env: Env): Promise<Response> {
  // Access sets this on every request it lets through; failing closed means a missing
  // Access policy exposes nothing.
  if (!request.headers.get("Cf-Access-Jwt-Assertion")) return new Response("Forbidden", { status: 403 });
  const { results } = await env.DB.prepare(
    "SELECT started_at, nation, continent, level, original_caps, ip FROM game_starts ORDER BY id DESC LIMIT 1000",
  ).all<Start>();
  const rows = results
    .map(
      (s) => `<tr><td>${esc(s.started_at.replace("T", " ").replace("Z", ""))}</td><td>${esc(s.nation)}</td><td>${esc(
        s.continent,
      )}</td><td>${esc(s.level)}</td><td>${s.original_caps ? "Original caps" : "Uncapped"}</td><td>${esc(
        s.ip ?? "",
      )}</td></tr>`,
    )
    .join("\n");
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <!-- Google tag (gtag.js) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-1526QV5JQX"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', 'G-1526QV5JQX');
    </script>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Reports &mdash; The Global Dilemma: Guns or Butter</title>
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="stylesheet" href="/home.css" />
  </head>
  <body>
    <main class="reports">
      <h1>Games started<span>${results.length} most recent, times in UTC</span></h1>
      <table>
        <thead><tr><th>Started</th><th>Nation</th><th>Continent</th><th>Difficulty</th><th>Production</th><th>IP address</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </main>
  </body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
