// PhenoAge result card — canvas renderer.
//
// Draws the 600x600 shareable card described in design_handoff_result_card.
// Canvas rather than DOM-plus-screenshot so the export is exact at any pixel
// ratio, no font data has to be inlined per render, and there is one artefact
// on the page instead of a live card that gets swapped for a PNG.
//
// Generic drawing (colour/text helpers, background, top row, footer, pill,
// photo) lives in shared/card-kit.js, loaded before this file — see that file
// for anything not specific to PhenoAge. EVERY position, size and colour below
// lives in LAYOUT and TONES. The design is expected to keep moving, so tweaks
// should be edits to those two blocks — if you find yourself changing a number
// inside a draw* function, it belongs up here instead. Values were measured
// off the reference render at 600x600; the whole card scales by one factor at
// draw time.

// --- Design tokens -----------------------------------------------------------

// Tone is chosen by diff = round(bioAge) - floor(chronoAge).
// `light` is the gradient's top-left stop: bg mixed 82% with white, precomputed
// rather than colour-mixed at runtime.
var TONES = {
  younger: { bg: '#0f3d31', deep: '#082822', accent: '#5bc198', light: '#2f5a4c' },
  ontrack: { bg: '#16306b', deep: '#0d1f4a', accent: '#6aa3ff', light: '#35497e' },
  older:   { bg: '#5d2a0d', deep: '#3d1a05', accent: '#f3b53b', light: '#764a2c' }
};

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

// --- Card sections -----------------------------------------------------------

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

  var pillW = measurePill(ctx, H.pill, opts.pillText);
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

  drawPill(ctx, H.pill, tone, colX, H.pill.top, opts.pillText, pillW, opts.empty);
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
  var bText = clampCenter(bx, bioW, LAYOUT.pad.side);

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
  var cText = clampCenter(cx, chronoW, LAYOUT.pad.side);

  ctx.fillStyle = white(S.chrono.alpha);
  roundRect(ctx, cx - 1, S.chrono.stemTop, 2, S.chrono.stemH, 1);
  ctx.fill();
  ctx.font = font(400, S.chrono.labelSize, MONO);
  drawTracked(ctx, chronoLabel, cText, S.chrono.labelMidY, S.labelTracking, 'center');
  ctx.fillStyle = '#ffffff';
  ctx.font = font(700, S.chrono.valueSize, SANS);
  drawTracked(ctx, chronoValue, cText, S.chrono.valueMidY, 0, 'center');
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
    drawTopRow(ctx, LAYOUT.eyebrow, LAYOUT.logo, logo, s.eyebrow);
    drawHero(ctx, tone, {
      empty: opts.empty, bioAge: opts.bioAge,
      suffixLines: s.suffixLines, pillText: s.pill
    });
    drawScale(ctx, tone, {
      empty: opts.empty, bioAge: opts.bioAge, chronoAge: opts.chronoAge,
      bioLabel: s.bioLabel, chronoLabel: s.chronoLabel
    });
    drawFoot(ctx, LAYOUT.foot, s.cta, s.url);
    return canvas;
  });
}
