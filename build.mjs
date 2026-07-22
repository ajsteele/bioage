/*
 * Production build for the embeddable calculators.
 *
 * Reads embed/calculators.json and emits dist/ — the folder that gets deployed
 * as the site's /embed/. The build:
 *   - ships only `ready: true` calculators (jet lag, etc. are held back);
 *   - writes a ready-only manifest, so nothing unfinished is even listed;
 *   - bundles each calculator page's own <script src> files into one minified
 *     app.min.js (fewer requests, no change to the calculators' logic);
 *   - minifies inline <script>/<style>, external CSS/JS, and shared assets.
 *
 * The dist/ layout mirrors embed/ exactly, so EMBED_BASE (/embed/), the
 * ../../shared/... relative links and the shared/setup.js contract URL all keep
 * resolving. Config/strings stay as fetched-at-runtime data files.
 *
 * Usage: `npm run build` (after `npm install`).
 */
import { readFile, writeFile, mkdir, cp, rm, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'embed');
const OUT = join(ROOT, 'dist');

const minifyJS = (code) =>
  esbuild.transform(code, { loader: 'js', minify: true, legalComments: 'none' }).then((r) => r.code);
const minifyCSS = (code) =>
  esbuild.transform(code, { loader: 'css', minify: true, legalComments: 'none' }).then((r) => r.code);

// Run an async replacer over every regex match, in order.
async function replaceAsync(str, re, fn) {
  const out = [];
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(str)) !== null) {
    out.push(str.slice(last, m.index), await fn(...m));
    last = m.index + m[0].length;
  }
  out.push(str.slice(last));
  return out.join('');
}

// Minify the page's own inline <style>…</style> and attribute-less
// <script>…</script> blocks. Tags with a src (e.g. <script src=…>) don't match
// the attribute-less pattern and are left for bundlePageScripts / kept as-is.
async function minifyInlineHTML(html) {
  html = await replaceAsync(html, /<style>([\s\S]*?)<\/style>/g, async (_, css) =>
    '<style>' + (await minifyCSS(css)) + '</style>');
  html = await replaceAsync(html, /<script>([\s\S]*?)<\/script>/g, async (_, js) =>
    '<script>' + (await minifyJS(js)) + '</script>');
  return html;
}

// Concatenate a page's local <script src> files (in document order) into one
// minified bundle, and rewrite the HTML to load just that. Cross-origin scripts
// (none today) are left untouched. Returns the rewritten HTML, the bundle code,
// and the local page-relative files that were folded in (so they can be pruned
// from dist).
async function bundlePageScripts(html, srcDir) {
  const scriptRe = /<script\s+src="([^"]+)"[^>]*><\/script>/g;
  const srcs = [...html.matchAll(scriptRe)].map((m) => m[1]).filter((s) => !/^https?:/i.test(s));
  if (!srcs.length) return { html, bundle: null, folded: [] };

  let code = '';
  for (const src of srcs) code += '\n;\n' + (await readFile(join(srcDir, src), 'utf8'));
  const bundle = await minifyJS(code);

  let first = true;
  html = html.replace(scriptRe, (full, src) => {
    if (/^https?:/i.test(src)) return full;
    if (first) { first = false; return '<script src="app.min.js"></script>'; }
    return '';
  });

  // Local files that live inside the page dir (not ../../shared/...) are now
  // dead once bundled — list them for pruning.
  const folded = srcs.filter((s) => !s.startsWith('../') && !s.startsWith('/'));
  return { html, bundle, folded };
}

async function minifyCssFilesIn(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.css')) {
      const p = join(dir, entry.name);
      await writeFile(p, await minifyCSS(await readFile(p, 'utf8')));
    }
  }
}

async function build() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const manifest = JSON.parse(await readFile(join(SRC, 'calculators.json'), 'utf8'));
  const ready = manifest.filter((c) => c.ready);

  // Ready-only manifest: the picker's `ready` filter still works, and nothing
  // unfinished is listed or linkable on the live site.
  await writeFile(join(OUT, 'calculators.json'), JSON.stringify(ready, null, 2) + '\n');

  // Shared assets: copy wholesale, then minify the CSS/JS in place. Fonts,
  // images and the SVG favicon copy through unchanged.
  await cp(join(SRC, 'shared'), join(OUT, 'shared'), { recursive: true });
  await writeFile(join(OUT, 'shared', 'embed.css'), await minifyCSS(await readFile(join(SRC, 'shared', 'embed.css'), 'utf8')));
  for (const js of ['setup.js', 'card-kit.js']) {
    await writeFile(join(OUT, 'shared', js), await minifyJS(await readFile(join(SRC, 'shared', js), 'utf8')));
  }

  // Picker page: options are built from the manifest at runtime, so only its
  // inline <script>/<style> need minifying.
  await writeFile(join(OUT, 'index.html'), await minifyInlineHTML(await readFile(join(SRC, 'index.html'), 'utf8')));

  // Ready calculators.
  for (const c of ready) {
    const srcDir = join(SRC, c.path);
    const outDir = join(OUT, c.path);
    await cp(srcDir, outDir, { recursive: true });

    let html = await readFile(join(outDir, 'index.html'), 'utf8');
    const { html: rewritten, bundle, folded } = await bundlePageScripts(html, srcDir);
    html = await minifyInlineHTML(rewritten);
    await writeFile(join(outDir, 'index.html'), html);

    if (bundle) await writeFile(join(outDir, 'app.min.js'), bundle);
    for (const dead of folded) await unlink(join(outDir, dead));

    await minifyCssFilesIn(outDir);
  }

  console.log('Built dist/ with calculators: ' + ready.map((c) => c.id).join(', '));
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
