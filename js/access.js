// การเข้าถึงทางถนนเมื่อน้ำท่วม: ถนนแต่ละช่วงลึกเท่าไร รถชนิดไหนผ่านได้ หมู่บ้านไหนต้องใช้เรือ
//
// โครงข่ายถนนจากแผนที่ฐาน (Overture/OSM) → กราฟ (จุดต่อ = พิกัดเดียวกัน) · ความลึกช่วงถนน = ค่าสูงสุดที่จุดตัวอย่างทุก ~30 ม.
// รถชนิดหนึ่งผ่านช่วงถนนได้เมื่อความลึก ≤ เกณฑ์ของรถนั้น · ไปถึงได้ = มีเส้นทางต่อเนื่องจากจุดเริ่ม (ฐานชุดปฏิบัติการ
// หรือถนนสายหลักที่น้ำไม่ท่วม) · หมู่บ้านเข้าถึงด้วยรถได้เมื่อมีจุดบนถนนในรัศมีที่ไปถึงได้ และน้ำที่ตัวหมู่บ้านไม่เกินเกณฑ์
(function (root) {
  var VEHICLES = [
    { key: 'car', label: 'รถเก๋ง', maxDepth: 0.3, color: '#fbc02d' },
    { key: 'pickup', label: 'รถกระบะ', maxDepth: 0.5, color: '#fb8c00' },
    { key: 'truck', label: 'รถยกสูง/รถทหาร', maxDepth: 0.8, color: '#e53935' }
  ];
  var BOAT = { key: 'boat', label: 'เรือเท่านั้น', color: '#6a1b9a' };
  // ผิวถนนสูงกว่าพื้นที่รอบข้าง (คันทาง) ซึ่ง DEM ~37 ม. มองไม่เห็น — หักออกจากความลึกตามชั้นถนน (ม.) ปรับได้
  var RAISE = [1.0, 0.7, 0.4, 0.2]; // สายหลัก, สายรอง, ถนนท้องถิ่น, ซอย/ถนนเล็ก

  function decode(arr, q) {
    var out = [], x = 0, y = 0;
    for (var i = 0; i < arr.length; i += 2) { x += arr[i]; y += arr[i + 1]; out.push([x, y]); }
    return out.map(function (p) { return [p[0] / q, p[1] / q, p[0] + ',' + p[1]]; });
  }
  function km(a, b) {
    var kx = 111.32 * Math.cos(b[1] * Math.PI / 180);
    return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110.57);
  }

  // basemap: { q, roads: { major:[], secondary:[], tertiary:[], minor:[] } }
  function buildGraph(basemap, bbox) {
    var q = basemap.q, ids = new Map(), lon = [], lat = [], major = [], ea = [], eb = [], elen = [], ecls = [];
    var CLS = { major: 0, secondary: 1, tertiary: 2, minor: 3 };
    function node(p, isMajor) {
      var id = ids.get(p[2]);
      if (id == null) { id = lon.length; ids.set(p[2], id); lon.push(p[0]); lat.push(p[1]); major.push(0); }
      if (isMajor) major[id] = 1;
      return id;
    }
    Object.keys(basemap.roads).forEach(function (cls) {
      basemap.roads[cls].forEach(function (arr) {
        var pts = decode(arr, q);
        if (bbox && !pts.some(function (p) { return p[0] >= bbox[0] && p[0] <= bbox[2] && p[1] >= bbox[1] && p[1] <= bbox[3]; })) return;
        for (var i = 1; i < pts.length; i++) {
          var a = node(pts[i - 1], cls === 'major' || cls === 'secondary'), b = node(pts[i], cls === 'major' || cls === 'secondary');
          if (a === b) continue;
          ea.push(a); eb.push(b); elen.push(km(pts[i - 1], pts[i])); ecls.push(CLS[cls]);
        }
      });
    });
    // เชื่อมปลายถนนที่ขาด: แผนที่ฐานถูกลดจุด (simplify) ทำให้ทางแยกรูปตัว T บางแห่งไม่มีจุดร่วม
    // ปลายถนน (จุดที่มีถนนเส้นเดียว) ที่อยู่ห่างถนนเส้นอื่นไม่เกิน 25 ม. → ต่อเข้ากับปลายช่วงถนนนั้นที่ใกล้กว่า
    (function snap() {
      var cnt = new Int32Array(lon.length), cell = 0.002, grid = new Map(), m0 = ea.length;
      for (var e = 0; e < m0; e++) { cnt[ea[e]]++; cnt[eb[e]]++; }
      function add(key, e) { var l = grid.get(key); if (!l) grid.set(key, l = []); l.push(e); }
      for (e = 0; e < m0; e++) {
        var steps = Math.max(1, Math.ceil(elen[e] / 0.15)), seen = {};
        for (var s2 = 0; s2 <= steps; s2++) {
          var t = s2 / steps, key = Math.floor((lon[ea[e]] + (lon[eb[e]] - lon[ea[e]]) * t) / cell) + ',' + Math.floor((lat[ea[e]] + (lat[eb[e]] - lat[ea[e]]) * t) / cell);
          if (!seen[key]) { seen[key] = 1; add(key, e); }
        }
      }
      for (var i = 0; i < lon.length; i++) {
        if (cnt[i] !== 1) continue;
        var cx = Math.floor(lon[i] / cell), cy = Math.floor(lat[i] / cell), best = null, bd = 0.025;
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) (grid.get((cx + dx) + ',' + (cy + dy)) || []).forEach(function (e2) {
          var a = ea[e2], b = eb[e2];
          if (a === i || b === i) return;
          // ระยะจากจุดถึงช่วงถนน (ระนาบเฉพาะที่)
          var kx = 111.32 * Math.cos(lat[i] * Math.PI / 180), ax = (lon[a] - lon[i]) * kx, ay = (lat[a] - lat[i]) * 110.57,
            bx = (lon[b] - lon[i]) * kx, by = (lat[b] - lat[i]) * 110.57, vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy;
          var t = L ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L)) : 0, d = Math.hypot(ax + vx * t, ay + vy * t);
          if (d < bd) { bd = d; best = t < 0.5 ? a : b; }
        });
        if (best != null) { ea.push(i); eb.push(best); elen.push(km([lon[i], lat[i]], [lon[best], lat[best]])); ecls.push(3); }
      }
    })();
    var n = lon.length, m = ea.length, deg = new Int32Array(n + 1);
    for (var e = 0; e < m; e++) { deg[ea[e] + 1]++; deg[eb[e] + 1]++; }
    for (var k = 0; k < n; k++) deg[k + 1] += deg[k];
    var adj = new Int32Array(2 * m), fill = deg.slice(0, n);
    for (e = 0; e < m; e++) { adj[fill[ea[e]]++] = e; adj[fill[eb[e]]++] = e; }
    return { n: n, m: m, lon: Float64Array.from(lon), lat: Float64Array.from(lat), major: Uint8Array.from(major),
      ea: Int32Array.from(ea), eb: Int32Array.from(eb), len: Float64Array.from(elen), cls: Uint8Array.from(ecls), off: deg, adj: adj };
  }

  // depthAt(lon, lat) → ความลึก (ม.) · คืนความลึกสูงสุดของแต่ละช่วงถนน
  function edgeDepths(g, depthAt, raise) {
    var d = new Float32Array(g.m);
    raise = raise || RAISE;
    for (var e = 0; e < g.m; e++) {
      var a = g.ea[e], b = g.eb[e], steps = Math.max(1, Math.ceil(g.len[e] / 0.03)), mx = 0;
      for (var s = 0; s <= steps; s++) {
        var t = s / steps, v = depthAt(g.lon[a] + (g.lon[b] - g.lon[a]) * t, g.lat[a] + (g.lat[b] - g.lat[a]) * t);
        if (v > mx) mx = v;
      }
      d[e] = Math.max(0, mx - (raise[g.cls[e]] || 0));
    }
    return d;
  }

  // จุดถนนที่ใกล้พิกัดที่สุดภายในรัศมี (กม.) — ดัชนีตารางอย่างง่าย
  function index(g) {
    var cell = 0.005, map = new Map();
    for (var i = 0; i < g.n; i++) {
      var key = Math.floor(g.lon[i] / cell) + ',' + Math.floor(g.lat[i] / cell);
      var l = map.get(key); if (!l) map.set(key, l = []); l.push(i);
    }
    return function near(lonv, latv, rKm) {
      var r = Math.ceil(rKm / 0.5) + 1, cx = Math.floor(lonv / cell), cy = Math.floor(latv / cell), out = [];
      for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) {
        (map.get((cx + dx) + ',' + (cy + dy)) || []).forEach(function (i) { if (km([lonv, latv], [g.lon[i], g.lat[i]]) <= rKm) out.push(i); });
      }
      return out;
    };
  }

  // ไปถึงได้จากจุดเริ่ม โดยใช้เฉพาะช่วงถนนที่ลึกไม่เกิน maxDepth
  function reach(g, depth, sources, maxDepth) {
    var seen = new Uint8Array(g.n), stack = [];
    sources.forEach(function (s) { if (!seen[s]) { seen[s] = 1; stack.push(s); } });
    while (stack.length) {
      var u = stack.pop();
      for (var k = g.off[u]; k < g.off[u + 1]; k++) {
        var e = g.adj[k];
        if (depth[e] > maxDepth) continue;
        var v = g.ea[e] === u ? g.eb[e] : g.ea[e];
        if (!seen[v]) { seen[v] = 1; stack.push(v); }
      }
    }
    return seen;
  }

  // วิเคราะห์ทั้งหมด: opts { depthAt, vehicles, bases: [[lon,lat]], villages: [{key, lon, lat, depth}], nearKm }
  function analyze(g, opts) {
    var veh = opts.vehicles || VEHICLES, depth = edgeDepths(g, opts.depthAt, opts.raise), near = g._near || (g._near = index(g));
    var sources = [];
    (opts.bases || []).forEach(function (b) {
      var c = near(b[0], b[1], 0.5);
      c.forEach(function (i) { sources.push(i); });
    });
    var fromBases = sources.length > 0;
    if (!fromBases) {
      // ไม่มีฐานชุดปฏิบัติการ: เริ่มจากถนนสายหลัก/สายรองที่น้ำไม่ท่วม
      for (var e = 0; e < g.m; e++) if (g.cls[e] <= 1 && depth[e] <= 0.02) { sources.push(g.ea[e]); sources.push(g.eb[e]); }
    }
    var reached = veh.map(function (v) { return reach(g, depth, sources, v.maxDepth); });
    // สรุปความยาวถนนตามชั้นความลึก (กม.)
    var lenBy = veh.map(function () { return 0; }).concat([0]), wet = 0, cut = 0, inArea = opts.inArea;
    function inside(e) { return !inArea || inArea((g.lon[g.ea[e]] + g.lon[g.eb[e]]) / 2, (g.lat[g.ea[e]] + g.lat[g.eb[e]]) / 2); }
    for (e = 0; e < g.m; e++) {
      var d = depth[e]; if (d <= 0.02 || !inside(e)) continue;
      wet += g.len[e];
      var c = veh.findIndex(function (v) { return d <= v.maxDepth; });
      lenBy[c < 0 ? veh.length : c] += g.len[e];
    }
    var last = reached[reached.length - 1];
    for (e = 0; e < g.m; e++) if (depth[e] <= 0.02 && !last[g.ea[e]] && !last[g.eb[e]] && inside(e)) cut += g.len[e];
    var villages = (opts.villages || []).map(function (vg) {
      var cand = near(vg.lon, vg.lat, opts.nearKm || 0.4), best = null;
      for (var i = 0; i < veh.length && !best; i++) {
        if ((vg.depth || 0) > veh[i].maxDepth) continue;
        if (cand.some(function (c) { return reached[i][c]; })) best = veh[i];
      }
      return Object.assign({}, vg, { access: best || BOAT, roadNearby: cand.length > 0 });
    });
    return { depth: depth, reached: reached, fromBases: fromBases, lenBy: lenBy, wetKm: wet, cutKm: cut, villages: villages, vehicles: veh };
  }

  // ช่วงถนนสำหรับวาด: คืน [{a:[lon,lat], b:[lon,lat], c: ดัชนีชั้น (0..n-1 = รถที่ยังผ่านได้, n = เรือ), cut: bool}]
  function segments(g, res, bbox) {
    var out = [], veh = res.vehicles, last = res.reached[res.reached.length - 1];
    for (var e = 0; e < g.m; e++) {
      var a = g.ea[e], b = g.eb[e], d = res.depth[e];
      if (bbox && (g.lon[a] < bbox[0] || g.lon[a] > bbox[2] || g.lat[a] < bbox[1] || g.lat[a] > bbox[3])) continue;
      var wetSeg = d > 0.02, cutSeg = !wetSeg && !last[a] && !last[b];
      if (!wetSeg && !cutSeg) continue;
      var c = wetSeg ? veh.findIndex(function (v) { return d <= v.maxDepth; }) : -1;
      out.push({ a: [g.lon[a], g.lat[a]], b: [g.lon[b], g.lat[b]], c: wetSeg ? (c < 0 ? veh.length : c) : -1, cut: cutSeg, d: d });
    }
    return out;
  }

  var api = { RAISE: RAISE, VEHICLES: VEHICLES, BOAT: BOAT, buildGraph: buildGraph, edgeDepths: edgeDepths, reach: reach, analyze: analyze, segments: segments };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Access = api;
})(this);
