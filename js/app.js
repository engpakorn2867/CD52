// ส่วนติดต่อผู้ใช้: แผนที่ดาวเทียม + การคำนวณน้ำล้นตลิ่ง + ข้อมูล ThaiWater
(function () {
  'use strict';
  var CFG = window.FLOOD_CONFIG, M = window.FloodModel, R = window.Rating, TW = window.ThaiWater;
  var PS = CFG.primaryStation, P = Object.assign({}, CFG.params);

  var state = {
    mode: 'q',           // 'q' ปริมาณน้ำ, 'h' ระดับน้ำ
    q: 3000,
    h: R.levelFromDischarge(PS.ratingCurve, 3000),
    riverLine: window.MAEKLONG_RIVER.slice(),
    riverSource: 'เส้นลำน้ำจาก DEM (สำรอง)',
    grid: null, gridZoom: null, river: null, result: null,
    stations: [],        // สถานี ThaiWater ในพื้นที่
    places: CFG.places.slice(),
    spread: 1            // สัดส่วนการแสดงการแพร่กระจาย 0..1
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
  function currentH() { return state.mode === 'q' ? R.levelFromDischarge(PS.ratingCurve, state.q) : state.h; }
  function currentQ() { return state.mode === 'q' ? state.q : R.dischargeFromLevel(PS.ratingCurve, state.h); }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.seg button').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === mode); });
    var r = $('valueRange'), i = $('valueInput');
    if (mode === 'q') {
      r.min = 2000; r.max = 4200; r.step = 10; i.step = 10;
      state.q = Math.round(currentQFromH(state.h));
      r.value = i.value = state.q;
    } else {
      r.min = 9; r.max = 14; r.step = 0.01; i.step = 0.01;
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
    var h = currentH(), q = currentQ();
    var st = R.bankStatus(h, PS.leftBank, PS.rightBank);
    var el = $('k55Status');
    el.className = 'status l' + st.level;
    var extra = st.level === 0
      ? 'ต่ำกว่าตลิ่งต่ำสุด <b>' + fmt(st.freeboard, 2) + ' ม.</b> · รับน้ำเพิ่มได้อีกประมาณ <b>' +
        fmt(R.dischargeFromLevel(PS.ratingCurve, Math.min(PS.leftBank, PS.rightBank)) - q) + '</b> ลบ.ม./วินาที'
      : 'สูงกว่าตลิ่งซ้าย <b>' + fmt(h - PS.leftBank, 2) + ' ม.</b> · ตลิ่งขวา <b>' + fmt(h - PS.rightBank, 2) + ' ม.</b>';
    el.innerHTML = '<b class="big">' + h.toFixed(2) + ' ม.รทก.</b> · Q ≈ ' + fmt(q) + ' ลบ.ม./วินาที<br>' +
      '<b>' + st.label + '</b> — ' + extra;
    drawCrossSection(h);
  }

  // รูปตัดลำน้ำอย่างง่าย (อิงภาพจาก สำนักงานชลประทานที่ 13)
  function drawCrossSection(h) {
    var svg = $('xsec');
    var W = 320, H = 150, top = 10.6, bottom = 13.2;
    function y(v) { return 12 + (bottom - v) / (bottom - top) * (H - 40); }
    var yl = y(PS.leftBank), yr = y(PS.rightBank), yw = y(Math.max(top, Math.min(bottom, h)));
    var bed = H - 8;
    var parts = [];
    // ระดับตาม rating curve
    PS.ratingCurve.forEach(function (p) {
      var yy = y(p[1]);
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
    parts.push('<text x="4" y="' + (yl + 12) + '" font-size="9" fill="#fff">ตลิ่งซ้าย ' + PS.leftBank.toFixed(2) + '</text>');
    parts.push('<text x="316" y="' + (yr + 12) + '" font-size="9" fill="#fff" text-anchor="end">ตลิ่งขวา ' + PS.rightBank.toFixed(2) + '</text>');
    parts.push('<text x="160" y="' + (yw - 4) + '" font-size="10" font-weight="700" text-anchor="middle" fill="' +
      (over ? '#b71c1c' : '#0d47a1') + '">▼ ' + h.toFixed(2) + ' ม.รทก.</text>');
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
        volumeM3: P.limitByVolume ? state.volumeM3 : null
      });
      var ms = performance.now() - t0;
      $('simStatus').innerHTML = 'คำนวณเสร็จใน ' + fmt(ms) + ' มิลลิวินาที · ตาราง ' + grid.w + '×' + grid.h +
        ' (' + fmt(state.result.pxM) + ' ม./พิกเซล) · จุดควบคุม ' + cps.length + ' จุด · แนวลำน้ำ: ' + esc(state.riverSource) +
        (grid.missingTiles ? '<br><span style="color:var(--warn)">⚠ โหลด DEM ไม่ได้ ' + grid.missingTiles + '/' + grid.totalTiles +
          ' แผ่น — บริเวณนั้นไม่ถูกคำนวณ (เปลี่ยนความละเอียดเพื่อโหลดใหม่)</span>' : '');
      renderFlood();
      renderResults(cps);
      renderPlaces();
    }).catch(function (e) {
      console.error(e);
      $('simStatus').innerHTML = '<span style="color:var(--bad)">ผิดพลาด: ' + esc(e.message) + '</span>';
    }).then(function () {
      simBusy = false;
      if (simAgain) { simAgain = false; runSim(); }
    });
  }

  // ปริมาตรน้ำที่ล้นตลิ่ง = (Q − Q ที่ระดับตลิ่งต่ำสุด) × ระยะเวลา
  function bankfullQ() { return R.dischargeFromLevel(PS.ratingCurve, Math.min(PS.leftBank, PS.rightBank)); }
  function overflowVolume() { return Math.max(0, currentQ() - bankfullQ()) * P.overflowHours * 3600; }

  // สีตามความลึก
  function depthColor(d) {
    if (d <= 0.5) return [129, 212, 250, 150];
    if (d <= 1.0) return [41, 182, 246, 175];
    if (d <= 2.0) return [21, 101, 192, 195];
    return [13, 27, 110, 215];
  }
  var LEGEND = [['0–0.5 ม.', depthColor(0.3)], ['0.5–1 ม.', depthColor(0.8)], ['1–2 ม.', depthColor(1.5)], ['> 2 ม.', depthColor(3)]];
  var ENVELOPE_COLOR = [255, 213, 79, 90];

  function renderFlood() {
    var g = state.grid, r = state.result;
    if (!g || !r) return;
    var canvas = renderFlood.canvas || (renderFlood.canvas = document.createElement('canvas'));
    canvas.width = g.w; canvas.height = g.h;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(g.w, g.h), px = img.data;
    var limit = Math.round(state.spread * Math.max(1, r.stats.maxDistSteps));
    var showEnv = r.volumeLimited && state.spread >= 1;
    for (var k = 0, j = 0; k < r.depth.length; k++, j += 4) {
      var d = r.depth[k], c = null;
      if (d > 0 && r.dist[k] <= limit) c = depthColor(d);
      else if (showEnv && r.envelope[k] > 0) c = ENVELOPE_COLOR;
      if (c) { px[j] = c[0]; px[j + 1] = c[1]; px[j + 2] = c[2]; px[j + 3] = c[3]; }
    }
    ctx.putImageData(img, 0, 0);
    var bounds = [[M.yToLat(g.y0 + g.h, g.z), M.xToLon(g.x0, g.z)], [M.yToLat(g.y0, g.z), M.xToLon(g.x0 + g.w, g.z)]];
    var url = canvas.toDataURL('image/png');
    if (floodLayer) floodLayer.setUrl(url);
    else {
      floodLayer = L.imageOverlay(url, bounds, { pane: 'flood', opacity: 0.85, interactive: false }).addTo(map);
      layersCtl.addOverlay(floodLayer, 'พื้นที่คาดว่าน้ำท่วม');
    }
    $('spreadLabel').textContent = '≤ ' + fmt(limit * r.pxM / 1000, 1) + ' กม. จากตลิ่ง';
  }

  function renderResults(cps) {
    var r = state.result, s = r.stats;
    var damage = s.areaRai * P.damageBahtPerRai;
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
      var s = sampleDepth(p.lat, p.lon, 2);
      return { p: p, d: s ? s.depth : 0, s: s };
    }).filter(function (x) { return x.d > 0.05; }).sort(function (a, b) { return b.d - a.d; });
    list.innerHTML = rows.length ? '' : '<li class="muted">ยังไม่มีชุมชนในรายการที่อยู่ในพื้นที่เสี่ยง</li>';
    rows.slice(0, 80).forEach(function (x) {
      var li = document.createElement('li');
      li.innerHTML = esc(x.p.name) + ' — ลึกประมาณ <b>' + x.d.toFixed(2) + ' ม.</b>' +
        (x.s && x.s.dist != null ? ' <span class="muted small">(' + fmt(x.s.dist / 1000, 1) + ' กม. จากตลิ่ง)</span>' : '');
      li.onclick = function () { map.setView([x.p.lat, x.p.lon], 15); showPoint(L.latLng(x.p.lat, x.p.lon)); };
      list.appendChild(li);
      L.circleMarker([x.p.lat, x.p.lon], {
        radius: 5, color: '#fff', weight: 1.5, fillColor: x.d > 1 ? '#c62828' : '#ff9800', fillOpacity: 1
      }).bindTooltip(esc(x.p.name) + ' ~' + x.d.toFixed(2) + ' ม.').addTo(placeLayer);
    });
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
      if (state.mode !== 'h') setMode('h');
      setValue(state.k55Observed.toFixed(2));
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
  function bindParam(id, key, obj, parse) {
    var el = $(id);
    el.value = obj[key];
    el.addEventListener('change', function () {
      var v = parse ? parse(el.value) : parseFloat(el.value);
      if (!isFinite(v)) { el.value = obj[key]; return; }
      obj[key] = v;
      renderStatus(); scheduleSim();
    });
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
    $('legend').innerHTML = '<b>ความลึกน้ำท่วมคาดการณ์ ▾</b>' + LEGEND.map(function (l) {
      return '<div><span class="sw" style="background:rgba(' + l[1].slice(0, 3).join(',') + ',0.9)"></span>' + l[0] + '</div>';
    }).join('') +
      '<div><span class="sw" style="background:rgba(255,213,79,0.8)"></span>เสี่ยงสูงสุด (ไม่จำกัดปริมาตร)</div>' +
      '<div><span class="sw" style="background:#c62828;border-radius:50%"></span>สถานีน้ำล้นตลิ่ง</div>' +
      '<div><span class="sw" style="background:#ff9800;border-radius:50%"></span>ใกล้ล้น (&lt; 0.5 ม.)</div>' +
      '<div><span class="sw" style="background:#2e7d32;border-radius:50%"></span>ปกติ</div>';
  }

  // animation การแพร่กระจาย
  var playTimer = null;
  function play() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; $('btnPlay').textContent = '▶ แพร่กระจาย'; return; }
    state.spread = 0;
    $('btnPlay').textContent = '■ หยุด';
    playTimer = setInterval(function () {
      state.spread = Math.min(1, state.spread + 0.04);
      $('spreadRange').value = Math.round(state.spread * 100);
      renderFlood();
      if (state.spread >= 1) play();
    }, 120);
  }

  // ---------------- เริ่มต้น ----------------
  document.querySelectorAll('.seg button').forEach(function (b) { b.onclick = function () { setMode(b.dataset.mode); }; });
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
  $('spreadRange').addEventListener('input', function (e) { state.spread = e.target.value / 100; renderFlood(); });
  $('btnPlay').onclick = play;
  bindParam('pSlope', 'riverSlopeMPerKm', P);
  bindParam('pOffset', 'demOffsetM', P);
  bindParam('pSpread', 'maxSpreadKm', P);
  bindParam('pChannel', 'channelHalfWidthM', P);
  bindParam('pDamage', 'damageBahtPerRai', P);
  bindParam('pZoom', 'demZoom', P, function (v) { return parseInt(v, 10); });
  bindParam('pHours', 'overflowHours', P);
  bindParam('pBankW', 'bankDemWeight', P);
  $('pVolume').checked = P.limitByVolume;
  $('pVolume').onchange = function () { P.limitByVolume = $('pVolume').checked; scheduleSim(); };
  bindParam('pLeft', 'leftBank', PS);
  bindParam('pRight', 'rightBank', PS);

  renderChips();
  renderLegend();
  setMode('q');
  setValue(3000);
  loadOsmRiver();
  loadOsmPlaces();
  fetchThaiWater();

  // สำหรับตรวจสอบ/ทดสอบจาก console
  window.floodApp = { state: state, params: P, runSim: runSim, setValue: setValue, setMode: setMode, applyStations: applyStations };
})();
