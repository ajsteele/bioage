// ═══════════════════════════════════════════════════════════════════════════
// Jet Lag Clock — The Longevity Initiative
// Circadian light-exposure calculator for jet lag adaptation
// ═══════════════════════════════════════════════════════════════════════════

// --- Science constants (single config object for expert review) ---

var SCIENCE = {
  cbtMinBeforeWake: 2,       // CBTmin occurs ~2h before habitual wake time
  advanceRate: 1.0,          // hours/day adaptation rate (eastward / advance)
  delayRate: 1.5,            // hours/day adaptation rate (westward / delay)
  avoidWindowHours: 6,       // hours either side of CBTmin with strong PRC effect
  windDownHours: 3,          // hours before bed to dim lights
  sleepDuration: 8.5,        // assumed sleep duration (hours)
  caffeineCutoffHours: 9,    // hours before bed to stop caffeine
  melatoninBeforeBed: 0.5,   // hours before target bedtime to take melatonin
  melatoninMinZones: 5,      // minimum timezone shift (hours) to recommend melatonin
  delayAroundThreshold: 9    // eastward shift >= this defaults to delay-around
};

// --- Clock drawing constants ---

var CX = 140, CY = 140;
var R_LABEL = 130, R_ARC_OUTER = 120, R_ARC_INNER = 74;

// --- Arc colours ---

var COLOURS = {
  seek: '#0066cc',
  seekBg: 'rgba(0, 102, 204, 0.15)',
  avoid: '#d4891a',
  avoidBg: 'rgba(212, 137, 26, 0.18)',
  sleepBg: '#e8e4df',
  sleepBorder: '#d0ccc4',
  cbt: '#e03030',
  melatonin: '#9060d0',
  caffeine: '#8a6010',
  now: '#333333',
  ring: '#ccc',
  ringLight: '#ddd',
  tick: '#aaa',
  tickMinor: '#ccc',
  tickFaint: '#ddd',
  hourLabel: '#999',
  centerText: '#aaa',
  face: '#f4f3f0'
};

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

// --- Utility functions ---

function mod24(h) {
  return ((h % 24) + 24) % 24;
}

function fmtTime(h) {
  h = mod24(h);
  var hh = Math.floor(h);
  var mm = Math.round((h - hh) * 60);
  if (mm === 60) { hh++; mm = 0; }
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

function inArc(h, start, end) {
  var span = mod24(end - start);
  var delta = mod24(h - start);
  return delta > 0.05 && delta < span - 0.05;
}

// --- Science logic ---

function computeStrategy(wakeH, rawShift, dayNum, forceAdvance) {
  var strat = 'none';
  var isDelayAround = false;

  if (rawShift > 0 && rawShift < SCIENCE.delayAroundThreshold) {
    strat = 'advance';
  } else if (rawShift >= SCIENCE.delayAroundThreshold) {
    if (forceAdvance) {
      strat = 'advance';
    } else {
      strat = 'delay';
      isDelayAround = true;
    }
  } else if (rawShift < 0) {
    strat = 'delay';
  }

  var rate = strat === 'advance' ? SCIENCE.advanceRate : SCIENCE.delayRate;
  var effectiveShift = isDelayAround ? -(24 - rawShift) : rawShift;
  var absEffective = Math.abs(effectiveShift);
  var adapted = Math.min(dayNum * rate, absEffective);
  var remainingShift = absEffective - adapted;

  if (remainingShift < 0.5) strat = 'none';

  var signedRemaining = effectiveShift > 0 ? remainingShift : -remainingShift;
  var cbtDest = mod24(wakeH - SCIENCE.cbtMinBeforeWake + signedRemaining);

  var sleepStart = mod24(wakeH - SCIENCE.sleepDuration);
  var sleepEnd = wakeH;
  var hygieneStart = mod24(sleepStart - SCIENCE.windDownHours);
  var cbtInWaking = inArc(cbtDest, sleepEnd, hygieneStart);

  var showMelatonin = absEffective >= SCIENCE.melatoninMinZones && strat === 'advance';
  var melaTime = showMelatonin ? mod24(sleepStart - SCIENCE.melatoninBeforeBed) : null;
  var caffeineCutoff = mod24(sleepStart - SCIENCE.caffeineCutoffHours);

  return {
    strat: strat,
    cbtDest: cbtDest,
    sleepStart: sleepStart,
    sleepEnd: sleepEnd,
    hygieneStart: hygieneStart,
    cbtInWaking: cbtInWaking,
    melaTime: melaTime,
    caffeineCutoff: caffeineCutoff,
    rawShift: rawShift,
    effectiveShift: effectiveShift,
    remainingShift: remainingShift,
    adapted: adapted,
    rate: rate,
    dayNum: dayNum,
    absEffective: absEffective,
    isDelayAround: isDelayAround,
    totalDays: Math.ceil(absEffective / rate)
  };
}

// --- SVG clock rendering ---

function polarXY(r, deg) {
  var a = (deg - 90) * Math.PI / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

function hourToAngle(h) {
  return (h / 24) * 360;
}

function svgEl(tag, attrs) {
  var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (var k in attrs) {
    if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]);
  }
  return el;
}

function arcPath(rOuter, rInner, h1, h2) {
  var a1 = hourToAngle(h1);
  var sweep = ((hourToAngle(h2) - a1) + 360) % 360;
  if (sweep < 0.05) sweep = 360;
  var a2 = a1 + sweep;
  var lg = sweep > 180 ? 1 : 0;
  var p1 = polarXY(rOuter, a1);
  var p2 = polarXY(rOuter, a2);
  var p3 = polarXY(rInner, a2);
  var p4 = polarXY(rInner, a1);
  return 'M' + p1[0] + ',' + p1[1] +
    'A' + rOuter + ',' + rOuter + ' 0 ' + lg + ' 1 ' + p2[0] + ',' + p2[1] +
    'L' + p3[0] + ',' + p3[1] +
    'A' + rInner + ',' + rInner + ' 0 ' + lg + ' 0 ' + p4[0] + ',' + p4[1] + 'Z';
}

function drawMarker(svg, h, col, label) {
  var a = hourToAngle(h);
  var p1 = polarXY(R_ARC_INNER, a);
  var p2 = polarXY(R_ARC_OUTER + 5, a);
  svg.appendChild(svgEl('line', {
    x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
    stroke: col, 'stroke-width': '1.5', 'stroke-dasharray': '3,2'
  }));
  var tp = polarXY(R_ARC_OUTER + 16, a);
  var text = svgEl('text', {
    x: tp[0], y: tp[1],
    'text-anchor': 'middle', 'dominant-baseline': 'middle',
    'font-size': '7.5', 'font-family': 'Inter, system-ui, sans-serif', fill: col
  });
  if (a > 90 && a < 270) text.setAttribute('transform', 'rotate(180 ' + tp[0] + ' ' + tp[1] + ')');
  text.textContent = label;
  svg.appendChild(text);
}

function renderClock(sc, shiftValue) {
  var svg = document.getElementById('clock');
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  var strat = sc.strat;
  var cbtDest = sc.cbtDest;
  var sleepStart = sc.sleepStart;
  var sleepEnd = sc.sleepEnd;
  var hygieneStart = sc.hygieneStart;
  var cbtInWaking = sc.cbtInWaking;
  var melaTime = sc.melaTime;
  var caffeineCutoff = sc.caffeineCutoff;

  // Clock face background
  svg.appendChild(svgEl('circle', {
    cx: CX, cy: CY, r: R_ARC_OUTER + 12,
    fill: COLOURS.face, stroke: COLOURS.ring, 'stroke-width': '1'
  }));

  // Wind-down arc (always present)
  svg.appendChild(svgEl('path', {
    d: arcPath(R_ARC_OUTER, R_ARC_INNER, hygieneStart, sleepStart),
    fill: COLOURS.avoidBg
  }));

  // Circadian-strategy arcs
  if (strat === 'advance' && cbtInWaking) {
    svg.appendChild(svgEl('path', {
      d: arcPath(R_ARC_OUTER, R_ARC_INNER, sleepEnd, cbtDest),
      fill: COLOURS.avoidBg
    }));
    svg.appendChild(svgEl('path', {
      d: arcPath(R_ARC_OUTER, R_ARC_INNER, cbtDest, hygieneStart),
      fill: COLOURS.seekBg
    }));
  } else if (strat === 'delay' && cbtInWaking) {
    svg.appendChild(svgEl('path', {
      d: arcPath(R_ARC_OUTER, R_ARC_INNER, sleepEnd, cbtDest),
      fill: COLOURS.seekBg
    }));
    svg.appendChild(svgEl('path', {
      d: arcPath(R_ARC_OUTER, R_ARC_INNER, cbtDest, hygieneStart),
      fill: COLOURS.avoidBg
    }));
  } else {
    svg.appendChild(svgEl('path', {
      d: arcPath(R_ARC_OUTER, R_ARC_INNER, sleepEnd, hygieneStart),
      fill: COLOURS.seekBg
    }));
  }

  // Sleep arc
  svg.appendChild(svgEl('path', {
    d: arcPath(R_ARC_OUTER, R_ARC_INNER, sleepStart, sleepEnd),
    fill: COLOURS.sleepBg, stroke: COLOURS.sleepBorder, 'stroke-width': '.5'
  }));

  // Hour ticks
  for (var h = 0; h < 24; h++) {
    var a = hourToAngle(h);
    var major = h % 6 === 0;
    var semi = h % 3 === 0 && !major;
    var tickLen = major ? 11 : semi ? 6 : 3;
    var p1 = polarXY(R_ARC_OUTER - tickLen, a);
    var p2 = polarXY(R_ARC_OUTER, a);
    svg.appendChild(svgEl('line', {
      x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
      stroke: major ? COLOURS.tick : semi ? COLOURS.tickMinor : COLOURS.tickFaint,
      'stroke-width': major ? '1.5' : '.75'
    }));
  }

  // Hour labels (00, 06, 12, 18)
  var labels = [[0, '00'], [6, '06'], [12, '12'], [18, '18']];
  for (var i = 0; i < labels.length; i++) {
    var lp = polarXY(R_LABEL, hourToAngle(labels[i][0]));
    var lt = svgEl('text', {
      x: lp[0], y: lp[1],
      'text-anchor': 'middle', 'dominant-baseline': 'middle',
      'font-size': '11', 'font-family': 'Inter, system-ui, sans-serif',
      'font-weight': '300', fill: COLOURS.hourLabel
    });
    lt.textContent = labels[i][1];
    svg.appendChild(lt);
  }

  // Ring outlines
  svg.appendChild(svgEl('circle', {
    cx: CX, cy: CY, r: R_ARC_OUTER,
    fill: 'none', stroke: COLOURS.ringLight, 'stroke-width': '1'
  }));
  svg.appendChild(svgEl('circle', {
    cx: CX, cy: CY, r: R_ARC_INNER,
    fill: 'none', stroke: COLOURS.ringLight, 'stroke-width': '1'
  }));

  // Current time indicator
  var now = new Date();
  var nowH = mod24((now.getHours() + shiftValue) + now.getMinutes() / 60);
  var nAngle = hourToAngle(nowH);
  var np1 = polarXY(R_ARC_INNER - 2, nAngle);
  var np2 = polarXY(R_ARC_OUTER + 2, nAngle);
  svg.appendChild(svgEl('line', {
    x1: np1[0], y1: np1[1], x2: np2[0], y2: np2[1],
    stroke: COLOURS.now, 'stroke-width': '2', 'stroke-linecap': 'round', opacity: '.7'
  }));
  svg.appendChild(svgEl('circle', {
    cx: np2[0], cy: np2[1], r: '3', fill: COLOURS.now, opacity: '.7'
  }));

  // CBTmin marker
  var cAngle = hourToAngle(cbtDest);
  var cp1 = polarXY(R_ARC_INNER - 6, cAngle);
  var cp2 = polarXY(R_ARC_OUTER + 7, cAngle);
  svg.appendChild(svgEl('line', {
    x1: cp1[0], y1: cp1[1], x2: cp2[0], y2: cp2[1],
    stroke: COLOURS.cbt, 'stroke-width': '2.5', 'stroke-linecap': 'round'
  }));
  svg.appendChild(svgEl('circle', {
    cx: cp2[0], cy: cp2[1], r: '5', fill: COLOURS.cbt
  }));

  // Caffeine cutoff marker
  drawMarker(svg, caffeineCutoff, COLOURS.caffeine, '☕');

  // Melatonin marker
  if (melaTime !== null) {
    drawMarker(svg, melaTime, COLOURS.melatonin, 'Mela');
  }

  // Center text
  var ct = svgEl('text', {
    x: CX, y: CY - 8,
    'text-anchor': 'middle', 'dominant-baseline': 'middle',
    'font-size': '9', 'font-family': 'Inter, system-ui, sans-serif',
    'font-weight': '300', fill: COLOURS.centerText
  });
  ct.textContent = t('clock_label');
  svg.appendChild(ct);
}

// --- Legend ---

function buildLegend(sc) {
  var section = document.getElementById('legendSection');
  section.innerHTML = '';

  var items = [
    { colour: COLOURS.seek, label: t('legend_seek') },
    { colour: COLOURS.avoid, label: t('legend_avoid'), opacity: '0.7' },
    { colour: COLOURS.sleepBg, label: t('legend_sleep'), border: '1px solid ' + COLOURS.sleepBorder },
    { colour: COLOURS.cbt, label: t('legend_cbt') },
    { colour: COLOURS.now, label: t('legend_now'), height: '2px', width: '12px' }
  ];

  if (sc.melaTime !== null) {
    items.push({ colour: COLOURS.melatonin, label: t('legend_melatonin'), height: '2px' });
  }

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var div = document.createElement('div');
    div.className = 'leg';

    var swatch = document.createElement('div');
    swatch.className = 'swatch';
    swatch.style.background = item.colour;
    if (item.opacity) swatch.style.opacity = item.opacity;
    if (item.border) swatch.style.border = item.border;
    if (item.height) swatch.style.height = item.height;
    if (item.width) swatch.style.width = item.width;

    div.appendChild(swatch);
    div.appendChild(document.createTextNode(item.label));
    section.appendChild(div);
  }
}

// --- Status message ---

function buildStatus(sc) {
  var el = document.getElementById('statusMsg');
  var abs = Math.abs(sc.rawShift);
  var strat = sc.strat;

  if (abs < 0.5) {
    el.className = 'status-msg status-same';
    el.innerHTML = t('status_same');
    return;
  }

  if (strat === 'none' && sc.dayNum > 0) {
    el.className = 'status-msg status-adapted';
    el.innerHTML = t('status_adapted');
    return;
  }

  var html = '';

  if (sc.isDelayAround) {
    el.className = 'status-msg status-delay';
    var delayH = 24 - sc.rawShift;
    if (sc.dayNum === 0) {
      html = t('status_delay_around_day0', String(sc.rawShift), String(delayH), String(sc.rate), String(sc.totalDays));
    } else {
      html = t('status_delay_around_dayN',
        String(sc.dayNum), sc.remainingShift.toFixed(1), String(delayH),
        String(sc.rate), String(Math.ceil(sc.remainingShift / sc.rate)));
    }
    html += '<br><span class="status-toggle"><a href="#" id="toggle-strat">' +
      t('status_switch_link_advance', String(sc.rawShift)) + '</a></span>';
  } else if (strat === 'advance') {
    el.className = 'status-msg status-advance';
    if (sc.dayNum === 0) {
      html = t('status_advance_day0', sc.absEffective.toFixed(1), String(sc.rate), String(sc.totalDays));
    } else {
      html = t('status_advance_dayN',
        String(sc.dayNum), sc.remainingShift.toFixed(1),
        String(sc.rate), String(Math.ceil(sc.remainingShift / sc.rate)));
    }
    if (sc.rawShift >= SCIENCE.delayAroundThreshold) {
      var dH = 24 - sc.rawShift;
      html += '<br><span class="status-toggle">' + t('status_switch_to_delay', String(dH)) +
        ' <a href="#" id="toggle-strat">' + t('status_switch_link_delay') + '</a></span>';
    }
  } else {
    el.className = 'status-msg status-delay';
    if (sc.dayNum === 0) {
      html = t('status_delay_day0', sc.absEffective.toFixed(1), String(sc.rate), String(sc.totalDays));
    } else {
      html = t('status_delay_dayN',
        String(sc.dayNum), sc.remainingShift.toFixed(1),
        String(sc.rate), String(Math.ceil(sc.remainingShift / sc.rate)));
    }
  }

  el.innerHTML = html;
}

// --- Instruction rows ---

function instructionRow(colour, heading, body) {
  return '<div class="irow" style="border-left-color:' + colour + '">' +
    '<strong style="color:' + colour + '">' + heading + '</strong>' + body + '</div>';
}

function buildInstructions(sc) {
  var strat = sc.strat;
  var cbtDest = sc.cbtDest;
  var sleepStart = sc.sleepStart;
  var sleepEnd = sc.sleepEnd;
  var hygieneStart = sc.hygieneStart;
  var cbtInWaking = sc.cbtInWaking;
  var caffeineCutoff = sc.caffeineCutoff;

  var wakeStr = fmtTime(sleepEnd);
  var slpStr = fmtTime(sleepStart);
  var hygStr = fmtTime(hygieneStart);
  var cbtStr = fmtTime(cbtDest);
  var caffStr = fmtTime(caffeineCutoff);

  var ins = '';

  if (strat === 'none') {
    ins += instructionRow(COLOURS.seek,
      t('inst_daytime_light', wakeStr, hygStr),
      t('inst_daytime_light_detail'));
    ins += instructionRow(COLOURS.avoid,
      t('inst_wind_down', hygStr, slpStr),
      t('inst_wind_down_detail'));
  } else if (strat === 'advance') {
    if (cbtInWaking) {
      ins += instructionRow(COLOURS.avoid,
        t('inst_block_light', wakeStr, cbtStr),
        t('inst_block_light_detail'));
      ins += instructionRow(COLOURS.seek,
        t('inst_seek_light_advance', cbtStr, hygStr),
        t('inst_seek_light_advance_detail'));
    } else {
      ins += instructionRow(COLOURS.seek,
        t('inst_seek_light_all_day', wakeStr, hygStr),
        t('inst_seek_light_all_day_advance_detail'));
    }
    ins += instructionRow(COLOURS.avoid,
      t('inst_wind_down', hygStr, slpStr),
      t('inst_wind_down_advance_detail'));
    if (sc.melaTime !== null) {
      ins += instructionRow(COLOURS.melatonin,
        t('inst_melatonin', fmtTime(sc.melaTime)),
        t('inst_melatonin_detail'));
    }
  } else {
    if (cbtInWaking) {
      ins += instructionRow(COLOURS.seek,
        t('inst_seek_light_delay', wakeStr, cbtStr),
        t('inst_seek_light_delay_detail'));
      ins += instructionRow(COLOURS.avoid,
        t('inst_avoid_and_wind_down', cbtStr, slpStr),
        t('inst_avoid_and_wind_down_detail'));
    } else {
      ins += instructionRow(COLOURS.seek,
        t('inst_seek_light_all_day', wakeStr, hygStr),
        t('inst_seek_light_all_day_delay_detail'));
      ins += instructionRow(COLOURS.avoid,
        t('inst_wind_down', hygStr, slpStr),
        t('inst_wind_down_detail'));
    }
    ins += instructionRow(COLOURS.cbt,
      t('inst_skip_melatonin'),
      t('inst_skip_melatonin_detail'));
  }

  if (strat !== 'none') {
    ins += instructionRow(COLOURS.caffeine,
      t('inst_exercise_caffeine'),
      t('inst_exercise_caffeine_detail', caffStr));
  }

  return ins;
}

// --- Form construction ---

function buildForm() {
  var panel = document.getElementById('controlsPanel');
  panel.innerHTML = '';

  // Wake time
  var wakeDiv = document.createElement('div');
  var wakeLabel = document.createElement('div');
  wakeLabel.className = 'q-label';
  wakeLabel.textContent = t('label_wake_time');
  var wakeInput = document.createElement('input');
  wakeInput.type = 'time';
  wakeInput.id = 'wakeTime';
  wakeInput.value = '07:00';
  wakeDiv.appendChild(wakeLabel);
  wakeDiv.appendChild(wakeInput);
  panel.appendChild(wakeDiv);

  // Travel date + adaptation day
  var whenDiv = document.createElement('div');
  var whenLabel = document.createElement('div');
  whenLabel.className = 'q-label';
  whenLabel.textContent = t('label_when');
  var dateRow = document.createElement('div');
  dateRow.className = 'travel-date-row';

  var dateCol = document.createElement('div');
  var dateLbl = document.createElement('label');
  dateLbl.setAttribute('for', 'travelDate');
  dateLbl.textContent = t('label_travel_date');
  var dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.id = 'travelDate';
  dateInput.value = new Date().toISOString().split('T')[0];
  dateCol.appendChild(dateLbl);
  dateCol.appendChild(dateInput);

  var dayCol = document.createElement('div');
  var dayLbl = document.createElement('label');
  dayLbl.setAttribute('for', 'daySelect');
  dayLbl.textContent = t('label_adaptation_day');
  var daySelect = document.createElement('select');
  daySelect.id = 'daySelect';
  dayCol.appendChild(dayLbl);
  dayCol.appendChild(daySelect);

  dateRow.appendChild(dateCol);
  dateRow.appendChild(dayCol);
  whenDiv.appendChild(whenLabel);
  whenDiv.appendChild(dateRow);
  panel.appendChild(whenDiv);

  // Timezone shift slider
  var shiftDiv = document.createElement('div');
  shiftDiv.className = 'shift-wrap';

  var shiftHeader = document.createElement('div');
  shiftHeader.className = 'shift-header';
  var shiftLabel = document.createElement('span');
  shiftLabel.textContent = t('label_timezone_shift');
  var shiftVal = document.createElement('span');
  shiftVal.className = 'shift-val';
  shiftVal.id = 'shiftDisplay';
  shiftVal.textContent = t('shift_zero');
  shiftHeader.appendChild(shiftLabel);
  shiftHeader.appendChild(shiftVal);

  var slider = document.createElement('input');
  slider.type = 'range';
  slider.id = 'shiftSlider';
  slider.min = '-12';
  slider.max = '12';
  slider.value = '0';
  slider.step = '0.5';

  var rangeLabels = document.createElement('div');
  rangeLabels.className = 'range-labels';
  var lblWest = document.createElement('span');
  lblWest.textContent = t('slider_west');
  var lblHome = document.createElement('span');
  lblHome.textContent = t('shift_home');
  var lblEast = document.createElement('span');
  lblEast.textContent = t('slider_east');
  rangeLabels.appendChild(lblWest);
  rangeLabels.appendChild(lblHome);
  rangeLabels.appendChild(lblEast);

  shiftDiv.appendChild(shiftHeader);
  shiftDiv.appendChild(slider);
  shiftDiv.appendChild(rangeLabels);
  panel.appendChild(shiftDiv);
}

// --- UI wiring ---

var forceAdvance = false;

function getWakeHour() {
  var val = document.getElementById('wakeTime').value;
  if (!val) return 7;
  var parts = val.split(':');
  return parseInt(parts[0], 10) + parseInt(parts[1], 10) / 60;
}

function getShift() {
  return parseFloat(document.getElementById('shiftSlider').value);
}

function getTravelDate() {
  var el = document.getElementById('travelDate');
  return el.value ? new Date(el.value + 'T12:00:00') : new Date();
}

function getDayNum(shift) {
  var sel = document.getElementById('daySelect');
  if (!sel) return 0;
  if (sel.value === 'auto') {
    var travel = getTravelDate();
    return Math.max(0, Math.floor((new Date() - travel) / 86400000));
  }
  return parseInt(sel.value, 10);
}

function updateDayDropdown(shift) {
  var sel = document.getElementById('daySelect');
  if (!sel) return;
  var currentVal = sel.value;
  var absShift = Math.abs(shift);

  var isAdvance = shift > 0 && shift < SCIENCE.delayAroundThreshold;
  var rate = isAdvance ? SCIENCE.advanceRate : SCIENCE.delayRate;
  var maxDays = Math.max(Math.ceil(absShift / rate), 1);

  var travel = getTravelDate();
  var autoDay = Math.max(0, Math.floor((new Date() - travel) / 86400000));

  sel.innerHTML = '';
  var autoOpt = document.createElement('option');
  autoOpt.value = 'auto';
  autoOpt.textContent = autoDay > 0 ? t('day_auto_n', String(autoDay)) : t('day_auto_arrival');
  sel.appendChild(autoOpt);

  for (var d = 0; d <= maxDays; d++) {
    var opt = document.createElement('option');
    opt.value = String(d);
    opt.textContent = d === 0 ? t('day_arrival') : t('day_n', String(d));
    sel.appendChild(opt);
  }

  if (currentVal === 'auto') {
    sel.value = 'auto';
  } else {
    var found = false;
    for (var j = 0; j < sel.options.length; j++) {
      if (sel.options[j].value === currentVal) { found = true; break; }
    }
    sel.value = found ? currentVal : 'auto';
  }
}

function updateShiftDisplay(shift) {
  var el = document.getElementById('shiftDisplay');
  if (!el) return;
  var abs = Math.abs(shift);
  var h = Math.floor(abs);
  var m = Math.round((abs - h) * 60);
  var mStr = m > 0 ? ' ' + m + 'm' : '';

  if (shift === 0) {
    el.textContent = t('shift_zero');
  } else if (shift > 0) {
    el.textContent = t('shift_east', '+' + h + 'h' + mStr);
  } else {
    el.textContent = t('shift_west', '−' + h + 'h' + mStr);
  }
}

function updateSliderFill(val) {
  var sl = document.getElementById('shiftSlider');
  if (!sl) return;
  var p = ((val + 12) / 24) * 100;
  if (val === 0) {
    sl.style.backgroundImage = 'none';
    sl.style.backgroundColor = '';
  } else if (val > 0) {
    sl.style.backgroundImage = 'linear-gradient(to right, var(--calc-btn-bg) 50%, var(--calc-accent) 50%, var(--calc-accent) ' + p + '%, var(--calc-btn-bg) ' + p + '%)';
  } else {
    sl.style.backgroundImage = 'linear-gradient(to right, var(--calc-btn-bg) ' + p + '%, var(--calc-accent) ' + p + '%, var(--calc-accent) 50%, var(--calc-btn-bg) 50%)';
  }
}

function updateAll() {
  var wakeH = getWakeHour();
  var shift = getShift();

  updateShiftDisplay(shift);
  updateSliderFill(shift);
  updateDayDropdown(shift);

  var dayNum = getDayNum(shift);
  var sc = computeStrategy(wakeH, shift, dayNum, forceAdvance);

  var statusEl = document.getElementById('statusMsg');
  var resultsEl = document.getElementById('resultsSection');

  statusEl.style.display = '';
  resultsEl.style.display = '';

  renderClock(sc, shift);
  buildStatus(sc);
  buildLegend(sc);
  document.getElementById('instructions').innerHTML = buildInstructions(sc);
}

function wireEvents() {
  var wakeEl = document.getElementById('wakeTime');
  var sliderEl = document.getElementById('shiftSlider');
  var dateEl = document.getElementById('travelDate');
  var dayEl = document.getElementById('daySelect');

  wakeEl.addEventListener('input', updateAll);
  sliderEl.addEventListener('input', function() {
    if (parseFloat(sliderEl.value) < SCIENCE.delayAroundThreshold) forceAdvance = false;
    updateAll();
  });
  dateEl.addEventListener('input', updateAll);
  dayEl.addEventListener('input', updateAll);

  document.addEventListener('click', function(e) {
    if (e.target && e.target.id === 'toggle-strat') {
      e.preventDefault();
      forceAdvance = !forceAdvance;
      updateAll();
    }
  });
}

// --- Boot ---

function boot() {
  loadStrings('en').then(function() {
    document.getElementById('pageTitle').textContent = t('title');
    document.getElementById('pageTagline').textContent = t('tagline');
    buildForm();
    wireEvents();
    updateAll();
    setInterval(updateAll, 60000);
  });
}

document.addEventListener('DOMContentLoaded', boot);
