// แผนที่ตำบล อ.บ้านโป่ง: จำแนกตำบลตามความสัมพันธ์กับแม่น้ำแม่กลอง และวาดเป็นภาพ (canvas) ที่บันทึกเป็น PNG ได้
//
// สีแดง  = ตำบลที่แม่น้ำแม่กลองไหลผ่าน/ติดแม่น้ำ (ได้รับผลกระทบโดยตรง)
// สีเหลือง = ตำบลที่ไม่ติดแม่น้ำ แต่มีแนวเขตติดกับตำบลสีแดง
// สีฟ้า  = ตัวแม่น้ำแม่กลอง (พิกเซลแหล่งน้ำจาก ESA WorldCover ตามแนวลำน้ำ + เส้นกึ่งกลาง)
(function (root) {
  var TILE = 256;

  // ---------- เรขาคณิต (lon/lat → ระนาบ กม. เฉพาะที่) ----------
  function kmPerDeg(lat) { return [111.32 * Math.cos(lat * Math.PI / 180), 110.57]; }
  function rings(f) { return f.geometry.coordinates.reduce(function (a, poly) { return a.concat(poly); }, []); }
  function outerRings(f) { return f.geometry.coordinates.map(function (poly) { return poly[0]; }); }

  function pointInRing(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function pointInFeature(lon, lat, f) {
    return f.geometry.coordinates.some(function (poly) {
      if (!pointInRing(lon, lat, poly[0])) return false;
      for (var h = 1; h < poly.length; h++) if (pointInRing(lon, lat, poly[h])) return false;
      return true;
    });
  }
  // ระยะ (กม.) จากจุดถึงขอบรูปปิด
  function distToFeatureEdge(lon, lat, f) {
    var k = kmPerDeg(lat), best = Infinity;
    rings(f).forEach(function (r) {
      for (var i = 0; i < r.length - 1; i++) {
        var ax = (r[i][0] - lon) * k[0], ay = (r[i][1] - lat) * k[1];
        var bx = (r[i + 1][0] - lon) * k[0], by = (r[i + 1][1] - lat) * k[1];
        var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        var t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
        var px = ax + t * dx, py = ay + t * dy, d = Math.sqrt(px * px + py * py);
        if (d < best) best = d;
      }
    });
    return best;
  }
  function bboxOf(features) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    features.forEach(function (f) {
      rings(f).forEach(function (r) {
        r.forEach(function (c) {
          if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1];
          if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1];
        });
      });
    });
    return b;
  }
  // จุดตัวอย่างตามแนวแม่น้ำ ทุก ~stepKm (river: [[lat, lon], ...])
  function densify(river, stepKm) {
    var out = [];
    for (var i = 0; i < river.length - 1; i++) {
      var a = river[i], b = river[i + 1], k = kmPerDeg(a[0]);
      var len = Math.hypot((b[1] - a[1]) * k[0], (b[0] - a[0]) * k[1]);
      var n = Math.max(1, Math.ceil(len / stepKm));
      for (var s = 0; s < n; s++) out.push([a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n, len / n]);
    }
    return out;
  }

  // ---------- จำแนกตำบล ----------
  // opts: { touchKm: ระยะที่ถือว่าติดแม่น้ำ (ขอบเขตแบบย่อ), adjKm: ระยะที่ถือว่าตำบลติดกัน }
  function classify(features, river, opts) {
    opts = opts || {};
    var touchKm = opts.touchKm == null ? 0.25 : opts.touchKm, adjKm = opts.adjKm == null ? 0.08 : opts.adjKm;
    var pts = densify(river, 0.05);
    var bp = features.filter(function (f) { return f.properties.role === 'banpong'; });
    bp.forEach(function (f) {
      var inside = 0, near = false, bb = bboxOf([f]);
      pts.forEach(function (p) {
        if (p[1] < bb[0] - 0.01 || p[1] > bb[2] + 0.01 || p[0] < bb[1] - 0.01 || p[0] > bb[3] + 0.01) return;
        if (pointInFeature(p[1], p[0], f)) inside += p[2];
        else if (!near && distToFeatureEdge(p[1], p[0], f) <= touchKm) near = true;
      });
      f.properties.riverKm = inside;
      f.properties.cls = inside > 0.05 || near ? 'red' : null;
    });
    // ติดกัน: มีจุดยอดของรูปหนึ่งอยู่ใกล้ขอบอีกรูป
    function adjacent(a, b) {
      var ba = bboxOf([a]), bbb = bboxOf([b]), pad = 0.01;
      if (ba[0] > bbb[2] + pad || bbb[0] > ba[2] + pad || ba[1] > bbb[3] + pad || bbb[1] > ba[3] + pad) return false;
      var hits = 0;
      rings(a).forEach(function (r) { r.forEach(function (c) { if (distToFeatureEdge(c[0], c[1], b) <= adjKm) hits++; }); });
      return hits >= 2;
    }
    bp.forEach(function (f) {
      f.properties.neighbors = bp.filter(function (g) { return g !== f && adjacent(f, g); }).map(function (g) { return g.properties.th; });
    });
    bp.forEach(function (f) {
      if (f.properties.cls) return;
      var nearRed = bp.some(function (g) { return g.properties.cls === 'red' && f.properties.neighbors.indexOf(g.properties.th) >= 0; });
      f.properties.cls = nearRed ? 'yellow' : 'gray';
    });
    return bp;
  }

  // ---------- จุดวางชื่อ (จุดในรูปที่ห่างขอบที่สุด) ----------
  function labelPoint(f) {
    var bb = bboxOf([f]), best = null, bd = -1, N = 24;
    for (var i = 1; i < N; i++) for (var j = 1; j < N; j++) {
      var lon = bb[0] + (bb[2] - bb[0]) * i / N, lat = bb[1] + (bb[3] - bb[1]) * j / N;
      if (!pointInFeature(lon, lat, f)) continue;
      var d = distToFeatureEdge(lon, lat, f);
      if (d > bd) { bd = d; best = [lon, lat]; }
    }
    return best || [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
  }

  // ถอดพิกัดแบบจำนวนเต็มผลต่างสะสม → [[lon, lat], ...]
  function decode(arr, q) {
    var out = [], x = 0, y = 0;
    for (var i = 0; i < arr.length; i += 2) { x += arr[i]; y += arr[i + 1]; out.push([x / q, y / q]); }
    return out;
  }

  // ---------- Web Mercator ----------
  function mx(lon) { return (lon + 180) / 360; }
  function my(lat) { var r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2; }

  var COLORS = {
    red: { fill: 'rgba(229,57,53,0.55)', stroke: '#b71c1c', text: '#5d0b0b' },
    yellow: { fill: 'rgba(255,235,59,0.70)', stroke: '#a68b00', text: '#4a3d00' },
    gray: { fill: 'rgba(189,189,189,0.55)', stroke: '#757575', text: '#303030' },
    context: { fill: 'rgba(255,255,255,0.0)', stroke: '#b0b0b0', text: '#9e9e9e' },
    water: '#2f86de'
  };

  // ---------- วาดภาพ ----------
  // cfg: { canvas, features, river, landcover (LANDCOVER raster {z,x0,y0,w,h,cls}), focus: [ชื่อตำบล] | null,
  //        title, subtitle, tiles: [{img,x,y,z}] (ภาพพื้นหลัง), panelWidth, note }
  function render(cfg) {
    var cv = cfg.canvas, ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height, PW = cfg.panelWidth || 470, HEAD = 92, PAD = 24;
    var mapX = PAD, mapY = HEAD, mapW = W - PW - PAD * 2, mapH = H - HEAD - PAD - 30;
    var bp = cfg.features.filter(function (f) { return f.properties.role === 'banpong'; });
    var focus = cfg.focus ? bp.filter(function (f) { return cfg.focus.indexOf(f.properties.th) >= 0; }) : bp;
    var bb = bboxOf(focus);
    var padX = (bb[2] - bb[0]) * (cfg.focus ? 0.35 : 0.06), padY = (bb[3] - bb[1]) * (cfg.focus ? 0.35 : 0.06);
    var x0 = mx(bb[0] - padX), x1 = mx(bb[2] + padX), y0 = my(bb[3] + padY), y1 = my(bb[1] - padY);
    var s = Math.min(mapW / (x1 - x0), mapH / (y1 - y0));
    var ox = mapX + (mapW - (x1 - x0) * s) / 2 - x0 * s, oy = mapY + (mapH - (y1 - y0) * s) / 2 - y0 * s;
    function P(lon, lat) { return [ox + mx(lon) * s, oy + my(lat) * s]; }
    function inv(px, py) {
      var X = (px - ox) / s, Y = (py - oy) / s;
      var n = Math.PI - 2 * Math.PI * Y;
      return [X * 360 - 180, 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))];
    }

    // พื้นหลัง
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath(); ctx.rect(mapX, mapY, mapW, mapH); ctx.clip();
    ctx.fillStyle = '#f4f4f2'; ctx.fillRect(mapX, mapY, mapW, mapH);
    if (cfg.tiles && cfg.tiles.length) {
      cfg.tiles.forEach(function (t) {
        var n = Math.pow(2, t.z), a = P(t.x / n * 360 - 180, 0), sz = s / n;
        ctx.drawImage(t.img, ox + t.x / n * s, oy + t.y / n * s, sz + 0.5, sz + 0.5);
      });
    }
    var sat = cfg.tiles && cfg.tiles.length;

    function pathFeature(f) {
      ctx.beginPath();
      f.geometry.coordinates.forEach(function (poly) {
        poly.forEach(function (r) {
          r.forEach(function (c, i) { var p = P(c[0], c[1]); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
          ctx.closePath();
        });
      });
    }
    var street = !!cfg.basemap && !sat, placed0 = [];
    // จองพื้นที่ป้ายชื่อตำบลก่อน เพื่อให้ป้ายสถานที่บนแผนที่พื้นฐานหลบ
    if (street) bp.forEach(function (f) {
      var lp = f.properties.labelAt || (f.properties.labelAt = labelPoint(f)), q = P(lp[0], lp[1]);
      var big = !cfg.focus || cfg.focus.indexOf(f.properties.th) >= 0, w2 = (big ? (cfg.focus ? 26 : 19) : 14) * 3.2;
      placed0.push([q[0] - w2, q[1] - 16, q[0] + w2, q[1] + 26, 'reserve']);
    });
    // ตำบลข้างเคียง (นอกอำเภอ)
    cfg.features.forEach(function (f) {
      if (f.properties.role !== 'context') return;
      pathFeature(f);
      if (!street) { ctx.fillStyle = sat ? 'rgba(255,255,255,0.15)' : '#fbfbfa'; ctx.fill('evenodd'); }
      ctx.strokeStyle = sat ? 'rgba(255,255,255,0.6)' : '#c8c8c8'; ctx.lineWidth = 1;
      if (street) ctx.setLineDash([2, 3]);
      ctx.stroke(); ctx.setLineDash([]);
    });
    // ตำบลในอำเภอบ้านโป่ง (แบบแผนที่ถนน: ระบายโปร่งแสงให้เห็นถนนข้างใต้)
    var STREET_FILL = { red: 'rgba(235,64,52,0.42)', yellow: 'rgba(255,232,0,0.55)', gray: 'rgba(150,150,150,0.30)' };
    var plain = cfg.colorMode === 'plain';
    if (!plain) bp.forEach(function (f) {
      var c = COLORS[f.properties.cls] || COLORS.gray;
      var dim = cfg.focus && cfg.focus.indexOf(f.properties.th) < 0;
      pathFeature(f);
      ctx.globalAlpha = dim ? 0.45 : 1;
      ctx.fillStyle = street ? STREET_FILL[f.properties.cls] || STREET_FILL.gray : c.fill; ctx.fill('evenodd');
      ctx.globalAlpha = 1;
      if (!street) { ctx.strokeStyle = c.stroke; ctx.lineWidth = dim ? 1 : 1.6; ctx.stroke(); }
    });
    // หน่วยงานรับผิดชอบ (ทั้งตำบล): ระบายสีใต้ถนนก่อน แล้วค่อยวางกรอบด้านในตำบลภายหลัง
    var agencies = {};
    (cfg.agencies || []).forEach(function (a) { agencies[a.id] = a; });
    function rgba(hex, a) {
      var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '') || [0, 'e5', '39', '35'];
      return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')';
    }
    var assign = cfg.assign || {}, used = {};
    function inView(lon, lat) { var q = P(lon, lat); return q[0] >= mapX && q[0] <= mapX + mapW && q[1] >= mapY && q[1] <= mapY + mapH; }
    bp.forEach(function (f) {
      var a = agencies[assign[f.properties.th]];
      if (!a) return;
      pathFeature(f); ctx.fillStyle = rgba(a.color, 0.32); ctx.fill('evenodd');
    });
    if (street) drawBasemap(ctx, cfg.basemap, P, s, mapX, mapY, mapW, mapH);

    // แม่น้ำ: พิกเซลแหล่งน้ำ (WorldCover) ในแนว ±400 ม. จากเส้นกึ่งกลาง
    var riverPts = densify(cfg.river, 0.1);
    if (cfg.landcover && !street) {
      var lc = cfg.landcover, n2 = Math.pow(2, lc.z) * TILE, near = {};
      riverPts.forEach(function (p) {
        var gx = Math.floor(mx(p[1]) * n2) - lc.x0, gy = Math.floor(my(p[0]) * n2) - lc.y0, r = 22;
        for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
          var X = gx + dx, Y = gy + dy;
          if (X < 0 || Y < 0 || X >= lc.w || Y >= lc.h || dx * dx + dy * dy > r * r) continue;
          var k = Y * lc.w + X;
          if (lc.cls[k] === 8) near[k] = 1;
        }
      });
      ctx.fillStyle = COLORS.water;
      var pxs = s / n2;
      Object.keys(near).forEach(function (key) {
        var k = +key, X = k % lc.w, Y = (k - X) / lc.w;
        ctx.fillRect(ox + (X + lc.x0) / n2 * s, oy + (Y + lc.y0) / n2 * s, pxs + 0.6, pxs + 0.6);
      });
    }
    // เส้นกึ่งกลาง (ให้แม่น้ำต่อเนื่องแม้พิกเซลน้ำขาดช่วง)
    ctx.beginPath();
    if (!street) cfg.river.forEach(function (c, i) { var p = P(c[1], c[0]); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
    // ความหนาตามความกว้างแม่น้ำจริง ~150 ม. (แสดงครึ่งหนึ่ง ส่วนที่เหลือมาจากพิกเซลแหล่งน้ำ)
    var mPerPx = 40075016.686 * Math.cos(cfg.river[0][0] * Math.PI / 180) / s;
    ctx.strokeStyle = COLORS.water; ctx.lineWidth = Math.min(14, Math.max(3, 75 / mPerPx)); ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();

    // แยกส่วนตำบล: เว้นขอบสีขาวระหว่างตำบล ไม่ให้สีของตำบลที่ติดกันดูเป็นผืนเดียว
    if (cfg.separate) bp.forEach(function (f) {
      pathFeature(f); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = cfg.focus ? 8 : 6; ctx.lineJoin = 'round'; ctx.stroke();
    });
    // เส้นขอบอำเภอบ้านโป่ง (เน้น)
    bp.forEach(function (f) {
      pathFeature(f);
      if (street) {
        var dim = cfg.focus && cfg.focus.indexOf(f.properties.th) < 0;
        ctx.strokeStyle = dim ? 'rgba(60,60,60,0.45)' : 'rgba(40,40,40,0.85)'; ctx.lineWidth = dim ? 1 : 1.6; ctx.setLineDash([7, 4]);
      } else { ctx.strokeStyle = 'rgba(40,40,40,0.35)'; ctx.lineWidth = 0.6; }
      ctx.stroke(); ctx.setLineDash([]);
    });
    // ตำบลที่เน้นในโหมดไม่ระบายสี: เส้นขอบเข้มให้เห็นชัด
    if (plain && cfg.focus) focus.forEach(function (f) {
      pathFeature(f); ctx.strokeStyle = '#111'; ctx.lineWidth = 3; ctx.setLineDash([12, 5]); ctx.stroke(); ctx.setLineDash([]);
    });
    // กรอบหน่วยงานรับผิดชอบ: วาดเฉพาะด้านในของแต่ละตำบล (ตำบลติดกันสีเดียวกันก็ยังแยกกันชัด)
    bp.forEach(function (f) {
      var a = agencies[assign[f.properties.th]];
      if (!a) return;
      ctx.save();
      pathFeature(f); ctx.clip('evenodd');
      pathFeature(f); ctx.strokeStyle = a.color; ctx.lineWidth = cfg.separate ? 11 : 8; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.restore();
      var lp = f.properties.labelAt || (f.properties.labelAt = labelPoint(f));
      if (inView(lp[0], lp[1]) || (cfg.focus && cfg.focus.indexOf(f.properties.th) >= 0)) {
        (used[a.id] = used[a.id] || { tambons: [], zones: 0 }).tambons.push(f.properties.th);
      }
    });
    function zonePath(pts) {
      ctx.beginPath();
      pts.forEach(function (c, i) { var q = P(c[0], c[1]); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
      ctx.closePath();
    }
    var zoneLabels = [];
    (cfg.zones || []).forEach(function (z) {
      var a = agencies[z.agency];
      if (!a || !z.pts || z.pts.length < 3) return;
      zonePath(z.pts);
      ctx.fillStyle = rgba(a.color, 0.30); ctx.fill();
      ctx.strokeStyle = a.color; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.stroke();
      var cx = 0, cy2 = 0; z.pts.forEach(function (c) { cx += c[0]; cy2 += c[1]; });
      cx /= z.pts.length; cy2 /= z.pts.length;
      if (inView(cx, cy2)) { (used[a.id] = used[a.id] || { tambons: [], zones: 0 }).zones++; zoneLabels.push([z.label || a.name, cx, cy2, a.color]); }
    });
    // กรอบที่กำลังวาด
    if (cfg.draft && cfg.draft.pts.length) {
      var da = agencies[cfg.draft.agency] || { color: '#e53935' };
      ctx.beginPath();
      cfg.draft.pts.forEach(function (c, i) { var q = P(c[0], c[1]); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
      ctx.strokeStyle = da.color; ctx.lineWidth = 3; ctx.setLineDash([8, 5]); ctx.stroke(); ctx.setLineDash([]);
      cfg.draft.pts.forEach(function (c) { var q = P(c[0], c[1]); ctx.beginPath(); ctx.arc(q[0], q[1], 6, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = da.color; ctx.lineWidth = 2.5; ctx.stroke(); });
    }
    cfg._used = used;
    if (street) drawBaseLabels(ctx, cfg.basemap, P, mapX, mapY, mapW, mapH, placed0, cfg.focus ? 12 : 10.5, cfg.focus ? 160 : 110);

    // ชื่อตำบล
    var fs = cfg.focus ? 26 : 19, placed = placed0;
    // วางป้ายโดยเลี่ยงการซ้อนกับป้ายที่วางแล้ว (ลองเลื่อนรอบจุด ถ้าไม่ได้ให้ตัดบรรทัดอังกฤษ/ย่อขนาด)
    function label(text, sub, lon, lat, col, size, bold) {
      var p = P(lon, lat), FONT = '"Sarabun","Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif';
      var tries = [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1], [0, -2], [0, 2]];
      for (var pass = 0; pass < 3; pass++) {
        var sz = pass === 2 ? Math.round(size * 0.8) : size, useSub = sub && pass === 0;
        ctx.font = (bold ? '700 ' : '600 ') + sz + 'px ' + FONT;
        var tw = ctx.measureText(text).width, th = sz * (useSub ? 1.75 : 1.1);
        if (useSub) { ctx.font = '500 ' + Math.round(sz * 0.62) + 'px ' + FONT; tw = Math.max(tw, ctx.measureText(sub).width); }
        for (var i = 0; i < tries.length; i++) {
          var cx = p[0] + tries[i][0] * (tw * 0.55 + 4), cy = p[1] + tries[i][1] * (th * 0.6);
          var box = [cx - tw / 2 - 3, cy - sz * 0.6, cx + tw / 2 + 3, cy - sz * 0.6 + th];
          var hit = placed.some(function (b) { return !b[4] && box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]; });
          if (hit) continue;
          placed.push(box);
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineJoin = 'round';
          ctx.font = (bold ? '700 ' : '600 ') + sz + 'px ' + FONT;
          ctx.strokeText(text, cx, cy); ctx.fillStyle = col; ctx.fillText(text, cx, cy);
          if (useSub) {
            ctx.font = '500 ' + Math.round(sz * 0.62) + 'px ' + FONT;
            ctx.strokeText(sub, cx, cy + sz * 0.85); ctx.fillText(sub, cx, cy + sz * 0.85);
          }
          return true;
        }
      }
      return false;
    }
    bp.slice().sort(function (a, b) {
      var fa = cfg.focus && cfg.focus.indexOf(a.properties.th) >= 0 ? 1 : 0, fb = cfg.focus && cfg.focus.indexOf(b.properties.th) >= 0 ? 1 : 0;
      return fb - fa || a.properties.areaKm2 - b.properties.areaKm2;
    }).forEach(function (f) {
      var lp = f.properties.labelAt || (f.properties.labelAt = labelPoint(f));
      var dim = cfg.focus && cfg.focus.indexOf(f.properties.th) < 0;
      var c = COLORS[f.properties.cls] || COLORS.gray;
      label(f.properties.th, dim ? null : '(ต.' + f.properties.en + ')', lp[0], lp[1], dim ? '#555' : (street || plain ? '#111' : c.text), dim ? Math.round(fs * 0.7) : fs, !dim);
    });
    if (cfg.focus) {
      // ชื่อตำบลข้างเคียงนอกอำเภอ
      cfg.features.forEach(function (f) {
        if (f.properties.role !== 'context') return;
        var lp = f.properties.labelAt || (f.properties.labelAt = labelPoint(f)), p = P(lp[0], lp[1]);
        if (p[0] < mapX + 30 || p[0] > mapX + mapW - 30 || p[1] < mapY + 20 || p[1] > mapY + mapH - 20) return;
        label(f.properties.th, null, lp[0], lp[1], '#8a8a8a', 14, false);
      });
    }
    zoneLabels.forEach(function (z) { label(z[0], null, z[1], z[2], '#111', cfg.focus ? 18 : 14, true); });
    // ชุดปฏิบัติการ: หมุดหมายเลขที่จุดตั้ง + ชื่อชุด
    var teamsShown = [];
    (cfg.teams || []).forEach(function (t, i) {
      var a = agencies[t.agency], col = (a && a.color) || '#37474f';
      var inFocus = !cfg.focus || (t.tambons || []).some(function (th) { return cfg.focus.indexOf(th) >= 0; });
      var hasBase = t.base && inView(t.base[0], t.base[1]);
      if (!hasBase && !inFocus) return;
      teamsShown.push({ t: t, n: i + 1, color: col });
      if (!hasBase) return;
      var q = P(t.base[0], t.base[1]), r = cfg.focus ? 17 : 13;
      ctx.beginPath(); ctx.moveTo(q[0], q[1] + r + 9); ctx.lineTo(q[0] - r * 0.6, q[1] + r * 0.5); ctx.lineTo(q[0] + r * 0.6, q[1] + r * 0.5); ctx.closePath();
      ctx.fillStyle = col; ctx.fill();
      ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '700 ' + Math.round(r * 1.05) + 'px "Sarabun","Noto Sans Thai",Tahoma,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), q[0], q[1] + 1);
      placed.push([q[0] - r, q[1] - r, q[0] + r, q[1] + r + 9]);
      var nm = t.name || ('ชุดที่ ' + (i + 1)), fz = cfg.focus ? 17 : 13;
      ctx.font = '700 ' + fz + 'px "Sarabun","Noto Sans Thai",Tahoma,sans-serif';
      var ll = inv(q[0] + r + 8 + ctx.measureText(nm).width / 2, q[1]);
      label(nm, null, ll[0], ll[1], '#111', fz, true);
    });
    cfg._teams = teamsShown;
    // ป้ายแม่น้ำ
    var mid = cfg.river[Math.floor(cfg.river.length * (cfg.focus ? 0.5 : 0.28))];
    var rp = (function () {
      // หาตำแหน่งบนแม่น้ำที่อยู่ในกรอบแผนที่
      for (var i = 0; i < cfg.river.length; i++) {
        var q = P(cfg.river[i][1], cfg.river[i][0]);
        if (q[0] > mapX + 80 && q[0] < mapX + mapW - 80 && q[1] > mapY + 60 && q[1] < mapY + mapH * 0.55) return cfg.river[i];
      }
      return mid;
    })();
    var pr = P(rp[1], rp[0]);
    ctx.font = 'italic 700 18px "Sarabun","Noto Sans Thai",Tahoma,sans-serif';
    ctx.textAlign = 'left'; ctx.lineWidth = 4; ctx.strokeStyle = '#fff';
    ctx.strokeText('แม่น้ำแม่กลอง', pr[0] + 14, pr[1]); ctx.fillStyle = '#0d47a1'; ctx.fillText('แม่น้ำแม่กลอง', pr[0] + 14, pr[1]);
    ctx.restore();

    // กรอบแผนที่ + ทิศเหนือ + มาตราส่วน
    ctx.strokeStyle = '#9e9e9e'; ctx.lineWidth = 1; ctx.strokeRect(mapX, mapY, mapW, mapH);
    northArrow(ctx, mapX + mapW - 40, mapY + 46);
    scaleBar(ctx, mapX + 16, mapY + mapH - 22, s, inv(mapX, mapY + mapH / 2)[1]);

    // หัวเรื่อง
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#1a1a1a';
    ctx.font = '700 34px "Sarabun","Noto Sans Thai",Tahoma,sans-serif';
    ctx.fillText(cfg.title, PAD, 46);
    ctx.font = '500 18px "Sarabun","Noto Sans Thai",Tahoma,sans-serif'; ctx.fillStyle = '#555';
    ctx.fillText(cfg.subtitle || '', PAD, 74);

    // แผงด้านขวา
    panel(ctx, W - PW - PAD + 12, HEAD, PW - 12, H - HEAD - PAD - 30, cfg, bp, focus);

    // ที่มา
    ctx.font = '400 12px "Sarabun","Noto Sans Thai",Tahoma,sans-serif'; ctx.fillStyle = '#777'; ctx.textAlign = 'left';
    ctx.fillText(cfg.note || '', PAD, H - 14);
    return { P: P, inv: inv, map: [mapX, mapY, mapW, mapH] };
  }

  // แผนที่พื้นฐานแบบเส้นถนนสีเทา (คล้ายแผนที่เขตของหน่วยงาน)
  function drawBasemap(ctx, bm, P, s, mapX, mapY, mapW, mapH) {
    var q = bm.q;
    function visible(pts) {
      for (var i = 0; i < pts.length; i++) { var p = P(pts[i][0], pts[i][1]); if (p[0] > mapX - 50 && p[0] < mapX + mapW + 50 && p[1] > mapY - 50 && p[1] < mapY + mapH + 50) return true; }
      return false;
    }
    function strokeLines(list, color, width, dash) {
      ctx.beginPath();
      list.forEach(function (arr) {
        var pts = arr._d || (arr._d = decode(arr, q));
        pts.forEach(function (c, i) { var p = P(c[0], c[1]); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
      });
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (dash) ctx.setLineDash(dash);
      ctx.stroke(); ctx.setLineDash([]);
    }
    function fillPolys(list, color) {
      ctx.beginPath();
      list.forEach(function (poly) {
        poly.forEach(function (ring) {
          var pts = ring._d || (ring._d = decode(ring, q));
          pts.forEach(function (c, i) { var p = P(c[0], c[1]); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
          ctx.closePath();
        });
      });
      ctx.fillStyle = color; ctx.fill('evenodd');
    }
    var zoomF = Math.max(0.7, Math.min(2.2, s / 40000)); // ความหนาเส้นตามมาตราส่วน
    fillPolys(bm.water.area, 'rgba(158,196,224,0.75)');
    strokeLines(bm.water.canal, 'rgba(120,170,210,0.8)', 0.9 * zoomF);
    strokeLines(bm.roads.minor, 'rgba(110,110,110,0.45)', 0.55 * zoomF);
    strokeLines(bm.roads.tertiary, 'rgba(90,90,90,0.6)', 0.9 * zoomF);
    strokeLines(bm.roads.secondary, '#ffffff', 2.6 * zoomF);
    strokeLines(bm.roads.secondary, 'rgba(80,80,80,0.75)', 1.3 * zoomF);
    strokeLines(bm.roads.major, '#ffffff', 3.6 * zoomF);
    strokeLines(bm.roads.major, 'rgba(60,60,60,0.85)', 2 * zoomF);
    // แม่น้ำแม่กลอง (รูปพื้นที่จริง) — ไฮไลต์สีฟ้า
    fillPolys(bm.water.river, '#2f86de');
    // เส้นแม่น้ำ (ให้ต่อเนื่องแม้รูปพื้นที่ขาดช่วง)
    if (bm.water.riverLine) strokeLines(bm.water.riverLine, '#2f86de', Math.max(2.5, 2.2 * zoomF));
    if (bm.river) {
      // เส้นกึ่งกลางแม่น้ำแม่กลอง (สำรอง) ให้ต่อเนื่องตลอดแนว
      ctx.beginPath();
      bm.river.forEach(function (c, i) { var p = P(c[1], c[0]); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
      ctx.strokeStyle = '#2f86de'; ctx.lineWidth = Math.max(2.5, 2.2 * zoomF); ctx.stroke();
    }
    // เส้นแบ่งเขตอำเภอ (เส้นประ)
    bm.districts.forEach(function (d) {
      ctx.beginPath();
      d[1].forEach(function (poly) {
        poly.forEach(function (ring) {
          var pts = ring._d || (ring._d = decode(ring, q));
          pts.forEach(function (c, i) { var p = P(c[0], c[1]); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
        });
      });
      var bp = d[0] === 'Ban Pong';
      ctx.strokeStyle = bp ? 'rgba(20,20,20,0.9)' : 'rgba(60,60,60,0.6)'; ctx.lineWidth = bp ? 2.4 : 1.4;
      ctx.setLineDash(bp ? [10, 4, 2, 4] : [6, 4]); ctx.stroke(); ctx.setLineDash([]);
    });
  }

  // ชื่อชุมชน/วัด/โรงเรียนสีเทาจาง (หลบป้ายอื่น)
  function drawBaseLabels(ctx, bm, P, mapX, mapY, mapW, mapH, placed, size, maxN) {
    var order = { town: 0, village: 1, 'โรงพยาบาล': 2, 'ราชการ': 3, hamlet: 4, 'วัด': 5, 'โรงเรียน': 6 };
    var list = bm.labels.slice().sort(function (a, b) { return (order[a[3]] == null ? 9 : order[a[3]]) - (order[b[3]] == null ? 9 : order[b[3]]); });
    var n = 0;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    list.forEach(function (l) {
      if (n >= maxN) return;
      var p = P(l[1], l[2]);
      if (p[0] < mapX + 20 || p[0] > mapX + mapW - 20 || p[1] < mapY + 10 || p[1] > mapY + mapH - 10) return;
      if (l[0].length > 26) return; // ชื่อยาวเกินไปทำให้แผนที่รก
      var town = l[3] === 'town' || l[3] === 'village';
      var sz = town ? size + 1.5 : size;
      ctx.font = (town ? '600 ' : '400 ') + sz + 'px "Sarabun","Noto Sans Thai",Tahoma,sans-serif';
      var w = ctx.measureText(l[0]).width, box = [p[0] - w / 2 - 2, p[1] - sz * 0.6, p[0] + w / 2 + 2, p[1] + sz * 0.6];
      if (placed.some(function (b) { return box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]; })) return;
      box.push('base'); placed.push(box); n++;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.strokeText(l[0], p[0], p[1]);
      ctx.fillStyle = town ? 'rgba(60,60,60,0.9)' : 'rgba(110,110,110,0.85)'; ctx.fillText(l[0], p[0], p[1]);
    });
    ctx.restore();
  }

  function northArrow(ctx, x, y) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.beginPath(); ctx.arc(x, y, 24, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#555'; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y - 17); ctx.lineTo(x + 8, y + 9); ctx.lineTo(x, y + 4); ctx.lineTo(x - 8, y + 9); ctx.closePath();
    ctx.fillStyle = '#222'; ctx.fill();
    ctx.font = '700 12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('N', x, y + 21);
    ctx.restore();
  }
  function scaleBar(ctx, x, y, s, lat) {
    // s = พิกเซลต่อหน่วย mercator (0..1 = เส้นรอบโลก)
    var mPerPx = 40075016.686 * Math.cos(lat * Math.PI / 180) / s;
    var nice = [500, 1000, 2000, 5000, 10000], len = nice[0];
    nice.forEach(function (n) { if (n / mPerPx <= 180) len = n; });
    var px = len / mPerPx;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(x - 6, y - 18, px + 60, 28);
    ctx.fillStyle = '#222'; ctx.fillRect(x, y, px / 2, 5); ctx.strokeStyle = '#222'; ctx.strokeRect(x, y, px, 5);
    ctx.font = '600 12px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(len >= 1000 ? len / 1000 + ' กม.' : len + ' ม.', x + px + 6, y + 6);
    ctx.fillText('0', x - 2, y - 5);
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function panel(ctx, x, y, w, h, cfg, bp, focus) {
    var font = '"Sarabun","Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif';
    ctx.save();
    roundRect(ctx, x, y, w, h, 12); ctx.fillStyle = '#fafafa'; ctx.fill(); ctx.strokeStyle = '#d0d0d0'; ctx.lineWidth = 1; ctx.stroke();
    var cy = y + 36, lx = x + 22, tw = w - 44, plain = cfg.colorMode === 'plain';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    var teams = cfg._teams || [];
    var usedIds = (cfg.agencies || []).filter(function (a) { return cfg._used && cfg._used[a.id]; });
    var legendItems = [[COLORS.water, 'แม่น้ำแม่กลอง', 'box']];
    if (!plain) legendItems.push([COLORS.red.fill, 'ตำบลติด/แม่น้ำไหลผ่าน', 'box'], [COLORS.yellow.fill, 'ตำบลติดตำบลริมแม่น้ำ (เฝ้าระวัง)', 'box'], [COLORS.gray.fill, 'ตำบลอื่นใน อ.บ้านโป่ง', 'box']);
    if (teams.some(function (t) { return t.t.base; })) legendItems.push(['#37474f', 'จุดตั้งชุดปฏิบัติการ (หมายเลขตามรายการ)', 'pin']);
    var legendTop = y + h - 38 - legendItems.length * 26;
    var hidden = 0;
    function fits(n) { if (cy + n < legendTop - 24) return true; hidden++; return false; }
    function heading(t, col) { if (!fits(30)) return; ctx.font = '700 20px ' + font; ctx.fillStyle = col || '#1a1a1a'; ctx.fillText(t, lx, cy); cy += 28; }
    function line(t, f, col, lh) { ctx.font = f + ' ' + font; ctx.fillStyle = col; cy = wrap(ctx, t, lx + 32, cy, tw - 32, lh || 19); }
    function riverText(f) {
      return f.properties.cls !== 'red' ? 'ไม่ติดแม่น้ำแม่กลอง' : f.properties.riverKm >= 0.05 ? 'แม่น้ำแม่กลองไหลผ่าน ~' + f.properties.riverKm.toFixed(1) + ' กม.' : 'ติดแนวแม่น้ำแม่กลอง';
    }

    // ตำบลที่เลือก
    if (cfg.focus) {
      if (focus.length === 1) {
        var f0 = focus[0];
        ctx.font = '700 22px ' + font; ctx.fillStyle = '#222'; ctx.fillText('ต.' + f0.properties.th + ' (' + f0.properties.en + ')', lx, cy); cy += 26;
        ctx.font = '400 15px ' + font; ctx.fillStyle = '#555';
        cy = wrap(ctx, 'พื้นที่ ~' + f0.properties.areaKm2.toFixed(1) + ' ตร.กม. · ' + riverText(f0), lx, cy, tw, 19);
        cy = wrap(ctx, 'ติดกับ: ' + f0.properties.neighbors.map(function (n) { return 'ต.' + n; }).join(', '), lx, cy, tw, 19);
      } else {
        var tot = focus.reduce(function (a, f) { return a + f.properties.areaKm2; }, 0);
        ctx.font = '700 21px ' + font; ctx.fillStyle = '#222'; ctx.fillText('ตำบลที่เลือก ' + focus.length + ' ตำบล (~' + tot.toFixed(1) + ' ตร.กม.)', lx, cy); cy += 26;
        focus.forEach(function (f) {
          ctx.font = '600 16px ' + font; ctx.fillStyle = '#222'; ctx.fillText('ต.' + f.properties.th, lx, cy);
          ctx.font = '400 14px ' + font; ctx.fillStyle = '#555'; ctx.textAlign = 'right';
          ctx.fillText(f.properties.areaKm2.toFixed(1) + ' ตร.กม. · ' + riverText(f), x + w - 20, cy); ctx.textAlign = 'left';
          cy += 22;
        });
      }
      cy += 14;
    }

    // หน่วยงานรับผิดชอบ
    if (usedIds.length) {
      heading('หน่วยงานรับผิดชอบ');
      usedIds.forEach(function (a) {
        var u = cfg._used[a.id];
        if (!fits(64)) return;
        ctx.fillStyle = a.color; roundRect(ctx, lx, cy - 16, 22, 22, 5); ctx.fill();
        line(a.name || '(ไม่ระบุชื่อหน่วยงาน)', '700 17px', '#1a1a1a', 21);
        if (a.person) line('ผู้รับผิดชอบ: ' + a.person, '400 14px', '#333');
        if (a.phone) line('☎ ' + a.phone, '700 15px', '#b71c1c', 20);
        var area = u.tambons.map(function (t) { return 'ต.' + t; });
        if (u.zones) area.push('กรอบพื้นที่ ' + u.zones + ' แห่ง');
        line('พื้นที่: ' + area.join(', '), '400 13px', '#555', 18);
        if (a.note) line(a.note, '400 13px', '#555', 18);
        cy += 8;
      });
      cy += 4;
    }

    // ชุดปฏิบัติการ
    if (teams.length) {
      heading('ชุดปฏิบัติการ (' + teams.length + ' ชุด)');
      teams.forEach(function (it) {
        var t = it.t;
        if (!fits(58)) return;
        ctx.beginPath(); ctx.arc(lx + 11, cy - 5, 12, 0, Math.PI * 2); ctx.fillStyle = it.color; ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '700 13px ' + font; ctx.textAlign = 'center'; ctx.fillText(String(it.n), lx + 11, cy - 1); ctx.textAlign = 'left';
        var org = (cfg.agencies || []).filter(function (a) { return a.id === t.agency; })[0];
        line((t.name || 'ชุดที่ ' + it.n) + (org && org.name ? ' · ' + org.name : ''), '700 16px', '#1a1a1a', 20);
        var lead = [t.leader ? 'หัวหน้าชุด: ' + t.leader : '', t.phone ? '☎ ' + t.phone : ''].filter(Boolean).join('  ');
        if (lead) line(lead, '600 14px', t.phone ? '#b71c1c' : '#333');
        var res = [t.staff ? 'กำลังพล ' + t.staff + ' นาย' : '', t.equipment || ''].filter(Boolean).join(' · ');
        if (res) line(res, '400 13px', '#333', 18);
        if ((t.tambons || []).length) line('พื้นที่: ' + t.tambons.map(function (x) { return 'ต.' + x; }).join(', '), '400 13px', '#555', 18);
        if (t.note) line(t.note, '400 13px', '#555', 18);
        cy += 8;
      });
    }

    // ไม่มีหน่วยงาน/ชุดปฏิบัติการ: สรุปตำบลตามแม่น้ำ (ภาพรวม) หรือคำแนะนำ
    if (!usedIds.length && !teams.length) {
      if (!cfg.focus && !plain) {
        var red = bp.filter(function (f) { return f.properties.cls === 'red'; }).sort(function (a, b) { return b.properties.riverKm - a.properties.riverKm; });
        var yel = bp.filter(function (f) { return f.properties.cls === 'yellow'; });
        heading('ตำบลที่ได้รับผลกระทบ (' + red.length + ' ตำบล)', '#b71c1c');
        red.forEach(function (f, i) {
          if (!fits(34)) return;
          ctx.fillStyle = '#e53935'; roundRect(ctx, lx, cy - 18, 26, 26, 6); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.font = '700 15px ' + font; ctx.textAlign = 'center'; ctx.fillText(String(i + 1), lx + 13, cy);
          ctx.textAlign = 'left'; ctx.fillStyle = '#222'; ctx.font = '700 19px ' + font; ctx.fillText('ต.' + f.properties.th, lx + 38, cy);
          ctx.font = '400 14px ' + font; ctx.fillStyle = '#555'; ctx.textAlign = 'right';
          ctx.fillText((f.properties.riverKm > 0.05 ? '~' + f.properties.riverKm.toFixed(1) + ' กม.' : 'ติดแนวแม่น้ำ') + ' · ' + f.properties.areaKm2.toFixed(1) + ' ตร.กม.', x + w - 20, cy);
          ctx.textAlign = 'left'; cy += 34;
        });
        if (fits(60)) {
          cy += 6; ctx.font = '700 17px ' + font; ctx.fillStyle = '#7a6400';
          ctx.fillText('ตำบลเฝ้าระวัง ' + yel.length + ' ตำบล', lx, cy); cy += 24;
          ctx.font = '400 15px ' + font; ctx.fillStyle = '#333';
          cy = wrap(ctx, yel.map(function (f) { return f.properties.th; }).join(' · '), lx, cy, tw, 21);
        }
      } else {
        ctx.font = '400 14px ' + font; ctx.fillStyle = '#777';
        cy = wrap(ctx, 'ยังไม่ได้กำหนดหน่วยงานหรือชุดปฏิบัติการ — ใช้เครื่องมือ “คลิกตำบล”, “วาดกรอบ” หรือ “วางจุดชุดปฏิบัติการ” ใต้แผนที่', lx, cy + 4, tw, 20);
      }
    }
    if (hidden) {
      ctx.font = '400 13px ' + font; ctx.fillStyle = '#777';
      ctx.fillText('…ยังมีอีก ' + hidden + ' รายการที่แสดงไม่พอในกรอบนี้', lx, legendTop - 26);
    }

    // คำอธิบายสัญลักษณ์
    var ly = legendTop;
    ctx.strokeStyle = '#ddd'; ctx.beginPath(); ctx.moveTo(lx, ly - 16); ctx.lineTo(x + w - 22, ly - 16); ctx.stroke();
    ctx.font = '700 15px ' + font; ctx.fillStyle = '#333'; ctx.fillText('คำอธิบายสัญลักษณ์', lx, ly + 4); ly += 28;
    legendItems.forEach(function (it) {
      if (it[2] === 'pin') { ctx.beginPath(); ctx.arc(lx + 15, ly - 5, 10, 0, Math.PI * 2); ctx.fillStyle = it[0]; ctx.fill(); }
      else { ctx.fillStyle = it[0]; roundRect(ctx, lx, ly - 15, 30, 20, 4); ctx.fill(); ctx.strokeStyle = '#888'; ctx.stroke(); }
      ctx.fillStyle = '#333'; ctx.font = '400 14px ' + font; ctx.fillText(it[1], lx + 42, ly); ly += 26;
    });
    ctx.restore();
  }

  function wrap(ctx, text, x, y, maxW, lh) {
    var words = text.split(' '), line = '';
    words.forEach(function (wd) {
      var t = line ? line + ' ' + wd : wd;
      if (ctx.measureText(t).width > maxW && line) { ctx.fillText(line, x, y); y += lh; line = wd; } else line = t;
    });
    if (line) { ctx.fillText(line, x, y); y += lh; }
    return y;
  }

  var api = { classify: classify, render: render, decode: decode, labelPoint: labelPoint, pointInFeature: pointInFeature, bboxOf: bboxOf, mx: mx, my: my, COLORS: COLORS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TambonMap = api;
})(this);
