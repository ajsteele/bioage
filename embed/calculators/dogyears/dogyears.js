// --- Internationalisation ---

var strings = {};

function loadStrings(lang) {
  lang = lang || 'en';
  return fetch('strings/' + lang + '.json')
    .then(function(r) { return r.json(); })
    .then(function(data) { strings = data; });
}

function t(key) {
  var s = strings[key] || key;
  for (var i = 1; i < arguments.length; i++) {
    s = s.split('{' + (i - 1) + '}').join(arguments[i]);
  }
  return s;
}

// --- Notices -------------------------------------------------------------
// Same construction as PhenoAge's (see phenoage.js) — every user-facing
// message goes through this so severity and styling can't drift apart. See
// the .notice block in shared/embed.css.

function noticeClass(level, contexts) {
  var cls = 'notice notice--' + (level || 'neutral');
  if (contexts) {
    for (var i = 0; i < contexts.length; i++) cls += ' notice--' + contexts[i];
  }
  return cls;
}

function noticeHTML(level, html, opts) {
  opts = opts || {};
  var label = opts.title ? '<strong>' + opts.title + '</strong> ' : '';
  return '<div class="' + noticeClass(level, opts.contexts) + '">' + label + html + '</div>';
}

// --- Calculation ---

var MIN_DOG_AGE = 2 / 12; // ~2 months, below which the formula gives nonsensical results

function epigeneticHumanAge(dogAge) {
  return 16 * Math.log(dogAge) + 31;
}

function traditionalHumanAge(dogAge) {
  return 7 * dogAge;
}

// A natural phrase for the dog's actual age, e.g. "5 years, 6 months old" or
// "6 months old" — the decimal form used for the formula (5.5) is what drives
// the maths, but nobody describes a dog's age that way out loud.
function formatDogAge(years, months) {
  var parts = [];
  if (years > 0) parts.push(years + ' ' + (years === 1 ? t('unit_year') : t('unit_years')));
  if (months > 0) parts.push(months + ' ' + (months === 1 ? t('unit_month') : t('unit_months')));
  if (parts.length === 0) return '';
  return t('card_age_suffix', parts.join(', '));
}

// --- Form and result ---

function createForm() {
  var form = document.getElementById('dogYearsForm');
  form.innerHTML = '';

  // Title and intro from strings
  document.getElementById('pageTitle').textContent = t('title');
  document.getElementById('pageIntro').textContent = t('intro');

  // "<input> years, <input> months" — an inline sentence rather than two
  // labelled fields stacked with a label above each, which read messily for
  // a form this small. The comma lives in the years label's own text so the
  // row's flex gap doesn't have to special-case the punctuation.
  var row = document.createElement('div');
  row.className = 'age-input-row';

  var yearsInput = document.createElement('input');
  yearsInput.type = 'number';
  yearsInput.id = 'dogYears';
  yearsInput.min = '0';
  yearsInput.max = '30';
  yearsInput.step = '1';
  yearsInput.setAttribute('inputmode', 'numeric');
  yearsInput.oninput = calculateResult;
  var yearsLabel = document.createElement('label');
  yearsLabel.setAttribute('for', 'dogYears');
  yearsLabel.textContent = t('label_years');
  row.appendChild(yearsInput);
  row.appendChild(yearsLabel);

  var monthsInput = document.createElement('input');
  monthsInput.type = 'number';
  monthsInput.id = 'dogMonths';
  monthsInput.min = '0';
  monthsInput.max = '11';
  monthsInput.step = '1';
  monthsInput.setAttribute('inputmode', 'numeric');
  monthsInput.oninput = calculateResult;
  var monthsLabel = document.createElement('label');
  monthsLabel.setAttribute('for', 'dogMonths');
  monthsLabel.textContent = t('label_months');
  row.appendChild(monthsInput);
  row.appendChild(monthsLabel);

  form.appendChild(row);

  // Share section labels
  document.getElementById('shareHeading').textContent = t('share_heading');
  document.getElementById('dogPhotoCircle').setAttribute('aria-label', t('photo_upload_label'));
  document.getElementById('dogNameInput').placeholder = t('name_placeholder');
  document.getElementById('photoRemoveBtn').setAttribute('aria-label', t('photo_remove'));
  document.getElementById('photoAddHintText').textContent = t('photo_add_hint');
  document.getElementById('photoDragHintText').textContent =
    t(primaryPointerIsTouch() ? 'photo_drag_hint_touch' : 'photo_drag_hint_mouse');
  document.getElementById('toneLabel').textContent = t('tone_label');
  initShareButtons(t('share_download'), t('share_button'));

  // About section
  document.getElementById('aboutHeading').textContent = t('about_heading');
  document.getElementById('aboutFormula').innerHTML = t('about_formula');
  document.getElementById('aboutLimitations').textContent = t('about_limitations');
  document.getElementById('aboutCitation').innerHTML = t('about_citation') +
    ' <a href="' + t('about_citation_url') + '">doi:10.1016/j.cels.2020.06.006</a>';
}

var lastHumanAge = null;
var lastDogAgeText = '';

function calculateResult() {
  var resultDiv = document.getElementById('dogYearsResult');
  var yearsVal = document.getElementById('dogYears').value;
  var monthsVal = document.getElementById('dogMonths').value;

  function showError(html) {
    resultDiv.innerHTML = noticeHTML('error', html);
    lastHumanAge = null;
    lastDogAgeText = '';
    showEmptyShareCard();
  }

  // Both empty — clear result
  if (yearsVal === '' && monthsVal === '') {
    resultDiv.innerHTML = '';
    lastHumanAge = null;
    lastDogAgeText = '';
    showEmptyShareCard();
    return;
  }

  var years = yearsVal === '' ? 0 : parseInt(yearsVal, 10);
  var months = monthsVal === '' ? 0 : parseInt(monthsVal, 10);

  if (isNaN(years) || isNaN(months)) return showError(t('error_invalid'));
  if (months < 0 || months > 11) return showError(t('error_months_range'));

  var dogAge = years + months / 12;

  if (dogAge <= 0) return showError(t('error_enter_age'));
  if (dogAge < MIN_DOG_AGE) return showError(t('error_minimum_age'));

  var epiAge = epigeneticHumanAge(dogAge);
  var tradAge = traditionalHumanAge(dogAge);
  var roundedEpi = Math.round(epiAge);

  // Format the dog age for display (e.g. "5" or "2.5")
  var dogAgeDisplay = months === 0
    ? years.toString()
    : dogAge % 1 === 0 ? dogAge.toString() : dogAge.toFixed(1);

  var lines = '<p class="result-headline">' + t('result_heading', roundedEpi) + '</p>' +
    '<p>' + t('result_subheading') + '</p>' +
    '<p>' + t('result_traditional', dogAgeDisplay, Math.round(tradAge)) + '</p>';

  var diff = Math.abs(roundedEpi - Math.round(tradAge));
  if (diff <= 1) {
    lines += '<p>' + t('result_difference_same') + '</p>';
  } else if (epiAge > tradAge) {
    lines += '<p>' + t('result_difference_higher', diff) + '</p>';
  } else {
    lines += '<p>' + t('result_difference_lower', diff) + '</p>';
  }

  resultDiv.innerHTML = '<div class="notice-group">' + noticeHTML('neutral', lines, { contexts: ['box'] }) + '</div>';

  lastHumanAge = roundedEpi;
  lastDogAgeText = formatDogAge(years, months);
  generateShareCard(roundedEpi);
}

// --- Photo: upload, preview and drag-to-reposition ---------------------------
//
// The photo lives directly on the card: dogPhotoCircle, photoRemoveBtn and
// dogNameInput are transparent overlay elements positioned (in
// layoutCardOverlays, below) on top of the same spot share-card.js draws the
// photo circle and name — so there's one circle, not a separate upload box
// plus a preview. Percent-based position and container-query-unit font sizes
// (see dogyears.css) keep the overlays aligned with the card at any
// responsive width without a resize listener.
//
// A photo is cropped to the circle the way CSS `object-fit: cover` would by
// default — fill both dimensions, no letterboxing — and dragging chooses
// which part shows. Scroll (desktop) or pinch (touch) zoom in beyond that
// exact fit, for when cover alone doesn't leave enough of the photo to work
// with (a dog's face taking up a small corner of a wide shot, say).
//
// dogPhotoImg is an off-DOM Image element once a photo is loaded — used by
// card-kit's drawCoverImage for the canvas export, which is the only visual
// copy; there's no separate live DOM preview to keep in sync. Offset is 0-100
// percentages with the same meaning as CSS object-position; zoom is a
// multiplier on top of the exact-cover scale (1 = today's default fit).
// Neither is reset by a zoom/pan gesture itself, only by loading or removing
// a photo, so the position picked survives a stray scroll or a colour change.

// Whether to word the zoom hint as "pinch" or "scroll" — based on the
// device's primary pointer, not touch feature detection: a laptop with a
// touchscreen still has "mouse" as its primary pointer, and should still be
// told to scroll. Checked once at startup rather than kept live, since the
// hint text doesn't need to react to a mouse being plugged into a tablet
// mid-session.
function primaryPointerIsTouch() {
  return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}

var dogPhotoImg = null;
var dogPhotoOffset = { x: 50, y: 50 };
var dogPhotoZoom = 1;
var ZOOM_MIN = 1, ZOOM_MAX = 3;
var dogName = '';
var DRAG_THRESHOLD = 6; // px of pointer movement before a click becomes a drag

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function initPhotoControls() {
  var circle = document.getElementById('dogPhotoCircle');
  var fileInput = document.getElementById('dogPhotoInput');
  var nameInput = document.getElementById('dogNameInput');
  var removeBtn = document.getElementById('photoRemoveBtn');

  fileInput.addEventListener('change', function() {
    var file = fileInput.files[0];
    if (file) loadPhotoFile(file);
    fileInput.value = '';
  });

  circle.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  removeBtn.addEventListener('click', removePhoto);

  nameInput.addEventListener('input', function() {
    dogName = nameInput.value;
    regenerateShareCard();
  });

  initPhotoDrag(circle);
  initToneSwatches();
}

function loadPhotoFile(file) {
  var reader = new FileReader();
  reader.onload = function(e) {
    var img = new Image();
    img.onload = function() {
      dogPhotoImg = img;
      dogPhotoOffset = { x: 50, y: 50 };
      dogPhotoZoom = 1;
      updatePhotoState();
      regenerateShareCard();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function removePhoto() {
  dogPhotoImg = null;
  dogPhotoOffset = { x: 50, y: 50 };
  dogPhotoZoom = 1;
  updatePhotoState();
  regenerateShareCard();
}

function updatePhotoState() {
  var circle = document.getElementById('dogPhotoCircle');
  var removeBtn = document.getElementById('photoRemoveBtn');
  var hasPhoto = !!dogPhotoImg;
  circle.classList.toggle('has-photo', hasPhoto);
  removeBtn.hidden = !hasPhoto;
}

// Pan math mirrors card-kit's drawCoverImage: the offset is where along the
// image's "excess" size (once scaled to cover the circle *and* zoomed in by
// dogPhotoZoom) its origin sits. Dragging moves the image with the pointer,
// so the offset moves the opposite way to the drag. A short single-finger
// drag (under DRAG_THRESHOLD) is treated as a click instead — opens the file
// picker whether or not a photo is already loaded, so the same gesture both
// adds and replaces a photo.
//
// A second finger touching down mid-gesture switches straight from pan to
// pinch-zoom (tracked in `pointers`, keyed by pointerId); lifting back to one
// finger resumes panning from wherever that finger is, rather than ending the
// gesture. Desktop has no pinch, so the wheel handles zoom there instead —
// same dogPhotoZoom, just a different input.
function initPhotoDrag(circle) {
  var pointers = {}; // pointerId -> {x, y}, active touches/pointers on the circle
  var mode = null; // 'drag' | 'pinch' | null
  var moved = false;
  var dragStartX, dragStartY, dragStartOffset, overflowW, overflowH;
  var pinchStartDist, pinchStartZoom;
  var renderScheduled = false;

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(function() {
      renderScheduled = false;
      regenerateShareCard();
    });
  }

  function pointerIds() { return Object.keys(pointers); }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // The pan overflow depends on the circle's current rendered size and the
  // current zoom, so it's recomputed whenever a drag (re)starts rather than
  // cached — cheap, and correct across a resize or a zoom that happened
  // first.
  function computeOverflow() {
    if (!dogPhotoImg) return;
    var rect = circle.getBoundingClientRect();
    var baseScale = Math.max(rect.width / dogPhotoImg.naturalWidth, rect.height / dogPhotoImg.naturalHeight);
    var scale = baseScale * dogPhotoZoom;
    overflowW = dogPhotoImg.naturalWidth * scale - rect.width;
    overflowH = dogPhotoImg.naturalHeight * scale - rect.height;
  }

  function beginDrag(e) {
    mode = 'drag';
    moved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartOffset = { x: dogPhotoOffset.x, y: dogPhotoOffset.y };
    computeOverflow();
  }

  circle.addEventListener('pointerdown', function(e) {
    circle.setPointerCapture(e.pointerId);
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = pointerIds();

    if (ids.length === 1) {
      beginDrag(e);
    } else if (ids.length === 2 && dogPhotoImg) {
      var pts = ids.map(function(id) { return pointers[id]; });
      mode = 'pinch';
      moved = true; // a pinch is never a click-to-add/change
      circle.classList.add('dragging');
      pinchStartDist = dist(pts[0], pts[1]);
      pinchStartZoom = dogPhotoZoom;
    }
  });

  circle.addEventListener('pointermove', function(e) {
    if (!(e.pointerId in pointers)) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = pointerIds();

    if (mode === 'pinch' && ids.length >= 2 && pinchStartDist > 0) {
      var pts = ids.slice(0, 2).map(function(id) { return pointers[id]; });
      dogPhotoZoom = clamp(pinchStartZoom * (dist(pts[0], pts[1]) / pinchStartDist), ZOOM_MIN, ZOOM_MAX);
      scheduleRender();
      return;
    }

    if (mode === 'drag' && dogPhotoImg) {
      var dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
      if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        moved = true;
        circle.classList.add('dragging');
      }
      if (!moved) return;

      var deltaX = overflowW > 0 ? -(dx / overflowW) * 100 : 0;
      var deltaY = overflowH > 0 ? -(dy / overflowH) * 100 : 0;
      dogPhotoOffset = {
        x: clamp(dragStartOffset.x + deltaX, 0, 100),
        y: clamp(dragStartOffset.y + deltaY, 0, 100)
      };
      scheduleRender();
    }
  });

  function endPointer(e, cancelled) {
    delete pointers[e.pointerId];
    if (circle.hasPointerCapture(e.pointerId)) circle.releasePointerCapture(e.pointerId);
    var ids = pointerIds();

    if (ids.length === 1 && mode === 'pinch') {
      // Dropped from two fingers to one — resume as a pan from here instead
      // of ending the gesture.
      var only = pointers[ids[0]];
      beginDrag({ clientX: only.x, clientY: only.y });
      moved = true; // already a real gesture, never a click
      return;
    }
    if (ids.length > 0) return;

    circle.classList.remove('dragging');
    var wasMode = mode;
    mode = null;
    if (cancelled) return; // aborted gesture (e.g. an interrupting scroll) — not a click, not a drag
    if (wasMode === 'drag' && !moved) {
      document.getElementById('dogPhotoInput').click();
    } else if (dogPhotoImg) {
      regenerateShareCard();
    }
  }
  circle.addEventListener('pointerup', function(e) { endPointer(e, false); });
  circle.addEventListener('pointercancel', function(e) { endPointer(e, true); });

  circle.addEventListener('wheel', function(e) {
    if (!dogPhotoImg) return;
    e.preventDefault();
    var factor = Math.exp(-e.deltaY * 0.0015);
    dogPhotoZoom = clamp(dogPhotoZoom * factor, ZOOM_MIN, ZOOM_MAX);
    scheduleRender();
  }, { passive: false });
}

// Position the overlay circle, remove button and name input on top of the
// card at the same spot share-card.js's LAYOUT.photo draws them, expressed as
// percentages of the card so they track its responsive width. Both files
// share the LAYOUT.photo numbers (global, from share-card.js) rather than
// each keeping their own copy, so they can't drift apart.
function layoutCardOverlays() {
  var P = LAYOUT.photo;
  function pct(v) { return (v / CARD_SIZE) * 100 + '%'; }

  var circle = document.getElementById('dogPhotoCircle');
  circle.style.left = pct(P.cx - P.r);
  circle.style.top = pct(P.cy - P.r);
  circle.style.width = pct(P.r * 2);
  circle.style.height = pct(P.r * 2);

  // Inscribed in the top-right corner of the photo's own square bounding box
  // — tangent to its top and right edges — rather than centred on the
  // circle's rim, so it reads as a small corner badge instead of overlapping
  // the photo itself.
  var removeBtn = document.getElementById('photoRemoveBtn');
  var badgeD = P.removeBadge.diameter;
  var boxRight = P.cx + P.r, boxTop = P.cy - P.r;
  removeBtn.style.left = pct(boxRight - badgeD);
  removeBtn.style.top = pct(boxTop);
  removeBtn.style.width = pct(badgeD);
  removeBtn.style.height = pct(badgeD);

  var nameInput = document.getElementById('dogNameInput');
  var N = P.name;
  nameInput.style.left = pct(P.cx - N.boxWidth / 2);
  nameInput.style.top = pct(N.midY - N.boxHeight / 2);
  nameInput.style.width = pct(N.boxWidth);
  nameInput.style.height = pct(N.boxHeight);
}

// --- Card colour ---

var selectedTone = DEFAULT_TONE;
var TONE_KEYS = ['blue', 'pink', 'yellow', 'green', 'grey'];

function initToneSwatches() {
  var container = document.getElementById('toneSwatches');
  container.innerHTML = '';
  TONE_KEYS.forEach(function(key) {
    var tone = TONES[key];
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tone-swatch';
    btn.style.setProperty('--tone-bg', tone.bg);
    btn.style.setProperty('--tone-accent', tone.accent);
    btn.setAttribute('aria-label', t('tone_' + key));
    btn.setAttribute('aria-pressed', key === selectedTone ? 'true' : 'false');
    btn.addEventListener('click', function() {
      selectedTone = key;
      Array.prototype.forEach.call(container.children, function(child, i) {
        child.setAttribute('aria-pressed', TONE_KEYS[i] === key ? 'true' : 'false');
      });
      regenerateShareCard();
    });
    container.appendChild(btn);
  });
}

// --- Share card generation ---
// Canvas export (JPEG blob, download link, Web Share API) and the icon/label
// on the two buttons are shared with every calculator — see card-kit.js's
// CARD_EXPORT, getShareCanvas, downloadCard, shareCard and initShareButtons.

var shareCardFilename = 'my-dog.' + CARD_EXPORT.ext;

// "Good Dog" -> "good-dog", for the download filename. Apostrophes are
// dropped rather than turned into a hyphen ("Bella's" -> "bellas", not
// "bella-s"); accents are folded to their base letter first so a name like
// "Café" still produces "cafe" instead of being emptied out by the
// alphanumeric filter. A name that's entirely symbols/emoji slugifies to
// '' — the caller falls back to the plain filename in that case.
function slugify(str) {
  return str
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cardStrings() {
  return {
    eyebrow: t('card_title'),
    suffix: t('card_suffix'),
    pillLines: t('card_pill').split('\n'),
    cta: t('card_cta'),
    url: t('card_url')
  };
}

function currentPhotoOpts() {
  return dogPhotoImg
    ? { img: dogPhotoImg, offsetX: dogPhotoOffset.x, offsetY: dogPhotoOffset.y, zoom: dogPhotoZoom }
    : null;
}

function renderCard(opts) {
  var canvas = getShareCanvas(layoutCardOverlays);
  if (!canvas) return;
  opts.tone = selectedTone;
  opts.scale = 2;
  opts.strings = cardStrings();
  renderDogShareCard(canvas, opts);
}

function generateShareCard(humanAge) {
  var canvas = getShareCanvas(layoutCardOverlays);
  if (!canvas) return;

  var namePart = dogName ? slugify(dogName) : '';
  shareCardFilename = (namePart || 'my-dog') + '-' + humanAge + '-dog-years.' + CARD_EXPORT.ext;
  var ariaLabel = dogName
    ? t('card_aria_label_named', dogName, humanAge)
    : t('card_aria_label', humanAge);
  canvas.setAttribute('aria-label', ariaLabel);

  renderCard({
    humanAge: humanAge,
    dogAgeText: lastDogAgeText,
    photo: currentPhotoOpts(),
    name: dogName
  });
}

// The card before there is a result: full chrome, a "??" figure, but the
// photo/name overlays stay live so a photo or name entered before the age
// isn't lost or hidden.
function showEmptyShareCard() {
  var canvas = getShareCanvas(layoutCardOverlays);
  if (!canvas) return;
  canvas.setAttribute('aria-label', t('card_aria_label_empty'));
  renderCard({
    empty: true,
    photo: currentPhotoOpts(),
    name: dogName
  });
}

function regenerateShareCard() {
  if (lastHumanAge !== null) generateShareCard(lastHumanAge);
  else showEmptyShareCard();
}

function downloadShareCard() {
  downloadCard(getShareCanvas(layoutCardOverlays), shareCardFilename);
}

function nativeShare() {
  shareCard(getShareCanvas(layoutCardOverlays), shareCardFilename,
    t('share_native_title'), t('share_native_text', lastHumanAge !== null ? lastHumanAge : ''));
}

// --- Startup ---

window.onload = function() {
  loadStrings('en').then(function() {
    createForm();
    initPhotoControls();
    showEmptyShareCard();
  }).catch(function() {
    document.getElementById('dogYearsForm').innerHTML =
      '<p>Error loading calculator. Please try refreshing the page.</p>';
  });
};
