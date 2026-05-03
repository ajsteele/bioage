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

  var shareSection = document.getElementById('shareSection');

  // Both empty — clear result
  if (yearsVal === '' && monthsVal === '') {
    resultDiv.innerHTML = '';
    if (shareSection) shareSection.style.display = 'none';
    return;
  }

  var years = yearsVal === '' ? 0 : parseInt(yearsVal, 10);
  var months = monthsVal === '' ? 0 : parseInt(monthsVal, 10);

  // Validation
  if (isNaN(years) || isNaN(months)) {
    resultDiv.innerHTML = '<p class="error-message">' + t('error_invalid') + '</p>';
    if (shareSection) shareSection.style.display = 'none';
    return;
  }

  if (months < 0 || months > 11) {
    resultDiv.innerHTML = '<p class="error-message">' + t('error_months_range') + '</p>';
    if (shareSection) shareSection.style.display = 'none';
    return;
  }

  var dogAge = years + months / 12;

  if (dogAge <= 0) {
    resultDiv.innerHTML = '<p class="error-message">' + t('error_enter_age') + '</p>';
    if (shareSection) shareSection.style.display = 'none';
    return;
  }

  if (dogAge < MIN_DOG_AGE) {
    resultDiv.innerHTML = '<p class="error-message">' + t('error_minimum_age') + '</p>';
    if (shareSection) shareSection.style.display = 'none';
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

  // Generate share card
  generateShareCard(epiAge);
}

// --- Photo upload ---

var dogPhotoDataUrl = null;

function handlePhotoUpload(fileInput) {
  var file = fileInput.files[0];
  if (!file) return;

  var reader = new FileReader();
  reader.onload = function(e) {
    dogPhotoDataUrl = e.target.result;
    var preview = document.getElementById('photoPreview');
    var img = document.getElementById('photoPreviewImg');
    img.src = dogPhotoDataUrl;
    preview.style.display = '';
    // Re-render the share card with the photo
    regenerateShareCard();
  };
  reader.readAsDataURL(file);
  fileInput.value = '';
}

function removePhoto() {
  dogPhotoDataUrl = null;
  document.getElementById('photoPreview').style.display = 'none';
  document.getElementById('photoPreviewImg').src = '';
  regenerateShareCard();
}

function regenerateShareCard() {
  if (lastEpiAge !== null) {
    generateShareCard(lastEpiAge);
  }
}

// --- Share card generation ---

var lastEpiAge = null;
var shareCardBlob = null;
var shareCardFilename = 'my-dogs-age.png';

function generateShareCard(epiAge) {
  lastEpiAge = epiAge;
  var shareSection = document.getElementById('shareSection');
  var container = document.getElementById('shareCardContainer');
  if (!container || !shareSection) return;

  shareSection.style.display = 'block';

  // Update text from strings
  document.getElementById('shareHeading').textContent = t('share_heading');
  document.getElementById('photoUploadText').textContent = t('share_photo_label');
  document.getElementById('photoUploadHint').textContent = t('share_photo_hint');
  document.getElementById('photoRemoveBtn').textContent = t('share_photo_remove');
  document.getElementById('downloadImageBtn').textContent = t('share_download');

  var humanAge = Math.round(epiAge);
  shareCardFilename = 'my-dogs-age-' + humanAge + '-human-years.png';

  container.innerHTML = generateCardHTML(humanAge, dogPhotoDataUrl);

  // Reset image link state
  shareCardBlob = null;
  var wrapper = document.getElementById('shareCardImageLink');
  var img = document.getElementById('shareCardImage');
  if (wrapper) wrapper.style.display = 'none';
  container.style.display = '';

  // Generate PNG
  var cardEl = container.querySelector('.share-card-inner');
  if (cardEl && window.modernScreenshot) {
    modernScreenshot.domToPng(cardEl, { width: 600, height: 600, scale: 2 })
      .then(function(dataUrl) {
        return fetch(dataUrl).then(function(r) { return r.blob(); });
      })
      .then(function(blob) {
        shareCardBlob = blob;
        var objectUrl = URL.createObjectURL(blob);
        if (wrapper && img) {
          wrapper.href = objectUrl;
          wrapper.download = shareCardFilename;
          img.src = objectUrl;
          img.alt = t('card_aria_label', humanAge);
          wrapper.style.display = 'block';
          container.style.display = 'none';
        }
      })
      .catch(function(err) {
        console.log('PNG generation failed, HTML card will remain visible:', err);
      });
  }
}

function generateCardHTML(humanAge, photoUrl) {
  // Deep teal theme
  var bg = '#0f2b3c';
  var accent = '#4fc3f7';
  var badgeBg = '#0a1e2a';

  // Photo: circle with image, or a paw icon placeholder
  var photoHTML;
  if (photoUrl) {
    photoHTML = '<div style="width:180px; height:180px; border-radius:50%; overflow:hidden;' +
      ' border:4px solid ' + accent + '; margin:0 auto;">' +
      '<img src="' + photoUrl + '" style="width:100%; height:100%; object-fit:cover;" alt="">' +
      '</div>';
  } else {
    // Simple paw print placeholder using Unicode
    photoHTML = '<div style="width:180px; height:180px; border-radius:50%;' +
      ' background:' + badgeBg + '; border:4px solid rgba(255,255,255,0.15);' +
      ' margin:0 auto; display:flex; align-items:center; justify-content:center;">' +
      '<span style="font-size:72px; opacity:0.3;" aria-hidden="true">\uD83D\uDC3E</span>' +
      '</div>';
  }

  var ariaLabel = t('card_aria_label', humanAge);

  return '<div class="share-card" role="img" aria-label="' + ariaLabel.replace(/"/g, '&quot;') + '">' +
    '<div class="share-card-inner" style="width:600px; height:600px; background-color:' + bg +
    '; color:#ffffff; padding:36px 40px; box-sizing:border-box; display:flex; flex-direction:column;' +
    ' align-items:center; justify-content:space-between; font-family:Inter,system-ui,-apple-system,sans-serif;">' +

    // Header
    '<p style="text-transform:uppercase; letter-spacing:2px; font-size:15px; opacity:0.7;' +
    ' margin:0; line-height:1; width:100%;">' + t('card_title') + '</p>' +

    // Photo
    photoHTML +

    // Big number + label
    '<div style="text-align:center;">' +
    '<div style="font-size:120px; font-weight:400; color:' + accent +
    '; line-height:0.85; letter-spacing:-3px;">' + humanAge + '</div>' +
    '<div style="font-size:22px; font-weight:300; margin-top:4px; opacity:0.9;">' +
    t('card_human_years') + '</div></div>' +

    // Epigenetic badge
    '<div style="background:' + badgeBg + '; padding:8px 28px; border-radius:50px;' +
    ' font-size:16px; color:' + accent + '; font-weight:500;">' +
    t('card_epigenetic') + '</div>' +

    // CTA + branding
    '<div style="text-align:center;">' +
    '<p style="font-size:16px; opacity:0.5; margin:0; font-weight:300;">' +
    t('card_cta') + '</p>' +
    '<p style="font-size:24px; font-weight:400; margin:2px 0 0;">' +
    t('card_url') + '</p></div>' +

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
  if (!navigator.share || !shareCardBlob) return;
  var humanAge = lastEpiAge !== null ? Math.round(lastEpiAge) : '';
  var file = new File([shareCardBlob], shareCardFilename, { type: 'image/png' });
  navigator.share({
    title: t('share_native_title'),
    text: t('share_native_text', humanAge),
    files: [file]
  }).catch(function(err) {
    console.log('Share cancelled or failed:', err);
  });
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
