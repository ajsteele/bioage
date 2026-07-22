/*
 * The Longevity Initiative — embed picker.
 *
 * Powers the "embed a calculator" builder: reads calculators.json, fills the
 * chooser, and generates the copy-paste snippet plus a live preview. Loaded by
 * BOTH the standalone /embed/ page and the WordPress block version, so it wires
 * everything up by element id with addEventListener — no inline on* handlers and
 * no globals, which keeps it safe to drop onto a shared WordPress page.
 */
(function () {
  'use strict';

  var EMBED_ORIGIN = 'https://thelongevityinitiative.org';
  var EMBED_BASE = EMBED_ORIGIN + '/embed/';

  // Same-origin assets (the manifest, the preview iframe) load relative in local
  // dev and from the absolute /embed/ base in production. That way the picker
  // works as the standalone page AND as a WordPress page at /embed/, whose URL
  // may or may not keep its trailing slash.
  var isLocal = location.protocol === 'file:' ||
                location.hostname === 'localhost' ||
                location.hostname === '127.0.0.1';
  var ASSET_BASE = isLocal ? '' : EMBED_BASE;

  function $(id) { return document.getElementById(id); }

  // Pre-select a calculator from the URL hash (e.g. /embed/#phenoage). Match the
  // hash exactly against each option's anchor (its id by default).
  function preselectFromHash() {
    var hash = location.hash.replace(/^#\/?/, '');
    if (!hash) return;
    var select = $('calculatorSelect');
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].getAttribute('data-anchor') === hash) {
        select.selectedIndex = i;
        break;
      }
    }
  }

  function getSelectedCalculator() {
    var select = $('calculatorSelect');
    var opt = select.options[select.selectedIndex];
    return {
      id: opt.value,
      name: opt.getAttribute('data-name'),
      path: opt.getAttribute('data-path')
    };
  }

  function getThemeParam() {
    var theme = $('optTheme').value;
    return theme === 'light' ? '' : '?theme=' + theme;
  }

  function buildEmbedUrl(calc) {
    return ASSET_BASE + calc.path + getThemeParam();
  }

  function generateSnippet(calc) {
    var maxWidth = $('optMaxWidth').value || '800px';
    var embedUrl = EMBED_BASE + calc.path + getThemeParam();
    var iframeId = 'li-calc-' + calc.id;

    return '<!-- ' + calc.name + ' by The Longevity Initiative -->\n' +
      '<iframe\n' +
      '  id="' + iframeId + '"\n' +
      '  src="' + embedUrl + '"\n' +
      '  width="100%"\n' +
      '  height="600"\n' +
      '  frameborder="0"\n' +
      '  sandbox="allow-scripts allow-same-origin allow-popups allow-downloads"\n' +
      '  allow="web-share; clipboard-write"\n' +
      '  style="border:none; display:block; width:100%; max-width:' + maxWidth + '; margin:0 auto; overflow:hidden;"\n' +
      '  title="' + calc.name + ' — The Longevity Initiative"\n' +
      '  loading="lazy"\n' +
      '></iframe>\n' +
      '<p style="margin-top: 4px; padding-top: 0; font-size: 0.75em">' +
      '<a href="https://thelongevityinitiative.org/calculators/' + calc.id + '">' + calc.name + '</a>' +
      ' by <a href="https://thelongevityinitiative.org/">The Longevity Initiative</a></p>' +
      '<script src="' + EMBED_BASE + 'shared/setup.js" async><\/script>\n' +
      '<!-- / end of ' + calc.name + ' calculator code -->';
  }

  function updateEmbed() {
    var select = $('calculatorSelect');
    if (!select.options.length || !select.options[select.selectedIndex].getAttribute('data-path')) return;
    var calc = getSelectedCalculator();
    $('embedCode').value = generateSnippet(calc);

    var frame = $('previewFrame');
    var previewUrl = buildEmbedUrl(calc);
    if (frame.src !== previewUrl) frame.src = previewUrl;
  }

  function copySnippet() {
    var code = $('embedCode');
    code.select();
    code.setSelectionRange(0, 99999);
    var btn = $('copyBtn');
    function flash() {
      var original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = original; }, 2000);
    }
    function fallback() {
      try { if (document.execCommand('copy')) flash(); } catch (e) {}
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code.value).then(flash, fallback);
    } else {
      fallback();
    }
  }

  // Populate the <select> from the manifest. The deployed manifest already
  // contains only ready calculators; the `ready` filter makes local development
  // (which serves the full manifest) behave the same.
  function buildOptions(calculators) {
    var select = $('calculatorSelect');
    select.innerHTML = '';
    calculators.filter(function (c) { return c.ready; }).forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.setAttribute('data-name', c.name);
      opt.setAttribute('data-path', c.path);
      opt.setAttribute('data-anchor', c.anchor || c.id);
      opt.textContent = c.label;
      select.appendChild(opt);
    });
    return select.options.length;
  }

  // Size the preview iframe to its reported content height.
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'li-calculator-resize') {
      var frame = $('previewFrame');
      if (frame) frame.style.height = (e.data.height + 32) + 'px';
    }
  });

  function bindEvents() {
    var sel = $('calculatorSelect'); if (sel) sel.addEventListener('change', updateEmbed);
    var theme = $('optTheme'); if (theme) theme.addEventListener('change', updateEmbed);
    var mw = $('optMaxWidth'); if (mw) mw.addEventListener('input', updateEmbed);
    var copy = $('copyBtn'); if (copy) copy.addEventListener('click', copySnippet);
  }

  function start() {
    if (!$('calculatorSelect')) return; // not on a page with the builder
    bindEvents();
    fetch(ASSET_BASE + 'calculators.json')
      .then(function (r) { return r.json(); })
      .then(function (calculators) {
        if (!buildOptions(calculators)) throw new Error('no ready calculators');
        preselectFromHash();
        updateEmbed();
        window.addEventListener('hashchange', function () {
          preselectFromHash();
          updateEmbed();
        });
      })
      .catch(function () {
        var sel = $('calculatorSelect'); if (sel) sel.style.display = 'none';
        var err = $('calcLoadError'); if (err) err.style.display = '';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
