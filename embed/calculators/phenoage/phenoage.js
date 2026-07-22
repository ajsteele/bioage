// Configuration state — populated by loading config files
var testDefs = [];       // from tests.csv: [{test_id, name, canonical_unit}]
var conversions = {};    // from conversions.csv: {test_id: [{unit, to_canonical_factor}]}
var model = null;        // from phenoage.json: full model definition
var defaults = [];       // from defaults.csv: [{age, albumin, creatinine, ...}]
var uncertainties = [];  // from uncertainty.csv: per-age imputation year-SD per marker
var bounds = null;       // from bounds.csv: {accelLow, accelHigh} in years

// Multiplier on the imputation band SD for the displayed range. 1 SD ≈ 68%
// ("probably between X and Y"); the markers are near-independent within age, so
// the band is a quadrature sum of per-marker contributions (see uncertainty.csv).
var IMPUTATION_BAND_Z = 1;

// Below this half-width (years) the range isn't worth showing: the imputed
// markers barely move the result, and rounding the bounds outward would imply
// more spread than there really is. The single number stands on its own.
var IMPUTATION_BAND_MIN = 1;

var anchorUnitsSeparator = ',';
var anchorKeysSeparator = ';';

// --- Internationalisation ---

var strings = {};

function loadStrings(lang) {
  lang = lang || 'en';
  return fetch('strings/' + lang + '.json')
    .then(function(r) { return r.json(); })
    .then(function(data) { strings = data; });
}

/** Look up a translated string by key, with optional positional placeholders {0}, {1}, etc. */
function t(key) {
  var s = strings[key] || key;
  for (var i = 1; i < arguments.length; i++) {
    s = s.split('{' + (i - 1) + '}').join(arguments[i]);
  }
  return s;
}

// Test names are stored sentence-case (e.g. "albumin") so they read naturally
// mid-sentence in joined lists. Use this when one starts a sentence or labels
// a field.
function capitalizeFirst(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Join a list with commas and a final conjunction, e.g.
// ['a','b','c'] -> "a, b, and c". For two items: "a and b". For one: "a".
function joinAndList(items) {
  if (!items || items.length === 0) return '';
  if (items.length === 1) return items[0];
  var conj = t('list_and');
  if (items.length === 2) return items[0] + ' ' + conj + ' ' + items[1];
  return items.slice(0, -1).join(', ') + ', ' + conj + ' ' + items[items.length - 1];
}

// --- Config loading ---

// Split a single CSV line, respecting quoted fields (commas inside quotes are
// preserved as part of the field).
function splitCSVLine(line) {
  return line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
}

function parseCSV(text) {
  var lines = text.trim().split('\n');
  var headers = splitCSVLine(lines[0]).map(function(h) {
    return h.trim().replace(/^"|"$/g, '');
  });
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var values = splitCSVLine(lines[i]);
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ? values[j].trim().replace(/^"|"$/g, '') : '';
    }
    rows.push(row);
  }
  return rows;
}

function loadConfig() {
  return Promise.all([
    fetch('config/tests.csv').then(function(r) { return r.text(); }),
    fetch('config/conversions.csv').then(function(r) { return r.text(); }),
    fetch('config/models/phenoage.json').then(function(r) { return r.json(); }),
    fetch('config/defaults.csv').then(function(r) { return r.text(); }),
    fetch('config/uncertainty.csv').then(function(r) { return r.text(); }),
    fetch('config/bounds.csv').then(function(r) { return r.text(); })
  ]).then(function(results) {
    var testsCSV = results[0];
    var conversionsCSV = results[1];
    model = results[2];
    var defaultsCSV = results[3];
    var uncertaintyCSV = results[4];
    var boundsCSV = results[5];

    // Parse tests
    testDefs = parseCSV(testsCSV);

    // Parse conversions into a lookup: {test_id: [{unit, to_canonical_factor}]}
    conversions = {};
    var convRows = parseCSV(conversionsCSV);
    for (var i = 0; i < convRows.length; i++) {
      var row = convRows[i];
      if (!conversions[row.test_id]) {
        conversions[row.test_id] = [];
      }
      conversions[row.test_id].push({
        unit: row.unit,
        to_canonical_factor: parseFloat(row.to_canonical_factor)
      });
    }

    // Parse defaults into array of {age, test_id: value, ...}
    defaults = parseCSV(defaultsCSV).map(function(row) {
      var parsed = { age: parseFloat(row.age) };
      for (var key in row) {
        if (key !== 'age') parsed[key] = parseFloat(row[key]);
      }
      return parsed;
    }).sort(function(a, b) { return a.age - b.age; });

    // Parse the per-age imputation uncertainty table (same shape as defaults).
    uncertainties = parseCSV(uncertaintyCSV).map(function(row) {
      var parsed = { age: parseFloat(row.age) };
      for (var key in row) {
        if (key !== 'age') parsed[key] = parseFloat(row[key]);
      }
      return parsed;
    }).sort(function(a, b) { return a.age - b.age; });

    // Plausibility bounds for the finished result (one row, in years).
    var boundsRow = parseCSV(boundsCSV)[0];
    if (boundsRow) {
      bounds = {
        accelLow: parseFloat(boundsRow.accel_low),
        accelHigh: parseFloat(boundsRow.accel_high)
      };
    }

    // Build the form input list from the model's biomarkers,
    // enriched with test names from testDefs and available units from conversions
    buildFormTests();
  });
}

// Build the tests array used by the form, derived from model + testDefs + conversions
// Age is excluded — it's calculated from DOB + test date
var formTests = [];

function buildFormTests() {
  formTests = [];
  for (var i = 0; i < model.biomarkers.length; i++) {
    var bm = model.biomarkers[i];
    if (bm.test_id === 'age') continue; // age is calculated, not entered

    var testDef = findTestDef(bm.test_id);
    var testConversions = conversions[bm.test_id];

    var units = [];
    if (testConversions) {
      for (var j = 0; j < testConversions.length; j++) {
        units.push(testConversions[j].unit);
      }
    }

    formTests.push({
      id: bm.test_id,
      name: testDef ? testDef.name : bm.test_id,
      units: units,
      normal_low: testDef && testDef.normal_low !== '' ? parseFloat(testDef.normal_low) : null,
      normal_high: testDef && testDef.normal_high !== '' ? parseFloat(testDef.normal_high) : null,
      plausible_low: testDef && testDef.plausible_low !== '' ? parseFloat(testDef.plausible_low) : null,
      plausible_high: testDef && testDef.plausible_high !== '' ? parseFloat(testDef.plausible_high) : null
    });
  }
}

function findTestDef(test_id) {
  for (var i = 0; i < testDefs.length; i++) {
    if (testDefs[i].test_id === test_id) return testDefs[i];
  }
  return null;
}

// --- Age calculation from DOB + test date ---

function calculateAge(dob, testDate) {
  var ms = testDate.getTime() - dob.getTime();
  return ms / (365.25 * 24 * 60 * 60 * 1000);
}

// Local calendar date as yyyy-mm-dd. Deliberately not toISOString(), which
// converts to UTC and can land on the wrong day either side of midnight.
function toDateString(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function getTodayString() {
  return toDateString(new Date());
}

// Midnight tomorrow: the latest test date accepted, i.e. today plus one day of
// grace for clock skew. Test dates parse to local midnight, so a date of
// tomorrow compares equal to this and passes; the day after does not.
// This is also the test date input's `max`, so the browser's own validation and
// the check in calculateResult agree — set to today, the browser rejected the
// grace day before our own logic ever ran.
function latestAllowedTestDate() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d;
}

// --- Age-stratified defaults (linear interpolation) ---

// Returns the population median value for a given test_id at a given age,
// in canonical units. Linearly interpolates between the ages in defaults.csv.
function getDefaultForAge(age, test_id) {
  if (!defaults || defaults.length === 0) return null;

  // Clamp to the range of ages in the defaults table
  if (age <= defaults[0].age) return defaults[0][test_id];
  if (age >= defaults[defaults.length - 1].age) return defaults[defaults.length - 1][test_id];

  // Find bracketing rows and interpolate
  for (var i = 0; i < defaults.length - 1; i++) {
    if (age >= defaults[i].age && age <= defaults[i + 1].age) {
      var t = (age - defaults[i].age) / (defaults[i + 1].age - defaults[i].age);
      var lo = defaults[i][test_id];
      var hi = defaults[i + 1][test_id];
      if (lo == null || hi == null || isNaN(lo) || isNaN(hi)) return null;
      return lo + t * (hi - lo);
    }
  }
  return null;
}

// Returns the PhenoAge uncertainty (in years, 1 SD) introduced by imputing
// `test_id` with its population default at a given age. Linearly interpolated
// from uncertainty.csv, mirroring getDefaultForAge.
function getUncertaintyForAge(age, test_id) {
  if (!uncertainties || uncertainties.length === 0) return null;
  if (age <= uncertainties[0].age) return uncertainties[0][test_id];
  if (age >= uncertainties[uncertainties.length - 1].age) {
    return uncertainties[uncertainties.length - 1][test_id];
  }
  for (var i = 0; i < uncertainties.length - 1; i++) {
    if (age >= uncertainties[i].age && age <= uncertainties[i + 1].age) {
      var t = (age - uncertainties[i].age) / (uncertainties[i + 1].age - uncertainties[i].age);
      var lo = uncertainties[i][test_id];
      var hi = uncertainties[i + 1][test_id];
      if (lo == null || hi == null || isNaN(lo) || isNaN(hi)) return null;
      return lo + t * (hi - lo);
    }
  }
  return null;
}

// Imputation uncertainty band on the displayed biological age. Because the
// PhenoAge markers are near-independent once you condition on age (mean
// pairwise correlation ≈ 0.04 in NHANES III), the variance contributed by each
// defaulted marker adds, so the total SD is the quadrature sum of the per-marker
// year-SDs from uncertainty.csv. Returns whole-year {low, high} bounds centred
// on phenoAge, or null when nothing was defaulted (an exact result).
function imputationBand(phenoAge, age, defaultedIds) {
  if (!defaultedIds || defaultedIds.length === 0) return null;
  var variance = 0;
  for (var i = 0; i < defaultedIds.length; i++) {
    var sd = getUncertaintyForAge(age, defaultedIds[i]);
    if (sd != null && !isNaN(sd)) variance += sd * sd;
  }
  if (variance <= 0) return null;
  var band = IMPUTATION_BAND_Z * Math.sqrt(variance);
  if (band <= IMPUTATION_BAND_MIN) return null; // within ±1 yr — not worth a range
  return { low: Math.floor(phenoAge - band), high: Math.ceil(phenoAge + band) };
}

// --- Unit conversion engine ---

function findModelBiomarker(test_id) {
  if (!model || !model.biomarkers) return null;
  for (var i = 0; i < model.biomarkers.length; i++) {
    if (model.biomarkers[i].test_id === test_id) return model.biomarkers[i];
  }
  return null;
}

function getConversionFactor(test_id, unit) {
  var testConvs = conversions[test_id];
  if (!testConvs) return null;
  for (var i = 0; i < testConvs.length; i++) {
    if (testConvs[i].unit === unit) return testConvs[i].to_canonical_factor;
  }
  return null;
}

// Convert a user-entered value to its canonical unit.
//
// For most tests this is a simple `value * factor`. The interesting case is
// lymphocytes, which the model wants as a percentage of WBC: when the user
// has selected an absolute-count unit instead, we still need to produce a
// percentage. That cross-test conversion is described once, on the model
// biomarker, as `transform: percentage_of:wbc`. We apply it here whenever the
// user's selected unit doesn't already match the model's canonical unit.
//
// `context` (optional) is a {test_id: canonicalValue} map providing reference
// values for percentage_of transforms; returns null when a needed reference is
// missing or non-positive.
function toCanonical(value, unit, test_id, context) {
  var factor = getConversionFactor(test_id, unit);
  if (factor === null) return value;
  var raw = value * factor;

  var bm = findModelBiomarker(test_id);
  if (bm && bm.transform && bm.transform.indexOf('percentage_of:') === 0 && unit !== bm.unit) {
    // raw is now a count in the same scale as the reference's canonical.
    var refId = bm.transform.substring('percentage_of:'.length);
    var refVal = context && context[refId];
    if (refVal == null || refVal <= 0) return null;
    return raw / refVal * 100;
  }
  return raw;
}

// Inverse of toCanonical: render a canonical value in `targetUnit`. Same
// context contract — returns null if a needed reference is unavailable.
function fromCanonical(value, targetUnit, test_id, context) {
  var factor = getConversionFactor(test_id, targetUnit);
  if (factor === null) return value;

  var bm = findModelBiomarker(test_id);
  if (bm && bm.transform && bm.transform.indexOf('percentage_of:') === 0 && targetUnit !== bm.unit) {
    // canonical value is a percentage; convert back to an absolute count.
    var refId = bm.transform.substring('percentage_of:'.length);
    var refVal = context && context[refId];
    if (refVal == null || refVal <= 0) return null;
    return (value / 100 * refVal) / factor;
  }
  return value / factor;
}

// --- Transforms ---

function applyTransform(value, transform, refValues, transformFloor) {
  if (!transform) return value;

  if (transform === 'log') {
    // Apply floor if specified (e.g. NHANES III CRP detection limit of 0.22 mg/dL)
    if (transformFloor != null && value < transformFloor) {
      value = transformFloor;
    }
    return Math.log(value);
  }

  // Cross-test transforms like `percentage_of:wbc` are handled at the
  // unit-conversion layer (toCanonical/fromCanonical) and are a no-op here.
  return value;
}

// --- Model calculation ---

function calculateMortalityModel(rollingTotal, constants) {
  var gamma = constants.gamma;

  // xb is the model's linear predictor (the weighted biomarker sum + intercept).
  var xb = rollingTotal + constants.intercept;

  // PhenoAge is an exact affine function of xb: the exp/ln of the published
  // mortality-score -> age transform cancel algebraically, leaving
  //   PhenoAge = phenoage_intercept + (ln(-phenoage_log_coeff * k) + xb) / phenoage_divisor
  // where k = (exp(gamma * tmonths) - 1) / gamma. Computing it directly (rather
  // than forming the 120-month mortality score and taking 1 - exp(...)) avoids
  // catastrophic float cancellation for low-risk users and is simpler.
  var k = (Math.exp(gamma * constants.tmonths) - 1) / gamma;
  var bioAge = constants.phenoage_intercept +
    (Math.log(-constants.phenoage_log_coeff * k) + xb) / constants.phenoage_divisor;

  // 12-month mortality risk still needs the Gompertz survival expression.
  var riskOfDeath = 1 - Math.exp(
    -Math.exp(xb) * (Math.exp(gamma * 12) - 1) / gamma
  );

  return { bioAge: bioAge, riskOfDeath: riskOfDeath };
}

// --- URL anchor persistence ---
// Format: #dob=1990-01-15;testdate=2024-03-18;albumin=4.5,g/dL;creatinine=99,µmol/L;...

function extractValuesFromAnchor(url) {
  var anchor = url.split('#')[1];
  if (typeof anchor === 'undefined') return null;

  var parts = anchor.split(anchorKeysSeparator);
  var result = { dob: null, testdate: null, tests: [], isLegacy: false };

  for (var i = 0; i < parts.length; i++) {
    var eqIdx = parts[i].indexOf('=');
    if (eqIdx === -1) continue;
    var key = decodeURIComponent(parts[i].substring(0, eqIdx));
    var rest = parts[i].substring(eqIdx + 1);

    if (key === 'dob') {
      result.dob = decodeURIComponent(rest);
    } else if (key === 'testdate') {
      result.testdate = decodeURIComponent(rest);
    } else if (key === 'age') {
      // Old-format URL had age as a direct value; new format computes it from DOB + test date.
      result.isLegacy = true;
    } else {
      var commaIdx = rest.indexOf(anchorUnitsSeparator);
      var rawValue = commaIdx === -1 ? rest : rest.substring(0, commaIdx);
      var rawUnits = commaIdx === -1 ? '' : rest.substring(commaIdx + 1);
      result.tests.push({
        id: key,
        value: decodeURIComponent(rawValue),
        units: decodeURIComponent(rawUnits)
      });
    }
  }
  return result;
}

function createAnchorFromValues(dob, testdate, formTests, values, units) {
  var url = '#dob=' + encodeURIComponent(dob) +
    anchorKeysSeparator + 'testdate=' + encodeURIComponent(testdate);

  for (var i = 0; i < formTests.length; i++) {
    url += anchorKeysSeparator +
      encodeURIComponent(formTests[i].id) + '=' +
      encodeURIComponent(values[i]) + anchorUnitsSeparator +
      encodeURIComponent(units[i]);
  }
  return url;
}

// The page's own <link rel="canonical"> (see index.html) names the friendly,
// themed page this embed lives inside — not this bare iframe document — so a
// result link built from it lands a visitor somewhere with real chrome around
// it rather than the raw embed. Falls back to this document's own URL (minus
// any existing fragment) if a canonical tag is ever missing.
function resultLinkBaseUrl() {
  var canonical = document.querySelector('link[rel="canonical"]');
  return (canonical && canonical.href) || window.location.href.split('#')[0];
}

// --- Input parsing and validation ---

// Decimal separator for the user's locale (most browsers normalise type="number"
// inputs to '.' in the .value property, but be defensive for older engines and
// for any other input paths that might pass a user-typed string through).
var localeDecimal = (function() {
  try {
    var part = new Intl.NumberFormat().formatToParts(1.1).find(function(p) {
      return p.type === 'decimal';
    });
    return part ? part.value : '.';
  } catch (e) {
    return '.';
  }
})();

function parseInput(value) {
  if (value === '' || value == null) return NaN;
  if (localeDecimal === ',' && typeof value === 'string') {
    value = value.replace(/,/g, '.');
  }
  return Number(value);
}

// --- Notices -----------------------------------------------------------------
// Every user-facing message goes through one of these two constructors, so
// severity and styling can never drift apart again. See the .notice block in
// shared/embed.css. `level` is 'neutral' | 'success' | 'warning' | 'error'.

// Build the class attribute for a notice. `contexts` is an optional array of
// modifier suffixes, e.g. ['field'] or ['headline'].
function noticeClass(level, contexts) {
  var cls = 'notice notice--' + (level || 'neutral');
  if (contexts) {
    for (var i = 0; i < contexts.length; i++) cls += ' notice--' + contexts[i];
  }
  return cls;
}

// A global notice as an HTML string, for the innerHTML-driven result panel.
// `html` is trusted markup (already-escaped values from t() and figure()).
// An optional `title` is rendered as a leading bold label.
function noticeHTML(level, html, opts) {
  opts = opts || {};
  var label = opts.title ? '<strong>' + opts.title + '</strong> ' : '';
  return '<div class="' + noticeClass(level, opts.contexts) + '">' +
    label + html + '</div>';
}

// Field notices are reconciled, not rebuilt. calculateResult() runs on every
// keystroke, so tearing them all down and re-adding them made every alert on the
// page collapse and regrow whenever any value changed. Instead: mark them stale
// up front, let attachFieldNotice revive and update the ones still wanted, then
// sweep whatever is left. A surviving notice keeps its DOM node, so a change of
// severity cross-fades via the CSS transition instead of reflowing.
// Set the gutter glyph for a row.
//   'ok'        — a value the user supplied, in range
//   'estimated' — filled from the population average, not measured
//   'hint'      — a prompt for something missing
//   'warning' / 'error' — faults
//   ''          — clears it
// A tick on an imputed value would claim the user had provided something they
// hadn't, so those get "≈": the row is answered, but only approximately.
var FIELD_GLYPHS = { ok: '✓', estimated: '≈', hint: 'i', warning: '!', error: '!' };

function setFieldState(elementId, state) {
  var el = document.getElementById(elementId);
  var row = el && el.closest('.field');
  var icon = row && row.querySelector('.field-status-icon');
  if (!icon) return;
  icon.textContent = state ? (FIELD_GLYPHS[state] || '') : '';
  icon.className = 'field-status-icon' + (state ? ' field-status-' + state : '');
}

function beginFieldNotices() {
  var icons = document.querySelectorAll('.field-status-icon');
  for (var i = 0; i < icons.length; i++) {
    icons[i].textContent = '';
    icons[i].className = 'field-status-icon';
  }
  var marked = document.querySelectorAll('.input-error, .input-warning');
  for (var i = 0; i < marked.length; i++) {
    marked[i].classList.remove('input-error', 'input-warning',
      'notice--warning', 'notice--error');
    marked[i].removeAttribute('aria-describedby');
    marked[i].removeAttribute('aria-invalid');
  }
  var rows = document.querySelectorAll('.row-flagged');
  for (var i = 0; i < rows.length; i++) {
    rows[i].classList.remove('row-flagged',
      'notice--neutral', 'notice--warning', 'notice--error');
  }
  var notices = document.querySelectorAll('[data-field-notice]');
  for (var i = 0; i < notices.length; i++) {
    notices[i].setAttribute('data-stale', '1');
  }
}

// Remove the notices nothing revived during this pass. They collapse shut on
// the same timing they opened on, rather than blinking out from under a row
// that is still fading — the pair went in as one object and has to leave as one.
function endFieldNotices() {
  var stale = document.querySelectorAll('[data-field-notice][data-stale]');
  for (var i = 0; i < stale.length; i++) {
    var slot = stale[i].closest('.field-notice');
    if (!slot) { stale[i].remove(); continue; }
    // Drop the identifiers first: a notice that reappears for this field while
    // the old one is still closing must not find the dying node and revive it.
    stale[i].removeAttribute('id');
    stale[i].removeAttribute('data-field-notice');
    closeFieldNotice(slot);
  }
}

function closeFieldNotice(slot) {
  if (slot.getAttribute('data-closing')) return;
  slot.setAttribute('data-closing', '1');

  var animated = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
  if (!animated) { slot.remove(); return; }

  slot.classList.remove('field-notice-open');
  var done = false;
  function finish() {
    if (done) return;
    done = true;
    slot.remove();
  }
  slot.addEventListener('transitionend', function(e) {
    if (e.target === slot) finish();
  });
  // Belt and braces: a slot that is display:none or already collapsed fires no
  // transitionend, and a notice that never leaves the DOM would stack up.
  setTimeout(finish, 400);
}

// Attach a notice to a form field, marking the input and wiring ARIA. Every
// field is a .field row on the shared grid, so the notice is a full-width cell
// beneath its own row, tinted to match: the pair reads as one block and there is
// never a message floating free of the input it is about.
//
// `level` is 'neutral' | 'warning' | 'error'. Only the latter two are faults, so
// only they mark the input itself; a neutral notice is a prompt (e.g. "enter
// your date of birth"), which tints its row but leaves the input alone.
function attachFieldNotice(elementId, level, message) {
  var el = document.getElementById(elementId);
  if (!el) return;
  // The notice--* level class carries the severity colours as custom properties;
  // the input and the row pick them up from it rather than redefining them.
  if (level === 'warning' || level === 'error') {
    el.classList.add(level === 'error' ? 'input-error' : 'input-warning',
      'notice--' + level);
    if (level === 'error') el.setAttribute('aria-invalid', 'true');
  }

  setFieldState(elementId, level === 'neutral' ? 'hint' : level);

  var row = el.closest('.field');
  if (row) row.classList.add('row-flagged', 'notice--' + level);
  if (!message) return;

  var noticeId = elementId + '-alert';
  el.setAttribute('aria-describedby', noticeId);

  // Already on screen: update in place rather than replacing the node.
  var existing = document.getElementById(noticeId);
  if (existing) {
    existing.removeAttribute('data-stale');
    existing.className = noticeClass(level, ['field']);
    if (existing.textContent !== message) existing.textContent = message;
    return;
  }

  var p = document.createElement('p');
  p.id = noticeId;
  p.className = noticeClass(level, ['field']);
  p.setAttribute('data-field-notice', '');
  p.textContent = message;

  if (!row) return;
  var slot = document.createElement('div');
  slot.className = 'field-notice notice-collapse';
  slot.appendChild(p);
  row.appendChild(slot);
  // Let it paint collapsed, then open it so the transition runs.
  requestAnimationFrame(function() {
    slot.classList.add('field-notice-open');
  });
}

// --- Range validation ---

// Check a value (in canonical units) against normal and plausible ranges.
// Returns 'ok', 'warning' (outside normal), or 'error' (outside plausible).
function checkRange(canonicalValue, formTest) {
  if (formTest.plausible_low !== null && canonicalValue < formTest.plausible_low) return 'error';
  if (formTest.plausible_high !== null && canonicalValue > formTest.plausible_high) return 'error';
  if (formTest.normal_low !== null && canonicalValue < formTest.normal_low) return 'warning';
  if (formTest.normal_high !== null && canonicalValue > formTest.normal_high) return 'warning';
  return 'ok';
}

// Format a canonical range value in the user's selected display unit.
// Uses fromCanonical so transform-based units (e.g. lymphocyte absolute
// counts) render correctly when the relevant context is supplied.
function formatRangeInUnit(canonicalValue, unitIndex, formTest, context) {
  var unit = formTest.units[unitIndex];
  var displayVal = fromCanonical(canonicalValue, unit, formTest.id, context);
  if (displayVal == null || isNaN(displayVal)) return '?';
  // Use sensible precision: more decimals for small numbers
  if (displayVal < 0.1) return displayVal.toPrecision(2);
  if (displayVal < 10) return displayVal.toFixed(2);
  if (displayVal < 100) return displayVal.toFixed(1);
  return displayVal.toFixed(0);
}

// Format a number to n significant figures, returning a clean string.
// e.g. formatSigFigs(0.1234, 2) => "0.12", formatSigFigs(10.456, 2) => "10"
function formatSigFigs(value, n) {
  if (value === 0) return '0';
  var raw = parseFloat(value.toPrecision(n));
  // Determine decimal places needed to show n sig figs
  var magnitude = Math.floor(Math.log10(Math.abs(value)));
  var decimals = Math.max(0, n - 1 - magnitude);
  return raw.toFixed(decimals);
}

// Is this result outside anything the model produced on a real population?
//
// The bounds in config/bounds.csv come from analysis/generate_bounds.py, which
// scores every complete-case NHANES III participant and rounds the observed
// extremes of PhenoAge acceleration outward with a margin. They are deliberately
// not a percentile cut: a 0.5/99.5 threshold would flag 1% of genuine users, so
// instead a trip here means "no real participant looked remotely like this",
// which in practice means a mistyped value or the wrong units selected.
//
// Note this tests acceleration, not absolute age. A negative PhenoAge is not by
// itself absurd — NHANES III contains genuine values just below zero, and the
// model is only validated on adults anyway.
function isRidiculousResult(acceleration) {
  if (!bounds) return false;
  return acceleration < bounds.accelLow || acceleration > bounds.accelHigh;
}

// --- Main calculation triggered by form input ---

function calculateResult() {
  var shareSection = document.getElementById('shareSection');
  var saveSection = document.getElementById('saveSection');
  var warningsDiv = document.getElementById('resultWarnings');
  beginFieldNotices();
  // Counts blocking problems. Each is shown against its own field, so this is
  // only a gate on whether a result can be produced.
  var errorCount = 0;

  // No result to show: display `html` (if any) and hide the result sections.
  // Every early return in this function ends here, so this is also where the
  // field notices that nothing revived get swept.
  // The share card stays on screen throughout, in its empty state — it is the
  // thing the form is for, so showing what it will become is more use than
  // hiding it until the last field is filled.
  function showNoResult(html) {
    endFieldNotices();
    warningsDiv.innerHTML = html || '';
    showEmptyShareCard();
    if (saveSection) saveSection.style.display = 'none';
  }

  // Read biomarker values and selected units from the form (always, even without DOB)
  var rawValues = [];
  var selectedUnits = [];
  var implausibleNames = [];

  // Pass 1: read raw inputs and validate parseability + positivity.
  for (var i = 0; i < formTests.length; i++) {
    var valueElement = document.getElementById(formTests[i].id);
    var unitsElement = document.getElementById(formTests[i].id + 'Unit');
    rawValues[i] = parseInput(valueElement.value);
    selectedUnits[i] = unitsElement.options[unitsElement.selectedIndex].text;

    if (isNaN(rawValues[i]) && valueElement.value !== '') {
      attachFieldNotice(formTests[i].id, 'error', t('error_invalid_number'));
      errorCount++;
    } else if (!isNaN(rawValues[i])) {
      // Reject zero/negative — but skip if plausible_low allows zero (e.g. CRP "not detectable")
      if (rawValues[i] <= 0 && !(formTests[i].plausible_low !== null && formTests[i].plausible_low <= 0)) {
        attachFieldNotice(formTests[i].id, 'error', t('error_must_be_positive'));
        errorCount++;
      }
    }
  }

  // Pass 2: convert to canonical in form order, building up a context so
  // dependent conversions (e.g. lymphocyte-as-absolute-count needs wbc) can
  // resolve. Form order matches model.biomarkers order, which puts referenced
  // tests before their dependants.
  var canonicalContext = {};
  var canonicalByIndex = [];
  for (var i = 0; i < formTests.length; i++) {
    if (isNaN(rawValues[i])) { canonicalByIndex[i] = NaN; continue; }
    var canon = toCanonical(rawValues[i], selectedUnits[i], formTests[i].id, canonicalContext);
    canonicalByIndex[i] = canon;
    if (canon != null && !isNaN(canon)) {
      canonicalContext[formTests[i].id] = canon;
    }
  }

  // Pass 3: range checks against canonical values. Skip when a dependent
  // conversion couldn't resolve yet (e.g. lymphocyte abs without wbc).
  for (var i = 0; i < formTests.length; i++) {
    if (isNaN(rawValues[i])) continue;
    var canonVal = canonicalByIndex[i];
    if (canonVal == null || isNaN(canonVal)) continue;

    var rangeStatus = checkRange(canonVal, formTests[i]);
    var unitIdx = formTests[i].units.indexOf(selectedUnits[i]);
    if (rangeStatus === 'error') {
      var pLow = formatRangeInUnit(formTests[i].plausible_low, unitIdx, formTests[i], canonicalContext);
      var pHigh = formatRangeInUnit(formTests[i].plausible_high, unitIdx, formTests[i], canonicalContext);
      // Check if the raw value would be plausible in a different unit
      var suggestedUnit = null;
      if (formTests[i].units.length > 1) {
        for (var u = 0; u < formTests[i].units.length; u++) {
          if (u === unitIdx) continue;
          var altCanon = toCanonical(rawValues[i], formTests[i].units[u], formTests[i].id, canonicalContext);
          if (altCanon != null && !isNaN(altCanon) &&
              checkRange(altCanon, formTests[i]) !== 'error') {
            suggestedUnit = formTests[i].units[u];
            break;
          }
        }
      }
      var msg = t('range_implausible',
        capitalizeFirst(formTests[i].name), pLow, pHigh, selectedUnits[i]);
      msg += ' ' + (suggestedUnit ? t('range_suggest_unit', suggestedUnit) : t('range_check'));
      attachFieldNotice(formTests[i].id, 'error', msg);
      implausibleNames.push(formTests[i].name);
    } else if (rangeStatus === 'warning') {
      var nLow = formatRangeInUnit(formTests[i].normal_low, unitIdx, formTests[i], canonicalContext);
      var nHigh = formatRangeInUnit(formTests[i].normal_high, unitIdx, formTests[i], canonicalContext);
      attachFieldNotice(formTests[i].id, 'warning',
        t('range_warning',
          capitalizeFirst(formTests[i].name), nLow, nHigh, selectedUnits[i]));
    } else {
      // Population-average fills are marked as estimates, not as answers.
      var filledInput = document.getElementById(formTests[i].id);
      setFieldState(formTests[i].id,
        filledInput && filledInput.classList.contains('default-value')
          ? 'estimated' : 'ok');
    }
  }

  // Every error here is already shown against its own field, so there is
  // nothing to add at the foot of the form.
  if (errorCount > 0) {
    showNoResult('');
    return;
  }

  // Check all biomarker inputs are filled
  var allFilled = true;
  for (var i = 0; i < rawValues.length; i++) {
    if (isNaN(rawValues[i])) { allFilled = false; break; }
  }

  // Read DOB and test date
  var dobInput = document.getElementById('dob');
  var testdateInput = document.getElementById('testdate');
  var dobVal = dobInput.value;
  var testdateVal = testdateInput.value;
  var hasDates = dobVal && testdateVal;
  var anyFilled = rawValues.some(function(v) { return !isNaN(v); });

  if (!hasDates) {
    // Prompt against whichever date field is empty, so the message sits on the
    // row it is asking about. Neutral while the form is still being filled in;
    // once every biomarker is present the missing date is the only thing left
    // between the user and a result, so it escalates to an error.
    var level = allFilled ? 'error' : 'neutral';
    if (!dobVal) {
      attachFieldNotice('dob', level,
        t(allFilled ? 'dob_prompt_error_dob' : 'dob_prompt'));
    }
    if (!testdateVal) {
      attachFieldNotice('testdate', level,
        t(allFilled ? 'dob_prompt_error_testdate' : 'dob_prompt_testdate'));
    }
    // Nothing typed yet: the empty form speaks for itself, and a prompt to fill
    // it in reads as a reprimand for not having done so instantly.
    showNoResult(!allFilled && anyFilled
      ? noticeHTML('neutral', t('prompt_enter_all_values')) : '');
    return;
  }

  // The legacy-URL note nudges users to enter DOB; once they have, drop it.
  var legacyNote = document.querySelector('.legacy-note');
  if (legacyNote) legacyNote.remove();

  // dobVal/testdateVal are guaranteed non-empty valid yyyy-mm-dd strings here:
  // hasDates checked non-empty above, and native <input type="date"> only ever
  // holds "" or a valid date, never something Date() can't parse.
  var dob = new Date(dobVal + 'T00:00:00');
  var testDate = new Date(testdateVal + 'T00:00:00');

  if (testDate <= dob) {
    attachFieldNotice('testdate', 'error', t('error_test_date_after_dob_detail'));
    errorCount++;
  }
  // A test date in the future makes the calculated age wrong. Allow one day of
  // grace: a device clock that is a few hours slow, or a user in a timezone
  // where it is already tomorrow, can make a legitimate "today" look like the
  // future. Nobody benefits from rejecting a date one day out, and anything
  // beyond that is a real typo.
  if (testDate > latestAllowedTestDate()) {
    attachFieldNotice('testdate', 'error', t('error_test_date_future'));
    errorCount++;
  }

  if (errorCount > 0) {
    showNoResult('');
    return;
  }

  setFieldState('dob', 'ok');
  setFieldState('testdate', 'ok');
  // The dates are now good, so any "enter your dates first" complaint from the
  // defaults button no longer applies.
  clearDefaultsMessage();

  var age = calculateAge(dob, testDate);
  if (age < 0 || age > 150) {
    showNoResult(noticeHTML('error',
      t('error_prefix', t('error_age_out_of_range', age.toFixed(1)))));
    return;
  }

  if (!allFilled) {
    showNoResult(noticeHTML('neutral', t('prompt_enter_all_values')));
    return;
  }

  // Convert all values to canonical (SI) units. We rebuild rather than reuse
  // canonicalContext above so that fillMissingWithDefaults paths and re-entry
  // are robust, and so this stage uses the now-known full input set.
  var canonicalValues = { age: age };
  for (var i = 0; i < formTests.length; i++) {
    var testId = formTests[i].id;
    canonicalValues[testId] = toCanonical(rawValues[i], selectedUnits[i], testId, canonicalValues);
  }

  // Compute the weighted sum using model coefficients
  var rollingTotal = 0;
  for (var i = 0; i < model.biomarkers.length; i++) {
    var bm = model.biomarkers[i];
    var canonicalVal = canonicalValues[bm.test_id];

    // Convert from canonical to the unit the model coefficient expects.
    // (Unit conversion handles cross-test transforms like percentage_of, so
    // applyTransform here is only ever used for log/floor on a single value.)
    var modelVal = (bm.test_id === 'age')
      ? canonicalVal
      : fromCanonical(canonicalVal, bm.unit, bm.test_id, canonicalValues);
    modelVal = applyTransform(modelVal, bm.transform, canonicalValues, bm.transform_floor);

    rollingTotal += modelVal * bm.coefficient;
  }

  // Apply the model formula
  var result;
  if (model.formula === 'mortality_model') {
    result = calculateMortalityModel(rollingTotal, model.constants);
  } else {
    return;
  }

  var phenoAge = result.bioAge;
  var riskOfDeath = result.riskOfDeath;
  var acceleration = phenoAge - age;

  // Display the result
  if (isNaN(phenoAge) || !isFinite(phenoAge)) {
    showNoResult(noticeHTML('error', t('error_calculation_failed')));
    return;
  }

  // 1. Share card (the primary visual result)
  generateShareCard(phenoAge, age);

  // 2. Result explanation — a stack of notices above the share card. The
  // biological age leads, because it is what the user came for; everything else
  // is context for it. Warnings are their own notices at their own severity,
  // rather than coloured text inside a neutral box.

  // Which markers were filled from population defaults?
  var defaultCount = 0;
  var defaultedIds = [];
  for (var i = 0; i < formTests.length; i++) {
    var input = document.getElementById(formTests[i].id);
    if (input && input.classList.contains('default-value')) {
      defaultCount++;
      defaultedIds.push(formTests[i].id);
    }
  }
  var totalTests = formTests.length;

  // Emphasise a figure within the result box.
  function figure(value) {
    return '<strong class="result-figure">' + value + '</strong>';
  }

  // Every figure goes inside a single box, with any warnings stacked below it.
  // One box per sentence turned a single answer into a wall of six alerts.
  var notices = [];
  var lines = [];

  // Biological age — the headline line of the result box. A range when
  // imputation leaves it uncertain, otherwise a point estimate.
  var band = imputationBand(phenoAge, age, defaultedIds);
  var bioageText = (band && band.high > band.low)
    ? t('result_list_bioage_range', figure(band.low), figure(band.high))
    : t('result_list_bioage_point', figure(phenoAge.toFixed(1)));
  lines.push('<p class="result-headline">' + bioageText + '.</p>');

  // Is the result outside anything seen in the NHANES III population? If so it
  // almost certainly reflects a mistyped value or wrong unit, not biology. Say
  // so loudly, but still show the number — it is the user's best clue as to
  // which input is wrong. Where markers were already flagged as implausible,
  // name them here so there is one actionable message rather than two.
  var ridiculous = isRidiculousResult(acceleration);
  if (ridiculous) {
    var culpritText = implausibleNames.length > 0
      ? (implausibleNames.length === 1
          ? t('result_ridiculous_culprit_one', implausibleNames[0])
          : t('result_ridiculous_culprit_many', joinAndList(implausibleNames)))
      : t('result_ridiculous_generic');
    notices.push(noticeHTML('error', culpritText, { title: t('notice_warning_label') }));
  } else if (implausibleNames.length > 0) {
    // Plausible-looking result, but a marker is out of its plausible range.
    notices.push(noticeHTML('error', implausibleNames.length === 1
      ? t('result_implausible_warning_one', implausibleNames[0])
      : t('result_implausible_warning_many', joinAndList(implausibleNames)),
      { title: t('notice_warning_label') }));
  }

  // Imputed markers make the estimate approximate.
  if (defaultCount > 0) {
    var severe = defaultCount >= Math.ceil(totalTests / 3);
    var noteKey = defaultCount === 1 ? 'result_list_approx_one' : 'result_list_approx_many';
    notices.push(noticeHTML(severe ? 'error' : 'warning',
      capitalizeFirst(t(noteKey, defaultCount, totalTests)) + '.'));
  }

  // Chronological age and the comparison with it, as one sentence. Neither
  // direction is tinted: older is a result, not a fault, and tinting younger
  // as "good" implied the reverse for older — which is what made a broken
  // "1067 years older" look like a mild caution rather than the error it was.
  var accelRounded = Math.round(acceleration);
  var chronoFigure = figure(age.toFixed(1));
  var accelText;
  if (accelRounded < -1) {
    accelText = t('result_chrono_accel_younger', chronoFigure, figure(Math.abs(accelRounded)));
  } else if (accelRounded > 1) {
    accelText = t('result_chrono_accel_older', chronoFigure, figure(accelRounded));
  } else {
    accelText = t('result_chrono_accel_ontrack', chronoFigure);
  }

  // Risk of death in the coming year. Use a dedicated "less than 0.1%" phrasing
  // for tiny risks — otherwise a healthy 30-year-old sees "0.0050%", which reads
  // as noise. Follows the chronological-age sentence directly, in the same
  // paragraph, rather than a new line — it is the next clause of the same
  // thought, not a separate point.
  var oneInN = Math.round(parseFloat((1 / riskOfDeath).toPrecision(3))).toLocaleString();
  var riskText;
  if (riskOfDeath * 100 < 0.1) {
    riskText = t('result_list_risk_low', figure(t('result_one_in', oneInN)));
  } else {
    var riskPct = formatSigFigs(riskOfDeath * 100, 2);
    riskText = t('result_list_risk', figure(riskPct + '%'), figure(t('result_one_in', oneInN)));
  }
  lines.push('<p>' + accelText + ' ' + riskText + '</p>');

  endFieldNotices();
  warningsDiv.innerHTML = '<div class="notice-group">' +
    noticeHTML('neutral', lines.join(''), { contexts: ['box'] }) +
    notices.join('') +
    '</div>';

  // 4. Save your result. The panel itself is built once, in createFormElements —
  // rebuilding it here would throw away the user's chosen tab, and their focus
  // with it, on every keystroke.
  if (saveSection) saveSection.style.display = '';
  var linkInput = document.getElementById('resultLink');
  if (linkInput) {
    linkInput.value = resultLinkBaseUrl() + createAnchorFromValues(
      dobVal, testdateVal, formTests, rawValues, selectedUnits);
  }
}

// --- Share card ---
// Canvas export (JPEG blob, download link, Web Share API) and the icon/label
// on the two buttons are shared with every calculator — see card-kit.js's
// CARD_EXPORT, getShareCanvas, downloadCard, shareCard and initShareButtons.

var shareCardFilename = 'my-biological-age.' + CARD_EXPORT.ext;

// The strings the canvas renderer needs, so all the i18n stays on this side and
// share-card.js knows nothing about the string table.
function cardStrings(pillText) {
  return {
    eyebrow: t('card_title'),
    suffixLines: t('card_years_old_biologically').split('\n'),
    pill: pillText,
    bioLabel: t('card_biological_label'),
    chronoLabel: t('card_chronological_label'),
    cta: t('card_cta'),
    url: t('card_url')
  };
}

// The pill on the card, derived from the two figures the card actually prints
// — round(bioAge) and floor(chronoAge) — not from the raw acceleration. Taken
// from the raw value it could disagree with the numbers beside it: a 27.6-year
// biological age against a 26.2-year chronological one prints "28" and "26" but
// an acceleration of 1.4, which rounded to "1 year older" next to a visible gap
// of two.
// Both figures are already whole numbers, so the thresholds below mean the
// smallest gap the pill ever names is two years — a one-year difference reads
// as "Right on track". That is why the strings can be unconditionally plural:
// "1 years older" was a symptom of rounding the raw acceleration here, not a
// missing singular form.
function badgeTextFor(displayedBio, displayedChrono) {
  var diff = displayedBio - displayedChrono;
  if (diff < -1) return t('card_younger', Math.abs(diff));
  if (diff > 1) return t('card_older', diff);
  return t('card_on_track');
}

// `acceleration` is not a parameter: everything the card says about the gap is
// derived from the two figures it prints, so they can never contradict.
function generateShareCard(bioAge, chronAge) {
  var shareSection = document.getElementById('shareSection');
  var canvas = getShareCanvas();
  if (!canvas || !shareSection) return;

  shareSection.style.display = 'block';
  shareSection.classList.remove('share-section-empty');

  var downloadBtn = document.getElementById('downloadImageBtn');
  if (downloadBtn) downloadBtn.disabled = false;
  var imageNote = document.getElementById('shareImageNote');
  if (imageNote) imageNote.textContent = t('share_image_note');

  var roundedBio = Math.round(bioAge);
  var flooredChrono = Math.floor(chronAge);
  var badge = badgeTextFor(roundedBio, flooredChrono);
  shareCardFilename = 'my-biological-age-phenoage-' +
    roundedBio + '-' + flooredChrono + '.' + CARD_EXPORT.ext;
  canvas.setAttribute('aria-label', t('card_aria_label', roundedBio, flooredChrono, badge));

  renderShareCard(canvas, {
    bioAge: roundedBio,
    chronoAge: flooredChrono,
    scale: 2,
    strings: cardStrings(badge)
  });
}

// The card before there is a result: the real chrome, an empty figure. It shows
// what the form is for without inventing a number that could be screenshotted
// and mistaken for one.
function showEmptyShareCard() {
  var shareSection = document.getElementById('shareSection');
  var canvas = getShareCanvas();
  if (!canvas || !shareSection) return;

  shareSection.style.display = 'block';
  shareSection.classList.add('share-section-empty');

  var downloadBtn = document.getElementById('downloadImageBtn');
  if (downloadBtn) downloadBtn.disabled = true;
  var imageNote = document.getElementById('shareImageNote');
  if (imageNote) imageNote.textContent = '';

  canvas.setAttribute('aria-label', t('card_aria_label_empty'));
  renderShareCard(canvas, {
    empty: true,
    scale: 2,
    strings: cardStrings(t('card_empty_pill'))
  });
}

function downloadShareCard() {
  downloadCard(getShareCanvas(), shareCardFilename);
}

function nativeShare() {
  // The URL is built from card_url (the same one printed on the card itself),
  // not hardcoded here, so the two can never drift apart.
  shareCard(getShareCanvas(), shareCardFilename,
    t('share_native_title'), t('share_native_text', 'https://' + t('card_url')));
}

// --- Result link copy / browser save ---

function copyResultLink() {
  var input = document.getElementById('resultLink');
  if (!input) return;
  input.select();
  input.setSelectionRange(0, 99999); // mobile

  var btn = input.nextElementSibling;
  function flashConfirm() {
    if (!btn) return;
    var original = btn.textContent;
    btn.textContent = t('save_copied');
    setTimeout(function() { btn.textContent = original; }, 2000);
  }
  function execCommandFallback() {
    try {
      if (document.execCommand('copy')) flashConfirm();
    } catch (e) { /* nothing more to do */ }
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(input.value).then(flashConfirm, execCommandFallback);
  } else {
    execCommandFallback();
  }
}

function showBrowserSaveConfirm() {
  var btn = document.querySelector('.save-browser-btn');
  if (!btn) return;
  var original = btn.textContent;
  btn.textContent = t('save_to_browser_saved');
  setTimeout(function() { btn.textContent = original; }, 2000);
}

// --- Form generation ---

// One row of the form grid. The date fields and the biomarkers are the same
// shape — a label, a control, and a trailing cell — so they are built by the
// same function and land on the same three columns. The wrapper is
// `display: contents` (see .field in embed.css), which is what lets a row group
// its own cells and its own notice without breaking out of the shared grid.
//
// `aux` is the trailing cell's content: the unit selector for a biomarker, the
// "load from CSV" button on the first date row, nothing at all otherwise.
function createFieldRow(id, labelText, control, aux) {
  var field = document.createElement('div');
  field.className = 'field';

  // Leading gutter: a tick once the row holds a good value, an exclamation when
  // it doesn't. It gives the left edge of the form something to do — the label
  // column is ragged by design, so without this the space beside a short label
  // reads as a hole — and it turns filling the form into visible progress.
  var status = document.createElement('span');
  status.className = 'field-status-icon';
  status.setAttribute('aria-hidden', 'true');
  field.appendChild(status);

  var label = document.createElement('label');
  label.className = 'field-label';
  label.setAttribute('for', id);
  label.textContent = labelText;
  field.appendChild(label);

  var controlCell = document.createElement('div');
  controlCell.className = 'field-control';
  controlCell.appendChild(control);
  field.appendChild(controlCell);

  var auxCell = document.createElement('div');
  auxCell.className = 'field-aux';
  if (aux) auxCell.appendChild(aux);
  field.appendChild(auxCell);

  // Empty by design: it carries the row's tint out to the full width of the
  // embed so a flagged row is a band, not a stub.
  var tail = document.createElement('div');
  tail.className = 'field-tail';
  field.appendChild(tail);

  return field;
}

function createFormElements() {
  var saved = extractValuesFromAnchor(window.location.href);
  var fromStorage = false;

  // Fall back to localStorage if no URL anchor data
  if (!saved || (saved.tests.length === 0 && !saved.dob)) {
    var stored = loadFromLocalStorage();
    if (stored && stored.tests && stored.tests.length > 0) {
      saved = {
        dob: stored.dob,
        testdate: stored.testdate,
        tests: stored.tests,
        isLegacy: false
      };
      fromStorage = true;
    }
  }

  var formDiv = document.getElementById('phenoAgeForm');
  formDiv.innerHTML = '';

  // Storage notice leads the form: it's context for everything below it (why
  // the fields are already filled in), so it needs to be read first, not
  // discovered after scrolling past the whole form.
  if (fromStorage) {
    var storageDiv = document.createElement('div');
    storageDiv.className = noticeClass('neutral', ['muted']);
    storageDiv.id = 'storageNotice';
    storageDiv.innerHTML = t('storage_restored') + ' ' +
      '<a href="#" onclick="clearLocalStorage(); return false;">' + t('storage_clear_link') + '</a>';
    formDiv.appendChild(storageDiv);
  }

  // One grid holds every row — the two dates and all nine biomarkers — so their
  // labels, inputs and units line up on one set of columns instead of two
  // layouts that happen to sit above each other.
  var grid = document.createElement('div');
  grid.className = 'field-grid';

  // CSV upload rides in the trailing cell of the first row: it belongs at the
  // top (you load a file before typing anything) and that cell is otherwise
  // empty on the date rows.
  var csvBtn = document.createElement('button');
  csvBtn.setAttribute('type', 'button');
  csvBtn.className = 'csv-upload';
  csvBtn.textContent = t('save_upload_csv');
  csvBtn.onclick = uploadCSV;

  var dobInput = document.createElement('input');
  dobInput.setAttribute('type', 'date');
  dobInput.setAttribute('id', 'dob');
  dobInput.setAttribute('max', getTodayString());
  dobInput.setAttribute('oninput', 'calculateResult()');
  if (saved && saved.dob) dobInput.value = saved.dob;
  var dobRow = createFieldRow('dob', t('label_dob'), dobInput, csvBtn);
  if (saved && saved.isLegacy) {
    var legacyNote = document.createElement('div');
    legacyNote.className = 'field-notice legacy-note';
    var legacyText = document.createElement('p');
    legacyText.className = noticeClass('warning', ['field']);
    legacyText.textContent = t('legacy_note');
    legacyNote.appendChild(legacyText);
    dobRow.appendChild(legacyNote);
  }
  grid.appendChild(dobRow);

  var testdateInput = document.createElement('input');
  testdateInput.setAttribute('type', 'date');
  testdateInput.setAttribute('id', 'testdate');
  // Derived from latestAllowedTestDate so the browser's own validation and the
  // check in calculateResult agree, grace day included. Set to plain "today"
  // the browser silently rejected the grace day before our logic ever ran.
  testdateInput.setAttribute('max', toDateString(latestAllowedTestDate()));
  testdateInput.setAttribute('oninput', 'calculateResult()');
  testdateInput.value = (saved && saved.testdate) ? saved.testdate : getTodayString();
  var testdateRow = createFieldRow('testdate', t('label_test_date'), testdateInput);
  testdateRow.classList.add('field-group-end');
  grid.appendChild(testdateRow);

  // Where "loaded 9 values from CSV" lands: full width, at the foot of the date
  // group, so it reports on the button above it without displacing a row.
  var csvStatus = document.createElement('div');
  csvStatus.className = 'field-status';
  csvStatus.id = 'csvStatus';
  grid.appendChild(csvStatus);

  var csvFileInput = document.createElement('input');
  csvFileInput.setAttribute('type', 'file');
  csvFileInput.setAttribute('id', 'csvFileInput');
  csvFileInput.setAttribute('accept', '.csv');
  csvFileInput.style.display = 'none';
  csvFileInput.setAttribute('onchange', 'handleCSVUpload(this)');
  formDiv.appendChild(csvFileInput);

  for (var i = 0; i < formTests.length; i++) {
    var input = document.createElement('input');
    // Deliberately type="text", not "number": a number input silently clears
    // itself to "" on invalid entry (pasted text, stray letters), so
    // error_invalid_number could never actually fire. Text plus inputmode
    // still gets the numeric keypad on mobile, and parseInput/Number() do the
    // real validation either way.
    input.setAttribute('type', 'text');
    input.setAttribute('id', formTests[i].id);
    input.setAttribute('inputmode', 'decimal');
    input.setAttribute('placeholder', t('placeholder'));
    input.setAttribute('oninput', 'clearDefaultStyling(this); calculateResult(); updateDefaultsButton()');
    // Restore from anchor — match by test id, not array index
    var savedTest = null;
    if (saved) {
      for (var k = 0; k < saved.tests.length; k++) {
        if (saved.tests[k].id === formTests[i].id) { savedTest = saved.tests[k]; break; }
      }
    }
    if (savedTest) {
      input.setAttribute('value', savedTest.value);
    }

    var select = document.createElement('select');
    select.setAttribute('id', formTests[i].id + 'Unit');
    select.setAttribute('aria-label', t('label_units_for', formTests[i].name));
    select.setAttribute('oninput', 'calculateResult()');
    for (var j = 0; j < formTests[i].units.length; j++) {
      var option = document.createElement('option');
      option.textContent = formTests[i].units[j];
      select.appendChild(option);
      if (savedTest && formTests[i].units[j] === savedTest.units) {
        select.selectedIndex = j;
      }
    }
    if (formTests[i].units.length <= 1) {
      select.disabled = true;
    }

    grid.appendChild(createFieldRow(formTests[i].id,
      capitalizeFirst(formTests[i].name), input, select));
  }

  var form = document.createElement('form');
  form.appendChild(grid);
  formDiv.appendChild(form);

  // Restore default-value styling for fields loaded from localStorage
  if (fromStorage) {
    for (var i = 0; i < formTests.length; i++) {
      var storedTest = null;
      for (var k = 0; k < saved.tests.length; k++) {
        if (saved.tests[k].id === formTests[i].id) { storedTest = saved.tests[k]; break; }
      }
      if (storedTest && storedTest.isDefault) {
        var inp = document.getElementById(formTests[i].id);
        if (inp) inp.classList.add('default-value');
      }
    }
  }

  // "Fill missing with defaults" button
  var defaultsDiv = document.createElement('div');
  defaultsDiv.className = 'defaults-section';
  defaultsDiv.id = 'defaultsSection';
  var defaultsBtn = document.createElement('button');
  defaultsBtn.setAttribute('type', 'button');
  defaultsBtn.id = 'defaultsBtn';
  defaultsBtn.textContent = t('defaults_button');
  defaultsBtn.onclick = fillMissingWithDefaults;
  defaultsDiv.appendChild(defaultsBtn);
  var defaultsNote = document.createElement('p');
  defaultsNote.className = 'defaults-note';
  defaultsNote.textContent = t('defaults_note');
  defaultsDiv.appendChild(defaultsNote);
  formDiv.appendChild(defaultsDiv);

  buildSaveSection();

  // Always run: this is what puts the "enter your date of birth" prompt on its
  // row, and it has to reflect whatever was restored from the URL or storage.
  calculateResult();
  updateDefaultsButton();
}

// --- Save panel --------------------------------------------------------------

// Three ways to keep a result, as a tab set. They are alternatives, not a list
// to work through, and each carries a different privacy caveat — shown one at a
// time so it is read, rather than three competing footnotes none of which is.
// The one thing true of all three goes in the shared intro above the tabs.
var SAVE_TABS = [
  { id: 'link', label: 'save_tab_link', note: 'save_privacy_note' },
  { id: 'csv', label: 'save_tab_csv', note: 'save_csv_note' },
  { id: 'browser', label: 'save_tab_browser', note: 'save_browser_warning' }
];

function buildSaveSection() {
  var saveSection = document.getElementById('saveSection');
  if (!saveSection) return;

  var panel = document.createElement('div');
  panel.className = 'save-section';

  var heading = document.createElement('h3');
  heading.textContent = t('save_section_heading');
  panel.appendChild(heading);

  var intro = document.createElement('p');
  intro.className = 'save-intro';
  intro.textContent = t('save_intro');
  panel.appendChild(intro);

  var tablist = document.createElement('div');
  tablist.className = 'save-tabs';
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', t('save_tablist_label'));
  panel.appendChild(tablist);

  var panels = document.createElement('div');
  panels.className = 'save-panels';
  panel.appendChild(panels);

  for (var i = 0; i < SAVE_TABS.length; i++) {
    var spec = SAVE_TABS[i];
    var selected = i === 0;   // the link leads: it is the canonical artefact

    var tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'save-tab';
    tab.id = 'savetab-' + spec.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'savepanel-' + spec.id);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    // Roving tabindex: one stop for the whole set, then arrow keys within it.
    tab.tabIndex = selected ? 0 : -1;
    tab.textContent = t(spec.label);
    tablist.appendChild(tab);

    var tabPanel = document.createElement('div');
    tabPanel.className = 'save-panel';
    tabPanel.id = 'savepanel-' + spec.id;
    tabPanel.setAttribute('role', 'tabpanel');
    tabPanel.setAttribute('aria-labelledby', tab.id);
    if (!selected) tabPanel.hidden = true;
    tabPanel.appendChild(buildSaveControl(spec.id));

    var note = document.createElement('p');
    note.className = 'save-note';
    note.textContent = t(spec.note);
    tabPanel.appendChild(note);
    panels.appendChild(tabPanel);
  }

  tablist.addEventListener('click', function(e) {
    var tab = e.target.closest('.save-tab');
    if (tab) selectSaveTab(tab.id.replace('savetab-', ''), true);
  });
  tablist.addEventListener('keydown', onSaveTabKeydown);

  saveSection.appendChild(panel);
}

function buildSaveControl(id) {
  var wrap = document.createElement('div');

  if (id === 'link') {
    var label = document.createElement('label');
    label.className = 'save-control-label';
    label.setAttribute('for', 'resultLink');
    label.textContent = t('save_link_label');
    wrap.appendChild(label);

    var row = document.createElement('div');
    row.className = 'save-link-row';
    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'resultLink';
    input.className = 'result-link-input';
    input.readOnly = true;
    input.setAttribute('onclick', 'this.select()');
    row.appendChild(input);
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'save-btn copy-btn';
    copy.textContent = t('save_copy_button');
    copy.onclick = copyResultLink;
    row.appendChild(copy);
    wrap.appendChild(row);
    return wrap;
  }

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'save-btn';
  if (id === 'csv') {
    btn.textContent = t('save_download_csv');
    btn.onclick = downloadCSV;
  } else {
    btn.className += ' save-browser-btn';
    btn.textContent = t('save_to_browser');
    btn.onclick = function() { saveToLocalStorage(); showBrowserSaveConfirm(); };
  }
  wrap.appendChild(btn);
  return wrap;
}

function selectSaveTab(id, focus) {
  var tabs = document.querySelectorAll('.save-tab');
  for (var i = 0; i < tabs.length; i++) {
    var isTarget = tabs[i].id === 'savetab-' + id;
    tabs[i].setAttribute('aria-selected', isTarget ? 'true' : 'false');
    tabs[i].tabIndex = isTarget ? 0 : -1;
    var p = document.getElementById(tabs[i].getAttribute('aria-controls'));
    if (p) p.hidden = !isTarget;
    if (isTarget && focus) tabs[i].focus();
  }
}

function onSaveTabKeydown(e) {
  var keys = { ArrowLeft: -1, ArrowRight: 1, Home: 'first', End: 'last' };
  if (!(e.key in keys)) return;
  e.preventDefault();
  var tabs = [].slice.call(document.querySelectorAll('.save-tab'));
  var current = tabs.indexOf(document.activeElement);
  if (current === -1) current = 0;
  var next;
  if (keys[e.key] === 'first') next = 0;
  else if (keys[e.key] === 'last') next = tabs.length - 1;
  else next = (current + keys[e.key] + tabs.length) % tabs.length;
  selectSaveTab(tabs[next].id.replace('savetab-', ''), true);
}

// --- Fill missing values with age-appropriate population defaults ---

// Both messages this can show ("enter your dates first") are complaints about
// the dates, so they are the caller's to raise and calculateResult's to retract
// — see clearDefaultsMessage, called as soon as the dates are valid. Without
// that the warning sat there contradicting a form the user had since fixed.
function clearDefaultsMessage() {
  var existing = document.querySelector('.defaults-message');
  if (existing) existing.remove();
}

function showDefaultsMessage(text, type) {
  var section = document.getElementById('defaultsSection');
  if (!section) return;
  clearDefaultsMessage();
  var msg = document.createElement('p');
  msg.className = noticeClass(type === 'success' ? 'success' : 'warning', ['field']) +
    ' defaults-message';
  msg.textContent = text;
  section.appendChild(msg);
}

function updateDefaultsButton() {
  var btn = document.getElementById('defaultsBtn');
  if (!btn) return;
  var allFilled = formTests.every(function(t) {
    var input = document.getElementById(t.id);
    return input && input.value !== '';
  });
  btn.disabled = allFilled;
}

function fillMissingWithDefaults() {
  var dobVal = document.getElementById('dob').value;
  var testdateVal = document.getElementById('testdate').value;
  if (!dobVal || !testdateVal) {
    showDefaultsMessage(t('defaults_need_dates'), 'warning');
    return;
  }

  var dob = new Date(dobVal + 'T00:00:00');
  var testDate = new Date(testdateVal + 'T00:00:00');
  if (isNaN(dob.getTime()) || isNaN(testDate.getTime()) || testDate <= dob) {
    showDefaultsMessage(t('defaults_need_valid_dates'), 'warning');
    return;
  }

  var age = calculateAge(dob, testDate);
  var filled = 0;

  for (var i = 0; i < formTests.length; i++) {
    var input = document.getElementById(formTests[i].id);
    if (input.value !== '') continue; // don't overwrite user values

    var canonicalDefault = getDefaultForAge(age, formTests[i].id);
    if (canonicalDefault == null) continue;

    // Defaults from defaults.csv are in canonical units. Switch the unit
    // selector to canonical so the value can be written without conversion —
    // avoids round-trip drift for transforms like lymphocyte-as-absolute-count.
    var testDef = findTestDef(formTests[i].id);
    var canonicalUnit = testDef && testDef.canonical_unit;
    var unitSelect = document.getElementById(formTests[i].id + 'Unit');
    if (canonicalUnit) {
      for (var j = 0; j < unitSelect.options.length; j++) {
        if (unitSelect.options[j].text === canonicalUnit) {
          unitSelect.selectedIndex = j;
          break;
        }
      }
    }

    var rounded;
    if (canonicalDefault < 0.1) rounded = canonicalDefault.toPrecision(2);
    else if (canonicalDefault < 10) rounded = canonicalDefault.toFixed(2);
    else if (canonicalDefault < 100) rounded = canonicalDefault.toFixed(1);
    else rounded = canonicalDefault.toFixed(0);

    input.value = rounded;
    input.classList.add('default-value');
    filled++;
  }

  if (filled > 0) {
    // No success toast here — the result list above the card now states how
    // many values were filled from population averages.
    calculateResult();
  }

  updateDefaultsButton();
}

// Clear default styling when user types in a field
function clearDefaultStyling(input) {
  input.classList.remove('default-value');
}

// --- CSV download ---

function downloadCSV() {
  var dobVal = document.getElementById('dob').value;
  var testdateVal = document.getElementById('testdate').value;

  var lines = ['field,value,unit'];
  lines.push('dob,' + dobVal + ',');
  lines.push('test_date,' + testdateVal + ',');

  for (var i = 0; i < formTests.length; i++) {
    var input = document.getElementById(formTests[i].id);
    var unitSelect = document.getElementById(formTests[i].id + 'Unit');
    var unit = unitSelect.options[unitSelect.selectedIndex].text;
    var value = input.classList.contains('default-value') ? 'auto' : input.value;
    lines.push(formTests[i].id + ',' + value + ',' + unit);
  }

  var blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  var link = document.createElement('a');
  link.download = 'phenoage-' + (testdateVal || 'results') + '.csv';
  link.href = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);
}

function uploadCSV() {
  var input = document.getElementById('csvFileInput');
  if (input) input.click();
}

// Normalise a date string to YYYY-MM-DD for <input type="date">.
// Accepts: YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, DD-MM-YYYY, DD.MM.YYYY
function normaliseDate(str) {
  str = str.trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  var parts;
  if (str.indexOf('/') !== -1) parts = str.split('/');
  else if (str.indexOf('.') !== -1) parts = str.split('.');
  else if (str.indexOf('-') !== -1) parts = str.split('-');
  else return str;

  if (parts.length !== 3) return str;

  var a = parseInt(parts[0], 10);
  var b = parseInt(parts[1], 10);
  var c = parseInt(parts[2], 10);

  // If first part is a 4-digit year: YYYY/MM/DD
  if (a > 99) return pad(a) + '-' + pad(b) + '-' + pad(c);
  // If last part is a 4-digit year: DD/MM/YYYY or MM/DD/YYYY
  if (c > 99) {
    // If first part > 12 it must be the day (DD/MM/YYYY)
    if (a > 12) return pad(c) + '-' + pad(b) + '-' + pad(a);
    // If second part > 12 it must be the day (MM/DD/YYYY)
    if (b > 12) return pad(c) + '-' + pad(a) + '-' + pad(b);
    // Ambiguous (e.g. 01/02/2000) — use browser locale to decide
    // US-style locales put month first; almost everyone else puts day first
    var lang = (navigator.language || navigator.userLanguage || '').toLowerCase();
    var monthFirst = lang === 'en-us' || lang === 'en-ph' || lang === 'en-bz';
    if (monthFirst) return pad(c) + '-' + pad(a) + '-' + pad(b);
    return pad(c) + '-' + pad(b) + '-' + pad(a);
  }
  return str;
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function showCSVMessage(text, isError) {
  var slot = document.getElementById('csvStatus');
  if (!slot) return;
  slot.innerHTML = '';
  var msg = document.createElement('p');
  msg.className = noticeClass(isError ? 'error' : 'success', ['field']);
  msg.textContent = text;
  slot.appendChild(msg);
}

function handleCSVUpload(fileInput) {
  var file = fileInput.files[0];
  if (!file) return;

  var reader = new FileReader();
  reader.onload = function(e) {
    var text = e.target.result;
    // Strip UTF-8 BOM and normalise CRLF/CR line endings (Excel re-saves CSVs as CRLF).
    if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1);
    text = text.replace(/\r\n?/g, '\n');
    var lines = text.split('\n');
    var loaded = 0;

    var unquote = function(s) { return s.trim().replace(/^"|"$/g, ''); };

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#' || line.indexOf('field,') === 0) continue;

      var parts = splitCSVLine(line);
      var field = unquote(parts[0] || '');
      var value = unquote(parts[1] || '');
      var unit = unquote(parts[2] || '');

      if (!field || !value) continue;

      if (field === 'dob' || field === 'test_date') {
        var dateInput = document.getElementById(field === 'dob' ? 'dob' : 'testdate');
        if (dateInput) {
          dateInput.value = normaliseDate(value);
          if (dateInput.value) loaded++;
        }
      } else if (value !== 'auto') {
        // 'auto' marks fields that were filled from population defaults and
        // shouldn't be re-imported as user data.
        var input = document.getElementById(field);
        if (input) {
          input.value = value;
          input.classList.remove('default-value');
          loaded++;
          // Set the matching unit if available
          if (unit) {
            var unitSelect = document.getElementById(field + 'Unit');
            if (unitSelect) {
              for (var j = 0; j < unitSelect.options.length; j++) {
                if (unitSelect.options[j].text === unit) {
                  unitSelect.selectedIndex = j;
                  break;
                }
              }
            }
          }
        }
      }
    }

    if (loaded > 0) {
      showCSVMessage(t('save_upload_success', loaded,
        loaded > 1 ? t('save_upload_success_plural') : t('save_upload_success_singular')), false);
      updateDefaultsButton();
      calculateResult();
    } else {
      showCSVMessage(t('save_upload_no_data'), true);
    }
  };
  reader.readAsText(file);

  // Reset so the same file can be re-uploaded
  fileInput.value = '';
}

// --- localStorage persistence ---

var STORAGE_KEY = 'phenoage_last_entry';

function saveToLocalStorage() {
  try {
    var data = {
      dob: document.getElementById('dob').value,
      testdate: document.getElementById('testdate').value,
      tests: []
    };
    for (var i = 0; i < formTests.length; i++) {
      var input = document.getElementById(formTests[i].id);
      var unitSelect = document.getElementById(formTests[i].id + 'Unit');
      data.tests.push({
        id: formTests[i].id,
        value: input.value,
        units: unitSelect.options[unitSelect.selectedIndex].text,
        isDefault: input.classList.contains('default-value')
      });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    // localStorage may be unavailable (private browsing, etc.)
  }
}

function loadFromLocalStorage() {
  try {
    var json = localStorage.getItem(STORAGE_KEY);
    if (!json) return null;
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function clearLocalStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    var notice = document.getElementById('storageNotice');
    if (notice) notice.textContent = t('storage_cleared');
  } catch (e) {}
}

// --- Startup ---

window.onload = function() {
  loadStrings('en').then(function() {
    return loadConfig();
  }).then(function() {
    createFormElements();
    initShareButtons(t('share_download_image'), t('share_button'));
  }).catch(function() {
    document.getElementById('phenoAgeForm').innerHTML =
      '<p>' + t('error_config_failed') + '</p>';
  });
};
