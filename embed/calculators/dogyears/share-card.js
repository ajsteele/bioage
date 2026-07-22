// Dog age result card — canvas renderer.
//
// Same card system as PhenoAge (see phenoage/share-card.js and
// shared/card-kit.js): background gradient, top row with logo, tracked text
// and footer are the shared primitives from card-kit.js. What's specific here
// is the layout — a photo circle with the dog's name and actual age on the
// left, the big human-equivalent number and a two-line explanation stacked on
// the right — plus a choice of colour TONES. The explanation is a full
// sentence rather than a two-word badge and confined to the right-hand
// column, so it gets its own drawInfoPill below rather than card-kit's
// single-line drawPill.
//
// dogyears.js positions the live photo/name controls directly on top of this
// card (see layoutCardOverlays there) using the same LAYOUT.photo numbers
// this file draws from, so the two can't drift apart.
//
// EVERY position, size and colour lives in LAYOUT and TONES. If you find
// yourself changing a number inside a draw* function, it belongs up here
// instead.

// --- Design tokens -----------------------------------------------------------

// Five identities, one shared gradient formula (see card-kit's drawBackground:
// light top-left stop, bg midpoint, deep bottom-right). Each `light`/`deep` is
// `bg` moved ~16% toward white / to ~63% of its value — the same ratios
// PhenoAge's tones use — so every colour reads as "the same card" regardless
// of which is picked.
var TONES = {
  blue:   { bg: '#0f2b3c', deep: '#0a1e2a', accent: '#4fc3f7', light: '#2c4759' },
  pink:   { bg: '#3d1029', deep: '#260a1a', accent: '#f472b6', light: '#5c364b' },
  yellow: { bg: '#3d2a0a', deep: '#261b06', accent: '#facc15', light: '#5c4c31' },
  green:  { bg: '#0d2e1a', deep: '#081d10', accent: '#a3e635', light: '#344f3f' },
  grey:   { bg: '#1a1c1f', deep: '#101213', accent: '#cbd5e1', light: '#3f4043' }
};
var DEFAULT_TONE = 'blue';

var LAYOUT = {
  pad: { top: 38, side: 46, bottom: 36 },

  eyebrow: { x: 46, midY: 69.5, size: 19, weight: 500, tracking: 0.14, alpha: 0.88 },
  logo: { right: 566, y: 38, w: 240, h: 63, alpha: 0.96 },

  // Photo circle, left, with the dog's name and actual age stacked under it.
  // dogyears.js reads cx/cy/r directly to position the live upload/drag
  // control over the same spot, and reads `name`/`age` to place its name
  // input — so a photo real photo never fills a different circle than the
  // one the placeholder paw sits in.
  // cy and hero.num.top are chosen so the photo+hero block, taken as a whole,
  // sits vertically centred in the gap between the top row and the footer —
  // both currently land 76px clear of the block on either side. If either
  // block's internal sizes change, recheck that (top row bottom ~101, footer
  // top ~542, so the pair's midpoint is ~321.5).
  photo: {
    cx: 162, cy: 289, r: 112, borderW: 4,
    // The "add a photo" / "drag to reposition" instructions are DOM overlays
    // (dogyears.js), not drawn here — they're guidance for the person filling
    // the form in, not content that belongs in the image they end up sharing.
    placeholderChar: '🐾',
    placeholderIcon: { size: 76, alpha: 0.4 },
    name: { midY: 429, size: 25, weight: 600, boxWidth: 240, boxHeight: 36 },
    age: { midY: 457, size: 17, weight: 400, alpha: 0.65 },
    // Overlay-only — dogyears.js positions the remove button here, but
    // nothing is drawn on the canvas for it (removing a photo is a
    // page-editing action, not part of the shared image). Sized as a
    // diameter, inscribed in the top-right corner of the photo's own square
    // bounding box (tangent to its top and right edges).
    removeBadge: { diameter: 26 }
  },

  // Number, its "dog years" caption, and the explanation, all stacked in one
  // left-aligned column — not centred as a group (PhenoAge's hero), because
  // there's a photo on the other side of the card. A stray value (someone
  // typing an age far outside the form's intended range) can still produce a
  // 3-digit number, so the number shrinks to fit its column rather than
  // assuming two digits.
  hero: {
    x: 306,
    num: { top: 200, height: 140, size: 152, weight: 700, tracking: -0.03 },
    suffix: { midY: 360, size: 37, weight: 600, tracking: -0.005 }
  },

  // Explanation, right under "dog years" in the same column — two lines
  // (the sentence doesn't fit the column width on one) in a pill matching
  // card-kit's, drawn locally since drawPill only handles a single line.
  pill: {
    top: 400, padX: 22, padY: 13, lineHeight: 20, size: 15, weight: 600,
    dot: 8, dotHalo: 3, dotGap: 9, ringAlpha: 0.30
  },

  foot: { midY: 551.5, size: 18, gap: 10, ctaAlpha: 0.68 }
};

// --- Card sections -----------------------------------------------------------

function drawPhoto(ctx, tone, opts) {
  var P = LAYOUT.photo;
  var cx = P.cx, cy = P.cy, r = P.r;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  if (opts.img) {
    drawCoverImage(ctx, opts.img, cx - r, cy - r, r * 2, r * 2, opts.offsetX, opts.offsetY, opts.zoom);
  } else {
    ctx.fillStyle = tone.deep;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

    var icon = P.placeholderIcon;
    ctx.save();
    ctx.globalAlpha = icon.alpha;
    ctx.fillStyle = '#ffffff';
    ctx.font = font(400, icon.size, SANS);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(P.placeholderChar, cx, cy);
    ctx.restore();
  }
  ctx.restore();

  // Ring, drawn after the clip is released so it sits crisply on the edge.
  ctx.beginPath();
  ctx.arc(cx, cy, r - P.borderW / 2, 0, Math.PI * 2);
  ctx.lineWidth = P.borderW;
  ctx.strokeStyle = opts.img ? tone.accent : 'rgba(255,255,255,0.18)';
  ctx.stroke();

  if (opts.name) {
    ctx.fillStyle = '#ffffff';
    ctx.font = font(P.name.weight, P.name.size, SANS);
    drawTracked(ctx, opts.name, cx, P.name.midY, 0, 'center');
  }
  // The dog's actual age — a cute aside under its name, so it's set apart in
  // weight rather than competing with the headline figure. Reads as an
  // orphaned caption without the name above it, so it only appears with one.
  if (opts.name && opts.ageText) {
    ctx.fillStyle = white(P.age.alpha);
    ctx.font = font(P.age.weight, P.age.size, SANS);
    drawTracked(ctx, opts.ageText, cx, P.age.midY, 0, 'center');
  }
}

function drawFigure(ctx, tone, opts) {
  var H = LAYOUT.hero;
  var numText = opts.empty ? '??' : String(opts.humanAge);

  // The realistic range is two digits, but a value typed outside the form's
  // intended bounds can still reach three — shrink rather than overflow into
  // the padding.
  var colW = CARD_SIZE - LAYOUT.pad.side - H.x;
  ctx.font = font(H.num.weight, H.num.size, SANS);
  var numW = measureTracked(ctx, numText, H.num.tracking);
  var fit = Math.min(1, colW / numW);
  var midY = H.num.top + H.num.height / 2;

  ctx.save();
  if (fit < 1) {
    ctx.translate(H.x, midY);
    ctx.scale(fit, fit);
    ctx.translate(-H.x, -midY);
  }
  ctx.fillStyle = tone.accent;
  if (opts.empty) ctx.globalAlpha = 0.4;
  drawTracked(ctx, numText, H.x, midY, H.num.tracking, 'left');
  ctx.restore();

  ctx.fillStyle = '#ffffff';
  ctx.font = font(H.suffix.weight, H.suffix.size, SANS);
  drawTracked(ctx, opts.suffixText, H.x, H.suffix.midY, H.suffix.tracking, 'left');
}

// Two lines in the pill: at the hero column's width the explanation sentence
// doesn't fit on one, and wrapping it here (fixed break, not measured) keeps
// the split predictable rather than reflowing oddly at render time.
function drawInfoPill(ctx, tone, x, lines) {
  var P = LAYOUT.pill;
  ctx.font = font(P.weight, P.size, SANS);
  var textW = 0;
  for (var i = 0; i < lines.length; i++) textW = Math.max(textW, measureTracked(ctx, lines[i], 0));
  var w = P.padX + P.dot + P.dotGap + textW + P.padX;
  var h = P.padY * 2 + P.lineHeight * lines.length;

  roundRect(ctx, x, P.top, w, h, Math.min(18, h / 2));
  ctx.fillStyle = tone.deep;
  ctx.fill();
  ctx.strokeStyle = rgba(tone.accent, P.ringAlpha);
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, P.top + 0.5, w - 1, h - 1, Math.min(18, h / 2) - 0.5);
  ctx.stroke();

  var midY = P.top + h / 2;
  // The leading whitespace ahead of the text — padX (edge margin) plus
  // dotGap (the dot's own clearance from the text) — is more room than the
  // small dot needs on its own. Split it evenly around the dot instead of
  // stacking it all on the text side, which read as the dot crowding the
  // text rather than sitting in its own space. textX is unaffected: the two
  // halves still sum to the same padX + dot + dotGap as before.
  var leadingFree = P.padX + P.dotGap;
  var dotX = x + leadingFree / 2 + P.dot / 2;
  ctx.fillStyle = rgba(tone.accent, 0.22);
  ctx.beginPath();
  ctx.arc(dotX, midY, P.dot / 2 + P.dotHalo, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = tone.accent;
  ctx.beginPath();
  ctx.arc(dotX, midY, P.dot / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = tone.accent;
  ctx.font = font(P.weight, P.size, SANS);
  var textX = x + P.padX + P.dot + P.dotGap;
  var textTop = P.top + (h - P.lineHeight * lines.length) / 2;
  for (var j = 0; j < lines.length; j++) {
    drawTracked(ctx, lines[j], textX, textTop + P.lineHeight * (j + 0.5), 0, 'left');
  }
}

// --- Public entry point ------------------------------------------------------

// Render into `canvas`. `opts`:
//   empty              — true for the placeholder card shown before any age is entered
//   humanAge           — number (ignored when empty)
//   dogAgeText         — the dog's actual age, e.g. "5.5 years old", or '' to omit
//   photo              — { img, offsetX, offsetY, zoom } or null for the paw placeholder
//   name               — dog's name, or '' to omit
//   tone               — key into TONES (default 'blue')
//   scale              — device pixels per CSS pixel (default 2)
//   strings            — { eyebrow, suffix, pillLines[], cta, url }
// Resolves once the card is on the canvas.
function renderDogShareCard(canvas, opts) {
  return Promise.all([loadCardFonts(), loadLogo()]).then(function(res) {
    var logo = res[1];
    var scale = opts.scale || 2;
    var tone = TONES[opts.tone] || TONES[DEFAULT_TONE];

    canvas.width = CARD_SIZE * scale;
    canvas.height = CARD_SIZE * scale;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, CARD_SIZE, CARD_SIZE);

    var s = opts.strings;

    drawBackground(ctx, tone);
    drawTopRow(ctx, LAYOUT.eyebrow, LAYOUT.logo, logo, s.eyebrow);
    drawPhoto(ctx, tone, {
      img: opts.photo && opts.photo.img,
      offsetX: opts.photo ? opts.photo.offsetX : 50,
      offsetY: opts.photo ? opts.photo.offsetY : 50,
      zoom: opts.photo ? opts.photo.zoom : 1,
      name: opts.name,
      ageText: opts.empty ? '' : opts.dogAgeText
    });
    drawFigure(ctx, tone, {
      empty: opts.empty, humanAge: opts.humanAge, suffixText: s.suffix
    });
    drawInfoPill(ctx, tone, LAYOUT.hero.x, s.pillLines);
    drawFoot(ctx, LAYOUT.foot, s.cta, s.url);
    return canvas;
  });
}
