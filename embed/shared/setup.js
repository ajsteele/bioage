/*
 * The Longevity Initiative — embed setup script.
 *
 * Loaded on the *host* page (the site embedding one of our calculators), this
 * sizes each of our embed iframes to its content. The embed, running inside the
 * cross-origin iframe, can't set its own height, so it postMessages the height
 * out and this script applies it.
 *
 * Why a hosted file rather than an inline <script> in the embed snippet:
 *   - survives more CMS HTML sanitisers than inline script;
 *   - lets us fix or extend this logic later without asking every embedder to
 *     re-paste their code — so this file's URL is a permanent contract. Never
 *     move or rename it; only ever add backwards-compatible behaviour.
 *
 * We identify our embeds by ORIGIN, never by their URL path. postMessage's
 * targetOrigin does the work: a hello sent with targetOrigin = ORIGIN is only
 * delivered by the browser to a frame actually loaded from our origin, and a
 * resize message is trusted only when e.origin === ORIGIN. So the embed URL
 * path is free to change (a snappier path needs no update here); only moving to
 * a new domain would require updating the one ORIGIN constant below.
 *
 * If this file ever fails to load, the embed still works — the iframe just stays
 * at its fallback height="600" and doesn't auto-resize.
 */
(function () {
  'use strict';

  var ORIGIN = 'https://thelongevityinitiative.org';
  var VERTICAL_MARGIN = 32; // breathing room + guard against sub-pixel clipping

  // Run once per page even if the snippet (and so this script) is pasted more
  // than once — a single listener sizes every embed on the page.
  if (window.__liEmbedSetupLoaded) return;
  window.__liEmbedSetupLoaded = true;

  function iframes() {
    return document.getElementsByTagName('iframe');
  }

  // A calculator's own "copy result link" builds its link from this page's
  // canonical URL (see phenoage.js's resultLinkBaseUrl), so a saved link's
  // #dob=...;testdate=...;... fragment arrives on THIS page, not the embed
  // iframe — fragments never travel with a request, so nothing forwards it on
  // its own. Copy it onto our own iframe(s) before they load, so reopening a
  // saved link actually restores the calculator instead of showing it blank.
  //
  // `.src` (not getAttribute) is the browser-resolved absolute URL, so a
  // same-site embed snippet written with a relative path still matches ORIGIN
  // here. Only touches iframes already pointed at our own origin, and only
  // those that don't already carry their own fragment — never a third party's
  // embed sitting on the same host page, and never overwrites a link that
  // already names its own state.
  function forwardHashToEmbeds() {
    if (!window.location.hash) return;
    var fs = iframes();
    for (var i = 0; i < fs.length; i++) {
      var src = fs[i].src;
      if (src.indexOf(ORIGIN) !== 0 || src.indexOf('#') !== -1) continue;
      fs[i].src = src + window.location.hash;
    }
  }

  // Ask each of our embeds to (re)report its height. This handshake is what
  // makes loading async safe: if this script loads *after* an embed has already
  // sent its first height, that message is gone (postMessage doesn't queue for
  // listeners that don't exist yet), so we prompt a fresh report.
  //
  // We post to EVERY iframe on the page but with targetOrigin = ORIGIN, so the
  // browser only delivers the hello to frames actually loaded from our origin.
  // Third-party iframes never receive it — no URL matching, no leak. (Calling
  // postMessage on a cross-origin contentWindow is allowed; reading it isn't.)
  function requestHeights() {
    var fs = iframes();
    for (var i = 0; i < fs.length; i++) {
      try {
        fs[i].contentWindow.postMessage({ type: 'li-embed-hello' }, ORIGIN);
      } catch (e) { /* not ready yet; its load handler will retry */ }
    }
  }

  // Apply a height reported by one of our embeds. Trusted only when it comes
  // from our origin AND from a specific iframe's window, so nothing else on the
  // page — including other providers' iframes — can size a frame.
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN) return;
    if (!e.data || e.data.type !== 'li-calculator-resize') return;
    var fs = iframes();
    for (var i = 0; i < fs.length; i++) {
      if (fs[i].contentWindow === e.source) {
        fs[i].style.height = (e.data.height + VERTICAL_MARGIN) + 'px';
        break;
      }
    }
  });

  // Prompt a report now, when each frame finishes loading, and once more after
  // the whole page loads — between them these cover every load-order race.
  function init() {
    forwardHashToEmbeds();
    var fs = iframes();
    for (var i = 0; i < fs.length; i++) fs[i].addEventListener('load', requestHeights);
    requestHeights();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  window.addEventListener('load', requestHeights);
})();
