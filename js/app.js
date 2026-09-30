// ส่วนติดต่อผู้ใช้: แผนที่ดาวเทียม + การคำนวณน้ำล้นตลิ่ง + ข้อมูล ThaiWater
(function () {
  'use strict';
  var CFG = window.FLOOD_CONFIG, M = window.FloodModel, R = window.Rating, TW = window.ThaiWater, HY = window.Hydro, FC = window.Forecast;
  var PS = CFG.primaryStation, P = Object.assign({}, CFG.params);

  var FCP = Object.assign({}, CFG.forecast, FC.PRESETS[CFG.forecast.preset || 'mid']);
  FCP.obs = Object.assign({}, CFG.forecast.obs);
  var state = {
    scn: 'forecast',     // 'forecast' คาดการณ์ตามเวลา, 'manual' กำหนดเอง (คงที่)
    fc: null,            // ผลคาดการณ์ (Forecast.build)
    selTime: null,       // เวลาที่เลือกดูบนแผนที่/กราฟ (ms) — null = ค่าสูงสุดตลอดช่วง
    simStart: null,      // เวลาเริ่มจำลองการไหล (ms) ในโหมดคาดการณ์
    mode: 'h',           // 'q' ปริมาณน้ำ, 'h' ระดับน้ำ (โหมดกำหนดเอง)
    q: R.dischargeFromLevel(PS.ratingCurve, CFG.forecast.obs.h),
    h: CFG.forecast.obs.h,
    riverLine: window.MAEKLONG_RIVER.slice(),
    riverSource: 'เส้นลำน้ำจาก DEM (สำรอง)',
    grid: null, gridZoom: null, river: null, result: null,
    stations: [],        // สถานี ThaiWater ในพื้นที่
    places: CFG.places.slice(),
    spread: 1,           // สัดส่วนการแสดงการแพร่กระจาย 0..1 (แบบเร็ว)
    view: 'depth',       // ชั้นข้อมูลที่แสดง: depth, velocity, hazard, damage, arrival
    hydro: null, hsum: null, liveDepth: null, timeIdx: -1, depthCache: {}
  };

  var $ = function (id) { return document.getElementById(id); };
  function fmt(n, d) {
    if (!isFinite(n)) return '–';
    return n.toLocaleString('th-TH', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------- แผนที่ ----------------
  var esriImg = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'ภาพดาวเทียม &copy; Esri, Maxar, Earthstar Geographics'
  });
  var esriLabels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, pane: 'overlayPane'
  });
  var googleHybrid = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&hl=th&x={x}&y={y}&z={z}', {
    maxZoom: 20, subdomains: '0123', attribution: 'ภาพดาวเทียม &copy; Google'
  });
  var osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; ผู้ร่วมพัฒนา OpenStreetMap'
  });
  var map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([PS.lat - 0.1, PS.lon], 11);
  var esriHybrid = L.layerGroup([esriImg, esriLabels]).addTo(map);

  map.createPane('flood'); map.getPane('flood').style.zIndex = 390;
  var riverLayer = L.polyline(state.riverLine, { color: '#00e5ff', weight: 2, opacity: 0.8, dashArray: '6 4' }).addTo(map);
  var floodLayer = null;
  var stationLayer = L.layerGroup().addTo(map);
  var placeLayer = L.layerGroup().addTo(map);
  var bboxLayer = L.rectangle([[CFG.bbox.south, CFG.bbox.west], [CFG.bbox.north, CFG.bbox.east]],
    { color: '#ffd54f', weight: 1, fill: false, dashArray: '4 4', interactive: false }).addTo(map);

  var layersCtl = L.control.layers({
    'ดาวเทียม + ชื่อสถานที่ (Esri)': esriHybrid,
    'ดาวเทียม (Google)': googleHybrid,
    'แผนที่ถนน (OSM)': osm
  }, {
    'แนวแม่น้ำแม่กลอง': riverLayer,
    'สถานีวัดระดับน้ำ': stationLayer,
    'ชุมชนเสี่ยง': placeLayer,
    'ขอบเขตคำนวณ': bboxLayer
  }, { collapsed: true }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  var primaryMarker = L.marker([PS.lat, PS.lon], { draggable: true, zIndexOffset: 1000, title: 'K.55A' })
    .addTo(map)
    .bindTooltip('K.55A ค่ายหลวง (ลากเพื่อปรับตำแหน่ง)', { direction: 'top', offset: [0, -30] });
  primaryMarker.on('dragend', function () {
    var ll = primaryMarker.getLatLng();
    PS.lat = ll.lat; PS.lon = ll.lng;
    scheduleSim();
  });

  // ---------------- สถานะ K.55A ----------------
  // ระดับที่ใช้คำนวณขอบเขตน้ำท่วม: โหมดคาดการณ์ = ยอดน้ำตลอดช่วง, โหมดกำหนดเอง = ค่าที่ป้อน
  function currentH() {
    if (state.scn === 'forecast' && state.fc) return state.fc.peak.h;
    return state.mode === 'q' ? R.levelFromDischarge(PS.ratingCurve, state.q) : state.h;
  }
  function currentQ() { return R.dischargeFromLevel(PS.ratingCurve, currentH()); }

  // ---------------- เวลา (เวลาประเทศไทย) ----------------
  var TZ = 'Asia/Bangkok';
  function fmtTime(t, opt) {
    if (t == null || !isFinite(t)) return '–';
    return new Date(t).toLocaleString('th-TH', Object.assign({ timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, opt || {})) + ' น.';
  }
  function toLocalInput(t) { return new Date(t + 7 * 3600000).toISOString().slice(0, 16); }
  function fromLocalInput(v) { return Date.parse(v + ':00+07:00'); }
  function parseStationTime(str) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(str || ''));
    return m ? Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':00+07:00') : NaN;
  }

  // ---------------- คาดการณ์ระดับน้ำตามเวลา ----------------
  function rebuildForecast() {
    state.fc = FC.build(Object.assign({}, FCP, { bank: PS.bank, ratingCurve: PS.ratingCurve }));
    renderForecastChart();
    renderForecastTable();
  }
  function fillForecastInputs() {
    $('fcTime').value = toLocalInput(typeof FCP.obs.time === 'number' ? FCP.obs.time : Date.parse(FCP.obs.time));
    $('fcLevel').value = FCP.obs.h;
    $('fcRate').value = FCP.riseRate;
    $('fcPeakAfter').value = FCP.peakAfterH;
    $('fcShape').value = FCP.riseShape;
    $('fcHold').value = FCP.holdH;
    $('fcFall').value = FCP.fallRate;
    $('fcHorizon').value = FCP.horizonH;
    var key = Object.keys(FC.PRESETS).filter(function (k) {
      var p = FC.PRESETS[k];
      return p.riseShape === FCP.riseShape && p.peakAfterH === FCP.peakAfterH && p.holdH === FCP.holdH && p.fallRate === FCP.fallRate;
    })[0];
    document.querySelectorAll('#presetSeg button').forEach(function (b) { b.classList.toggle('active', b.dataset.preset === key); });
    $('presetDesc').textContent = key ? FC.PRESETS[key].desc : 'กำหนดสมมติฐานเอง';
  }
  function forecastChanged() {
    rebuildForecast();
    renderStatus();
    scheduleSim();
  }

  // กราฟระดับน้ำตามเวลา (แกนเดียว: ม.รทก.; Q แสดงในป้ายเมื่อชี้)
  var chartGeom = null;
  function renderForecastChart() {
    var f = state.fc, svg = $('fcChart');
    if (!f) return;
    var W = 360, H = 200, ml = 32, mr = 10, mt = 12, mb = 28;
    var t0 = Math.min(f.start != null ? f.start : f.obs.t, f.obs.t), t1 = f.end;
    var ser = f.series(15, t0, t1);
    var hs = ser.map(function (p) { return p.h; });
    var hmin = Math.floor(Math.min(PS.bank - 0.5, Math.min.apply(null, hs)) * 2) / 2;
    var hmax = Math.ceil((Math.max(PS.bank, Math.max.apply(null, hs)) + 0.3) * 2) / 2;
    function x(t) { return ml + (t - t0) / (t1 - t0) * (W - ml - mr); }
    function y(h) { return mt + (hmax - h) / (hmax - hmin) * (H - mt - mb); }
    chartGeom = { x: x, y: y, t0: t0, t1: t1, ml: ml, mr: mr, W: W, H: H, mt: mt, mb: mb };
    var o = [];
    // พื้นที่เหนือตลิ่ง
    o.push('<rect class="over" x="' + ml + '" y="' + mt + '" width="' + (W - ml - mr) + '" height="' + Math.max(0, y(PS.bank) - mt) + '"/>');
    // เส้นกริด/แกน y
    var stepY = hmax - hmin > 4 ? 1 : 0.5;
    for (var v = Math.ceil(hmin / stepY) * stepY; v <= hmax + 1e-9; v += stepY) {
      o.push('<line class="grid" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
        '<text class="tick" x="' + (ml - 4) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + v.toFixed(stepY < 1 ? 1 : 0) + '</text>');
    }
    // แกน x: เที่ยงคืน (เส้น) + เที่ยงวัน (ขีด)
    var day0 = Date.parse(new Date(t0 + 7 * 3600000).toISOString().slice(0, 10) + 'T00:00:00+07:00');
    for (var d = day0; d <= t1; d += 12 * 3600000) {
      if (d < t0) continue;
      var midnight = ((d - day0) / 3600000) % 24 === 0;
      o.push('<line class="grid" x1="' + x(d) + '" x2="' + x(d) + '" y1="' + mt + '" y2="' + (H - mb) + '"' + (midnight ? '' : ' stroke-dasharray="1 3"') + '/>');
      if (midnight) o.push('<text class="tick" x="' + (x(d) + 2) + '" y="' + (H - mb + 11) + '">' +
        new Date(d).toLocaleDateString('th-TH', { timeZone: TZ, day: 'numeric', month: 'short' }) + '</text>');
    }
    o.push('<line class="axis" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + (H - mb) + '" y2="' + (H - mb) + '"/>');
    o.push('<text class="tick" x="' + ml + '" y="' + (H - 4) + '">ม.รทก. · เส้นทึบ = ค่าจริง/ตารางคาดการณ์ · เส้นประ = สมมติฐาน</text>');
    // ตลิ่ง
    o.push('<line class="bankline" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + y(PS.bank) + '" y2="' + y(PS.bank) + '"/>' +
      '<text class="lbl" x="' + (W - mr - 2) + '" y="' + (y(PS.bank) + 11) + '" text-anchor="end">ตลิ่ง ' + PS.bank.toFixed(2) + ' ม.</text>');
    // เส้นระดับน้ำ: ทึบถึงจุดคาดการณ์สุดท้าย ประหลังจากนั้น
    function path(pts) { return pts.map(function (p, i) { return (i ? 'L' : 'M') + x(p.t).toFixed(1) + ',' + y(p.h).toFixed(1); }).join(''); }
    var solid = ser.filter(function (p) { return p.t <= f.last.t; });
    solid.push({ t: f.last.t, h: f.hAt(f.last.t) });
    var model = [{ t: f.last.t, h: f.hAt(f.last.t) }].concat(ser.filter(function (p) { return p.t > f.last.t; }));
    o.push('<path class="series" d="' + path(solid) + '"/>');
    if (model.length > 1) o.push('<path class="series model" d="' + path(model) + '"/>');
    // ค่าล่าสุด
    o.push('<line class="nowline" x1="' + x(f.obs.t) + '" x2="' + x(f.obs.t) + '" y1="' + mt + '" y2="' + (H - mb) + '"/>' +
      '<text class="tick" x="' + (x(f.obs.t) + 3) + '" y="' + (mt + 8) + '">ล่าสุด</text>');
    f.known.forEach(function (p) {
      o.push('<circle class="pt" cx="' + x(p.t) + '" cy="' + y(p.h) + '" r="' + (p.kind === 'obs' ? 4.5 : 3) + '"/>');
    });
    // ยอดน้ำ
    var px = x(f.peak.t), py = y(f.peak.h), anchor = px > W - 110 ? 'end' : 'start';
    o.push('<circle class="pt" cx="' + px + '" cy="' + py + '" r="4"/>' +
      '<text class="lbl" x="' + (px + (anchor === 'end' ? -6 : 6)) + '" y="' + (py - mt < 14 ? py + 14 : py - 5) + '" text-anchor="' + anchor + '">ยอด ' +
      f.peak.h.toFixed(2) + ' ม. · ' + fmtTime(f.peak.t) + '</text>');
    // เวลาที่เลือกบนแผนที่
    if (state.selTime != null && state.selTime >= t0 && state.selTime <= t1) {
      o.push('<line class="selline" x1="' + x(state.selTime) + '" x2="' + x(state.selTime) + '" y1="' + mt + '" y2="' + (H - mb) + '"/>');
    }
    o.push('<g id="fcCross" visibility="hidden"><line class="cross" y1="' + mt + '" y2="' + (H - mb) + '"/><circle class="pt" r="4"/></g>');
    svg.innerHTML = o.join('');
  }

  function chartTimeAt(ev) {
    var g = chartGeom, svg = $('fcChart');
    if (!g) return null;
    var r = svg.getBoundingClientRect();
    var sx = (ev.clientX - r.left) / r.width * g.W;
    if (sx < g.ml || sx > g.W - g.mr) return null;
    return g.t0 + (sx - g.ml) / (g.W - g.ml - g.mr) * (g.t1 - g.t0);
  }
  function statusText(h) {
    var ex = h - PS.bank;
    return ex > 0 ? 'ล้นตลิ่ง ' + ex.toFixed(2) + ' ม.' : 'ต่ำกว่าตลิ่ง ' + (-ex).toFixed(2) + ' ม.';
  }
  function onChartMove(ev) {
    var t = chartTimeAt(ev), f = state.fc, g = chartGeom, tip = $('fcTip'), cross = $('fcCross');
    if (t == null || !f) { tip.hidden = true; if (cross) cross.setAttribute('visibility', 'hidden'); return; }
    var h = f.hAt(t), q = f.qAt(t);
    cross.setAttribute('visibility', 'visible');
    cross.firstChild.setAttribute('x1', g.x(t)); cross.firstChild.setAttribute('x2', g.x(t));
    cross.lastChild.setAttribute('cx', g.x(t)); cross.lastChild.setAttribute('cy', g.y(h));
    tip.hidden = false;
    tip.innerHTML = '<b>' + fmtTime(t) + '</b><br>ระดับ ' + h.toFixed(2) + ' ม.รทก. · ' + statusText(h) +
      '<br>Q ≈ ' + fmt(q) + ' ลบ.ม./วินาที' + (q > PS.bankfullQ ? ' (เกินความจุ ' + fmt(q - bankfullQ()) + ')' : '') +
      (t > f.last.t ? '<br><span class="muted">ช่วงสมมติฐาน</span>' : '') +
      (state.hsum && state.simStart != null ? '<br><span class="muted">คลิกเพื่อดูแผนที่ ณ เวลานี้</span>' : '');
    var wrap = $('fcChart').getBoundingClientRect(), left = ev.clientX - wrap.left + 10;
    if (left > wrap.width - 170) left = ev.clientX - wrap.left - 170;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = Math.max(0, ev.clientY - wrap.top - 50) + 'px';
  }
  function onChartClick(ev) {
    var t = chartTimeAt(ev);
    if (t == null || !state.hsum || state.simStart == null) return;
    var n = state.hydro.snapshots.length;
    var best = 0, bd = Infinity;
    for (var i = 0; i < n; i++) {
      var dd = Math.abs(state.simStart + state.hydro.snapshots[i].t * 1000 - t);
      if (dd < bd) { bd = dd; best = i; }
    }
    state.timeIdx = best;
    $('spreadRange').value = best;
    onTimeChanged();
  }

  function renderForecastTable() {
    var f = state.fc;
    if (!f) return;
    var rows = f.series(180, Math.ceil(f.obs.t / 3600000) * 3600000, f.end);
    var html = '';
    if (f.milestones.length) {
      html += '<p class="small"><b>ระดับน้ำจะถึง</b> ' + f.milestones.map(function (m) {
        return m.h.toFixed(2) + ' ม. ' + fmtTime(m.t);
      }).join(' · ') + '</p>';
    }
    html += '<table><tr><th>เวลา</th><th>ระดับ (ม.รทก.)</th><th>เทียบตลิ่ง (ม.)</th><th>Q (ลบ.ม./วิ)</th><th>เกินความจุ</th></tr>';
    rows.forEach(function (r) {
      var ex = r.h - PS.bank, cls = Math.abs(r.t - f.peak.t) < 90 * 60000 ? 'peak' : '';
      html += '<tr class="' + cls + '"><td>' + fmtTime(r.t) + '</td><td>' + r.h.toFixed(2) + '</td><td>' + (ex > 0 ? '+' : '') + ex.toFixed(2) +
        '</td><td>' + fmt(r.q) + '</td><td>' + (r.q > bankfullQ() ? fmt(r.q - bankfullQ()) : '–') + '</td></tr>';
    });
    $('fcTable').innerHTML = html + '</table>';
  }

  function setScenario(scn) {
    state.scn = scn;
    document.querySelectorAll('#scnSeg button').forEach(function (b) { b.classList.toggle('active', b.dataset.scn === scn); });
    $('fcBox').hidden = scn !== 'forecast';
    $('manualBox').hidden = scn !== 'manual';
    renderStatus(); scheduleSim();
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('#modeSeg button').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === mode); });
    var r = $('valueRange'), i = $('valueInput');
    if (mode === 'q') {
      r.min = 1000; r.max = 4200; r.step = 10; i.step = 10;
      state.q = Math.round(currentQFromH(state.h));
      r.value = i.value = state.q;
    } else {
      r.min = 7; r.max = 14; r.step = 0.01; i.step = 0.01;
      r.value = i.value = state.h.toFixed(2);
    }
    renderStatus(); scheduleSim();
  }
  function currentQFromH(h) { return R.dischargeFromLevel(PS.ratingCurve, h); }

  function setValue(v) {
    v = parseFloat(v);
    if (!isFinite(v)) return;
    if (state.mode === 'q') { state.q = v; state.h = R.levelFromDischarge(PS.ratingCurve, v); }
    else { state.h = v; state.q = R.dischargeFromLevel(PS.ratingCurve, v); }
    $('valueRange').value = v; $('valueInput').value = v;
    renderStatus(); scheduleSim();
  }

  function renderChips() {
    var box = $('curveChips');
    box.innerHTML = '';
    PS.ratingCurve.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = fmt(p[0]) + ' → ' + p[1].toFixed(2);
      b.title = 'Q ' + fmt(p[0]) + ' ลบ.ม./วินาที = ระดับ ' + p[1].toFixed(2) + ' ม.รทก.';
      b.onclick = function () {
        if (state.mode === 'q') setValue(p[0]);
        else setValue(p[1]);
      };
      box.appendChild(b);
    });
  }

  function renderStatus() {
    var el = $('k55Status');
    $('bankInfo').innerHTML = 'ระดับตลิ่ง <b>' + PS.bank.toFixed(2) + ' ม.รทก.</b> ทั้งสองฝั่ง · รองรับน้ำได้ <b>' + fmt(bankfullQ()) + '</b> ลบ.ม./วินาที';
    if (state.scn === 'forecast' && state.fc) {
      var f = state.fc, oq = f.qAt(f.obs.t), maxRating = PS.ratingCurve[PS.ratingCurve.length - 1][1];
      var lvl = f.obs.h > PS.bank ? 2 : (f.peak.h > PS.bank ? 1 : 0);
      el.className = 'status l' + lvl;
      el.innerHTML = 'ล่าสุด ' + fmtTime(f.obs.t) + ': <b class="big">' + f.obs.h.toFixed(2) + ' ม.รทก.</b><br>' +
        '<b>' + statusText(f.obs.h) + '</b> · Q ≈ ' + fmt(oq) + ' ลบ.ม./วินาที' +
        (oq > bankfullQ() ? ' (เกินความจุ ' + fmt(oq - bankfullQ()) + ')' : '') + '<br>' +
        'คาดสูงสุด <b>' + f.peak.h.toFixed(2) + ' ม.</b> (Q ≈ ' + fmt(f.peak.q) + ') ' + fmtTime(f.peak.t) + '<br>' +
        (f.start != null ? 'น้ำเริ่มล้นตลิ่ง ~' + fmtTime(f.start) + ' · ' : '') +
        (f.recede != null ? 'ลดต่ำกว่าตลิ่ง ~' + fmtTime(f.recede) : (f.peak.h > PS.bank ? 'ยังไม่ลดต่ำกว่าตลิ่งภายใน ' + fmtTime(f.end) : '')) +
        (f.peak.h > maxRating ? '<br><span class="small">⚠ ยอดน้ำสูงกว่าช่วง rating curve (' + maxRating.toFixed(2) + ' ม.) ค่า Q ช่วงนั้นเป็นการต่อเส้นตรง</span>' : '');
      var hSel = state.selTime != null ? f.hAt(state.selTime) : f.obs.h;
      drawCrossSection(hSel, state.selTime != null ? fmtTime(state.selTime) : 'ล่าสุด');
      return;
    }
    var h = currentH(), q = currentQ();
    var st = R.bankStatus(h, PS.leftBank, PS.rightBank);
    el.className = 'status l' + st.level;
    var extra = st.level === 0
      ? 'ต่ำกว่าตลิ่ง <b>' + fmt(st.freeboard, 2) + ' ม.</b> · รับน้ำเพิ่มได้อีกประมาณ <b>' + fmt(bankfullQ() - q) + '</b> ลบ.ม./วินาที'
      : 'สูงกว่าตลิ่ง <b>' + fmt(h - PS.bank, 2) + ' ม.</b> · เกินความจุ <b>' + fmt(q - bankfullQ()) + '</b> ลบ.ม./วินาที';
    el.innerHTML = '<b class="big">' + h.toFixed(2) + ' ม.รทก.</b> · Q ≈ ' + fmt(q) + ' ลบ.ม./วินาที<br>' +
      '<b>' + st.label + '</b> — ' + extra;
    drawCrossSection(h);
  }

  // รูปตัดลำน้ำอย่างง่าย (อิงภาพจาก สำนักงานชลประทานที่ 13)
  function drawCrossSection(h, when) {
    var svg = $('xsec');
    var W = 320, H = 150, top = PS.bank - 1.5, bottom = Math.max(PS.bank + 4, h + 0.5);
    function y(v) { return 12 + (bottom - v) / (bottom - top) * (H - 40); }
    var yl = y(PS.leftBank), yr = y(PS.rightBank), yw = y(Math.max(top, Math.min(bottom, h)));
    var bed = H - 8;
    var parts = [];
    // ระดับตาม rating curve
    var lastY = -99;
    PS.ratingCurve.forEach(function (p) {
      if (p[1] < top || p[1] > bottom) return;
      var yy = y(p[1]);
      if (Math.abs(yy - lastY) < 9) return; // ไม่ให้ป้ายซ้อนกัน
      lastY = yy;
      parts.push('<line x1="40" x2="280" y1="' + yy + '" y2="' + yy + '" stroke="#7a8fb3" stroke-dasharray="4 3" stroke-width="0.7"/>' +
        '<text x="282" y="' + (yy + 3) + '" font-size="7" fill="#51607a">' + fmt(p[0]) + '</text>');
    });
    // น้ำ
    var over = h > Math.min(PS.leftBank, PS.rightBank);
    var waterPath = over
      ? 'M0,' + yw + ' L320,' + yw + ' L320,' + H + ' L0,' + H + ' Z'
      : 'M' + (70 + (yw - yl) * 0.3) + ',' + yw + ' L' + (250 - (yw - yr) * 0.3) + ',' + yw + ' L220,' + bed + ' L100,' + bed + ' Z';
    parts.unshift('<path d="' + waterPath + '" fill="' + (over ? 'rgba(214,40,40,0.45)' : 'rgba(30,136,229,0.65)') + '"/>');
    // ตลิ่ง/พื้นดิน
    parts.push('<path d="M0,' + yl + ' L70,' + yl + ' L100,' + bed + ' L220,' + bed + ' L250,' + yr + ' L320,' + yr +
      ' L320,' + H + ' L0,' + H + ' Z" fill="#8d6e4a" opacity="0.85"/>');
    if (over) parts.push('<path d="' + waterPath + '" fill="rgba(214,40,40,0.25)"/>');
    parts.push('<line x1="0" x2="320" y1="' + yw + '" y2="' + yw + '" stroke="' + (over ? '#c62828' : '#1565c0') + '" stroke-width="1.6"/>');
    parts.push('<text x="4" y="' + (yl + 12) + '" font-size="9" fill="#fff">ตลิ่ง ' + PS.leftBank.toFixed(2) + '</text>');
    parts.push('<text x="316" y="' + (yr + 12) + '" font-size="9" fill="#fff" text-anchor="end">ตลิ่ง ' + PS.rightBank.toFixed(2) + '</text>');
    parts.push('<text x="160" y="' + (yw - 4) + '" font-size="10" font-weight="700" text-anchor="middle" fill="' +
      (over ? '#b71c1c' : '#0d47a1') + '">▼ ' + h.toFixed(2) + ' ม.รทก.' + (when ? ' (' + when + ')' : '') + '</text>');
    svg.innerHTML = parts.join('');
  }

  // ---------------- โปรไฟล์ลำน้ำ (จุดควบคุม) ----------------
  function controlPoints() {
    var line = state.riverLine;
    var pj = M.projectToLine(line, PS.lat, PS.lon);
    var cps = [{
      name: 'K.55A', chainage: pj.chainage, ws: currentH(),
      leftBank: PS.leftBank, rightBank: PS.rightBank, primary: true
    }];
    if ($('useStations').checked) {
      state.stations.forEach(function (s) {
        if (s.isPrimary || !isFinite(s.lat) || !isFinite(s.wl) || !isFinite(s.minBank)) return;
        var p = M.projectToLine(line, s.lat, s.lon);
        if (!p || p.distKm > P.stationSnapKm) return;
        // สถานีที่อยู่ใกล้ K.55A มาก (< 2 กม.) ข้ามเพื่อไม่ให้ขัดกับเกณฑ์หลัก
        if (Math.abs(p.chainage - pj.chainage) < 2) return;
        // ถ้ามีระดับจริงของ K.55A: เลื่อนระดับน้ำของสถานีตามส่วนต่างของสถานการณ์ที่เลือก
        // (ถ้าเลือกสถานการณ์ = ค่าจริง จะได้ค่าจริงของทุกสถานี)
        // ถ้าไม่มี: ใช้เฉพาะระดับตลิ่งของสถานี ส่วนระดับน้ำคำนวณจาก K.55A และความลาดชัน
        var ws = state.k55Observed != null ? s.wl + (currentH() - state.k55Observed) : NaN;
        cps.push({
          name: s.name, chainage: p.chainage, ws: ws,
          leftBank: isFinite(s.leftBank) ? s.leftBank : s.minBank,
          rightBank: isFinite(s.rightBank) ? s.rightBank : s.minBank
        });
      });
    }
    return cps;
  }

  // ---------------- DEM + จำลอง ----------------
  var simTimer = null, simBusy = false, simAgain = false;
  function scheduleSim() {
    clearTimeout(simTimer);
    simTimer = setTimeout(runSim, 250);
  }

  function ensureGrid() {
    var z = parseInt(P.demZoom, 10);
    if (state.grid && state.gridZoom === z) return Promise.resolve(state.grid);
    $('simStatus').textContent = 'กำลังโหลดความสูงภูมิประเทศ (DEM) ซูม ' + z + '…';
    return window.DEM.loadGrid(CFG.bbox, z, function (d, t, f) {
      $('simStatus').textContent = 'กำลังโหลด DEM ' + d + '/' + t + ' แผ่น' + (f ? ' (ล้มเหลว ' + f + ')' : '') + '…';
    }).then(function (g) {
      state.grid = g; state.gridZoom = z; state.river = null;
      return g;
    });
  }

  function runSim() {
    if (simBusy) { simAgain = true; return; }
    simBusy = true;
    ensureGrid().then(function (grid) {
      if (!state.river || state.river.halfWidth !== P.channelHalfWidthM || state.river.line !== state.riverLine) {
        state.river = M.rasterizeRiver(grid, state.riverLine, P.channelHalfWidthM);
        state.river.halfWidth = P.channelHalfWidthM;
        state.river.line = state.riverLine;
        state.river.bankDev = M.bankDeviation(grid, state.river);
      }
      var t0 = performance.now();
      var cps = controlPoints();
      var profile = M.makeProfile(cps, P.riverSlopeMPerKm);
      state.profile = profile;
      state.volumeM3 = overflowVolume();
      state.result = M.simulate(grid, state.river, profile, {
        demOffsetM: P.demOffsetM, maxSpreadKm: P.maxSpreadKm,
        bankDev: state.river.bankDev, bankDevWeight: P.bankDemWeight,
        waterBodyDepthM: P.waterBodyDepthM,
        volumeM3: P.limitByVolume && !P.dynamicFlow ? state.volumeM3 : null
      });
      var ms = performance.now() - t0;
      $('simStatus').innerHTML = 'คำนวณเสร็จใน ' + fmt(ms) + ' มิลลิวินาที · ตาราง ' + grid.w + '×' + grid.h +
        ' (' + fmt(state.result.pxM) + ' ม./พิกเซล) · จุดควบคุม ' + cps.length + ' จุด · แนวลำน้ำ: ' + esc(state.riverSource) +
        (grid.missingTiles ? '<br><span style="color:var(--warn)">⚠ โหลด DEM ไม่ได้ ' + grid.missingTiles + '/' + grid.totalTiles +
          ' แผ่น — บริเวณนั้นไม่ถูกคำนวณ (เปลี่ยนความละเอียดเพื่อโหลดใหม่)</span>' : '');
      state.cps = cps;
      stopFlow();
      renderFlood();
      renderResults(cps);
      renderPlaces();
      if (P.dynamicFlow) startFlow(grid, state.result);
    }).catch(function (e) {
      console.error(e);
      $('simStatus').innerHTML = '<span style="color:var(--bad)">ผิดพลาด: ' + esc(e.message) + '</span>';
    }).then(function () {
      simBusy = false;
      if (simAgain) { simAgain = false; runSim(); }
    });
  }

  // ---------------- การใช้ที่ดิน (ESA WorldCover) ----------------
  var lcPromise = null;
  function landcoverRaster() {
    if (lcPromise) return lcPromise;
    var LC = window.LANDCOVER;
    lcPromise = !LC ? Promise.resolve(null) : new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = LC.w; c.height = LC.h;
        var ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        var px = ctx.getImageData(0, 0, LC.w, LC.h).data, cls = new Uint8Array(LC.w * LC.h);
        for (var i = 0; i < cls.length; i++) cls[i] = Math.round(px[i * 4] / LC.scale);
        resolve({ z: LC.z, x0: LC.x0, y0: LC.y0, w: LC.w, h: LC.h, cls: cls });
      };
      img.onerror = function () { resolve(null); };
      img.src = LC.png;
    });
    return lcPromise;
  }
  function landuseForGrid(grid) {
    if (grid.landuse !== undefined) return Promise.resolve(grid.landuse);
    return landcoverRaster().then(function (lc) {
      if (!lc) { grid.landuse = null; return null; }
      var out = new Uint8Array(grid.w * grid.h), sc = Math.pow(2, lc.z - grid.z);
      for (var y = 0; y < grid.h; y++) for (var x = 0; x < grid.w; x++) {
        var X = Math.floor((grid.x0 + x + 0.5) * sc) - lc.x0, Y = Math.floor((grid.y0 + y + 0.5) * sc) - lc.y0;
        out[y * grid.w + x] = X < 0 || Y < 0 || X >= lc.w || Y >= lc.h ? 4 : lc.cls[Y * lc.w + X];
      }
      grid.landuse = out;
      return out;
    });
  }

  // ---------------- จำลองการไหลของน้ำ 2 มิติ ----------------
  var flowToken = 0;
  function stopFlow() {
    flowToken++;
    state.hydro = null; state.hsum = null; state.liveDepth = null; state.depthCache = {}; state.timeIdx = -1; state.selTime = null;
    $('flowResults').innerHTML = '';
    setupTimeline();
  }
  function damageValues() {
    return {
      builtBahtPerM2: P.builtBahtPerM2, cropBahtPerRai: P.cropBahtPerRai, treeBahtPerRai: P.treeBahtPerRai,
      otherBahtPerRai: P.otherBahtPerRai, compensationBahtPerRai: P.damageBahtPerRai
    };
  }
  function startFlow(grid, bath) {
    var token = flowToken;
    var qx = Math.max(0, currentQ() - bankfullQ());
    if (!(bath.stats.areaRai > 0) && !(bath.envelopeStats && bath.envelopeStats.areaRai > 0)) return;
    var f = state.scn === 'forecast' ? state.fc : null;
    state.simStart = f && f.start != null ? f.start : null;
    if (f && f.start == null) qx = 0;
    if (qx <= 0) {
      $('flowResults').innerHTML = '<p class="small">K.55A ยังไม่เกินตลิ่ง (Q ≤ ' + fmt(bankfullQ()) +
        ') จึงไม่มีน้ำไหลล้นเข้าพื้นที่ในการจำลองการไหล — แผนที่แสดงเฉพาะพื้นที่ต่ำกว่าระดับน้ำ</p>';
      return;
    }
    landuseForGrid(grid).then(function (lu) {
      if (token !== flowToken) return;
      var opts = {
        inflowQ: qx, durationH: P.overflowHours, demOffsetM: P.demOffsetM,
        maxCells: P.flowMaxCells, waterBodyDepthM: P.waterBodyDepthM, snapshotMin: 60
      };
      if (f) {
        // น้ำล้นตามกราฟคาดการณ์ ตั้งแต่เริ่มล้นตลิ่งจนสิ้นสุดช่วงคาดการณ์
        var simT0 = f.start, hp = f.peak.h, bq = bankfullQ();
        opts.durationH = (f.end - simT0) / 3600000;
        opts.inflowFn = function (t) { return f.qAt(simT0 + t * 1000) - bq; };
        opts.stageFn = function (t) { return f.hAt(simT0 + t * 1000) - hp; };
      }
      var s = HY.setup(grid, bath, lu, opts);
      state.hydro = s;
      var t0 = performance.now(), lastDraw = 0;
      (function tick() {
        if (token !== flowToken) return;
        var done = HY.run(s, 50);
        var pct = Math.min(100, s.t / s.T * 100);
        $('flowResults').innerHTML = '<p class="small">กำลังจำลองการไหลของน้ำ: ' +
          (state.simStart != null ? fmtTime(state.simStart + s.t * 1000) + ' (ถึง ' + fmtTime(state.simStart + s.T * 1000) + ')' : 'ชั่วโมงที่ ' + fmt(s.t / 3600, 1) + ' / ' + fmt(P.overflowHours)) +
          ' · ' + fmt(s.nc) + ' เซลล์ (' + fmt(s.dx) + ' ม.) · น้ำเข้าพื้นที่ ' + fmt(s.volIn / 1e6, 1) + ' ล้าน ลบ.ม.</p>' +
          '<div class="progress"><div style="width:' + pct.toFixed(1) + '%"></div></div>';
        var now = performance.now();
        if (done || now - lastDraw > 600) {
          lastDraw = now;
          state.liveDepth = HY.fineDepth(s, s.h);
          renderFlood();
        }
        if (!done) { setTimeout(tick, 0); return; }
        state.liveDepth = null;
        state.hsum = HY.summarize(s, damageValues());
        state.flowMs = performance.now() - t0;
        state.timeIdx = -1;
        setupTimeline();
        renderFlood();
        renderFlowResults();
        renderPlaces();
      })();
    }).catch(function (e) {
      console.error(e);
      $('flowResults').innerHTML = '<p class="small" style="color:var(--bad)">จำลองการไหลไม่สำเร็จ: ' + esc(e.message) + '</p>';
    });
  }

  function setupTimeline() {
    var s = state.hydro, r = $('spreadRange');
    if (!s || !state.hsum) { r.max = 100; r.value = Math.round(state.spread * 100); return; }
    r.max = s.snapshots.length; // ตำแหน่งสุดท้าย = ค่าสูงสุดตลอดเหตุการณ์
    r.value = s.snapshots.length;
    updateTimeLabel();
  }
  function updateTimeLabel() {
    var s = state.hydro;
    if (!s || !state.hsum) return;
    if (state.timeIdx < 0) {
      state.selTime = null;
      $('spreadLabel').textContent = 'สูงสุดตลอด' + (state.simStart != null ? 'ช่วงคาดการณ์' : ' ' + fmt(P.overflowHours) + ' ชม.');
      return;
    }
    var st = s.snapshots[state.timeIdx].t;
    if (state.simStart != null) {
      state.selTime = state.simStart + st * 1000;
      $('spreadLabel').textContent = fmtTime(state.selTime) + ' · ' + state.fc.hAt(state.selTime).toFixed(2) + ' ม.';
    } else {
      state.selTime = null;
      $('spreadLabel').textContent = 'ชั่วโมงที่ ' + fmt(st / 3600, 0);
    }
  }
  function onTimeChanged() {
    updateTimeLabel();
    renderFlood();
    if (state.scn === 'forecast') { renderForecastChart(); renderStatus(); }
  }
  function currentFlowDepth() {
    var s = state.hydro;
    if (state.liveDepth) return state.liveDepth;
    if (!state.hsum) return null;
    if (state.timeIdx < 0) return state.hsum.depth;
    var c = state.depthCache[state.timeIdx];
    if (!c) c = state.depthCache[state.timeIdx] = HY.fineDepth(s, s.snapshots[state.timeIdx].h);
    return c;
  }

  // ปริมาตรน้ำที่ล้นตลิ่ง = (Q − Q ที่ระดับตลิ่งต่ำสุด) × ระยะเวลา
  function bankfullQ() { return R.dischargeFromLevel(PS.ratingCurve, PS.bank); }
  function overflowVolume() { return Math.max(0, currentQ() - bankfullQ()) * P.overflowHours * 3600; }

  // ---------------- ชั้นแสดงผล ----------------
  var VIEWS = {
    depth: {
      title: 'ความลึกน้ำท่วม',
      classes: [[0.5, '0–0.5 ม.', [129, 212, 250, 150]], [1, '0.5–1 ม.', [41, 182, 246, 175]],
        [2, '1–2 ม.', [21, 101, 192, 195]], [Infinity, '> 2 ม.', [13, 27, 110, 215]]]
    },
    velocity: {
      title: 'ความเร็วกระแสน้ำสูงสุด (➝ ทิศทาง)',
      classes: [[0.3, '< 0.3 ม./วิ (ไหลช้า)', [255, 255, 178, 170]], [0.6, '0.3–0.6 ม./วิ', [254, 204, 92, 190]],
        [1.0, '0.6–1 ม./วิ', [253, 141, 60, 200]], [2.0, '1–2 ม./วิ (ไหลแรง)', [240, 59, 32, 210]],
        [Infinity, '> 2 ม./วิ (ไหลแรงมาก)', [140, 0, 30, 220]]]
    },
    hazard: {
      title: 'ระดับอันตรายต่อคน d×(v+0.5)+DF',
      classes: HY.HAZARD.map(function (h, i) {
        return [i, h.label, [[170, 215, 110, 180], [255, 200, 60, 195], [240, 110, 40, 205], [165, 15, 30, 220]][i]];
      })
    },
    damage: {
      title: 'ความเสียหายทางเศรษฐกิจ (บาท/ตร.ม.)',
      classes: [[1, '< 1', [242, 240, 247, 150]], [10, '1–10 (เกษตร)', [203, 201, 226, 180]],
        [100, '10–100', [158, 154, 200, 195]], [1000, '100–1,000 (บ้านเรือน)', [117, 107, 177, 210]],
        [Infinity, '> 1,000', [74, 20, 134, 225]]]
    },
    arrival: {
      title: 'เวลาที่น้ำมาถึง (หลังเริ่มล้นตลิ่ง)',
      classes: [[3, '< 3 ชม.', [165, 0, 38, 210]], [6, '3–6 ชม.', [244, 109, 67, 200]], [12, '6–12 ชม.', [254, 224, 139, 190]],
        [24, '12–24 ชม.', [171, 217, 233, 190]], [Infinity, '> 24 ชม.', [69, 117, 180, 190]]]
    }
  };
  function classColor(view, v) {
    var cl = VIEWS[view].classes;
    for (var i = 0; i < cl.length; i++) if (v <= cl[i][0]) return cl[i][2];
    return cl[cl.length - 1][2];
  }
  function depthColor(d) { return classColor('depth', d); }
  var LEGEND = VIEWS.depth.classes.map(function (c) { return [c[1], c[2]]; });
  var ENVELOPE_COLOR = [255, 213, 79, 90];

  function renderFlood() {
    var g = state.grid, r = state.result;
    if (!g || !r) return;
    var canvas = renderFlood.canvas || (renderFlood.canvas = document.createElement('canvas'));
    canvas.width = g.w; canvas.height = g.h;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(g.w, g.h), px = img.data;
    var hs = state.hydro, sum = state.hsum, fd = hs ? currentFlowDepth() : null;
    var k, j, c, d;
    if (hs && fd) {
      var view = state.liveDepth ? 'depth' : (state.timeIdx >= 0 && (state.view === 'hazard' || state.view === 'damage') ? 'depth' : state.view);
      var showEnv = view === 'depth' && !state.liveDepth && state.timeIdx < 0;
      for (var y = 0; y < g.h; y++) for (var x = 0; x < g.w; x++) {
        k = y * g.w + x; j = k * 4; c = null; d = fd[k];
        if (d > 0.02) {
          if (view === 'depth') c = depthColor(d);
          else if (view === 'hazard') c = sum.hazard[k] < 255 ? VIEWS.hazard.classes[sum.hazard[k]][2] : null;
          else if (view === 'damage') c = classColor('damage', sum.damagePerM2[k]);
          else {
            var a = HY.coarseOf(hs, x, y);
            if (a < 0) continue;
            if (view === 'velocity') c = classColor('velocity', hs.vmax[a]);
            else if (view === 'arrival') c = hs.tArrive[a] >= 0 ? classColor('arrival', hs.tArrive[a] / 3600) : null;
          }
        } else if (showEnv && r.envelope[k] > 0) c = ENVELOPE_COLOR;
        if (c) { px[j] = c[0]; px[j + 1] = c[1]; px[j + 2] = c[2]; px[j + 3] = c[3]; }
      }
      ctx.putImageData(img, 0, 0);
      if (view === 'velocity' && !state.liveDepth) drawArrows(ctx, hs);
    } else {
      var limit = Math.round(state.spread * Math.max(1, r.stats.maxDistSteps));
      var showEnv2 = r.volumeLimited && state.spread >= 1;
      for (k = 0, j = 0; k < r.depth.length; k++, j += 4) {
        d = r.depth[k]; c = null;
        if (d > 0 && r.dist[k] <= limit) c = depthColor(d);
        else if (showEnv2 && r.envelope[k] > 0) c = ENVELOPE_COLOR;
        if (c) { px[j] = c[0]; px[j + 1] = c[1]; px[j + 2] = c[2]; px[j + 3] = c[3]; }
      }
      ctx.putImageData(img, 0, 0);
      $('spreadLabel').textContent = '≤ ' + fmt(limit * r.pxM / 1000, 1) + ' กม. จากตลิ่ง';
    }
    var bounds = [[M.yToLat(g.y0 + g.h, g.z), M.xToLon(g.x0, g.z)], [M.yToLat(g.y0, g.z), M.xToLon(g.x0 + g.w, g.z)]];
    var url = canvas.toDataURL('image/png');
    if (floodLayer) floodLayer.setUrl(url);
    else {
      floodLayer = L.imageOverlay(url, bounds, { pane: 'flood', opacity: 0.85, interactive: false }).addTo(map);
      layersCtl.addOverlay(floodLayer, 'ผลคาดการณ์น้ำท่วม');
    }
    renderLegend();
  }

  // ลูกศรทิศทางการไหล ณ เวลาที่ไหลแรงที่สุด (ยาวตามความเร็ว)
  function drawArrows(ctx, hs) {
    var step = Math.max(1, Math.round(10 / hs.f)); // ห่างกันประมาณ 10 พิกเซลละเอียด
    ctx.lineWidth = 1.2;
    for (var a = 0; a < hs.nc; a++) {
      var gc = hs.cells[a], cx = gc % hs.W, cy = (gc - cx) / hs.W;
      if (cx % step || cy % step) continue;
      var v = hs.vmax[a];
      if (v < 0.15) continue;
      var ux = hs.vxAtMax[a] / v, uy = hs.vyAtMax[a] / v;
      var x0 = (cx + 0.5) * hs.f, y0 = (cy + 0.5) * hs.f, len = 3 + Math.min(v, 3) * 3;
      var x1 = x0 + ux * len, y1 = y0 + uy * len;
      ctx.strokeStyle = v >= 1 ? 'rgba(80,0,20,0.95)' : 'rgba(40,40,40,0.8)';
      ctx.beginPath();
      ctx.moveTo(x0 - ux * len * 0.3, y0 - uy * len * 0.3); ctx.lineTo(x1, y1);
      ctx.lineTo(x1 - ux * 2.5 - uy * 1.8, y1 - uy * 2.5 + ux * 1.8);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - ux * 2.5 + uy * 1.8, y1 - uy * 2.5 - ux * 1.8);
      ctx.stroke();
    }
  }

  function renderFlowResults() {
    var hs = state.hydro, S = state.hsum;
    if (!hs || !S) return;
    var total = S.hazardRai.reduce(function (a, b) { return a + b; }, 0) || 1;
    var html = '<h3>ผลจำลองการไหลของน้ำ ' + (state.simStart != null ? fmtTime(state.simStart) + ' – ' + fmtTime(state.simStart + hs.T * 1000)
      : fmt(P.overflowHours) + ' ชั่วโมง') + '</h3><div class="kpis">' +
      kpi(fmt(S.areaRai), 'ไร่ น้ำท่วมสูงสุด (' + fmt(S.areaKm2, 1) + ' ตร.กม.)') +
      kpi(fmt(S.lossBaht / 1e6, 1) + ' ล้าน', 'บาท ความเสียหายทางเศรษฐกิจโดยประมาณ') +
      kpi(fmt(S.v99, 2) + ' / ' + fmt(S.vmax, 1), 'ม./วินาที ความเร็วน้ำ (P99 / สูงสุด)') +
      kpi(fmt(S.fastRai), 'ไร่ น้ำไหลแรง ≥ 1 ม./วินาที') +
      kpi(fmt(S.heavyBuiltRai, 1), 'ไร่ เขตบ้านเรือนเสี่ยงเสียหายหนัก (d·v ≥ 3)') +
      kpi(fmt(S.volInM3 / 1e6, 1) + ' / ' + fmt((S.volOutM3 || 0) / 1e6, 1), 'ล้าน ลบ.ม. น้ำล้นเข้าพื้นที่ / ไหลกลับลงแม่น้ำ') +
      '</div>';
    html += '<table class="cls"><tr><td colspan="3"><b>ระดับอันตรายต่อคน</b></td></tr>';
    HY.HAZARD.forEach(function (h, i) {
      var c = VIEWS.hazard.classes[i][2];
      html += '<tr><td><span class="sw" style="background:rgba(' + c.slice(0, 3).join(',') + ',0.95)"></span>' + esc(h.label) +
        '<br><span class="muted">' + esc(h.desc) + '</span></td><td class="n">' + fmt(S.hazardRai[i]) + ' ไร่</td><td class="n">' +
        fmt(S.hazardRai[i] / total * 100) + '%</td></tr>';
    });
    html += '</table><table class="cls"><tr><td colspan="3"><b>ความเสียหายตามการใช้ที่ดิน</b></td></tr>';
    [['built', 'บ้านเรือน/สิ่งปลูกสร้าง'], ['crop', 'นาข้าว/พืชไร่'], ['tree', 'สวน/ไม้ยืนต้น'], ['other', 'อื่นๆ']].forEach(function (g) {
      var v = S.groups[g[0]];
      html += '<tr><td>' + g[1] + '</td><td class="n">' + fmt(v.area / 1600) + ' ไร่</td><td class="n">' + fmt(v.loss / 1e6, 1) + ' ล้านบาท</td></tr>';
    });
    html += '<tr><td><b>รวม</b></td><td class="n"><b>' + fmt(S.areaRai) + ' ไร่</b></td><td class="n"><b>' + fmt(S.lossBaht / 1e6, 1) + ' ล้านบาท</b></td></tr>';
    html += '</table><p class="small muted">เงินช่วยเหลือเกษตรกรตามเกณฑ์ (' + fmt(P.damageBahtPerRai) + ' บาท/ไร่): ≈ ' +
      fmt(S.compensationBaht / 1e6, 1) + ' ล้านบาท · จำลอง ' + fmt(hs.nc) + ' เซลล์ ขนาด ' + fmt(hs.dx) + ' ม. ใช้เวลา ' +
      fmt(state.flowMs / 1000, 1) + ' วินาที</p>';
    $('flowResults').innerHTML = html;
  }

  function renderResults(cps) {
    var r = state.result, s = r.stats;
    var damage = s.areaRai * P.damageBahtPerRai;
    if (P.dynamicFlow) {
      var e = r.envelopeStats;
      $('results').innerHTML = '<p class="small">พื้นที่ต่ำกว่าระดับน้ำที่เชื่อมต่อกับจุดล้นตลิ่ง (ขอบเขตเสี่ยงสูงสุด): <b>' + fmt(e.areaRai) +
        ' ไร่</b> · ความยาวลำน้ำที่ล้นตลิ่ง ซ้าย ' + fmt(r.overflowKm.left, 1) + ' / ขวา ' + fmt(r.overflowKm.right, 1) + ' กม.' +
        (e.areaRai < 1 ? '<br>ที่ระดับนี้ยังไม่พบพื้นที่ที่น้ำจะล้นออกไป ลองเพิ่มปริมาณน้ำหรือกดปุ่มตาม Rating Curve' : '') + '</p>';
      return;
    }
    var html = '<div class="kpis">' +
      kpi(fmt(s.areaRai), 'ไร่ ที่คาดว่าน้ำท่วม (' + fmt(s.areaKm2, 1) + ' ตร.กม.)') +
      kpi(fmt(state.volumeM3 / 1e6, 1), 'ล้าน ลบ.ม. น้ำล้นตลิ่งใน ' + fmt(P.overflowHours) + ' ชม. (Q ตลิ่งเต็ม ≈ ' + fmt(bankfullQ()) + ')') +
      kpi(fmt(s.maxDistSteps * r.pxM / 1000, 1), 'กม. ระยะที่น้ำแพร่ไปถึงไกลสุดจากตลิ่ง') +
      kpi(fmt(damage / 1e6, 1) + ' ล้าน', 'บาท ความเสียหายพืชผลโดยประมาณ') +
      kpi(fmt(s.meanDepth, 2) + ' / ' + fmt(s.maxDepth, 1), 'ความลึกเฉลี่ย / สูงสุด (ม.)') +
      kpi(fmt(r.overflowKm.left, 1) + ' / ' + fmt(r.overflowKm.right, 1), 'ความยาวลำน้ำที่ล้นตลิ่ง ซ้าย / ขวา (กม.)') +
      '</div><table class="cls">';
    s.classLabels.forEach(function (lab, i) {
      var c = LEGEND[i][1];
      html += '<tr><td><span class="sw" style="background:rgba(' + c.slice(0, 3).join(',') + ',0.9)"></span>ลึก ' + lab + '</td>' +
        '<td class="n">' + fmt(s.byClassRai[i]) + ' ไร่</td><td class="n">' + fmt(s.byClassRai[i] * P.damageBahtPerRai / 1e6, 2) + ' ล้านบาท</td></tr>';
    });
    html += '</table>';
    if (r.volumeLimited) {
      html += '<p class="small"><span class="sw" style="background:rgba(255,213,79,0.8)"></span>ขอบเขตเสี่ยงสูงสุด (ถ้าน้ำล้นนานขึ้น/ไม่จำกัดปริมาตร): <b>' +
        fmt(r.envelopeStats.areaRai) + ' ไร่</b> ≈ ' + fmt(r.envelopeStats.areaRai * P.damageBahtPerRai / 1e6, 1) + ' ล้านบาท</p>';
    }
    if (cps.length > 1) {
      html += '<p class="small muted">จุดควบคุมระดับน้ำ: ' + cps.map(function (c) {
        return esc(c.name) + (isFinite(c.ws) ? ' น้ำ ' + c.ws.toFixed(2) : '') +
          ' ตลิ่ง ' + Math.min(c.leftBank, c.rightBank).toFixed(2) + ' ม.';
      }).join(' · ') + '</p>';
    }
    if (s.areaRai < 1) {
      html += '<p class="small">ที่ระดับนี้ยังไม่พบพื้นที่ที่น้ำจะล้นออกไป ลองเพิ่มปริมาณน้ำหรือกดปุ่มตาม Rating Curve</p>';
    }
    $('results').innerHTML = html;
  }
  function kpi(v, k) { return '<div class="kpi"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>'; }

  // ค่าความลึกสูงสุดรอบจุด (รัศมีเป็นพิกเซล)
  function sampleDepth(lat, lon, radius) {
    var g = state.grid, r = state.result;
    if (!g || !r) return null;
    var p = M.latLonToGrid(g, lat, lon), cx = Math.floor(p[0]), cy = Math.floor(p[1]);
    if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) return null;
    var best = 0, k0 = cy * g.w + cx;
    radius = radius || 0;
    for (var y = cy - radius; y <= cy + radius; y++) for (var x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
      var d = r.depth[y * g.w + x];
      if (d > best) best = d;
    }
    return {
      depth: best, ground: g.elev[k0] - P.demOffsetM, ws: r.ws[k0],
      dist: r.dist[k0] === 65535 ? null : r.dist[k0] * r.pxM, river: r.chan[k0] >= 0
    };
  }

  function renderPlaces() {
    placeLayer.clearLayers();
    var list = $('placeList');
    var rows = state.places.map(function (p) {
      var s = state.hsum ? flowProbe(p.lat, p.lon, 2) : sampleDepth(p.lat, p.lon, 2);
      return { p: p, d: s ? s.depth : 0, s: s };
    }).filter(function (x) { return x.d > 0.05; }).sort(function (a, b) {
      if (state.hsum && a.s.hazard !== b.s.hazard) return b.s.hazard - a.s.hazard;
      return b.d - a.d;
    });
    list.innerHTML = rows.length ? '' : '<li class="muted">ยังไม่มีชุมชนในรายการที่อยู่ในพื้นที่เสี่ยง</li>';
    rows.slice(0, 80).forEach(function (x) {
      var li = document.createElement('li');
      if (state.hsum) {
        li.innerHTML = esc(x.p.name) + ' — <b>' + esc(x.s.hazard >= 0 ? HY.HAZARD[x.s.hazard].label.split(' — ')[0] : '') + '</b>' +
          ' ลึก ' + x.d.toFixed(2) + ' ม. · ไหล ' + fmt(x.s.v, 2) + ' ม./วิ' +
          (x.s.tArrive >= 0 ? ' <span class="muted small">(' + arrivalText(x.s.tArrive) + ')</span>' : '');
      } else {
        li.innerHTML = esc(x.p.name) + ' — ลึกประมาณ <b>' + x.d.toFixed(2) + ' ม.</b>' +
          (x.s && x.s.dist != null ? ' <span class="muted small">(' + fmt(x.s.dist / 1000, 1) + ' กม. จากตลิ่ง)</span>' : '');
      }
      li.onclick = function () { map.setView([x.p.lat, x.p.lon], 15); showPoint(L.latLng(x.p.lat, x.p.lon)); };
      list.appendChild(li);
      L.circleMarker([x.p.lat, x.p.lon], {
        radius: 5, color: '#fff', weight: 1.5, fillOpacity: 1,
        fillColor: state.hsum ? 'rgb(' + VIEWS.hazard.classes[Math.max(0, x.s.hazard)][2].slice(0, 3).join(',') + ')' : (x.d > 1 ? '#c62828' : '#ff9800')
      }).bindTooltip(esc(x.p.name) + ' ~' + x.d.toFixed(2) + ' ม.').addTo(placeLayer);
    });
  }

  // ค่าจากการจำลองการไหล ณ จุด (เลือกพิกเซลที่ลึกที่สุดในรัศมี)
  function flowProbe(lat, lon, radius) {
    var g = state.grid, hs = state.hydro, S = state.hsum;
    if (!g || !hs || !S) return null;
    var p = M.latLonToGrid(g, lat, lon), cx = Math.floor(p[0]), cy = Math.floor(p[1]), best = null, bd = -1;
    for (var y = cy - radius; y <= cy + radius; y++) for (var x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
      var d = S.depth[y * g.w + x];
      if (d > bd) { bd = d; best = [x, y]; }
    }
    if (!best) return null;
    return HY.probe(hs, S, M.gridLatLon(g, best[0], best[1])[0], M.gridLatLon(g, best[0], best[1])[1]);
  }
  function arrivalText(tSec) {
    return state.simStart != null ? 'น้ำถึง ~' + fmtTime(state.simStart + tSec * 1000) : 'น้ำถึงใน ~' + fmt(tSec / 3600, 1) + ' ชม. หลังเริ่มล้น';
  }
  function compass(vx, vy) {
    // vy ชี้ลงใต้ในระบบพิกัดภาพ
    var ang = (Math.atan2(vx, -vy) * 180 / Math.PI + 360) % 360;
    return ['เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ'][Math.round(ang / 45) % 8];
  }

  function showPoint(latlng) {
    var s = sampleDepth(latlng.lat, latlng.lng, 0);
    var html;
    if (!s) html = 'อยู่นอกพื้นที่คำนวณ';
    else {
      var pj = M.projectToLine(state.riverLine, latlng.lat, latlng.lng);
      var ws = state.profile ? state.profile.ws(pj.chainage) : NaN;
      html = '<b>' + latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5) + '</b><br>' +
        'ความสูงพื้นดิน (DEM): <b>' + fmt(s.ground, 1) + '</b> ม.รทก.<br>' +
        'ระดับน้ำแม่กลองที่ใกล้ที่สุด: <b>' + fmt(ws, 2) + '</b> ม.รทก. (ห่างลำน้ำ ' + fmt(pj.distKm, 1) + ' กม.)<br>' +
        (s.river ? '<b>ตัวลำน้ำ</b>'
          : s.depth > 0 ? '<b style="color:#c62828">คาดว่าน้ำท่วมลึก ' + s.depth.toFixed(2) + ' ม.</b>' +
            (s.dist != null ? '<br>ห่างจากจุดน้ำล้นตลิ่ง ~' + fmt(s.dist / 1000, 1) + ' กม.' : '')
          : isFinite(ws) && s.ground < ws ? 'พื้นต่ำกว่าระดับน้ำแต่<b>ไม่เชื่อมต่อ</b>กับจุดล้นตลิ่ง (เสี่ยงน้ำขัง/น้ำซึม)'
          : '<span style="color:#1e8a4c">ไม่อยู่ในพื้นที่คาดว่าน้ำท่วม</span>');
      var f = state.hsum ? HY.probe(state.hydro, state.hsum, latlng.lat, latlng.lng) : null;
      if (f && !s.river) {
        html += '<hr style="border:0;border-top:1px solid #ddd">' + (f.landuse ? 'การใช้ที่ดิน: ' + esc(f.landuse) + '<br>' : '') +
          (f.depth > 0.02
            ? '<b>ผลจำลองการไหล:</b> ลึกสูงสุด <b>' + f.depth.toFixed(2) + ' ม.</b><br>' +
              'ความเร็วน้ำสูงสุด <b>' + fmt(f.v, 2) + ' ม./วินาที</b>' + (f.v > 0.05 ? ' ไหลไปทาง' + compass(f.vx, f.vy) : '') + '<br>' +
              (f.tArrive >= 0 ? 'น้ำมาถึง: <b>' + arrivalText(f.tArrive) + '</b> · ท่วมขัง ~' + fmt(f.wetH, 0) + ' ชม.<br>' : '') +
              (f.hazard >= 0 ? 'ระดับอันตราย: <b>' + esc(HY.HAZARD[f.hazard].label) + '</b><br>' : '') +
              'ความเสียหาย ~' + fmt(f.damagePerM2 * 1600) + ' บาท/ไร่'
            : 'ผลจำลองการไหล: น้ำไปไม่ถึงภายในช่วงที่จำลอง');
      }
    }
    L.popup().setLatLng(latlng).setContent(html).openOn(map);
  }
  map.on('click', function (e) { showPoint(e.latlng); });

  // ---------------- ThaiWater ----------------
  function stationColor(s) {
    if (!isFinite(s.overflow)) return '#9e9e9e';
    if (s.overflow > 0) return '#c62828';
    if (s.overflow > -0.5) return '#ff9800';
    return '#2e7d32';
  }

  function applyStations(stations, source) {
    var region = TW.filterRegion(stations, CFG.thaiwater, CFG.bbox);
    state.stations = region;
    state.k55Observed = null;
    stationLayer.clearLayers();
    region.forEach(function (s) {
      s.isPrimary = TW.isPrimary(s, PS.code);
      if (s.isPrimary) {
        state.k55Observed = s.wl;
        if (isFinite(s.lat) && isFinite(s.lon)) { PS.lat = s.lat; PS.lon = s.lon; primaryMarker.setLatLng([s.lat, s.lon]); }
      }
      if (!isFinite(s.lat) || !isFinite(s.lon)) return;
      var icon = L.divIcon({
        className: '', iconSize: [14, 14],
        html: '<div class="st-icon" style="width:14px;height:14px;background:' + stationColor(s) + '"></div>'
      });
      L.marker([s.lat, s.lon], { icon: icon }).bindPopup(stationPopup(s)).addTo(stationLayer);
    });

    // ถ้ามีข้อมูลจริงของ K.55A ให้ตั้งค่าเป็นระดับปัจจุบัน
    if (state.k55Observed != null) {
      var k55 = region.filter(function (s) { return s.isPrimary; })[0];
      var tObs = parseStationTime(k55.time);
      if (state.scn === 'forecast' && isFinite(tObs)) {
        FCP.obs = { time: tObs, h: k55.wl };
        fillForecastInputs();
        rebuildForecast();
        renderStatus();
      } else {
        if (state.mode !== 'h') setMode('h');
        setValue(state.k55Observed.toFixed(2));
      }
    }
    renderFeed(region, source);
    scheduleSim();
  }

  function stationPopup(s) {
    return '<b>' + esc(s.code ? s.code + ' ' : '') + esc(s.name) + '</b><br>' +
      esc([s.tambon && 'ต.' + s.tambon, s.amphoe && 'อ.' + s.amphoe, s.province && 'จ.' + s.province].filter(Boolean).join(' ')) + '<br>' +
      'ระดับน้ำ: <b>' + fmt(s.wl, 2) + '</b> ม.รทก.<br>' +
      'ตลิ่ง: ' + fmt(s.minBank, 2) + ' ม.รทก.' +
      (isFinite(s.leftBank) ? ' (ซ้าย ' + fmt(s.leftBank, 2) + ' / ขวา ' + fmt(s.rightBank, 2) + ')' : '') + '<br>' +
      (isFinite(s.overflow) ? (s.overflow > 0
        ? '<b style="color:#c62828">ล้นตลิ่ง ' + s.overflow.toFixed(2) + ' ม.</b>'
        : 'ต่ำกว่าตลิ่ง ' + (-s.overflow).toFixed(2) + ' ม.') : '') +
      (isFinite(s.storagePct) ? '<br>ความจุลำน้ำ ' + fmt(s.storagePct) + '%' : '') +
      '<br><span class="small">' + esc(s.time) + (s.agency ? ' · ' + esc(s.agency) : '') + '</span>';
  }

  function renderFeed(region, source) {
    var over = region.filter(function (s) { return s.overflow > 0; });
    var sorted = region.slice().sort(function (a, b) {
      var ao = isFinite(a.overflow) ? a.overflow : -99, bo = isFinite(b.overflow) ? b.overflow : -99;
      return bo - ao;
    });
    $('twStatus').innerHTML = 'แหล่งข้อมูล: ' + esc(source) + ' · พบ ' + region.length + ' สถานีในพื้นที่ · <b style="color:var(--bad)">ล้นตลิ่ง ' +
      over.length + ' สถานี</b>' + (state.k55Observed != null ? ' · ใช้ระดับจริงของ K.55A = ' + state.k55Observed.toFixed(2) + ' ม.' : '');
    var ul = document.createElement('ul');
    ul.className = 'feed';
    sorted.slice(0, 40).forEach(function (s) {
      var li = document.createElement('li');
      li.className = s.overflow > 0 ? 'over' : (s.overflow > -0.5 ? 'near' : '');
      var head = s.overflow > 0 ? '🔴 น้ำล้นตลิ่ง ' + s.overflow.toFixed(2) + ' ม.'
        : s.overflow > -0.5 ? '🟠 ใกล้ล้นตลิ่ง (ต่ำกว่า ' + (-s.overflow).toFixed(2) + ' ม.)'
        : isFinite(s.overflow) ? '🟢 ปกติ (ต่ำกว่าตลิ่ง ' + (-s.overflow).toFixed(2) + ' ม.)' : '⚪ ไม่มีข้อมูลตลิ่ง';
      li.innerHTML = '<b>' + head + '</b><br>' + esc(s.code ? s.code + ' ' : '') + esc(s.name) +
        (s.amphoe ? ' อ.' + esc(s.amphoe) : '') + ' — ระดับ ' + fmt(s.wl, 2) + ' ม.รทก.<br><span class="small muted">' + esc(s.time) + '</span>';
      li.onclick = function () { if (isFinite(s.lat)) { map.setView([s.lat, s.lon], 13); L.popup().setLatLng([s.lat, s.lon]).setContent(stationPopup(s)).openOn(map); } };
      ul.appendChild(li);
    });
    var feed = $('newsFeed');
    feed.innerHTML = '';
    if (sorted.length) feed.appendChild(ul);
  }

  function fetchThaiWater() {
    $('twStatus').textContent = 'กำลังดึงข้อมูลจาก thaiwater.net…';
    TW.fetchLatest(CFG.thaiwater.endpoints).then(function (res) {
      applyStations(res.stations, res.url + ' (' + new Date().toLocaleString('th-TH') + ')');
    }).catch(function (e) {
      $('twStatus').innerHTML = '<span style="color:var(--bad)">' + esc(e.message) + '</span><br>' +
        'แนะนำ: รันผ่าน <code>node server.js</code> (มีตัวกลางดึงข้อมูล) หรือวาง JSON ด้านล่าง';
      $('pasteBox').open = true;
    });
  }

  // ---------------- OpenStreetMap (เสริม ถ้าเข้าถึงได้) ----------------
  var OVERPASS = 'https://overpass-api.de/api/interpreter';
  function bboxStr() { var b = CFG.bbox; return [b.south, b.west, b.north, b.east].join(','); }

  // ต่อเส้น way หลายเส้นเป็นเส้นเดียว (เลือกสายที่ยาวที่สุด)
  function stitch(ways) {
    var segs = ways.map(function (w) { return w.geometry.map(function (p) { return [p.lat, p.lon]; }); })
      .filter(function (s) { return s.length > 1; });
    function key(p) { return p[0].toFixed(6) + ',' + p[1].toFixed(6); }
    var chains = [];
    while (segs.length) {
      var chain = segs.shift(), grown = true;
      while (grown) {
        grown = false;
        for (var i = 0; i < segs.length; i++) {
          var s = segs[i], h = key(chain[0]), t = key(chain[chain.length - 1]);
          if (key(s[0]) === t) chain = chain.concat(s.slice(1));
          else if (key(s[s.length - 1]) === t) chain = chain.concat(s.slice().reverse().slice(1));
          else if (key(s[s.length - 1]) === h) chain = s.concat(chain.slice(1));
          else if (key(s[0]) === h) chain = s.slice().reverse().concat(chain.slice(1));
          else continue;
          segs.splice(i, 1); grown = true; break;
        }
      }
      chains.push(chain);
    }
    chains.sort(function (a, b) { return lineLen(b) - lineLen(a); });
    return chains[0];
  }
  function lineLen(l) { var c = M.chainages(l); return c[c.length - 1]; }

  function loadOsmRiver() {
    var q = '[out:json][timeout:25];way["waterway"="river"]["name"~"แม่กลอง|Mae Klong"](' + bboxStr() + ');out geom;';
    return fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(q) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var line = stitch(j.elements || []);
        if (!line || lineLen(line) < 40) throw new Error('เส้นลำน้ำจาก OSM ไม่สมบูรณ์');
        // ให้ทิศทางจากต้นน้ำ (เหนือ/ตะวันตก) ไปท้ายน้ำ
        var up = window.MAEKLONG_RIVER[0];
        if (M.haversineKm(line[line.length - 1], up) < M.haversineKm(line[0], up)) line.reverse();
        state.riverLine = line;
        state.riverSource = 'OpenStreetMap (' + fmt(lineLen(line)) + ' กม.)';
        riverLayer.setLatLngs(line);
        scheduleSim();
      })
      .catch(function (e) { console.warn('ใช้เส้นลำน้ำสำรอง:', e.message); });
  }

  function loadOsmPlaces() {
    var q = '[out:json][timeout:25];(node["place"~"^(town|village|suburb|quarter|hamlet)$"](' + bboxStr() + '););out;';
    return fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(q) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var extra = (j.elements || []).filter(function (e) { return e.tags && (e.tags.name || e.tags['name:th']); })
          .map(function (e) {
            var kind = { town: 'เมือง', village: 'หมู่บ้าน', suburb: 'ชุมชน', quarter: 'ชุมชน', hamlet: 'หมู่บ้านย่อย' }[e.tags.place] || '';
            return { name: (e.tags['name:th'] || e.tags.name) + (kind ? ' (' + kind + ')' : ''), lat: e.lat, lon: e.lon };
          });
        if (extra.length) { state.places = CFG.places.concat(extra); renderPlaces(); }
      })
      .catch(function (e) { console.warn('ไม่ได้รายชื่อชุมชนจาก OSM:', e.message); });
  }

  // ---------------- การตั้งค่า ----------------
  function bindParam(id, key, obj, parse, after) {
    var el = $(id);
    el.value = obj[key];
    el.addEventListener('change', function () {
      var v = parse ? parse(el.value) : parseFloat(el.value);
      if (!isFinite(v)) { el.value = obj[key]; return; }
      obj[key] = v;
      if (after) { after(); return; }
      renderStatus(); scheduleSim();
    });
  }
  // มูลค่าความเสียหายเปลี่ยน: คำนวณสรุปใหม่โดยไม่ต้องจำลองการไหลซ้ำ
  function resummarize() {
    if (state.hydro && state.hsum) {
      state.hsum = HY.summarize(state.hydro, damageValues());
      state.depthCache = {};
      renderFlood(); renderFlowResults(); renderPlaces();
    } else if (state.result) renderResults(state.cps || []);
  }

  var legendCtl = L.control({ position: 'bottomright' });
  legendCtl.onAdd = function () {
    var div = L.DomUtil.create('div', 'legend');
    div.id = 'legend';
    div.title = 'แตะเพื่อย่อ/ขยาย';
    if (window.innerWidth < 760) div.classList.add('collapsed');
    L.DomEvent.disableClickPropagation(div);
    div.addEventListener('click', function () { div.classList.toggle('collapsed'); });
    return div;
  };
  legendCtl.addTo(map);

  function renderLegend() {
    var el = $('legend');
    if (!el) return;
    var view = state.hsum && !state.liveDepth ? state.view : 'depth';
    var v = VIEWS[view];
    el.innerHTML = '<b>' + v.title + ' ▾</b>' + v.classes.map(function (c) {
      return '<div><span class="sw" style="background:rgba(' + c[2].slice(0, 3).join(',') + ',0.9)"></span>' + esc(c[1]) + '</div>';
    }).join('') +
      (view === 'depth' ? '<div><span class="sw" style="background:rgba(255,213,79,0.8)"></span>เสี่ยงสูงสุด (ถ้าน้ำล้นนานกว่านี้)</div>' : '') +
      '<div><span class="sw" style="background:#c62828;border-radius:50%"></span>สถานีน้ำล้นตลิ่ง</div>' +
      '<div><span class="sw" style="background:#ff9800;border-radius:50%"></span>ใกล้ล้น (&lt; 0.5 ม.)</div>' +
      '<div><span class="sw" style="background:#2e7d32;border-radius:50%"></span>ปกติ</div>';
  }

  // animation การแพร่กระจาย
  var playTimer = null;
  function play() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; $('btnPlay').textContent = '▶ เล่น'; return; }
    $('btnPlay').textContent = '■ หยุด';
    if (state.hsum) {
      var n = state.hydro.snapshots.length;
      state.timeIdx = 0;
      playTimer = setInterval(function () {
        $('spreadRange').value = state.timeIdx;
        onTimeChanged();
        state.timeIdx++;
        if (state.timeIdx >= n) { state.timeIdx = -1; $('spreadRange').value = n; onTimeChanged(); play(); }
      }, 300);
      return;
    }
    state.spread = 0;
    playTimer = setInterval(function () {
      state.spread = Math.min(1, state.spread + 0.04);
      $('spreadRange').value = Math.round(state.spread * 100);
      renderFlood();
      if (state.spread >= 1) play();
    }, 120);
  }

  // ---------------- เริ่มต้น ----------------
  document.querySelectorAll('#modeSeg button').forEach(function (b) { b.onclick = function () { setMode(b.dataset.mode); }; });
  $('valueRange').addEventListener('input', function (e) { setValue(e.target.value); });
  $('valueInput').addEventListener('change', function (e) { setValue(e.target.value); });
  $('btnFetch').onclick = fetchThaiWater;
  $('btnPaste').onclick = function () {
    try {
      var st = TW.parse(JSON.parse($('pasteJson').value));
      if (!st.length) throw new Error('ไม่พบฟิลด์ waterlevel_msl ใน JSON');
      applyStations(st, 'JSON ที่วาง');
    } catch (e) { $('twStatus').innerHTML = '<span style="color:var(--bad)">' + esc(e.message) + '</span>'; }
  };
  $('useStations').onchange = scheduleSim;
  $('spreadRange').addEventListener('input', function (e) {
    if (state.hsum) {
      var i = parseInt(e.target.value, 10);
      state.timeIdx = i >= state.hydro.snapshots.length ? -1 : i;
      onTimeChanged();
      return;
    } else state.spread = e.target.value / 100;
    renderFlood();
  });
  document.querySelectorAll('#viewSeg button').forEach(function (b) {
    b.onclick = function () {
      state.view = b.dataset.view;
      document.querySelectorAll('#viewSeg button').forEach(function (o) { o.classList.toggle('active', o === b); });
      renderFlood();
    };
  });
  $('btnPlay').onclick = play;
  bindParam('pSlope', 'riverSlopeMPerKm', P);
  bindParam('pOffset', 'demOffsetM', P);
  bindParam('pSpread', 'maxSpreadKm', P);
  bindParam('pChannel', 'channelHalfWidthM', P);
  bindParam('pDamage', 'damageBahtPerRai', P, null, resummarize);
  bindParam('pBuilt', 'builtBahtPerM2', P, null, resummarize);
  bindParam('pCrop', 'cropBahtPerRai', P, null, resummarize);
  bindParam('pTree', 'treeBahtPerRai', P, null, resummarize);
  bindParam('pCells', 'flowMaxCells', P);
  $('pDynamic').checked = P.dynamicFlow;
  $('pDynamic').onchange = function () { P.dynamicFlow = $('pDynamic').checked; scheduleSim(); };
  bindParam('pZoom', 'demZoom', P, function (v) { return parseInt(v, 10); });
  bindParam('pHours', 'overflowHours', P);
  bindParam('pBankW', 'bankDemWeight', P);
  $('pVolume').checked = P.limitByVolume;
  $('pVolume').onchange = function () { P.limitByVolume = $('pVolume').checked; scheduleSim(); };
  bindParam('pBank', 'bank', PS, null, function () {
    PS.leftBank = PS.rightBank = PS.bank;
    PS.bankfullQ = bankfullQ();
    forecastChanged();
  });

  // คาดการณ์
  document.querySelectorAll('#scnSeg button').forEach(function (b) { b.onclick = function () { setScenario(b.dataset.scn); }; });
  document.querySelectorAll('#presetSeg button').forEach(function (b) {
    b.onclick = function () { Object.assign(FCP, FC.PRESETS[b.dataset.preset]); fillForecastInputs(); forecastChanged(); };
  });
  [['fcRate', 'riseRate'], ['fcPeakAfter', 'peakAfterH'], ['fcHold', 'holdH'], ['fcFall', 'fallRate'], ['fcHorizon', 'horizonH']].forEach(function (a) {
    $(a[0]).addEventListener('change', function () {
      var v = parseFloat($(a[0]).value);
      if (!isFinite(v) || v < 0) { $(a[0]).value = FCP[a[1]]; return; }
      FCP[a[1]] = v; fillForecastInputs(); forecastChanged();
    });
  });
  $('fcShape').onchange = function () { FCP.riseShape = $('fcShape').value; fillForecastInputs(); forecastChanged(); };
  $('fcTime').onchange = $('fcLevel').onchange = function () {
    var t = fromLocalInput($('fcTime').value), h = parseFloat($('fcLevel').value);
    if (!isFinite(t) || !isFinite(h)) { fillForecastInputs(); return; }
    FCP.obs = { time: t, h: h };
    forecastChanged();
  };
  var chart = $('fcChart');
  chart.addEventListener('pointermove', onChartMove);
  chart.addEventListener('pointerleave', function () { $('fcTip').hidden = true; var c = $('fcCross'); if (c) c.setAttribute('visibility', 'hidden'); });
  chart.addEventListener('click', onChartClick);

  renderChips();
  renderLegend();
  fillForecastInputs();
  rebuildForecast();
  setMode('h');
  setValue(CFG.forecast.obs.h);
  loadOsmRiver();
  loadOsmPlaces();
  fetchThaiWater();

  // สำหรับตรวจสอบ/ทดสอบจาก console
  window.floodApp = { map: map, state: state, params: P, forecast: FCP, setScenario: setScenario, runSim: runSim, setView: function (v) { var b = document.querySelector('#viewSeg button[data-view="' + v + '"]'); if (b) b.click(); }, setValue: setValue, setMode: setMode, applyStations: applyStations };
})();
