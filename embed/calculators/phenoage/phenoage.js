// Configuration state — populated by loading config files
var testDefs = [];       // from tests.csv: [{test_id, name, canonical_unit}]
var conversions = {};    // from conversions.csv: {test_id: [{unit, to_canonical_factor}]}
var model = null;        // from phenoage.json: full model definition
var defaults = [];       // from defaults.csv: [{age, albumin, creatinine, ...}]

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

// --- Config loading ---

function parseCSV(text) {
  var lines = text.trim().split('\n');
  // Split respecting quoted fields (commas inside quotes are preserved)
  function splitCSVLine(line) {
    return line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
  }
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
    fetch('config/defaults.csv').then(function(r) { return r.text(); })
  ]).then(function(results) {
    var testsCSV = results[0];
    var conversionsCSV = results[1];
    model = results[2];
    var defaultsCSV = results[3];

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
    var factors = [];
    if (testConversions) {
      for (var j = 0; j < testConversions.length; j++) {
        units.push(testConversions[j].unit);
        factors.push(testConversions[j].to_canonical_factor);
      }
    }

    formTests.push({
      id: bm.test_id,
      name: testDef ? testDef.name : bm.test_id,
      units: units,
      to_canonical_factors: factors,
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

function getTodayString() {
  var d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
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

// --- Unit conversion engine ---

function toCanonical(value, unit, test_id) {
  var testConvs = conversions[test_id];
  if (!testConvs) return value;
  for (var i = 0; i < testConvs.length; i++) {
    if (testConvs[i].unit === unit) {
      return value * testConvs[i].to_canonical_factor;
    }
  }
  console.warn('No conversion found for ' + test_id + ' unit ' + unit);
  return value;
}

function fromCanonical(value, targetUnit, test_id) {
  var testConvs = conversions[test_id];
  if (!testConvs) return value;
  for (var i = 0; i < testConvs.length; i++) {
    if (testConvs[i].unit === targetUnit) {
      return value / testConvs[i].to_canonical_factor;
    }
  }
  console.warn('No conversion found for ' + test_id + ' unit ' + targetUnit);
  return value;
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

  if (transform.indexOf('percentage_of:') === 0) {
    var refTestId = transform.split(':')[1];
    var refValue = refValues[refTestId];
    if (refValue && refValue !== 0) {
      return (value / refValue) * 100;
    }
    return value;
  }

  console.warn('Unknown transform: ' + transform);
  return value;
}

// --- Model calculation ---

function calculateMortalityModel(rollingTotal, constants) {
  var tmonths = constants.tmonths;
  var gamma = constants.gamma;

  rollingTotal = rollingTotal + constants.intercept;

  var mortalityScore = 1 - Math.exp(
    -Math.exp(rollingTotal) * (Math.exp(gamma * tmonths) - 1) / gamma
  );

  var bioAge = constants.phenoage_intercept +
    Math.log(constants.phenoage_log_coeff * Math.log(1 - mortalityScore)) /
    constants.phenoage_divisor;

  var riskOfDeath = 1 - Math.exp(
    -Math.exp(rollingTotal) * (Math.exp(gamma * 12) - 1) / gamma
  );

  return { bioAge: bioAge, mortalityScore: mortalityScore, riskOfDeath: riskOfDeath };
}

// --- URL anchor persistence ---
// Format: #dob=1990-01-15;testdate=2024-03-18;albumin=4.5,g/dL;creatinine=99,µmol/L;...

function extractValuesFromAnchor(url) {
  var anchor = url.split('#')[1];
  if (typeof anchor === 'undefined') return null;

  var parts = anchor.split(anchorKeysSeparator);
  var result = { dob: null, testdate: null, tests: [], isLegacy: false };

  for (var i = 0; i < parts.length; i++) {
    var keyVal = parts[i].split(/[=,]/);
    var key = decodeURIComponent(keyVal[0]);

    if (key === 'dob') {
      result.dob = decodeURIComponent(keyVal[1]);
    } else if (key === 'testdate') {
      result.testdate = decodeURIComponent(keyVal[1]);
    } else if (key === 'age') {
      // Old-format URL had age as a direct value; new format computes it from DOB + test date.
      result.isLegacy = true;
    } else {
      result.tests.push({
        id: key,
        value: decodeURIComponent(keyVal[1]),
        units: decodeURIComponent(keyVal[2])
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

// --- Input parsing and validation ---

function parseInput(value) {
  if (value === '') {
    return NaN;
  } else {
    return Number(value);
  }
}

function clearInputErrors() {
  var errors = document.querySelectorAll('.errorNaN, .input-error, .input-warning');
  for (var i = 0; i < errors.length; i++) {
    errors[i].classList.remove('errorNaN', 'input-error', 'input-warning');
  }
  var msgs = document.querySelectorAll('.error-message, .range-alert');
  for (var i = 0; i < msgs.length; i++) {
    msgs[i].remove();
  }
}

function markInputError(elementId, message) {
  var el = document.getElementById(elementId);
  if (el) el.classList.add('errorNaN');
  if (message) {
    var msg = document.createElement('span');
    msg.className = 'error-message';
    msg.textContent = ' ' + message;
    if (el && el.parentNode) el.parentNode.appendChild(msg);
  }
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

// Format a canonical range value in the user's selected display unit
function formatRangeInUnit(canonicalValue, unitIndex, formTest) {
  var factor = formTest.to_canonical_factors[unitIndex];
  var displayVal = canonicalValue / factor;
  // Use sensible precision: more decimals for small numbers
  if (displayVal < 0.1) return displayVal.toPrecision(2);
  if (displayVal < 10) return displayVal.toFixed(2);
  if (displayVal < 100) return displayVal.toFixed(1);
  return displayVal.toFixed(0);
}

function showRangeAlert(elementId, level, message) {
  var el = document.getElementById(elementId);
  if (!el) return;
  el.classList.add(level === 'error' ? 'input-error' : 'input-warning');
  var row = el.closest('tr');
  if (row) {
    var alert = document.createElement('tr');
    alert.className = 'range-alert';
    var td = document.createElement('td');
    td.setAttribute('colspan', '3');
    var p = document.createElement('p');
    p.className = level === 'error' ? 'input-alert input-alert-error' : 'input-alert';
    p.textContent = message;
    td.appendChild(p);
    alert.appendChild(td);
    row.parentNode.insertBefore(alert, row.nextSibling);
  }
}

// --- Main calculation triggered by form input ---

function calculateResult() {
  console.log('### Calculating! ###');
  var resultField = document.getElementById('phenoAgeResult');
  var shareSection = document.getElementById('shareSection');
  clearInputErrors();
  var errors = [];

  // Read biomarker values and selected units from the form (always, even without DOB)
  var rawValues = [];
  var selectedUnits = [];
  var implausibleNames = [];

  for (var i = 0; i < formTests.length; i++) {
    var valueElement = document.getElementById(formTests[i].id);
    var unitsElement = document.getElementById(formTests[i].id + 'Unit');
    rawValues[i] = parseInput(valueElement.value);
    selectedUnits[i] = unitsElement.options[unitsElement.selectedIndex].text;

    if (isNaN(rawValues[i]) && valueElement.value !== '') {
      markInputError(formTests[i].id);
      errors.push(t('error_invalid_value', formTests[i].name));
    } else if (isNaN(rawValues[i])) {
      // Missing value — not an error per se, just incomplete
    } else {
      // Reject zero/negative — but skip if plausible_low allows zero (e.g. CRP "not detectable")
      if (rawValues[i] <= 0 && !(formTests[i].plausible_low !== null && formTests[i].plausible_low <= 0)) {
        markInputError(formTests[i].id, t('error_must_be_positive'));
        errors.push(t('error_positive_detail', formTests[i].name));
      }

      // Range validation: convert to canonical, check against ranges
      var canonVal = toCanonical(rawValues[i], selectedUnits[i], formTests[i].id);
      var rangeStatus = checkRange(canonVal, formTests[i]);
      var unitIdx = formTests[i].units.indexOf(selectedUnits[i]);
      if (rangeStatus === 'error') {
        var pLow = formatRangeInUnit(formTests[i].plausible_low, unitIdx, formTests[i]);
        var pHigh = formatRangeInUnit(formTests[i].plausible_high, unitIdx, formTests[i]);
        // Check if the raw value would be plausible in a different unit
        var suggestedUnit = null;
        if (formTests[i].units.length > 1) {
          for (var u = 0; u < formTests[i].units.length; u++) {
            if (u === unitIdx) continue;
            var altCanon = rawValues[i] * formTests[i].to_canonical_factors[u];
            if (checkRange(altCanon, formTests[i]) !== 'error') {
              suggestedUnit = formTests[i].units[u];
              break;
            }
          }
        }
        var msg = t('range_implausible', selectedUnits[i], pLow, pHigh);
        if (suggestedUnit) {
          msg += ' ' + t('range_suggest_unit', suggestedUnit);
        }
        showRangeAlert(formTests[i].id, 'error', msg);
        implausibleNames.push(formTests[i].name);
      } else if (rangeStatus === 'warning') {
        var nLow = formatRangeInUnit(formTests[i].normal_low, unitIdx, formTests[i]);
        var nHigh = formatRangeInUnit(formTests[i].normal_high, unitIdx, formTests[i]);
        showRangeAlert(formTests[i].id, 'warning',
          t('range_warning', nLow, nHigh, selectedUnits[i]));
      }
    }
  }

  if (errors.length > 0) {
    resultField.innerHTML = '<p>' + t('error_prefix', errors.join('; ')) + '</p>';
    if (shareSection) shareSection.style.display = 'none';
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
  var dobPrompt = document.getElementById('dobPrompt');
  var hasDates = dobVal && testdateVal;

  if (!hasDates) {
    // Show DOB prompt — escalate to error style if all biomarker values are filled
    if (dobPrompt) {
      dobPrompt.style.display = '';
      if (allFilled) {
        dobPrompt.className = 'dob-prompt dob-prompt-error';
        dobPrompt.textContent = t('dob_prompt_error',
          !testdateVal ? t('dob_prompt_error_and_test_date') : '');
      } else {
        dobPrompt.className = 'dob-prompt';
        dobPrompt.textContent = t('dob_prompt');
      }
    }
    if (!allFilled) {
      resultField.innerHTML = '<p>' + t('prompt_enter_all_values') + '</p>';
    } else {
      resultField.innerHTML = '';
    }
    if (shareSection) shareSection.style.display = 'none';
    return;
  }

  // Hide DOB prompt once dates are present
  if (dobPrompt) dobPrompt.style.display = 'none';

  var dob = new Date(dobVal + 'T00:00:00');
  var testDate = new Date(testdateVal + 'T00:00:00');

  if (isNaN(dob.getTime())) {
    markInputError('dob', t('error_invalid_date'));
    errors.push(t('error_invalid_value', t('label_dob')));
  }
  if (isNaN(testDate.getTime())) {
    markInputError('testdate', t('error_invalid_date'));
    errors.push(t('error_invalid_value', t('label_test_date')));
  }
  if (!isNaN(dob.getTime()) && !isNaN(testDate.getTime()) && testDate <= dob) {
    markInputError('testdate', t('error_test_date_after_dob'));
    errors.push(t('error_test_date_after_dob_detail'));
  }

  if (errors.length > 0) {
    resultField.innerHTML = '<p>' + t('error_prefix', errors.join('; ')) + '</p>';
    if (shareSection) shareSection.style.display = 'none';
    return;
  }

  var age = calculateAge(dob, testDate);
  if (age < 0 || age > 150) {
    resultField.innerHTML = '<p>' + t('error_prefix', t('error_age_out_of_range', age.toFixed(1))) + '</p>';
    if (shareSection) shareSection.style.display = 'none';
    return;
  }

  if (!allFilled) {
    resultField.innerHTML = '<p>' + t('prompt_enter_all_values') + '</p>';
    if (shareSection) shareSection.style.display = 'none';
    return;
  }

  // Convert all values to canonical (SI) units
  var canonicalValues = {};
  canonicalValues['age'] = age;
  for (var i = 0; i < formTests.length; i++) {
    var testId = formTests[i].id;
    canonicalValues[testId] = toCanonical(rawValues[i], selectedUnits[i], testId);
  }

  // Compute the weighted sum using model coefficients
  var rollingTotal = 0;
  for (var i = 0; i < model.biomarkers.length; i++) {
    var bm = model.biomarkers[i];
    var canonicalVal = canonicalValues[bm.test_id];

    // Convert from canonical to the unit the model coefficient expects
    var modelVal;
    if (bm.test_id === 'age') {
      modelVal = canonicalVal;
    } else {
      modelVal = fromCanonical(canonicalVal, bm.unit, bm.test_id);
    }

    // Handle transforms
    var modelRefValues = {};
    if (bm.transform && bm.transform.indexOf('percentage_of:') === 0) {
      var refId = bm.transform.split(':')[1];
      var refBm = null;
      for (var j = 0; j < model.biomarkers.length; j++) {
        if (model.biomarkers[j].test_id === refId) { refBm = model.biomarkers[j]; break; }
      }
      // Find which form index corresponds to this biomarker
      var formIdx = -1;
      for (var j = 0; j < formTests.length; j++) {
        if (formTests[j].id === bm.test_id) { formIdx = j; break; }
      }
      if (refBm && formIdx >= 0 && selectedUnits[formIdx] !== '%') {
        var refModelVal = fromCanonical(canonicalValues[refId], refBm.unit, refId);
        modelRefValues[refId] = refModelVal;
        modelVal = applyTransform(modelVal, bm.transform, modelRefValues, bm.transform_floor);
      }
    } else {
      modelVal = applyTransform(modelVal, bm.transform, {}, bm.transform_floor);
    }

    console.log(bm.test_id + ': ' +
      (bm.test_id === 'age' ? age.toFixed(2) + ' years' : rawValues[formTests.findIndex(function(t) { return t.id === bm.test_id; })] + ' ' + selectedUnits[formTests.findIndex(function(t) { return t.id === bm.test_id; })]) +
      ' → model (' + bm.unit + ') ' + modelVal +
      ' × ' + bm.coefficient + ' = ' + (modelVal * bm.coefficient));

    rollingTotal += modelVal * bm.coefficient;
  }

  // Apply the model formula
  var result;
  if (model.formula === 'mortality_model') {
    result = calculateMortalityModel(rollingTotal, model.constants);
  } else {
    console.error('Unknown model formula: ' + model.formula);
    return;
  }

  var phenoAge = result.bioAge;
  var riskOfDeath = result.riskOfDeath;
  var acceleration = phenoAge - age;

  // Display the result
  if (isNaN(phenoAge) || !isFinite(phenoAge)) {
    resultField.innerHTML = '<p>' + t('error_calculation_failed') + '</p>';
    if (shareSection) shareSection.style.display = 'none';
    return;
  }

  var accelStr = (acceleration >= 0 ? '+' : '') + acceleration.toFixed(2);

  // 1. Main result line
  resultField.innerHTML = '<p class="result"><strong>' + t('result_heading') + '</strong> ' +
    t('result_detail', phenoAge.toFixed(2), accelStr) + '</p>';

  // 2. Share card (image + sharing buttons) — shown first below the result
  generateShareCard(phenoAge, age, acceleration);

  // 3. Additional details
  resultField.innerHTML += '<p>' + t('result_chronological_age', age.toFixed(1)) + '</p>';
  resultField.innerHTML += '<p>' + t('result_risk_of_death',
    (riskOfDeath * 100).toFixed(2),
    parseFloat((1 / riskOfDeath).toPrecision(2))) + '</p>';

  // Note if any values are population defaults — graduated warning
  var defaultCount = 0;
  for (var i = 0; i < formTests.length; i++) {
    var input = document.getElementById(formTests[i].id);
    if (input && input.classList.contains('default-value')) defaultCount++;
  }
  if (defaultCount > 0) {
    var totalTests = formTests.length;
    var warningKey;
    if (defaultCount >= totalTests) {
      warningKey = 'defaults_warning_all';
    } else if (defaultCount >= Math.ceil(totalTests * 2 / 3)) {
      warningKey = 'defaults_warning_extreme';
    } else if (defaultCount >= Math.ceil(totalTests / 3)) {
      warningKey = 'defaults_warning_very';
    } else if (defaultCount === 1) {
      warningKey = 'defaults_warning_one';
    } else {
      warningKey = 'defaults_warning_few';
    }
    var level = (defaultCount >= Math.ceil(totalTests / 3)) ? 'error' : 'warning';
    resultField.innerHTML += '<div class="result-warning' +
      (level === 'error' ? ' result-warning-severe' : '') + '">' +
      t(warningKey, defaultCount, totalTests) + '</div>';
  }

  // Warning if any values look implausible
  if (implausibleNames.length > 0) {
    var warningText = implausibleNames.length === 1
      ? t('result_implausible_warning_one', implausibleNames[0])
      : t('result_implausible_warning_many', implausibleNames.join(', '));
    resultField.innerHTML += '<div class="result-warning"><strong>Warning:</strong> ' +
      warningText + '</div>';
  }

  // 4. Save your result — separate section
  var resultLink = createAnchorFromValues(dobVal, testdateVal, formTests, rawValues, selectedUnits);
  resultField.innerHTML += '<div class="save-section">' +
    '<h3>' + t('save_section_heading') + '</h3>' +
    '<label for="resultLink">' + t('save_link_label') + '</label>' +
    '<div class="save-link-row">' +
      '<input type="text" id="resultLink" class="result-link-input" value="' +
        resultLink.replace(/"/g, '&quot;') + '" readonly onclick="this.select()">' +
      '<button type="button" class="copy-btn" onclick="copyResultLink()">' +
        t('save_copy_button') + '</button>' +
    '</div>' +
    '<p class="save-privacy-note">' + t('save_privacy_note') + '</p>' +

    '<div class="save-option">' +
      '<div class="save-buttons">' +
        '<button type="button" onclick="downloadCSV()" class="csv-download">' +
          t('save_download_csv') + '</button>' +
      '</div>' +
      '<p class="save-option-note">' + t('save_csv_note') + '</p>' +
    '</div>' +

    '<div class="save-option">' +
      '<div class="save-buttons">' +
        '<button type="button" onclick="saveToLocalStorage(); showBrowserSaveConfirm()" class="save-browser-btn">' +
          t('save_to_browser') + '</button>' +
      '</div>' +
      '<p class="save-option-note save-browser-warning">' + t('save_browser_warning') + '</p>' +
    '</div>' +
    '</div>';

}

// --- Share card generation ---

// Cached PNG blob and filename from the most recent card render
var shareCardBlob = null;
var shareCardFilename = 'my-biological-age.png';

function generateShareCard(bioAge, chronAge, acceleration) {
  var shareSection = document.getElementById('shareSection');
  var container = document.getElementById('shareCardContainer');
  if (!container || !shareSection) return;

  shareSection.style.display = 'block';

  // Update share section text from strings
  var shareHeading = document.getElementById('shareHeading');
  if (shareHeading) shareHeading.textContent = t('share_heading');
  var shareNote = document.getElementById('shareNote');
  if (shareNote) shareNote.textContent = t('share_image_note');
  var downloadBtn = document.getElementById('downloadImageBtn');
  if (downloadBtn) downloadBtn.textContent = t('share_download_image');

  // Build the HTML card
  container.innerHTML = generateResultCardHTML(
    bioAge, chronAge, t('card_url'), t('card_methodology')
  );

  // Compute a descriptive filename
  var roundedBio = Math.round(bioAge);
  var flooredChrono = Math.floor(chronAge);
  shareCardFilename = 'my-biological-age-phenoage-' + roundedBio + '-' + flooredChrono + '.png';

  // Generate PNG for right-click saving and download/share buttons
  shareCardBlob = null;
  var cardEl = container.querySelector('.share-card-inner');
  if (cardEl && window.modernScreenshot) {
    modernScreenshot.domToPng(cardEl, { width: 600, height: 600, scale: 2 })
      .then(function(dataUrl) {
        // Convert data URL to a named object URL for right-click "Save image as"
        return fetch(dataUrl).then(function(r) { return r.blob(); });
      })
      .then(function(blob) {
        shareCardBlob = blob;
        var objectUrl = URL.createObjectURL(blob);
        // Wrap image in an <a> with download attribute so right-click uses our filename
        var wrapper = document.getElementById('shareCardImageLink');
        var img = document.getElementById('shareCardImage');
        if (wrapper && img) {
          wrapper.href = objectUrl;
          wrapper.download = shareCardFilename;
          img.src = objectUrl;
          img.alt = t('card_aria_label', roundedBio, flooredChrono, badgeTextFor(acceleration));
          wrapper.style.display = 'block';
          container.style.display = 'none';
        }
      })
      .catch(function(err) {
        console.log('PNG generation failed, HTML card will remain visible:', err);
      });
  }
}

function badgeTextFor(acceleration) {
  var diff = acceleration;
  if (diff < -1) return t('card_younger', Math.abs(Math.round(diff)));
  if (diff > 1) return t('card_older', Math.round(diff));
  return t('card_on_track');
}

function generateResultCardHTML(rawBioAge, rawChronoAge, urlDisplay, methodologyText) {
  var bioAge = Math.round(Number(rawBioAge));
  var chronoAge = Math.floor(Number(rawChronoAge));
  var diff = bioAge - chronoAge;

  var badgeText, theme;
  if (diff < -1) {
    badgeText = t('card_younger', Math.abs(diff));
    theme = { bg: '#125b4a', primary: '#5bc198', badgeBg: '#0d4236' };
  } else if (diff >= -1 && diff <= 1) {
    badgeText = t('card_on_track');
    theme = { bg: '#1e3a8a', primary: '#60a5fa', badgeBg: '#172554' };
  } else {
    badgeText = t('card_older', diff);
    theme = { bg: '#78350f', primary: '#fbbf24', badgeBg: '#451a03' };
  }

  // --- Number line geometry ---
  var minAge = Math.min(bioAge, chronoAge);
  var maxAge = Math.max(bioAge, chronoAge);
  var midPoint = (bioAge + chronoAge) / 2;
  var lowerDecade = Math.floor(minAge / 10) * 10;
  var upperDecade = Math.ceil(maxAge / 10) * 10;
  var radiusToLower = midPoint - lowerDecade;
  var radiusToUpper = upperDecade - midPoint;
  var radius = Math.max(radiusToLower, radiusToUpper, 5);
  radius += 7;
  var span = radius * 2;
  var startVal = midPoint - radius;
  var endVal = midPoint + radius;
  var bioPercent = ((bioAge - startVal) / span) * 100;
  var chronoPercent = ((chronoAge - startVal) / span) * 100;

  // Label collision: if markers are within 4% of each other, stack them
  var labelCollision = Math.abs(bioPercent - chronoPercent) < 4;

  // Decade tick marks (skip if too close to either marker)
  var ticksHTML = '';
  var firstDecade = Math.max(0, Math.ceil(startVal / 10) * 10);
  var lastDecade = Math.floor(endVal / 10) * 10;
  for (var i = firstDecade; i <= lastDecade; i += 10) {
    if (Math.abs(i - bioAge) <= 3 || Math.abs(i - chronoAge) <= 3) continue;
    var tickPercent = ((i - startVal) / span) * 100;
    ticksHTML += '<div style="position:absolute; top:72px; left:' + tickPercent +
      '%; transform:translateX(-50%); text-align:center; z-index:1;">' +
      '<span style="font-size:14px; color:rgba(255,255,255,0.4);">' + i + '</span></div>';
  }

  var highlightLeft = Math.min(bioPercent, chronoPercent);
  var highlightWidth = Math.abs(bioPercent - chronoPercent);

  // Biological marker (above the line)
  var bioMarkerHTML;
  if (labelCollision) {
    // Stacked layout: both labels to one side
    bioMarkerHTML = '<div style="position:absolute; bottom:74px; left:' + bioPercent +
      '%; transform:translateX(-50%); display:flex; flex-direction:column; align-items:center; z-index:10;">' +
      '<span style="font-size:14px; color:' + theme.primary + ';">' + t('card_biological_label') +
      ' ' + bioAge + '</span>' +
      '<span style="font-size:14px; color:rgba(255,255,255,0.7); margin-top:2px;">' +
      t('card_chronological_label') + ' ' + chronoAge + '</span>' +
      '<div style="width:2px; height:10px; background:' + theme.primary + '; margin-top:4px; border-radius:2px;"></div>' +
      '</div>';
  } else {
    bioMarkerHTML = '<div style="position:absolute; bottom:74px; left:' + bioPercent +
      '%; transform:translateX(-50%); display:flex; flex-direction:column; align-items:center; z-index:10;">' +
      '<span style="font-size:14px; color:' + theme.primary + '; margin-bottom:2px;">' +
      t('card_biological_label') + '</span>' +
      '<span style="font-size:20px; color:' + theme.primary + '; font-weight:bold; background:' +
      theme.bg + '; padding:0 6px; line-height:1; border-radius:4px;">' + bioAge + '</span>' +
      '<div style="width:2px; height:10px; background:' + theme.primary + '; margin-top:4px; border-radius:2px;"></div>' +
      '</div>';
  }

  // Chronological marker (below the line) — omit if labels are collapsed
  var chronoMarkerHTML = '';
  if (!labelCollision) {
    chronoMarkerHTML = '<div style="position:absolute; top:64px; left:' + chronoPercent +
      '%; transform:translateX(-50%); display:flex; flex-direction:column; align-items:center; z-index:10;">' +
      '<div style="width:2px; height:10px; background:rgba(255,255,255,0.7); margin-bottom:4px; border-radius:2px;"></div>' +
      '<span style="font-size:20px; color:#ffffff; font-weight:bold; background:' + theme.bg +
      '; padding:0 6px; line-height:1; border-radius:4px;">' + chronoAge + '</span>' +
      '<span style="font-size:14px; color:rgba(255,255,255,0.7); margin-top:2px;">' +
      t('card_chronological_label') + '</span></div>';
  }

  // Build the accessible card — aria-label on the wrapper, number line hidden from SR
  var ariaLabel = t('card_aria_label', bioAge, chronoAge, badgeText);
  var yearsOldLines = t('card_years_old_biologically').split('\n');

  return '<div class="share-card" role="img" aria-label="' + ariaLabel.replace(/"/g, '&quot;') + '">' +
    '<div class="share-card-inner" style="width:600px; height:600px; background-color:' + theme.bg +
    '; color:#ffffff; padding:40px; box-sizing:border-box; display:flex; flex-direction:column;' +
    ' justify-content:space-between; font-family:Inter,system-ui,-apple-system,sans-serif;">' +

    // Header
    '<div style="display:flex; justify-content:space-between; align-items:flex-start; width:100%;">' +
    '<p style="text-transform:uppercase; letter-spacing:2px; font-size:16px; opacity:0.8; margin:0; line-height:1;">' +
    t('card_title') + '</p></div>' +

    // Big number
    '<div style="display:flex; flex-direction:column; align-items:center;">' +
    '<div style="display:flex; align-items:center; gap:15px;">' +
    '<span style="font-size:150px; font-weight:400; color:' + theme.primary +
    '; line-height:0.8; letter-spacing:-4px;">' + bioAge + '</span>' +
    '<span style="font-size:30px; text-align:left; line-height:1.2; font-weight:300;">' +
    yearsOldLines.join('<br>') + '</span></div></div>' +

    // Badge
    '<div style="text-align:center; margin:40px 0 0;">' +
    '<div style="background-color:' + theme.badgeBg +
    '; display:inline-block; padding:10px 35px; border-radius:50px; font-size:26px; color:' +
    theme.primary + '; font-weight:500;">' + badgeText + '</div></div>' +

    // Number line (decorative — hidden from screen readers)
    '<div aria-hidden="true" style="position:relative; height:130px; margin:0 20px;">' +
    '<div style="position:absolute; top:58px; left:0; right:0; height:4px; background:rgba(255,255,255,0.2); border-radius:4px;"></div>' +
    (highlightWidth > 0 ? '<div style="position:absolute; top:56px; left:calc(' + highlightLeft +
      '% - 4px); width:calc(' + highlightWidth + '% + 8px); height:8px; background:' +
      theme.primary + '; border-radius:4px; z-index:2;"></div>' : '') +
    ticksHTML + bioMarkerHTML + chronoMarkerHTML + '</div>' +

    // Footer / CTA
    '<div style="text-align:center;">' +
    '<p style="font-size:18px; opacity:0.7; margin:0; font-weight:300;">' + t('card_cta') + '</p>' +
    '<p style="font-size:28px; font-weight:400; margin:2px 0 6px 0;">' + urlDisplay + '</p>' +
    '<p style="font-size:13px; opacity:0.4; margin:0; font-weight:300;">' +
    methodologyText + '</p></div>' +

    '</div></div>';
}

function downloadShareCard() {
  if (shareCardBlob) {
    var link = document.createElement('a');
    link.download = shareCardFilename;
    link.href = URL.createObjectURL(shareCardBlob);
    link.click();
    URL.revokeObjectURL(link.href);
    return;
  }
  // Fallback: try to generate on the fly
  var container = document.getElementById('shareCardContainer');
  var cardEl = container && container.querySelector('.share-card-inner');
  if (cardEl && window.modernScreenshot) {
    modernScreenshot.domToPng(cardEl, { width: 600, height: 600, scale: 2 })
      .then(function(dataUrl) {
        var link = document.createElement('a');
        link.download = shareCardFilename;
        link.href = dataUrl;
        link.click();
      });
  }
}

function nativeShare() {
  if (!navigator.share) return;
  var blob = shareCardBlob;
  if (!blob) return;
  var file = new File([blob], shareCardFilename, { type: 'image/png' });
  navigator.share({
    title: t('share_native_title'),
    text: t('share_native_text'),
    files: [file]
  }).catch(function(err) {
    console.log('Share cancelled or failed:', err);
  });
}

// --- Result link copy / browser save ---

function copyResultLink() {
  var input = document.getElementById('resultLink');
  if (!input) return;
  input.select();
  input.setSelectionRange(0, 99999); // mobile
  navigator.clipboard.writeText(input.value).then(function() {
    var btn = input.nextElementSibling;
    if (btn) {
      var original = btn.textContent;
      btn.textContent = t('save_copied');
      setTimeout(function() { btn.textContent = original; }, 2000);
    }
  });
}

function showBrowserSaveConfirm() {
  var btn = document.querySelector('.save-browser-btn');
  if (!btn) return;
  var original = btn.textContent;
  btn.textContent = t('save_to_browser_saved');
  setTimeout(function() { btn.textContent = original; }, 2000);
}

// --- Form generation ---

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

  // DOB + Test date section
  var dateSection = document.createElement('div');
  dateSection.className = 'date-section';

  var dobRow = document.createElement('div');
  dobRow.className = 'date-row';
  var dobLabel = document.createElement('label');
  dobLabel.setAttribute('for', 'dob');
  dobLabel.textContent = t('label_dob');
  var dobInput = document.createElement('input');
  dobInput.setAttribute('type', 'date');
  dobInput.setAttribute('id', 'dob');
  dobInput.setAttribute('oninput', 'updateDobPrompt(); calculateResult()');
  if (saved && saved.dob) dobInput.value = saved.dob;
  dobRow.appendChild(dobLabel);
  dobRow.appendChild(dobInput);
  if (saved && saved.isLegacy) {
    var legacyNote = document.createElement('p');
    legacyNote.className = 'input-alert';
    legacyNote.textContent = t('legacy_note');
    dobRow.appendChild(legacyNote);
  }
  dateSection.appendChild(dobRow);

  var testdateRow = document.createElement('div');
  testdateRow.className = 'date-row';
  var testdateLabel = document.createElement('label');
  testdateLabel.setAttribute('for', 'testdate');
  testdateLabel.textContent = t('label_test_date');
  var testdateInput = document.createElement('input');
  testdateInput.setAttribute('type', 'date');
  testdateInput.setAttribute('id', 'testdate');
  testdateInput.setAttribute('oninput', 'calculateResult()');
  if (saved && saved.testdate) {
    testdateInput.value = saved.testdate;
  } else {
    testdateInput.value = getTodayString();
  }
  testdateRow.appendChild(testdateLabel);
  testdateRow.appendChild(testdateInput);
  dateSection.appendChild(testdateRow);

  // CSV upload — available at the top so users can load data before entering values
  var csvRow = document.createElement('div');
  csvRow.className = 'date-row csv-load-row';
  var csvBtn = document.createElement('button');
  csvBtn.setAttribute('type', 'button');
  csvBtn.className = 'csv-upload';
  csvBtn.textContent = t('save_upload_csv');
  csvBtn.onclick = uploadCSV;
  csvRow.appendChild(csvBtn);
  var csvFileInput = document.createElement('input');
  csvFileInput.setAttribute('type', 'file');
  csvFileInput.setAttribute('id', 'csvFileInput');
  csvFileInput.setAttribute('accept', '.csv');
  csvFileInput.style.display = 'none';
  csvFileInput.setAttribute('onchange', 'handleCSVUpload(this)');
  csvRow.appendChild(csvFileInput);
  dateSection.appendChild(csvRow);

  formDiv.appendChild(dateSection);

  // DOB prompt — shown when date of birth is not yet entered
  var dobPrompt = document.createElement('div');
  dobPrompt.className = 'dob-prompt';
  dobPrompt.id = 'dobPrompt';
  dobPrompt.textContent = t('dob_prompt');
  if (saved && saved.dob) dobPrompt.style.display = 'none';
  formDiv.appendChild(dobPrompt);

  // Biomarker inputs table
  var formTable = document.createElement('table');

  for (var i = 0; i < formTests.length; i++) {
    var formRow = document.createElement('tr');

    var labelCell = document.createElement('th');
    var label = document.createElement('label');
    label.setAttribute('for', formTests[i].id);
    label.textContent = formTests[i].name;
    labelCell.appendChild(label);
    formRow.appendChild(labelCell);

    var inputCell = document.createElement('td');
    var input = document.createElement('input');
    input.setAttribute('type', 'text');
    input.setAttribute('id', formTests[i].id);
    input.setAttribute('inputmode', 'numeric');
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
    inputCell.appendChild(input);
    formRow.appendChild(inputCell);

    var unitCell = document.createElement('td');
    var select = document.createElement('select');
    select.setAttribute('id', formTests[i].id + 'Unit');
    select.setAttribute('oninput', 'calculateResult()');
    unitCell.appendChild(select);
    formRow.appendChild(unitCell);

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

    formTable.appendChild(formRow);
  }

  var form = document.createElement('form');
  form.appendChild(formTable);
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

  // Storage notice
  if (fromStorage) {
    var storageDiv = document.createElement('div');
    storageDiv.className = 'storage-notice';
    storageDiv.id = 'storageNotice';
    storageDiv.innerHTML = t('storage_restored') + ' ' +
      '<a href="#" onclick="clearLocalStorage(); return false;">' + t('storage_clear_link') + '</a>';
    formDiv.appendChild(storageDiv);
  }

  if (saved && saved.dob && saved.tests.length > 0) {
    calculateResult();
  }

  updateDefaultsButton();
}

// --- Fill missing values with age-appropriate population defaults ---

function updateDobPrompt() {
  var prompt = document.getElementById('dobPrompt');
  if (!prompt) return;
  var dobVal = document.getElementById('dob').value;
  if (dobVal) {
    prompt.style.display = 'none';
  } else {
    prompt.style.display = '';
    prompt.className = 'dob-prompt';
    prompt.textContent = t('dob_prompt');
  }
}

function showDefaultsMessage(text, type) {
  var section = document.getElementById('defaultsSection');
  if (!section) return;
  var existing = section.querySelector('.defaults-message');
  if (existing) existing.remove();
  var msg = document.createElement('p');
  msg.className = 'defaults-message' + (type === 'success' ? ' success' : '');
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

    // Convert from canonical to the currently selected display unit
    var unitSelect = document.getElementById(formTests[i].id + 'Unit');
    var selectedUnit = unitSelect.options[unitSelect.selectedIndex].text;
    var displayVal = fromCanonical(canonicalDefault, selectedUnit, formTests[i].id);

    // Use sensible precision
    var rounded;
    if (displayVal < 0.1) rounded = displayVal.toPrecision(2);
    else if (displayVal < 10) rounded = displayVal.toFixed(2);
    else if (displayVal < 100) rounded = displayVal.toFixed(1);
    else rounded = displayVal.toFixed(0);

    input.value = rounded;
    input.classList.add('default-value');
    filled++;
  }

  if (filled > 0) {
    showDefaultsMessage(t('defaults_filled', filled, filled > 1 ? t('defaults_filled_plural') : t('defaults_filled_singular')), 'success');
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
    var isDefault = input.classList.contains('default-value') ? ' (population default)' : '';
    lines.push(formTests[i].id + ',' + input.value + isDefault + ',' + unit);
  }

  // Add result if available
  var resultEl = document.getElementById('phenoAgeResult');
  var resultText = resultEl ? resultEl.textContent : '';
  if (resultText.indexOf('Result:') !== -1) {
    lines.push('');
    lines.push('# Result');
    // Extract the key numbers from the result display
    var match = resultText.match(/([\d.]+) years \(age acceleration ([+-]?[\d.]+)/);
    if (match) {
      lines.push('phenoage,' + match[1] + ',years');
      lines.push('acceleration,' + match[2] + ',years');
    }
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

function showCSVMessage(text, isError) {
  var row = document.querySelector('.csv-load-row');
  if (!row) return;
  var existing = row.querySelector('.csv-message');
  if (existing) existing.remove();
  var msg = document.createElement('span');
  msg.className = 'csv-message' + (isError ? ' csv-message-error' : '');
  msg.textContent = text;
  row.appendChild(msg);
}

function handleCSVUpload(fileInput) {
  var file = fileInput.files[0];
  if (!file) return;

  var reader = new FileReader();
  reader.onload = function(e) {
    var text = e.target.result;
    // Strip UTF-8 BOM if present
    if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1);
    var lines = text.trim().split('\n');
    var loaded = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#' || line.indexOf('field,') === 0) continue;

      var parts = line.split(',');
      var field = (parts[0] || '').trim();
      var value = (parts[1] || '').trim();
      var unit = (parts[2] || '').trim();

      if (!field || !value) continue;

      if (field === 'dob') {
        var dobInput = document.getElementById('dob');
        if (dobInput) { dobInput.value = value; loaded++; }
      } else if (field === 'test_date') {
        var tdInput = document.getElementById('testdate');
        if (tdInput) { tdInput.value = value; loaded++; }
      } else {
        // Biomarker value — strip " (population default)" suffix if present
        var cleanValue = value ? value.replace(/\s*\(population default\)/, '') : '';
        var input = document.getElementById(field);
        if (input && cleanValue) {
          input.value = cleanValue;
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
      updateDobPrompt();
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
        unit: unitSelect.options[unitSelect.selectedIndex].text,
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
  }).catch(function(err) {
    console.error('Failed to load config:', err);
    document.getElementById('phenoAgeForm').innerHTML =
      '<p>' + t('error_config_failed') + '</p>';
  });
};
