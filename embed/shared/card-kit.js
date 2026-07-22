// Card kit — canvas primitives shared by every calculator's share card.
//
// Anything here is identical across calculators by construction: colour math,
// tracked text, the logo, the background gradient, the top row and footer, the
// pill badge, and drawing a photo "cover"-cropped into a shape. A calculator's
// own share-card.js keeps only what's actually specific to it (its TONES, its
// LAYOUT numbers, its hero/body composition) and calls into these.
//
// Loaded as a plain global-scope script before a calculator's share-card.js —
// no module system, matching the rest of this codebase.

var CARD_SIZE = 600;

var SANS = '"Figtree Card", system-ui, -apple-system, sans-serif';
var MONO = '"JetBrains Mono Card", ui-monospace, "SF Mono", Menlo, monospace';

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

function font(weight, size, family) {
  return weight + ' ' + size + 'px ' + family;
}

// --- Fonts ---------------------------------------------------------------

// Canvas silently falls back to a system font if the face isn't loaded yet, and
// there is no repaint when it arrives — so every draw waits on this. Both card
// faces are variable fonts (one file covers their whole weight range), so
// loading one representative size per weight is enough to make every size a
// calculator later asks for available.
var fontsReady = null;

function loadCardFonts() {
  if (fontsReady) return fontsReady;
  if (!document.fonts || !document.fonts.load) {
    fontsReady = Promise.resolve();
    return fontsReady;
  }
  fontsReady = Promise.all([
    document.fonts.load('600 16px "Figtree Card"'),
    document.fonts.load('700 16px "Figtree Card"'),
    document.fonts.load('400 16px "JetBrains Mono Card"'),
    document.fonts.load('500 16px "JetBrains Mono Card"'),
    document.fonts.load('700 16px "JetBrains Mono Card"')
  ]).catch(function() { /* draw with whatever resolved */ });
  return fontsReady;
}

// --- Logo ------------------------------------------------------------------

// Must be same-origin: a cross-origin image taints the canvas and toBlob throws.
var DEFAULT_LOGO_URL = '../../shared/assets/li-logo-horizontal-white.svg';
var logoPromise = null;

function loadLogo(url) {
  if (logoPromise) return logoPromise;
  logoPromise = new Promise(function(resolve) {
    var img = new Image();
    img.onload = function() { resolve(img); };
    img.onerror = function() { resolve(null); }; // card is still fine without it
    img.src = url || DEFAULT_LOGO_URL;
  });
  return logoPromise;
}

// --- Text helpers ------------------------------------------------------------

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
// either end of a track would otherwise hang its label — which is much wider
// than the marker itself — off the edge of the image. The marker stays at the
// true position; only the text slides.
function clampCenter(x, width, padSide, cardSize) {
  cardSize = cardSize || CARD_SIZE;
  var half = width / 2;
  var min = padSide + half;
  var max = cardSize - padSide - half;
  if (min > max) return cardSize / 2;  // wider than the card: centre it
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

// --- Background --------------------------------------------------------------

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

// `tone` is { bg, deep, light }: the gradient's midpoint, its darkest corner,
// and its lightest stop (typically bg mixed ~80% with white).
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

// --- Top row and footer -------------------------------------------------------

// `eyebrowLayout` = { x, midY, size, weight, tracking, alpha }.
// `logoLayout` = { right, y, w, h, alpha }.
function drawTopRow(ctx, eyebrowLayout, logoLayout, logo, eyebrowText) {
  var L = eyebrowLayout;
  ctx.fillStyle = white(L.alpha);
  ctx.font = font(L.weight, L.size, MONO);
  drawTracked(ctx, eyebrowText.toUpperCase(), L.x, L.midY, L.tracking, 'left');

  if (logo) {
    var G = logoLayout;
    ctx.save();
    ctx.globalAlpha = G.alpha;
    ctx.drawImage(logo, G.right - G.w, G.y, G.w, G.h);
    ctx.restore();
  }
}

// `footLayout` = { midY, size, gap, ctaAlpha }.
function drawFoot(ctx, footLayout, ctaText, urlText) {
  var F = footLayout;
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

// --- Pill badge ----------------------------------------------------------

// `pillLayout` = { padX, dot, dotHalo, dotGap, size, weight, height, ringAlpha }.
function measurePill(ctx, pillLayout, text) {
  var P = pillLayout;
  ctx.font = font(P.weight, P.size, SANS);
  return P.padX + P.dot + P.dotGap + ctx.measureText(text).width + P.padX;
}

function drawPill(ctx, pillLayout, tone, x, top, text, w, empty) {
  var P = pillLayout;
  ctx.save();
  if (empty) ctx.globalAlpha = 0.55;

  roundRect(ctx, x, top, w, P.height, P.height / 2);
  ctx.fillStyle = tone.deep;
  ctx.fill();
  // The 1px ring is an inset stroke, so it sits inside the fill.
  ctx.strokeStyle = rgba(tone.accent, P.ringAlpha);
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, top + 0.5, w - 1, P.height - 1, (P.height - 1) / 2);
  ctx.stroke();

  var midY = top + P.height / 2;
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

// --- Photo ---------------------------------------------------------------

// Draw `img` into the (dx, dy, dw, dh) box the way CSS `object-fit: cover`
// would, offset by `object-position`-style percentages (0,0 = image's
// top-left is pinned to the box's top-left; 50,50 = centred; 100,100 =
// image's bottom-right pinned to the box's bottom-right), then scaled up
// further by `zoom` (default 1 = exactly cover, no more). Same formula the
// browser uses for the offset, so a live CSS preview using the same offsets
// crops identically to the canvas export.
function drawCoverImage(ctx, img, dx, dy, dw, dh, offsetXPct, offsetYPct, zoom) {
  var scale = Math.max(dw / img.naturalWidth, dh / img.naturalHeight) * (zoom || 1);
  var drawW = img.naturalWidth * scale, drawH = img.naturalHeight * scale;
  var overflowW = drawW - dw, overflowH = drawH - dh;
  var sx = dx - overflowW * (offsetXPct / 100);
  var sy = dy - overflowH * (offsetYPct / 100);
  ctx.drawImage(img, sx, sy, drawW, drawH);
}

// --- Exporting the card --------------------------------------------------------
// Every calculator's canvas leaves the page the same two ways: saved as a file,
// or handed to the OS share sheet. Both start from the same blob, so that part
// is shared; a calculator supplies only what's actually its own — which
// element holds the canvas, the filename, and the share-sheet title/text.

// JPEG rather than PNG: these cards are a full-bleed gradient, which PNG can't
// compress — the same card runs over 1MB as a PNG and about a tenth of that at
// this quality, with no visible difference even in a footer's small text. The
// destination is social media, which re-encodes to JPEG regardless, so a PNG
// would be a megabyte spent on an image nobody receives losslessly. Switch to
// { type: 'image/png', quality: undefined, ext: 'png' } for a lossless export.
var CARD_EXPORT = { type: 'image/jpeg', quality: 0.92, ext: 'jpg' };

// The canvas the share card is drawn on, creating it on first call. `onCreate`
// (optional) runs once, right after the canvas is inserted — for a calculator
// that overlays other elements on top of it (e.g. dog years' photo/name
// controls) and needs to position them relative to it.
function getShareCanvas(onCreate) {
  var container = document.getElementById('shareCardContainer');
  if (!container) return null;
  var canvas = container.querySelector('canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'share-card-canvas';
    canvas.setAttribute('role', 'img');
    container.appendChild(canvas);
    if (onCreate) onCreate(canvas);
  }
  return canvas;
}

function cardToBlob(canvas) {
  if (!canvas || !canvas.toBlob) return Promise.resolve(null);
  return new Promise(function(resolve) {
    canvas.toBlob(function(blob) { resolve(blob); }, CARD_EXPORT.type, CARD_EXPORT.quality);
  });
}

function downloadCard(canvas, filename) {
  return cardToBlob(canvas).then(function(blob) {
    if (!blob) return;
    var link = document.createElement('a');
    link.download = filename;
    link.href = URL.createObjectURL(blob);
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

function shareCard(canvas, filename, title, text) {
  if (!navigator.share) return Promise.resolve();
  return cardToBlob(canvas).then(function(blob) {
    if (!blob) return;
    var file = new File([blob], filename, { type: CARD_EXPORT.type });
    return navigator.share({ title: title, text: text, files: [file] }).catch(function() {
      // Share cancelled or failed — nothing more to do.
    });
  });
}

// --- Download/share button chrome ---------------------------------------------
// Icons, not just a label: a bare "Download"/"Share" pair reads as two
// identical grey buttons until read closely. The share icon follows the
// visitor's own platform, so it matches the share sheet it's about to open
// rather than some generic third glyph nobody's OS actually uses.

var SHARE_ICON_DOWNLOAD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 19h16"/></svg>';

// Apple's own share glyph: an upward arrow through the open top of a box.
var SHARE_ICON_APPLE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/>' +
  '<path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';

// Android's long-standing share glyph: three nodes joined by two struts.
var SHARE_ICON_ANDROID =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<circle cx="18" cy="5" r="2.4"/><circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="19" r="2.4"/>' +
  '<path d="M8.1 10.9l7.8-4.4M8.1 13.1l7.8 4.4" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round"/></svg>';

// Neither Apple's nor Android's glyph reads as "share" on a platform that owns
// neither (Windows, desktop Linux) — an arrow escaping a box is the more
// universal convention there.
var SHARE_ICON_GENERIC =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
  '<path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>';

function shareIconMarkup() {
  var ua = navigator.userAgent || '';
  if (/Android/.test(ua)) return SHARE_ICON_ANDROID;
  if (/iPad|iPhone|iPod|Macintosh/.test(ua)) return SHARE_ICON_APPLE;
  return SHARE_ICON_GENERIC;
}

function setShareButtonContent(btn, iconSvg, label) {
  if (!btn) return;
  btn.innerHTML = '<span class="share-btn-icon">' + iconSvg + '</span>' +
    '<span class="share-btn-label">' + label + '</span>';
}

// Wires the icon and label onto the download/share buttons every calculator's
// share section has (see index.html), and reveals the share button only where
// the Web Share API actually exists. Call once, after strings load — the
// buttons' content doesn't depend on the result, so it never needs redoing.
function initShareButtons(downloadLabel, shareLabel) {
  setShareButtonContent(document.getElementById('downloadImageBtn'), SHARE_ICON_DOWNLOAD, downloadLabel);
  var shareBtn = document.getElementById('nativeShareBtn');
  setShareButtonContent(shareBtn, shareIconMarkup(), shareLabel);
  if (shareBtn && navigator.share && navigator.canShare) {
    shareBtn.style.display = '';
  }
}
