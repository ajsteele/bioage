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
import { parse } from 'node-html-parser';

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

// Emit dist/embed.wordpress-blocks.html: the picker as Gutenberg block markup.
// Pasted once into the WordPress block editor's Code editor, it becomes native
// Heading/Paragraph blocks (which inherit the theme) plus Custom HTML blocks for
// the interactive builder — no manual per-block assembly.
//
// Prose (headings, plain paragraphs) => core/heading + core/paragraph, with
// their attributes stripped so they read as clean native blocks. Interactive
// elements (the chooser, options grid, snippet box, preview iframe, and the
// JS-toggled error note, identified by carrying an id) => grouped into core/html
// blocks. A trailing core/html block holds the scoped .liec-* CSS and loads the
// shared picker.js from the absolute /embed/ URL.
async function generateWordpressBlocks() {
  const src = await readFile(join(SRC, 'index.html'), 'utf8');
  const EMBED_BASE = 'https://thelongevityinitiative.org/embed/';

  // Keep only the leak-free component rules (those referencing a .liec- class);
  // a WordPress page inherits its theme for everything else.
  const css = (src.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1]
    .replace(/\/\*[\s\S]*?\*\//g, ''); // drop comments so a mention of .liec- can't fool the filter
  const liecCss = css
    .split('}')
    .map((r) => r.trim())
    .filter((r) => r && r.split('{')[0].includes('.liec-'))
    .map((r) => r + '}')
    .join('\n');

  const body = (src.match(/<body>([\s\S]*?)<\/body>/) || [, ''])[1];
  const root = parse(body, { comment: false });

  const blocks = [];
  let htmlGroup = [];
  const flush = () => {
    if (htmlGroup.length) {
      blocks.push('<!-- wp:html -->\n' + htmlGroup.join('\n') + '\n<!-- /wp:html -->');
      htmlGroup = [];
    }
  };

  for (const node of root.childNodes) {
    if (node.nodeType !== 1) continue; // elements only
    const tag = (node.rawTagName || '').toLowerCase();
    if (tag === 'h1' || tag === 'script' || tag === 'style') continue; // title / assets handled elsewhere

    // Prose: headings and plain paragraphs (no id => not JS-controlled).
    const isProse = (tag === 'h2' || tag === 'p') && !node.getAttribute('id');
    if (isProse) {
      flush();
      node.removeAttribute('class');
      if (tag === 'h2') {
        node.setAttribute('class', 'wp-block-heading');
        blocks.push('<!-- wp:heading -->\n' + node.toString() + '\n<!-- /wp:heading -->');
      } else {
        blocks.push('<!-- wp:paragraph -->\n' + node.toString() + '\n<!-- /wp:paragraph -->');
      }
    } else if (tag === 'footer') {
      flush();
      blocks.push('<!-- wp:separator -->\n<hr class="wp-block-separator has-alpha-channel-opacity"/>\n<!-- /wp:separator -->');
      blocks.push('<!-- wp:paragraph -->\n<p>' + node.innerHTML.trim() + '</p>\n<!-- /wp:paragraph -->');
    } else {
      htmlGroup.push(node.toString()); // select, options grid, snippet box, iframe, error note
    }
  }
  flush();

  const assets =
    '<!-- wp:html -->\n<style>' + (await minifyCSS(liecCss)) + '</style>\n' +
    '<script src="' + EMBED_BASE + 'picker.js"></script>\n<!-- /wp:html -->';
  blocks.push(assets);

  await writeFile(join(OUT, 'embed.wordpress-blocks.html'), blocks.join('\n\n') + '\n');
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

  // Picker page + its (external, shared) logic. The page's own <script> lives
  // in picker.js so the standalone page and the WordPress block can share it.
  await writeFile(join(OUT, 'index.html'), await minifyInlineHTML(await readFile(join(SRC, 'index.html'), 'utf8')));
  await writeFile(join(OUT, 'picker.js'), await minifyJS(await readFile(join(SRC, 'picker.js'), 'utf8')));
  await generateWordpressBlocks();

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
