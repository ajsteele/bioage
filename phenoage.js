const TEXT_PLACEHOLDER = 'Enter value';
const ANCHOR_UNITS_SEPARATOR = ',';
const ANCHOR_KEYS_SEPARATOR = ';';

// State to hold the configuration loaded from JSON
let biomarkers = [];

// Strategy definitions for special calculations
const calculations = {
  transforms: {
    log: (val) => Math.log(val),
  },
  dependencies: {
    // Calculates percentage: (CurrentValue / TargetValue) * 100
    percent_of: (val, targetVal) => (val / targetVal) * 100,
  }
};

async function init() {
  try {
    const response = await fetch('biomarkers.json');
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    biomarkers = await response.json();
    createFormElements();
  } catch (e) {
    document.getElementById('phenoAgeForm').innerHTML = 
      `<p style="error">Error loading configuration: ${e.message}.</p>`;
  }
}

function extractValuesFromAnchor(url) {
  const anchor = url.split('#')[1];
  if (!anchor) return null;

  const pairs = anchor.split(ANCHOR_KEYS_SEPARATOR);
  const result = {};
  
  pairs.forEach(pair => {
    if (!pair) return;
    // Format: id=value,unitName
    // We split by [=,] to get [id, value, unitName]
    const parts = pair.split(/[=,]/);
    if (parts.length >= 3) {
      result[decodeURIComponent(parts[0])] = {
        value: decodeURIComponent(parts[1]),
        unit: decodeURIComponent(parts[2])
      };
  }
  });
  return result;
}

function createAnchorFromValues(inputData) {
  let url = '#';
  biomarkers.forEach(test => {
    const data = inputData[test.id];
    if (data) {
      url += `${encodeURIComponent(test.id)}=${encodeURIComponent(data.rawValue)}${ANCHOR_UNITS_SEPARATOR}${encodeURIComponent(data.unitName)}${ANCHOR_KEYS_SEPARATOR}`;
  }
  });
  return url.slice(0, -1); // Remove trailing separator
}

function parseInput(value) {
  return value === '' ? NaN : Number(value);
}

function calculateResult() {
  console.log('### Calculating! ###');
  const resultField = document.getElementById('phenoAgeResult');
  let errorText = '';

  // 1. Gather all inputs into a Map for easy lookup by ID
  const inputs = {};
  biomarkers.forEach(test => {
    const valEl = document.getElementById(test.id);
    const unitEl = document.getElementById(test.id + 'Unit');

    const rawVal = parseInput(valEl.value);

    // Get stored multiplier and unit name from the option dataset/text
    const selectedOption = unitEl.options[unitEl.selectedIndex];
    const conversion = parseFloat(selectedOption.value);
    const unitName = selectedOption.text;
    
    // Check if this unit has a dependency (stored in data-dependency attribute)
    let dependency = null;
    if (selectedOption.dataset.dependency) {
      dependency = JSON.parse(selectedOption.dataset.dependency);
    }

    inputs[test.id] = {
      rawValue: rawVal,
      conversion: conversion,
      unitName: unitName,
      dependency: dependency
    };

    // UI Error handling
    if (isNaN(rawVal) && valEl.value !== '') {
      valEl.classList.add('errorNaN');
      errorText += (errorText ? ', ' : 'Invalid value for ') + test.name;
      } else {
      valEl.classList.remove('errorNaN');
      }
  });

  // 2. Compute Scores
  let rollingTotal = 0;
  // Calculate standardized values (applying units and dependencies)
  const computedValues = {}; 

  // We iterate purely to ensure dependencies are ready. 
  // NOTE: This assumes the JSON is ordered such that dependencies (WBC) come before dependents (lymphocytes).
  // If unordered, we would need a dependency graph or multi-pass approach.
  biomarkers.forEach(test => {
    const input = inputs[test.id];
    let val = input.rawValue * input.conversion; // Apply multiplicative conversion
    
    // Handle Dependencies (e.g., Lymphocyte count requires WBC count)
    if (input.dependency && input.dependency.type === 'percent_of') {
      const targetId = input.dependency.targetId;
      const targetVal = computedValues[targetId]; // Use the ALREADY COMPUTED base value of the target
      
      if (targetVal !== undefined && !isNaN(targetVal)) {
        val = calculations.dependencies.percent_of(val, targetVal);
        console.log(`${test.id}: Normalized using ${targetId} (${targetVal}) -> ${val}`);
    } else {
        // If target is missing, this value is invalid
        val = NaN; 
    }
  }

    // Apply Transforms (e.g. log for CRP)
    if (test.transform && calculations.transforms[test.transform]) {
       const original = val;
       val = calculations.transforms[test.transform](val);
       console.log(`${test.id}: Applied ${test.transform} to ${original} -> ${val}`);
    }

    computedValues[test.id] = val; // Store for future dependencies

    console.log(`${test.id}: ${input.rawValue} ${input.unitName} -> Base: ${val}`);
    rollingTotal += val * test.coeff;
  });

  // 3. Final Calculation
  const tmonths = 120;
  const b0 = -19.9067;
  const gamma = 0.0076927;
  rollingTotal += b0;

  console.log('Rolling Total:', rollingTotal);

  const mortalityScore = 1 - Math.exp(-Math.exp(rollingTotal) * (Math.exp(gamma * tmonths) - 1) / gamma);
  const riskOfDeath = 1 - Math.exp(-Math.exp(rollingTotal) * (Math.exp(gamma * 12) - 1) / gamma);
  const phenoAge = 141.50225 + Math.log(-0.00553 * Math.log(1 - mortalityScore)) / 0.090165;

  // 4. Display Results
  if(isNaN(phenoAge)) {
    if (errorText !== '') {
      resultField.innerHTML = 'Error: ' + errorText;
    } else {
      resultField.innerHTML = '<p>Please enter all values above to calculate your biological age.</p>';
    }
  } else {
    resultField.innerHTML = `<p class="result"><strong>Result:</strong> ${phenoAge.toFixed(2)} years (age acceleration ${(phenoAge - inputs['age'].rawValue).toFixed(2)} years)</p>`;
    resultField.innerHTML += `<p>This means your risk of death from age-related causes in the coming year is approximately ${(riskOfDeath * 100).toFixed(2)}%, or around 1 in ${parseFloat((1 / riskOfDeath).toPrecision(2))}.</p>`;
    resultField.innerHTML += `<p>You can access this result again or share it using <a href="${createAnchorFromValues(inputs)}">this link</a>. Please think carefully before doing so as these test results are private medical data.</p>`;
  }
}

function createFormElements() {
  const savedValues = extractValuesFromAnchor(window.location.href);
  const formDiv = document.getElementById('phenoAgeForm');
  formDiv.innerHTML = ''; // Clear loading message

  const formTable = document.createElement('table');
  const form = document.createElement('form');

  biomarkers.forEach(test => {
    const row = document.createElement('tr');

    // Label
    const labelCell = document.createElement('th');
    const label = document.createElement('label');
    label.htmlFor = test.id;
    label.textContent = test.name;
    labelCell.appendChild(label);
    row.appendChild(labelCell);

    // Input
    const inputCell = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.id = test.id;
    input.inputMode = 'numeric';
    input.placeholder = TEXT_PLACEHOLDER;
    input.oninput = calculateResult;
    
    // Pre-fill from URL
    if (savedValues && savedValues[test.id]) {
      input.value = savedValues[test.id].value;
    }
    inputCell.appendChild(input);
    row.appendChild(inputCell);

    // Units Select
    const unitCell = document.createElement('td');
    const select = document.createElement('select');
    select.id = test.id + 'Unit';
    select.oninput = calculateResult;

    test.units.forEach((unit, index) => {
      const option = document.createElement('option');
      option.value = unit.conversion; // Store the conversion directly
      option.textContent = unit.name;
      
      // Store dependency info in data attribute if it exists
      if (unit.dependency) {
        option.dataset.dependency = JSON.stringify(unit.dependency);
      }

      // Pre-select from URL
      if (savedValues && savedValues[test.id] && savedValues[test.id].unit === unit.name) {
        option.selected = true;
      }
      select.appendChild(option);
    });

    if (test.units.length === 1) {
      select.disabled = true;
    }

    unitCell.appendChild(select);
    row.appendChild(unitCell);
    formTable.appendChild(row);
  });

  form.appendChild(formTable);
  formDiv.appendChild(form);

  if (savedValues) {
    calculateResult();
  }
}

window.onload = init;