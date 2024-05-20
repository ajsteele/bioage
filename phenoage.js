var text_placeholder = 'Enter a number';
var anchorUnitsSeparator = ',';
var anchorKeysSeparator = ';';

var tests = [
  { id: 'age', name: 'age', units: ['years'], conversions: [1], coeff: 0.0804 },
  { id: 'albumin', name: 'albumin', units: ['g/L', 'g/dL', 'g%', 'µmol/L'], conversions: [1, 0.1, 0.1, 15.0466], coeff: -0.0336 },
  { id: 'creatinine', name: 'creatinine', units: ['µmol/L', 'mg/dL'], conversions: [1, 0.0113], coeff: 0.0095 },
  { id: 'glucose', name: 'glucose', units: ['mmol/L', 'mg/dL'], conversions: [1, 18.016], coeff: 0.1953 },
  { id: 'crp', name: 'C-reactive protein', units: ['mg/L', 'mg/dL', 'nmol/L'], conversions: [10, 1, 95.2381], coeff: 0.0954 },
  // The commonly used units are equal to one-another!
  { id: 'wbc', name: 'white blood cell count', units: ['1000 cells/µL', '10⁹ cells/L'], conversions: [1, 1], coeff: 0.0554 },
  // If not expressed as a percentage, the lymphocyte units here might need changing to get them into the same units as the WBC above
  { id: 'lymphocyte', name: 'lymphocytes', units: ['%', '1000 cells/µL', '10⁹ cells/L'], conversions: [1, 1, 1], coeff: -0.012 },
  { id: 'mcv', name: 'mean cell volume', units: ['fL'], conversions: [1], coeff: 0.0268 },
  { id: 'rcdw', name: 'red cell distribution width', units: ['%'], conversions: [1], coeff: 0.3306 },
  { id: 'ap', name: 'alkaline phosphatase', units: ['U/L'], conversions: [1], coeff: 0.0019 }
];
// TODO: replace this big array with two referential CSVs (test ID/name and ID/unit/conversions) which is more user-friendly to change, and could have a source column for the conversions

function extractValuesFromAnchor(url) {
  anchor = url.split('#')[1]; // Get the anchor part of the URL
  if(typeof anchor !== 'undefined') {
    // Split the anchor into key-value pairs
    testValUnitsURL = anchor.split(anchorKeysSeparator);
    // Loop through each key-value pair and assign them to the values object
    testValUnits = [];
    for(i=0; i<testValUnitsURL.length; i++) {
      console.log(testValUnitsURL[i].split(/[=,]/));
      var [test, value, units] = testValUnitsURL[i].split(/[=,]/);
      testValUnits.push({id: decodeURIComponent(test), value:decodeURIComponent(value), units:decodeURIComponent(units)});
      console.log(testValUnits[testValUnits.length - 1])
    }
    return testValUnits;
  } else {
    return null;
  }
}

function createAnchorFromValues(tests, values, units) {
  url = '#'; // Start with the base URL and add the anchor symbol
  
  // Loop through each key-value pair in the values object
  for (i=0; i < tests.length; i++) {
    // Encode key and value and concatenate them to the URL
    url += `${encodeURIComponent(tests[i].id)}=${encodeURIComponent(values[i])}${anchorUnitsSeparator}${encodeURIComponent(units[i])}${anchorKeysSeparator}`;
  }
  
  // Remove the trailing ','
  url = url.slice(0, -1);
  
  return url;
}

function parseInput(value) {
  if(value == '') {
    return NaN;
  } else {
    return Number(value);
  }
}

function calculateResult() {
  console.log('### Calculating! ###');
  resultField = document.getElementById('phenoAgeResult');
  errorText = ''

  // Initialize arrays for values, units, and prefactors
  var testValuesRaw = [];
  var testValues = [];
  var testUnitsId = [];
  var testUnits = [];

  // Loop through field names to populate values and units arrays
  for (i = 0; i < tests.length; i++) {
    valueElement = document.getElementById(tests[i].id);
    unitsElement = document.getElementById(tests[i].id+'Unit');
    testValuesRaw[i] = parseInput(valueElement.value);
    testUnitsId[i] = unitsElement.options[unitsElement.selectedIndex].text;
    testUnits[i] = parseInput(unitsElement.value);

    if(isNaN(testValuesRaw[i]) & valueElement.value != '') {
      document.getElementById(tests[i].id).classList.add('errorNaN');
      if(errorText == '') {
        errorText += 'Invalid value for ' + tests[i].name;
      } else {
        errorText += ', ' + tests[i].name;
      }
    } else {
      document.getElementById(tests[i].id).classList.remove('errorNaN');
    }
  }

  var rollingTotal = 0;
  // Loop through values and calculate total
  for (var i = 0; i < tests.length; i++) {
    // CRP is used as a log in the calculation
    if(tests[i].id == 'crp') {
      testValues[i] = Math.log(testValuesRaw[i]/testUnits[i]);
      console.log(tests[i].id + ': ln(' + testValuesRaw[i]/testUnits[i] + 'mg/dL) => ' + testValues[i] + ' x ' + testUnits[i] + ' x ' + tests[i].coeff + ' = ' + testValues[i] * tests[i].coeff);
    // If lymphocyte count rather than percentage, divide by the total white blood cell count
    } else if(tests[i].id == 'lymphocyte' && testUnitsId[i] != '%') {
      // i-1 because it's the value before: TODO replace with name-based addressing
      testValues[i] = testValuesRaw[i]/(testUnits[i]*(testValuesRaw[i-1]/testUnits[i-1]))*100;
      console.log(tests[i].id + ': ' + testValues[i] + '% x ' + testUnits[i] + ' / ' + tests[i].coeff + ' = ' + testValues[i] * tests[i].coeff);
    } else {
      testValues[i] = testValuesRaw[i] / testUnits[i];
      console.log(tests[i].id + ': ' + testValuesRaw[i] + testUnitsId[i] + ' / ' + testUnits[i] + ' x ' + tests[i].coeff + ' = ' + testValues[i] * tests[i].coeff);
    }

    rollingTotal += testValues[i] * tests[i].coeff;
  }

  tmonths = 120; // ie 10 years
  b0 = -19.9067;
  gamma = 0.0076927;
  rollingTotal = rollingTotal + b0;
  console.log(rollingTotal);
  mortalityScore = 1-Math.exp(-Math.exp(rollingTotal)*(Math.exp(gamma*tmonths)-1)/gamma);
  console.log(mortalityScore);
  // As a 'fun' aside, calculate the risk of death over the next 12 months...
  riskOfDeath = 1-Math.exp(-Math.exp(rollingTotal)*(Math.exp(gamma*12)-1)/gamma);
  phenoAge = 141.50225+Math.log(-0.00553*Math.log(1-mortalityScore))/0.090165;
  console.log(phenoAge);

  // Display the result
  if(isNaN(phenoAge)) {
    if(errorText != '') {
      resultField.innerHTML = 'Error: ' + errorText;
    } else {
      resultField.innerHTML = '<p>Please enter all values above to calculate your biological age.</p>'
    }
  } else {
    resultField.innerHTML = '<p class="result"><strong>Result:</strong> ' + phenoAge.toFixed(2) + ' years (age acceleration ' + (phenoAge - testValuesRaw[0]).toFixed(2) + ' years)</p>';
    resultField.innerHTML += '<p>This means your risk of death from age-related causes in the coming year is approximately ' + (riskOfDeath*100).toFixed(2) + '%, or around 1 in ' + parseFloat((1/riskOfDeath).toPrecision(2)) + '.</p>';
    resultField.innerHTML += '<p>You can access this result again or share it using <a href="' + createAnchorFromValues(tests, testValuesRaw, testUnitsId) + '">this link</a>. Please think carefully before doing so as these test results are private medical data, and with this many data points it is likely that your medical record could be uniquely identified using these values.</p>'
  }
}

// Function to create form elements
function createFormElements() {
  savedValues = extractValuesFromAnchor(window.location.href);

  var formTable = document.createElement('table');

  // Loop through field names to create form elements
  for (var i = 0; i < tests.length; i++) {
    var formRow = document.createElement('tr');

    var labelCell = document.createElement('th')
    var label = document.createElement('label');
    label.setAttribute('for', tests[i].id);
    label.textContent = tests[i].name;
    labelCell.appendChild(label);
    formRow.appendChild(labelCell);

    var inputCell = document.createElement('td');
    var input = document.createElement('input');
    input.setAttribute('type', 'text');
    input.setAttribute('id', tests[i].id);
    input.setAttribute('placeholder', text_placeholder);
    input.setAttribute('oninput', 'calculateResult()');
    if(savedValues !== null) {
      input.setAttribute('value', savedValues[i].value)
    }
    inputCell.appendChild(input);
    formRow.appendChild(inputCell);

    var unitCell = document.createElement('td');
    var select = document.createElement('select');
    select.setAttribute('id', tests[i].id + 'Unit');
    select.setAttribute('oninput', 'calculateResult()');
    unitCell.appendChild(select);

    formRow.appendChild(unitCell);

    // Add options to the select element
    for (var j = 0; j < tests[i].units.length; j++) {
      var option1 = document.createElement('option');
      option1.setAttribute('value', tests[i].conversions[j]);
      option1.textContent = tests[i].units[j];
      select.appendChild(option1);
      if(savedValues !== null && tests[i].units[j] == savedValues[i].units) {
        select.selectedIndex = j;
        //select.setAttribute('value', savedValues[i].units);
      }
    }
    if(tests[i].units.length == 1) {
      select.disabled = true
    }

    formTable.appendChild(formRow);
  }
  var form = document.createElement('form');
  form.appendChild(formTable);
  formDiv = document.getElementById('phenoAgeForm');
  formDiv.innerHTML = '';
  formDiv.appendChild(form);

  if(savedValues !== null) {
    calculateResult();
  }
}

// Run the function to create form elements on page load
window.onload = createFormElements;