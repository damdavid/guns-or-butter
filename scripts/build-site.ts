/**
 * Assemble the deployable site into `site/`.
 *
 * `web/` is a working directory — `main.ts` sits beside `index.html` and `dist/` holds
 * whatever the dev server last built — so a host is handed a clean copy rather than
 * that. The JS lands at `dist/app.js` because the pages already reference it there.
 */
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const web = (path: string) => fileURLToPath(new URL(`../web/${path}`, import.meta.url));
const out = (path: string) => fileURLToPath(new URL(`../site/${path}`, import.meta.url));

await rm(out(""), { recursive: true, force: true });
await mkdir(out("dist"), { recursive: true });

await build({
  entryPoints: [web("main.ts")],
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2022",
  outfile: out("dist/app.js"),
});

const pages = ["index.html", "play.html", "style.css", "home.css", "favicon.ico"];
for (const file of pages) await cp(web(file), out(file));
await cp(web("art"), out("art"), { recursive: true });

const sizes = await Promise.all(
  [...pages, "dist/app.js", "art/guns-or-butter.jpg", "art/icon.png"].map(async (f) => {
    const { size } = await stat(out(f));
    return { f, size };
  }),
);
const total = sizes.reduce((sum, s) => sum + s.size, 0);
for (const { f, size } of sizes) {
  console.log(`  ${f.padEnd(26)} ${(size / 1024).toFixed(1).padStart(7)} kB`);
}
console.log(`  ${"total".padEnd(26)} ${(total / 1024).toFixed(1).padStart(7)} kB`);
