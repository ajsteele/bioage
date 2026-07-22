# Biological age calculators

Free, embeddable biological-age calculators from
[The Longevity Initiative](https://thelongevityinitiative.org). Each one runs
**entirely in the visitor's browser** — no data is ever sent to a server. Results
live only in the page (and, where offered, in a URL you can bookmark), so the
calculators are safe to use and safe to embed anywhere.

Live calculators:

- **PhenoAge** — biological age estimated from routine blood biomarkers.
- **Dog years** — human-equivalent dog age from an epigenetic (DNA-methylation)
  formula.

The code is deliberately plain HTML / CSS / vanilla JS so it's easy to read and
contribute to. Found a bug or want to add a calculator? Issues and pull requests
are very welcome.

## Layout

```
embed/                         # everything that ships to the website's /embed/
  index.html                   # the "embed a calculator" picker page
  calculators.json             # manifest: which calculators exist + are ready
  calculators/<id>/            # one self-contained calculator per folder
    index.html                 #   the iframe embed target
    <id>.js, share-card.js     #   calculator + share-card logic
    config/, strings/          #   data + copy, fetched at runtime
  shared/                      # assets shared across calculators
    embed.css, card-kit.js     #   styles + share-card canvas primitives
    setup.js                   #   host-page iframe auto-resizer (see below)
    fonts/, assets/            #   self-hosted fonts, logo, favicon
analysis/                      # dev-only: R/Python that generates the config data
build.mjs                      # produces the minified dist/ that gets deployed
```

## The manifest

`embed/calculators.json` is the single source of truth for which calculators
exist and which are ready to go live:

```json
{ "id": "phenoage", "ready": true, "name": "…", "label": "…", "path": "calculators/phenoage/" }
```

- `ready: false` holds a calculator back — its files stay in the repo, but the
  build omits its folder from `dist/` and leaves it out of the shipped manifest,
  so it can't appear or be linked to on the live site.
- The picker builds its menu from this manifest at runtime.
- An optional `anchor` (defaults to `id`) is the deep-link key — see below.

## Deep links

`/embed/#<anchor>` pre-selects a calculator in the picker, e.g.
`https://thelongevityinitiative.org/embed/#phenoage`. The hash is matched
**exactly** against each calculator's `anchor` (its `id` by default). If two
calculators of different types ever need the same short name, give one an
explicit `anchor` (e.g. `"anchor": "graphs/phenoage"`) — no other links change.

## Develop

Calculators fetch their config/strings, so they need to be served over HTTP
(not opened as `file://`):

```sh
npm run dev     # serves embed/ at http://localhost:8000
```

The dev server shows the full manifest filtered by the `ready` flag, so it
behaves like production. (`npm run dev` uses Python's `http.server`; any static
server pointed at `embed/` works.)

## Build & deploy

```sh
npm install
npm run build   # writes dist/
npm run preview # build, then serve dist/ at http://localhost:8000
```

`build.mjs` (esbuild) emits `dist/` — the folder to deploy as the site's
`/embed/`. It ships only ready calculators, bundles each page's scripts into one
`app.min.js`, and minifies HTML-inline JS/CSS, external CSS/JS, and shared
assets. `dist/` mirrors `embed/` exactly, so all relative paths and the
`shared/setup.js` URL keep resolving.

Standalone pages at `/calculators/<id>/` are built separately on the main
Longevity Initiative site, which embeds `/embed/calculators/<id>/` as an iframe
and adds explanatory copy. The embed pages carry `<meta name="robots"
noindex>` and a canonical link so search credits those standalone pages.

### Deploying the picker into WordPress

The `/embed/` **picker** page can live as a WordPress page instead of a static
file. Upload everything in `dist/` **except `index.html`** to the server's
`/embed/` path (so `/embed/calculators/…`, `/embed/shared/…`, `/embed/picker.js`
and `/embed/calculators.json` are static files), and let WordPress own the
`/embed/` page — the web server's `try_files` would otherwise serve a static
`index.html` in preference to the WordPress page.

`npm run build` also emits **`dist/embed.wordpress-blocks.html`**: the picker as
Gutenberg block markup. To use it:

1. Create a page, set its permalink to `/embed/` and title to "Embed a calculator".
2. In the editor, open **Options ⋮ → Code editor** (Ctrl+Shift+Alt+M), paste the
   whole file, then switch back to the **Visual editor**.

It expands into native Heading/Paragraph blocks (which inherit your theme) plus
Custom HTML blocks for the interactive builder — no theme `style.css` edits and
no per-element inline styles (a small namespaced `.liec-*` stylesheet rides
along in the trailing block). The `<script>` survives only for users who can
post unfiltered HTML — administrators on single-site WordPress. The shared
picker logic loads from `/embed/picker.js`, so future logic changes never need
re-pasting.

### Web-server checklist

The build can't set HTTP headers, so configure these where `dist/` is served:

- **Allow framing.** Do **not** send `X-Frame-Options: DENY` or a restrictive
  `Content-Security-Policy: frame-ancestors` for `/embed/*` — these pages are
  meant to be embedded on other people's sites.
- **Cache `shared/setup.js` moderately, not forever.** It's pasted verbatim into
  third-party pages, so its URL is a permanent contract and can't be
  content-hashed. Give it a short-to-medium `max-age` (≈1 hour–1 day) so fixes
  propagate; **never** `immutable`.
- Long-cache fonts and other static assets; short-cache HTML.

### How the auto-resize works

The embed snippet loads `shared/setup.js` on the **host** page. Each calculator
`postMessage`s its content height out of its cross-origin iframe, and `setup.js`
sizes the iframe to match. Messages are trusted by **origin**, so the embed URL
path can change freely — only moving to a new domain would require editing the
one `ORIGIN` constant in `setup.js` (and `EMBED_ORIGIN` in `embed/index.html`).

## The analysis folder

`analysis/` holds the R and Python that generate PhenoAge's config data
(default marker values by age, uncertainty ranges, plausibility bounds) from the
NHANES-III dataset the clock was trained on. It's dev-only and not deployed; see
`analysis/requirements.txt` for the Python setup.

## Licence

[CC0 1.0 Universal](LICENSE) — dedicated to the public domain, so you're free to
use, adapt and embed these calculators however you like. A link back to
[The Longevity Initiative](https://thelongevityinitiative.org) is appreciated
but not required.
