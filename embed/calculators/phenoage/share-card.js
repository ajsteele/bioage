// PhenoAge result card — canvas renderer.
//
// Draws the 600x600 shareable card described in design_handoff_result_card.
// Canvas rather than DOM-plus-screenshot so the export is exact at any pixel
// ratio, no font data has to be inlined per render, and there is one artefact
// on the page instead of a live card that gets swapped for a PNG.
//
// EVERY position, size and colour lives in LAYOUT and TONES below. The design
// is expected to keep moving, so tweaks should be edits to those two blocks —
// if you find yourself changing a number inside a draw* function, it belongs up
// here instead. Values were measured off the reference render at 600x600; the
// whole card scales by one factor at draw time.

// --- Design tokens -----------------------------------------------------------

var CARD_SIZE = 600;

// Tone is chosen by diff = round(bioAge) - floor(chronoAge).
// `light` is the gradient's top-left stop: bg mixed 82% with white, precomputed
// rather than colour-mixed at runtime.
var TONES = {
  younger: { bg: '#0f3d31', deep: '#082822', accent: '#5bc198', light: '#2f5a4c' },
  ontrack: { bg: '#16306b', deep: '#0d1f4a', accent: '#6aa3ff', light: '#35497e' },
  older:   { bg: '#5d2a0d', deep: '#3d1a05', accent: '#f3b53b', light: '#764a2c' }
};

var SANS = '"Figtree Card", system-ui, -apple-system, sans-serif';
var MONO = '"JetBrains Mono Card", ui-monospace, "SF Mono", Menlo, monospace';

var LAYOUT = {
  pad: { top: 38, side: 46, bottom: 36 },

  // Top row: eyebrow left, logo right. Logo overhangs the padding by 12px.
  eyebrow: { x: 46, midY: 69.5, size: 19, weight: 500, tracking: 0.14, alpha: 0.88 },
  logo: { right: 566, y: 38, w: 240, h: 63, alpha: 0.96 },

  // Hero: big number and, to its right, the two-line suffix above the pill.
  // The group is centred horizontally as a unit, so x is computed at draw time.
  hero: {
    top: 169, height: 164, gap: 30,
    num: { size: 200, weight: 700, tracking: -0.05, lineHeight: 0.82 },
    suffix: { size: 40, weight: 600, tracking: -0.01, lineHeight: 43.2, top: 169.8 },
    pill: {
      top: 278.2, height: 54, padX: 28, size: 23, weight: 600,
      dot: 8, dotHalo: 4, dotGap: 11, ringAlpha: 0.30
    }
  },

  // Comparison timeline.
  scale: {
    x: 54, w: 492,
    trackY: 431, trackH: 3, trackAlpha: 0.16,
    fillY: 428, fillH: 9, fillOverhang: 5,
    tick: { stemTop: 436, stemH: 6, stemAlpha: 0.22, labelMidY: 454, size: 13, labelAlpha: 0.42 },
    bio: { valueMidY: 384, labelMidY: 408, stemTop: 421, stemH: 7, valueSize: 24, labelSize: 14 },
    chrono: {
      stemTop: 437, stemH: 7, labelMidY: 475, valueMidY: 499,
      valueSize: 24, labelSize: 14, alpha: 0.85
    },
    labelTracking: 0.08
  },

  foot: { midY: 551.5, size: 19, gap: 10, ctaAlpha: 0.68 },

  // Empty state: full card chrome, no fabricated number.
  empty: { text: '??', numAlpha: 0.4, pillAlpha: 0.55 }
};

// --- Colour helpers ----------------------------------------------------------

function hexToRgb(hex) {
  var h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgba(hex, alpha) {
  var c = hexToRgb(hex);
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
}

function white(alpha) {
  return 'rgba(255,255,255,' + alpha + ')';
}

// --- Fonts -------------------------------------------------------------------

// Canvas silently falls back to a system font if the face isn't loaded yet, and
// there is no repaint when it arrives — so every draw waits on this.
var fontsReady = null;

function loadCardFonts() {
  if (fontsReady) return fontsReady;
  if (!document.fonts || !document.fonts.load) {
    fontsReady = Promise.resolve();
    return fontsReady;
  }
  fontsReady = Promise.all([
    document.fonts.load('700 200px "Figtree Card"'),
    document.fonts.load('600 40px "Figtree Card"'),
    document.fonts.load('400 19px "JetBrains Mono Card"'),
    document.fonts.load('500 19px "JetBrains Mono Card"'),
    document.fonts.load('700 19px "JetBrains Mono Card"')
  ]).catch(function() { /* draw with whatever resolved */ });
  return fontsReady;
}

// --- Logo --------------------------------------------------------------------

// Must be same-origin: a cross-origin image taints the canvas and toBlob throws.
var LOGO_URL = '../../shared/assets/li-logo-horizontal-white.svg';
var logoPromise = null;

function loadLogo() {
  if (logoPromise) return logoPromise;
  logoPromise = new Promise(function(resolve) {
    var img = new Image();
    img.onload = function() { resolve(img); };
    img.onerror = function() { resolve(null); }; // card is still fine without it
    img.src = LOGO_URL;
  });
  return logoPromise;
}

// --- Text helpers ------------------------------------------------------------

function font(weight, size, family) {
  return weight + ' ' + size + 'px ' + family;
}

// Letter-spacing for canvas text. ctx.letterSpacing is unsupported in Firefox,
// so fall back to advancing glyph by glyph — same output, just drawn by hand.
// `tracking` is in em, matching the CSS the design is specified in.
var supportsLetterSpacing = null;

function canSetLetterSpacing(ctx) {
  if (supportsLetterSpacing === null) {
    supportsLetterSpacing = 'letterSpacing' in ctx;
  }
  return supportsLetterSpacing;
}

function measureTracked(ctx, text, tracking) {
  if (!tracking) return ctx.measureText(text).width;
  if (canSetLetterSpacing(ctx)) {
    ctx.letterSpacing = tracking + 'em';
    var w = ctx.measureText(text).width;
    ctx.letterSpacing = '0em';
    // Chromium includes trailing spacing after the final glyph; CSS does too,
    // so leave it — the reference measurements were taken from CSS.
    return w;
  }
  var size = parseFloat(ctx.font);
  var total = 0;
  for (var i = 0; i < text.length; i++) {
    total += ctx.measureText(text[i]).width + tracking * size;
  }
  return total;
}

// Draw `text` at (x, midY) with optional em tracking. `align` is 'left'|'center'.
function drawTracked(ctx, text, x, midY, tracking, align) {
  ctx.textBaseline = 'middle';
  var w = measureTracked(ctx, text, tracking);
  var startX = align === 'center' ? x - w / 2 : x;

  if (!tracking) {
    ctx.textAlign = 'left';
    ctx.fillText(text, startX, midY);
    return w;
  }
  if (canSetLetterSpacing(ctx)) {
    ctx.textAlign = 'left';
    ctx.letterSpacing = tracking + 'em';
    ctx.fillText(text, startX, midY);
    ctx.letterSpacing = '0em';
    return w;
  }
  ctx.textAlign = 'left';
  var size = parseFloat(ctx.font);
  var cursor = startX;
  for (var i = 0; i < text.length; i++) {
    ctx.fillText(text[i], cursor, midY);
    cursor += ctx.measureText(text[i]).width + tracking * size;
  }
  return w;
}

// Keep a centred label inside the card's side padding. A marker sitting at
// either end of the timeline would otherwise hang its label — which is much
// wider than the 2px stem it belongs to — off the edge of the image. The stem
// stays at the true position; only the text slides, and since there is just one
// label on each side of the track it still reads as belonging to its marker.
function clampCenter(x, width) {
  var half = width / 2;
  var min = LAYOUT.pad.side + half;
  var max = CARD_SIZE - LAYOUT.pad.side - half;
  if (min > max) return CARD_SIZE / 2;  // wider than the card: centre it
  return Math.max(min, Math.min(max, x));
}

function roundRect(ctx, x, y, w, h, r) {
  var radius = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// --- Scale domain ------------------------------------------------------------

// Centred on the midpoint of the two ages, widened to the enclosing decades and
// padded by 7 years so neither marker sits on the edge.
var TICK_STEPS = [10, 20, 50, 100, 200, 500];
var MAX_TICKS = 8;

function computeScale(bio, chrono) {
  var minA = Math.min(bio, chrono), maxA = Math.max(bio, chrono);
  var mid = (bio + chrono) / 2;
  var lower = Math.floor(minA / 10) * 10, upper = Math.ceil(maxA / 10) * 10;
  var radius = Math.max(mid - lower, upper - mid, 5) + 7;
  var start = mid - radius, end = mid + radius;

  // Decades are right for a normal result, but a wrong unit can open the domain
  // to 150+ years, where every-10 would print twenty overlapping labels. Step up
  // until the axis is readable.
  var step = TICK_STEPS[TICK_STEPS.length - 1];
  for (var s = 0; s < TICK_STEPS.length; s++) {
    if ((end - start) / TICK_STEPS[s] <= MAX_TICKS) { step = TICK_STEPS[s]; break; }
  }

  var ticks = [];
  for (var i = Math.ceil(start / step) * step; i <= Math.floor(end / step) * step; i += step) {
    // A tick sitting under a marker is noise, not information.
    var clearance = (end - start) * 0.03;
    if (Math.abs(i - bio) <= clearance || Math.abs(i - chrono) <= clearance) continue;
    ticks.push(i);
  }
  return { start: start, end: end, ticks: ticks };
}

function toneFor(diff) {
  if (diff < -1) return 'younger';
  if (diff > 1) return 'older';
  return 'ontrack';
}

// --- Background --------------------------------------------------------------

function drawBackground(ctx, tone) {
  var g = ctx.createLinearGradient(88, -54, 512, 654);
  g.addColorStop(0, tone.light);
  g.addColorStop(0.42, tone.bg);
  g.addColorStop(1, tone.deep);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE);

  // Bottom-left deepening, then a faint top-right haze. Both are ellipses, so
  // each is drawn as a circular gradient inside a scaled transform.
  drawEllipseGlow(ctx, 0.10, 1.12, 0.90, 0.60, tone.deep, 1, 0.62);
  drawEllipseGlow(ctx, 1.00, -0.05, 0.70, 0.45, '#ffffff', 0.05, 0.55);
}

function drawEllipseGlow(ctx, cxPct, cyPct, rxPct, ryPct, hex, alpha, stop) {
  var cx = cxPct * CARD_SIZE, cy = cyPct * CARD_SIZE;
  var rx = rxPct * CARD_SIZE, ry = ryPct * CARD_SIZE;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  var g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, rgba(hex, alpha));
  g.addColorStop(stop, rgba(hex, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// --- Card sections -----------------------------------------------------------

function drawTopRow(ctx, tone, logo, eyebrowText) {
  var L = LAYOUT.eyebrow;
  ctx.fillStyle = white(L.alpha);
  ctx.font = font(L.weight, L.size, MONO);
  drawTracked(ctx, eyebrowText.toUpperCase(), L.x, L.midY, L.tracking, 'left');

  if (logo) {
    var G = LAYOUT.logo;
    ctx.save();
    ctx.globalAlpha = G.alpha;
    ctx.drawImage(logo, G.right - G.w, G.y, G.w, G.h);
    ctx.restore();
  }
}

// The number and the column to its right are centred as one group, so the
// number's width has to be measured before anything can be placed.
function drawHero(ctx, tone, opts) {
  var H = LAYOUT.hero;
  var numText = opts.empty ? LAYOUT.empty.text : String(opts.bioAge);

  ctx.font = font(H.num.weight, H.num.size, SANS);
  var numW = measureTracked(ctx, numText, H.num.tracking);

  ctx.font = font(H.suffix.weight, H.suffix.size, SANS);
  var suffixW = 0;
  for (var i = 0; i < opts.suffixLines.length; i++) {
    suffixW = Math.max(suffixW, measureTracked(ctx, opts.suffixLines[i], H.suffix.tracking));
  }

  var pillW = measurePill(ctx, opts.pillText);
  var colW = Math.max(suffixW, pillW);
  var totalW = numW + H.gap + colW;

  // A mistyped value can produce something like "-102" with a "143 years
  // younger" pill, which is far wider than the card. The result is still shown
  // — it is the user's best clue as to which input is wrong — so the hero
  // shrinks to fit rather than running off both edges.
  var avail = CARD_SIZE - LAYOUT.pad.side * 2;
  var fit = Math.min(1, avail / totalW);
  var heroMidY = H.top + H.height / 2;
  ctx.save();
  if (fit < 1) {
    ctx.translate(CARD_SIZE / 2, heroMidY);
    ctx.scale(fit, fit);
    ctx.translate(-CARD_SIZE / 2, -heroMidY);
  }

  var x = (CARD_SIZE - totalW) / 2;

  // Big number, or "??" while there isn't one
  ctx.save();
  ctx.fillStyle = tone.accent;
  if (opts.empty) ctx.globalAlpha = LAYOUT.empty.numAlpha;
  ctx.font = font(H.num.weight, H.num.size, SANS);
  drawTracked(ctx, numText, x, H.top + H.height / 2, H.num.tracking, 'left');
  ctx.restore();

  // Two-line suffix
  var colX = x + numW + H.gap;
  ctx.fillStyle = '#ffffff';
  ctx.font = font(H.suffix.weight, H.suffix.size, SANS);
  for (var j = 0; j < opts.suffixLines.length; j++) {
    var midY = H.suffix.top + H.suffix.lineHeight * (j + 0.5);
    drawTracked(ctx, opts.suffixLines[j], colX, midY, H.suffix.tracking, 'left');
  }

  drawPill(ctx, tone, colX, opts.pillText, pillW, opts.empty);
  ctx.restore();
}

function measurePill(ctx, text) {
  var P = LAYOUT.hero.pill;
  ctx.font = font(P.weight, P.size, SANS);
  return P.padX + P.dot + P.dotGap + ctx.measureText(text).width + P.padX;
}

function drawPill(ctx, tone, x, text, w, empty) {
  var P = LAYOUT.hero.pill;
  ctx.save();
  if (empty) ctx.globalAlpha = LAYOUT.empty.pillAlpha;

  roundRect(ctx, x, P.top, w, P.height, P.height / 2);
  ctx.fillStyle = tone.deep;
  ctx.fill();
  // The 1px ring is an inset stroke, so it sits inside the fill.
  ctx.strokeStyle = rgba(tone.accent, P.ringAlpha);
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, P.top + 0.5, w - 1, P.height - 1, (P.height - 1) / 2);
  ctx.stroke();

  var midY = P.top + P.height / 2;
  var dotX = x + P.padX + P.dot / 2;
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
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + P.padX + P.dot + P.dotGap, midY);
  ctx.restore();
}

function drawScale(ctx, tone, opts) {
  var S = LAYOUT.scale;

  // Track, always drawn — it is what makes the empty card look like the real one.
  ctx.fillStyle = white(S.trackAlpha);
  roundRect(ctx, S.x, S.trackY, S.w, S.trackH, S.trackH / 2);
  ctx.fill();
  if (opts.empty) return;

  var domain = computeScale(opts.bioAge, opts.chronoAge);
  var span = domain.end - domain.start;
  var pos = function(v) { return S.x + ((v - domain.start) / span) * S.w; };

  var lo = Math.min(opts.bioAge, opts.chronoAge);
  var hi = Math.max(opts.bioAge, opts.chronoAge);
  ctx.fillStyle = tone.accent;
  roundRect(ctx, pos(lo) - S.fillOverhang, S.fillY,
    (pos(hi) - pos(lo)) + S.fillOverhang * 2, S.fillH, S.fillH / 2);
  ctx.fill();

  for (var i = 0; i < domain.ticks.length; i++) {
    var tx = pos(domain.ticks[i]);
    ctx.fillStyle = white(S.tick.stemAlpha);
    ctx.fillRect(tx - 0.5, S.tick.stemTop, 1, S.tick.stemH);
    ctx.fillStyle = white(S.tick.labelAlpha);
    ctx.font = font(400, S.tick.size, MONO);
    drawTracked(ctx, String(domain.ticks[i]), tx, S.tick.labelMidY, 0, 'center');
  }

  // Biological marker, above the track. Value and label are clamped as a pair,
  // by the wider of the two, so they stay aligned with each other.
  var bx = pos(opts.bioAge);
  var bioValue = String(opts.bioAge);
  var bioLabel = opts.bioLabel.toUpperCase();
  ctx.font = font(700, S.bio.valueSize, SANS);
  var bioW = measureTracked(ctx, bioValue, 0);
  ctx.font = font(400, S.bio.labelSize, MONO);
  bioW = Math.max(bioW, measureTracked(ctx, bioLabel, S.labelTracking));
  var bText = clampCenter(bx, bioW);

  ctx.fillStyle = tone.accent;
  ctx.font = font(700, S.bio.valueSize, SANS);
  drawTracked(ctx, bioValue, bText, S.bio.valueMidY, 0, 'center');
  ctx.font = font(400, S.bio.labelSize, MONO);
  drawTracked(ctx, bioLabel, bText, S.bio.labelMidY, S.labelTracking, 'center');
  roundRect(ctx, bx - 1, S.bio.stemTop, 2, S.bio.stemH, 1);
  ctx.fill();

  // Chronological marker, below the track. The reference design hides this when
  // the two ages are within 4% of each other, but that rule is inherited from a
  // layout where both labels sat on the same side: here the bio marker occupies
  // the band above the track and this one the band below, so they cannot
  // overlap at any x. Hiding it only ever cost the card half its comparison.
  var cx = pos(opts.chronoAge);
  var chronoValue = String(opts.chronoAge);
  var chronoLabel = opts.chronoLabel.toUpperCase();
  ctx.font = font(700, S.chrono.valueSize, SANS);
  var chronoW = measureTracked(ctx, chronoValue, 0);
  ctx.font = font(400, S.chrono.labelSize, MONO);
  chronoW = Math.max(chronoW, measureTracked(ctx, chronoLabel, S.labelTracking));
  var cText = clampCenter(cx, chronoW);

  ctx.fillStyle = white(S.chrono.alpha);
  roundRect(ctx, cx - 1, S.chrono.stemTop, 2, S.chrono.stemH, 1);
  ctx.fill();
  ctx.font = font(400, S.chrono.labelSize, MONO);
  drawTracked(ctx, chronoLabel, cText, S.chrono.labelMidY, S.labelTracking, 'center');
  ctx.fillStyle = '#ffffff';
  ctx.font = font(700, S.chrono.valueSize, SANS);
  drawTracked(ctx, chronoValue, cText, S.chrono.valueMidY, 0, 'center');
}

function drawFoot(ctx, ctaText, urlText) {
  var F = LAYOUT.foot;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  ctx.font = font(400, F.size, MONO);
  var ctaW = ctx.measureText(ctaText).width;
  ctx.font = font(700, F.size, MONO);
  var urlW = ctx.measureText(urlText).width;

  var x = (CARD_SIZE - (ctaW + F.gap + urlW)) / 2;
  ctx.fillStyle = white(F.ctaAlpha);
  ctx.font = font(400, F.size, MONO);
  ctx.fillText(ctaText, x, F.midY);
  ctx.fillStyle = '#ffffff';
  ctx.font = font(700, F.size, MONO);
  ctx.fillText(urlText, x + ctaW + F.gap, F.midY);
}

// --- Public entry point ------------------------------------------------------

// Render into `canvas`. `opts`:
//   bioAge, chronoAge  — numbers (ignored when empty)
//   empty              — true for the pre-result card: full chrome, no figure
//   scale              — device pixels per CSS pixel (default 2)
//   strings            — { eyebrow, suffixLines[], pill, bioLabel, chronoLabel,
//                          cta, url }
// Resolves once the card is on the canvas.
function renderShareCard(canvas, opts) {
  return Promise.all([loadCardFonts(), loadLogo()]).then(function(res) {
    var logo = res[1];
    var scale = opts.scale || 2;

    canvas.width = CARD_SIZE * scale;
    canvas.height = CARD_SIZE * scale;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, CARD_SIZE, CARD_SIZE);

    var s = opts.strings;
    var tone = TONES[opts.empty ? 'ontrack'
      : toneFor(opts.bioAge - opts.chronoAge)];

    drawBackground(ctx, tone);
    drawTopRow(ctx, tone, logo, s.eyebrow);
    drawHero(ctx, tone, {
      empty: opts.empty, bioAge: opts.bioAge,
      suffixLines: s.suffixLines, pillText: s.pill
    });
    drawScale(ctx, tone, {
      empty: opts.empty, bioAge: opts.bioAge, chronoAge: opts.chronoAge,
      bioLabel: s.bioLabel, chronoLabel: s.chronoLabel
    });
    drawFoot(ctx, s.cta, s.url);
    return canvas;
  });
}
