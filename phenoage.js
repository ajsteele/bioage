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
var formTests = [];

function buildFormTests() {
  formTests = [];
  for (var i = 0; i < model.biomarkers.length; i++) {
    var bm = model.biomarkers[i];
    var testDef = findTestDef(bm.test_id);
    var testConversions = conversions[bm.test_id];

    if (bm.test_id === 'age') {
      // Age is special: not in tests.csv, just a number in years
      formTests.push({
        id: 'age',
        name: 'Age',
        units: ['years'],
        to_canonical_factors: [1]
      });
      continue;
    }

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

// --- Unit conversion engine ---

// Convert a value from a given unit to canonical (SI) for a test
function toCanonical(value, unit, test_id) {
  var testConvs = conversions[test_id];
  if (!testConvs) return value; // no conversions defined (e.g. age)
  for (var i = 0; i < testConvs.length; i++) {
    if (testConvs[i].unit === unit) {
      return value * testConvs[i].to_canonical_factor;
    }
  }
  console.warn('No conversion found for ' + test_id + ' unit ' + unit);
  return value;
}

// Convert a value from canonical to a specific target unit
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

// Apply a biomarker transform as specified in the model definition.
// canonicalValues is a map of {test_id: canonical_value} for cross-references (e.g. percentage_of)
function applyTransform(value, transform, canonicalValues) {
  if (!transform) return value;

  if (transform === 'log') {
    return Math.log(value);
  }

  // percentage_of:other_test_id — compute (value / other_value) * 100
  if (transform.indexOf('percentage_of:') === 0) {
    var refTestId = transform.split(':')[1];
    var refValue = canonicalValues[refTestId];
    if (refValue && refValue !== 0) {
      // Both value and refValue should be in the same units at this point
      // (both converted to model units by the caller)
      return (value / refValue) * 100;
    }
    // If already in %, just return as-is
    return value;
  }

  console.warn('Unknown transform: ' + transform);
  return value;
}

// --- Model calculation ---

// Calculate biological age using a mortality model (PhenoAge formula)
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

  // 12-month mortality risk
  var riskOfDeath = 1 - Math.exp(
    -Math.exp(rollingTotal) * (Math.exp(gamma * 12) - 1) / gamma
  );

  return { bioAge: bioAge, mortalityScore: mortalityScore, riskOfDeath: riskOfDeath };
}

// --- URL anchor persistence (unchanged logic, adapted for new data structures) ---

function extractValuesFromAnchor(url) {
  var anchor = url.split('#')[1];
  if (typeof anchor !== 'undefined') {
    var testValUnitsURL = anchor.split(anchorKeysSeparator);
    var testValUnits = [];
    for (var i = 0; i < testValUnitsURL.length; i++) {
      var parts = testValUnitsURL[i].split(/[=,]/);
      var test = parts[0], value = parts[1], units = parts[2];
      testValUnits.push({
        id: decodeURIComponent(test),
        value: decodeURIComponent(value),
        units: decodeURIComponent(units)
      });
    }
    return testValUnits;
  } else {
    return null;
  }
}

function createAnchorFromValues(formTests, values, units) {
  var url = '#';
  for (var i = 0; i < formTests.length; i++) {
    url += encodeURIComponent(formTests[i].id) + '=' +
           encodeURIComponent(values[i]) + anchorUnitsSeparator +
           encodeURIComponent(units[i]) + anchorKeysSeparator;
  }
  return url.slice(0, -1); // remove trailing separator
}

// --- Input parsing ---

function parseInput(value) {
  if (value === '') {
    return NaN;
  } else {
    return Number(value);
  }
}

// --- Main calculation triggered by form input ---

function calculateResult() {
  console.log('### Calculating! ###');
  var resultField = document.getElementById('phenoAgeResult');
  var errorText = '';

  // Read raw values and selected units from the form
  var rawValues = [];
  var selectedUnits = [];

  for (var i = 0; i < formTests.length; i++) {
    var valueElement = document.getElementById(formTests[i].id);
    var unitsElement = document.getElementById(formTests[i].id + 'Unit');
    rawValues[i] = parseInput(valueElement.value);
    selectedUnits[i] = unitsElement.options[unitsElement.selectedIndex].text;

    if (isNaN(rawValues[i]) && valueElement.value !== '') {
      valueElement.classList.add('errorNaN');
      if (errorText === '') {
        errorText += 'Invalid value for ' + formTests[i].name;
      } else {
        errorText += ', ' + formTests[i].name;
      }
    } else {
      valueElement.classList.remove('errorNaN');
    }
  }

  // Convert all values to canonical (SI) units first
  var canonicalValues = {};
  for (var i = 0; i < formTests.length; i++) {
    var bm = model.biomarkers[i];
    if (bm.test_id === 'age') {
      canonicalValues['age'] = rawValues[i];
    } else {
      canonicalValues[bm.test_id] = toCanonical(rawValues[i], selectedUnits[i], bm.test_id);
    }
  }

  // Now compute the weighted sum using model coefficients
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

    // For percentage_of transforms, we need the reference value in model units too
    var modelCanonicalValues = {};
    if (bm.transform && bm.transform.indexOf('percentage_of:') === 0) {
      var refId = bm.transform.split(':')[1];
      // Find what unit the model expects for the reference biomarker
      var refBm = null;
      for (var j = 0; j < model.biomarkers.length; j++) {
        if (model.biomarkers[j].test_id === refId) {
          refBm = model.biomarkers[j];
          break;
        }
      }
      if (refBm && selectedUnits[i] !== '%') {
        // Both lymphocyte and WBC need to be in comparable units
        // Convert the reference (WBC) from canonical to model unit
        var refModelVal = fromCanonical(canonicalValues[refId], refBm.unit, refId);
        modelCanonicalValues[refId] = refModelVal;
        modelVal = applyTransform(modelVal, bm.transform, modelCanonicalValues);
      }
      // If already in %, modelVal is already the percentage — no transform needed
    } else {
      modelVal = applyTransform(modelVal, bm.transform, {});
    }

    console.log(bm.test_id + ': ' + rawValues[i] + ' ' + selectedUnits[i] +
      ' → canonical ' + canonicalVal + ' → model (' + bm.unit + ') ' + modelVal +
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
  var chronologicalAge = rawValues[0]; // age is always first in the model

  // Display the result
  if (isNaN(phenoAge)) {
    if (errorText !== '') {
      resultField.innerHTML = 'Error: ' + errorText;
    } else {
      resultField.innerHTML = '<p>Please enter all values above to calculate your biological age.</p>';
    }
  } else {
    resultField.innerHTML = '<p class="result"><strong>Result:</strong> ' +
      phenoAge.toFixed(2) + ' years (age acceleration ' +
      (phenoAge - chronologicalAge).toFixed(2) + ' years)</p>';
    resultField.innerHTML += '<p>This means your risk of death from age-related causes ' +
      'in the coming year is approximately ' + (riskOfDeath * 100).toFixed(2) +
      '%, or around 1 in ' + parseFloat((1 / riskOfDeath).toPrecision(2)) + '.</p>';
    resultField.innerHTML += '<p>You can access this result again or share it using <a href="' +
      createAnchorFromValues(formTests, rawValues, selectedUnits) +
      '">this link</a>. Please think carefully before doing so as these test results are ' +
      'private medical data, and with this many data points it is likely that your medical ' +
      'record could be uniquely identified using these values.</p>';
  }
}

// --- Form generation ---

function createFormElements() {
  var savedValues = extractValuesFromAnchor(window.location.href);
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
    if (savedValues !== null && savedValues[i]) {
      input.setAttribute('value', savedValues[i].value);
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
      if (savedValues !== null && savedValues[i] && formTests[i].units[j] === savedValues[i].units) {
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
  var formDiv = document.getElementById('phenoAgeForm');
  formDiv.innerHTML = '';
  formDiv.appendChild(form);

  if (savedValues !== null) {
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
