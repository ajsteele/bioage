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

// --- Calculation ---

var MIN_DOG_AGE = 2 / 12; // ~2 months, below which the formula gives nonsensical results

function epigeneticHumanAge(dogAge) {
  return 16 * Math.log(dogAge) + 31;
}

function traditionalHumanAge(dogAge) {
  return 7 * dogAge;
}

// --- Form and result ---

function createForm() {
  var form = document.getElementById('dogYearsForm');
  form.innerHTML = '';

  // Title and intro from strings
  document.getElementById('pageTitle').textContent = t('title');
  document.getElementById('pageIntro').textContent = t('intro');

  var row = document.createElement('div');
  row.className = 'age-input-row';

  // Years input
  var yearsGroup = document.createElement('div');
  yearsGroup.className = 'age-input-group';
  var yearsLabel = document.createElement('label');
  yearsLabel.setAttribute('for', 'dogYears');
  yearsLabel.textContent = t('label_years');
  var yearsInput = document.createElement('input');
  yearsInput.type = 'number';
  yearsInput.id = 'dogYears';
  yearsInput.min = '0';
  yearsInput.max = '30';
  yearsInput.step = '1';
  yearsInput.placeholder = t('placeholder_years');
  yearsInput.setAttribute('inputmode', 'numeric');
  yearsInput.oninput = calculateResult;
  yearsGroup.appendChild(yearsLabel);
  yearsGroup.appendChild(yearsInput);

  // Months input
  var monthsGroup = document.createElement('div');
  monthsGroup.className = 'age-input-group';
  var monthsLabel = document.createElement('label');
  monthsLabel.setAttribute('for', 'dogMonths');
  monthsLabel.textContent = t('label_months');
  var monthsInput = document.createElement('input');
  monthsInput.type = 'number';
  monthsInput.id = 'dogMonths';
  monthsInput.min = '0';
  monthsInput.max = '11';
  monthsInput.step = '1';
  monthsInput.placeholder = t('placeholder_months');
  monthsInput.setAttribute('inputmode', 'numeric');
  monthsInput.oninput = calculateResult;
  monthsGroup.appendChild(monthsLabel);
  monthsGroup.appendChild(monthsInput);

  row.appendChild(yearsGroup);
  row.appendChild(monthsGroup);
  form.appendChild(row);

  // About section
  document.getElementById('aboutHeading').textContent = t('about_heading');
  document.getElementById('aboutFormula').innerHTML = t('about_formula');
  document.getElementById('aboutLimitations').textContent = t('about_limitations');
  document.getElementById('aboutCitation').innerHTML = t('about_citation') +
    ' <a href="' + t('about_citation_url') + '">doi:10.1016/j.cels.2020.06.006</a>';
}

function calculateResult() {
  var resultDiv = document.getElementById('dogYearsResult');
  var yearsVal = document.getElementById('dogYears').value;
  var monthsVal = document.getElementById('dogMonths').value;

  // Both empty — clear result
  if (yearsVal === '' && monthsVal === '') {
    resultDiv.innerHTML = '';
    return;
  }

  var years = yearsVal === '' ? 0 : parseInt(yearsVal, 10);
  var months = monthsVal === '' ? 0 : parseInt(monthsVal, 10);

  // Validation
  if (isNaN(years) || isNaN(months)) {
    resultDiv.innerHTML = '<p class="error-message">' + t('error_invalid') + '</p>';
    return;
  }

  if (months < 0 || months > 11) {
    resultDiv.innerHTML = '<p class="error-message">' + t('error_months_range') + '</p>';
    return;
  }

  var dogAge = years + months / 12;

  if (dogAge <= 0) {
    resultDiv.innerHTML = '<p class="error-message">' + t('error_enter_age') + '</p>';
    return;
  }

  if (dogAge < MIN_DOG_AGE) {
    resultDiv.innerHTML = '<p class="error-message">' + t('error_minimum_age') + '</p>';
    return;
  }

  var epiAge = epigeneticHumanAge(dogAge);
  var tradAge = traditionalHumanAge(dogAge);

  // Format the dog age for display (e.g. "5" or "2.5")
  var dogAgeDisplay = months === 0
    ? years.toString()
    : dogAge % 1 === 0 ? dogAge.toString() : dogAge.toFixed(1);

  var html = '<div class="result-card">';
  html += '<p class="result-main">' + t('result_heading', Math.round(epiAge)) + '</p>';
  html += '<p class="result-sub">' + t('result_subheading') + '</p>';

  // Traditional comparison
  html += '<p class="result-traditional">' +
    t('result_traditional', dogAgeDisplay, Math.round(tradAge)) + '</p>';

  // Difference note
  var diff = Math.abs(Math.round(epiAge) - Math.round(tradAge));
  if (diff <= 1) {
    html += '<p class="result-difference">' + t('result_difference_same') + '</p>';
  } else if (epiAge > tradAge) {
    html += '<p class="result-difference">' + t('result_difference_higher', diff) + '</p>';
  } else {
    html += '<p class="result-difference">' + t('result_difference_lower', diff) + '</p>';
  }

  html += '</div>';
  resultDiv.innerHTML = html;
}

// --- Startup ---

window.onload = function() {
  loadStrings('en').then(function() {
    createForm();
  }).catch(function(err) {
    console.error('Failed to load strings:', err);
    document.getElementById('dogYearsForm').innerHTML =
      '<p>Error loading calculator. Please try refreshing the page.</p>';
  });
};
