// Configuration state — populated by loading config files
var testDefs = [];       // from tests.csv: [{test_id, name, canonical_unit}]
var conversions = {};    // from conversions.csv: {test_id: [{unit, to_canonical_factor}]}
var model = null;        // from phenoage.json: full model definition

var anchorUnitsSeparator = ',';
var anchorKeysSeparator = ';';
var text_placeholder = 'Enter a number';

// --- Config loading ---

function parseCSV(text) {
  var lines = text.trim().split('\n');
  var headers = lines[0].split(',');
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var values = lines[i].split(',');
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = values[j].trim();
    }
    rows.push(row);
  }
  return rows;
}

function loadConfig() {
  return Promise.all([
    fetch('config/tests.csv').then(function(r) { return r.text(); }),
    fetch('config/conversions.csv').then(function(r) { return r.text(); }),
    fetch('config/models/phenoage.json').then(function(r) { return r.json(); })
  ]).then(function(results) {
    var testsCSV = results[0];
    var conversionsCSV = results[1];
    model = results[2];

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
      to_canonical_factors: factors
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

function applyTransform(value, transform, canonicalValues) {
  if (!transform) return value;

  if (transform === 'log') {
    return Math.log(value);
  }

  if (transform.indexOf('percentage_of:') === 0) {
    var refTestId = transform.split(':')[1];
    var refValue = canonicalValues[refTestId];
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
  var errors = document.querySelectorAll('.errorNaN');
  for (var i = 0; i < errors.length; i++) {
    errors[i].classList.remove('errorNaN');
  }
  var msgs = document.querySelectorAll('.error-message');
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

// --- Main calculation triggered by form input ---

function calculateResult() {
  console.log('### Calculating! ###');
  var resultField = document.getElementById('phenoAgeResult');
  var shareSection = document.getElementById('shareSection');
  clearInputErrors();
  var errors = [];

  // Read DOB and test date
  var dobInput = document.getElementById('dob');
  var testdateInput = document.getElementById('testdate');
  var dobVal = dobInput.value;
  var testdateVal = testdateInput.value;

  if (!dobVal || !testdateVal) {
    resultField.innerHTML = '<p>Please enter your date of birth and test date above.</p>';
    if (shareSection) shareSection.style.display = 'none';
    return;
  }

  var dob = new Date(dobVal + 'T00:00:00');
  var testDate = new Date(testdateVal + 'T00:00:00');

  if (isNaN(dob.getTime())) {
    markInputError('dob', 'Invalid date');
    errors.push('Invalid date of birth');
  }
  if (isNaN(testDate.getTime())) {
    markInputError('testdate', 'Invalid date');
    errors.push('Invalid test date');
  }
  if (testDate <= dob) {
    markInputError('testdate', 'Must be after date of birth');
    errors.push('Test date must be after date of birth');
  }

  var age = calculateAge(dob, testDate);
  if (age < 0 || age > 150) {
    errors.push('Calculated age (' + age.toFixed(1) + ') is out of range');
  }

  // Read biomarker values and selected units from the form
  var rawValues = [];
  var selectedUnits = [];

  for (var i = 0; i < formTests.length; i++) {
    var valueElement = document.getElementById(formTests[i].id);
    var unitsElement = document.getElementById(formTests[i].id + 'Unit');
    rawValues[i] = parseInput(valueElement.value);
    selectedUnits[i] = unitsElement.options[unitsElement.selectedIndex].text;

    if (isNaN(rawValues[i]) && valueElement.value !== '') {
      markInputError(formTests[i].id);
      errors.push('Invalid value for ' + formTests[i].name);
    } else if (isNaN(rawValues[i])) {
      // Missing value — not an error per se, just incomplete
    } else {
      // Validate CRP > 0 (required for log transform)
      if (formTests[i].id === 'crp' && rawValues[i] <= 0) {
        markInputError('crp', 'Must be > 0');
        errors.push('CRP must be greater than 0 (required for logarithmic calculation)');
      }
    }
  }

  if (errors.length > 0) {
    resultField.innerHTML = '<p>Error: ' + errors.join('; ') + '</p>';
    if (shareSection) shareSection.style.display = 'none';
    return;
  }

  // Check all required inputs are filled
  var allFilled = true;
  for (var i = 0; i < rawValues.length; i++) {
    if (isNaN(rawValues[i])) { allFilled = false; break; }
  }
  if (!allFilled) {
    resultField.innerHTML = '<p>Please enter all values above to calculate your biological age.</p>';
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
        modelVal = applyTransform(modelVal, bm.transform, modelRefValues);
      }
    } else {
      modelVal = applyTransform(modelVal, bm.transform, {});
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
    resultField.innerHTML = '<p>Could not calculate result. Please check your inputs.</p>';
    if (shareSection) shareSection.style.display = 'none';
    return;
  }

  resultField.innerHTML = '<p class="result"><strong>Result:</strong> ' +
    phenoAge.toFixed(2) + ' years (age acceleration ' +
    (acceleration >= 0 ? '+' : '') + acceleration.toFixed(2) + ' years)</p>';
  resultField.innerHTML += '<p>Your chronological age at the test date: ' + age.toFixed(1) + ' years.</p>';
  resultField.innerHTML += '<p>This means your risk of death from age-related causes ' +
    'in the coming year is approximately ' + (riskOfDeath * 100).toFixed(2) +
    '%, or around 1 in ' + parseFloat((1 / riskOfDeath).toPrecision(2)) + '.</p>';
  resultField.innerHTML += '<p>You can access this result again or share it using <a href="' +
    createAnchorFromValues(dobVal, testdateVal, formTests, rawValues, selectedUnits) +
    '">this link</a>. Please think carefully before doing so as these test results are ' +
    'private medical data, and with this many data points it is likely that your medical ' +
    'record could be uniquely identified using these values.</p>';

  // Generate and show the share card
  generateShareCard(phenoAge, age, acceleration);
}

// --- Share card generation ---

function generateShareCard(bioAge, chronAge, acceleration) {
  var shareSection = document.getElementById('shareSection');
  var canvas = document.getElementById('shareCanvas');
  if (!canvas || !shareSection) return;

  shareSection.style.display = 'block';

  var ctx = canvas.getContext('2d');
  var w = canvas.width;
  var h = canvas.height;

  // Background gradient — green-ish for younger, amber for older
  var grad = ctx.createLinearGradient(0, 0, w, h);
  if (acceleration <= 0) {
    grad.addColorStop(0, '#e8f5e9');
    grad.addColorStop(1, '#c8e6c9');
  } else {
    grad.addColorStop(0, '#fff8e1');
    grad.addColorStop(1, '#ffecb3');
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Subtle border
  ctx.strokeStyle = acceleration <= 0 ? '#66bb6a' : '#ffb74d';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, w - 4, h - 4);

  // Title
  ctx.fillStyle = '#333';
  ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('MY BIOLOGICAL AGE', w / 2, 50);

  // Big biological age number
  ctx.fillStyle = acceleration <= 0 ? '#2e7d32' : '#e65100';
  ctx.font = 'bold 80px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(Math.round(bioAge), w / 2, 150);

  // "X years younger/older" text
  var deltaText;
  var absDelta = Math.abs(acceleration).toFixed(1);
  if (acceleration <= -0.5) {
    deltaText = absDelta + ' years younger than my real age';
  } else if (acceleration >= 0.5) {
    deltaText = absDelta + ' years older than my real age';
  } else {
    deltaText = 'Right on track for my age';
  }
  ctx.fillStyle = '#555';
  ctx.font = '20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(deltaText, w / 2, 190);

  // Chronological age
  ctx.fillStyle = '#777';
  ctx.font = '16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('Chronological age: ' + Math.round(chronAge), w / 2, 225);

  // Divider line
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(100, 250);
  ctx.lineTo(w - 100, 250);
  ctx.stroke();

  // Call to action
  ctx.fillStyle = '#888';
  ctx.font = '15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('Calculate yours at', w / 2, 278);
  ctx.fillStyle = '#1565c0';
  ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('andrewsteele.co.uk/biological-age', w / 2, 300);
}

function downloadShareCard() {
  var canvas = document.getElementById('shareCanvas');
  if (!canvas) return;
  var link = document.createElement('a');
  link.download = 'my-biological-age.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function nativeShare() {
  var canvas = document.getElementById('shareCanvas');
  if (!canvas || !navigator.share) return;

  canvas.toBlob(function(blob) {
    var file = new File([blob], 'my-biological-age.png', { type: 'image/png' });
    navigator.share({
      title: 'My Biological Age',
      text: 'Check out my biological age result!',
      files: [file]
    }).catch(function(err) {
      console.log('Share cancelled or failed:', err);
    });
  }, 'image/png');
}

// --- Form generation ---

function createFormElements() {
  var saved = extractValuesFromAnchor(window.location.href);
  var formDiv = document.getElementById('phenoAgeForm');
  formDiv.innerHTML = '';

  // DOB + Test date section
  var dateSection = document.createElement('div');
  dateSection.className = 'date-section';

  var dobRow = document.createElement('div');
  dobRow.className = 'date-row';
  var dobLabel = document.createElement('label');
  dobLabel.setAttribute('for', 'dob');
  dobLabel.textContent = 'Date of birth';
  var dobInput = document.createElement('input');
  dobInput.setAttribute('type', 'date');
  dobInput.setAttribute('id', 'dob');
  dobInput.setAttribute('oninput', 'calculateResult()');
  if (saved && saved.dob) dobInput.value = saved.dob;
  dobRow.appendChild(dobLabel);
  dobRow.appendChild(dobInput);
  if (saved && saved.isLegacy) {
    var legacyNote = document.createElement('p');
    legacyNote.className = 'input-alert';
    legacyNote.textContent = 'Your test results were loaded from an older version of ' +
      'this calculator which stored your age directly. Please enter your date of birth ' +
      'and the date of the test so we can calculate your age more accurately.';
    dobRow.appendChild(legacyNote);
  }
  dateSection.appendChild(dobRow);

  var testdateRow = document.createElement('div');
  testdateRow.className = 'date-row';
  var testdateLabel = document.createElement('label');
  testdateLabel.setAttribute('for', 'testdate');
  testdateLabel.textContent = 'Test date';
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

  formDiv.appendChild(dateSection);

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
    input.setAttribute('placeholder', text_placeholder);
    input.setAttribute('oninput', 'calculateResult()');
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

  if (saved && saved.dob && saved.tests.length > 0) {
    calculateResult();
  }
}

// --- Startup ---

window.onload = function() {
  loadConfig().then(function() {
    createFormElements();
  }).catch(function(err) {
    console.error('Failed to load config:', err);
    document.getElementById('phenoAgeForm').innerHTML =
      '<p>Error loading calculator configuration. Please try refreshing the page.</p>';
  });
};
