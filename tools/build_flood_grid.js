#!/usr/bin/env node
// สร้าง data/banpong-flood.js: ตารางคาดการณ์น้ำท่วม อ.บ้านโป่ง สำหรับหน้าแผนที่ตำบล (ใช้งานได้โดยไม่ต้องต่อเน็ต)
//
// ต่อเซลล์ (~37 ม.) เก็บ:
//   e   = ระดับพื้นดินเทียบระดับน้ำที่ K.55A (ม.) = พื้นดิน (ปรับเขตอาคาร/ต้นไม้แล้ว) + ความลาดผิวน้ำ × ระยะตามลำน้ำ
//         → ถ้าระดับน้ำ K.55A = H ความลึก ≈ H − e
//   thr = ระดับน้ำที่ K.55A ที่ต่ำที่สุดที่น้ำจะไหลจากตลิ่งมาถึงเซลล์นี้ได้
//         (เส้นทางต่อเนื่องจากจุดล้นตลิ่ง: ค่าสูงสุดตามเส้นทางของ max(ตลิ่ง, e) ที่ต่ำที่สุด — priority flood)
//   ตำบล (ลำดับใน data/banpong-tambons.js) และการใช้ที่ดิน (ESA WorldCover)
// ใช้งาน: npm install && node tools/build_flood_grid.js
'use strict';
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const ROOT = path.join(__dirname, '..');
const CFG = require(path.join(ROOT, 'js/config.js'));
const M = require(path.join(ROOT, 'js/flood.js'));
const T = require(path.join(ROOT, 'js/terrain.js'));
const TM = require(path.join(ROOT, 'js/tambon-map.js'));

const sb = {};
new Function('window', ['data/maeklong-river.js', 'data/landcover.js', 'data/banpong-tambons.js']
  .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n'))(sb);
const LC = sb.LANDCOVER, line = sb.MAEKLONG_RIVER, tambons = sb.BANPONG_TAMBONS.features.filter(f => f.properties.role === 'banpong');
const P = CFG.params, PS = CFG.primaryStation, Z = 12;
const CACHE = path.join(ROOT, '.cache', 'dem');

async function tile(z, x, y) {
  const f = path.join(CACHE, `${z}_${x}_${y}.png`);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(f, buf);
      return buf;
    } catch (e) { if (a >= 3) throw e; }
  }
}
async function loadGrid(b, z) {
  const x0 = Math.floor(M.lonToX(b.west, z)), x1 = Math.ceil(M.lonToX(b.east, z));
  const y0 = Math.floor(M.latToY(b.north, z)), y1 = Math.ceil(M.latToY(b.south, z));
  const w = x1 - x0, h = y1 - y0, elev = new Float32Array(w * h).fill(NaN), list = [];
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y1 - 1) / 256); ty++)
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x1 - 1) / 256); tx++) list.push([tx, ty]);
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(list.slice(i, i + 8).map(async ([tx, ty]) => {
      const p = PNG.sync.read(await tile(z, tx, ty));
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const gx = tx * 256 + x - x0, gy = ty * 256 + y - y0;
        if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
        const j = (y * 256 + x) * 4;
        elev[gy * w + gx] = p.data[j] * 256 + p.data[j + 1] + p.data[j + 2] / 256 - 32768;
      }
    }));
  }
  return { z, x0, y0, w, h, elev };
}
function landuseFor(g) {
  const png = PNG.sync.read(Buffer.from(LC.png.split(',')[1], 'base64'));
  const out = new Uint8Array(g.w * g.h), sc = 2 ** (LC.z - g.z);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const X = Math.floor((g.x0 + x + 0.5) * sc) - LC.x0, Y = Math.floor((g.y0 + y + 0.5) * sc) - LC.y0;
    out[y * g.w + x] = X < 0 || Y < 0 || X >= LC.w || Y >= LC.h ? 4 : Math.round(png.data[(Y * LC.w + X) * 4] / LC.scale);
  }
  return out;
}

// heap ค่าต่ำสุดก่อน
function Heap(n) { this.k = new Float64Array(n); this.v = new Int32Array(n); this.n = 0; }
Heap.prototype.push = function (key, val) {
  let i = this.n++; const k = this.k, v = this.v;
  while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
  k[i] = key; v[i] = val;
};
Heap.prototype.pop = function () {
  const k = this.k, v = this.v, top = v[0], topK = k[0], lk = k[--this.n], lv = v[this.n];
  let i = 0;
  for (;;) { let c = 2 * i + 1; if (c >= this.n) break; if (c + 1 < this.n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
  k[i] = lk; v[i] = lv;
  this.lastKey = topK; return top;
};

(async () => {
  const g = await loadGrid(CFG.bbox, Z);
  const lu = landuseFor(g);
  const mpp = M.metersPerPixel(M.yToLat(g.y0 + g.h / 2, g.z), g.z);
  if (P.bareEarth) g.elev = T.bareEarth(g, lu, { blockPx: Math.round(P.bareEarthBlockM / mpp), tolM: P.bareEarthTolM }).elev;
  const { w, h } = g, N = w * h;
  const river = M.rasterizeRiver(g, line, P.channelHalfWidthM);
  const dev = M.bankDeviation(g, river);
  const ch0 = M.projectToLine(line, PS.lat, PS.lon).chainage, slope = P.riverSlopeMPerKm, bank = PS.bank;
  const cl = river.cl, chan = river.chan;

  // ระยะตามลำน้ำของจุดกึ่งกลางที่ใกล้ที่สุด + ระยะห่างจากลำน้ำ (BFS)
  const near = new Int32Array(N).fill(-1), dist = new Uint16Array(N).fill(65535), q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let k = 0; k < N; k++) if (chan[k] >= 0) { near[k] = chan[k]; dist[k] = 0; q[qt++] = k; }
  while (qh < qt) {
    const c = q[qh++], cx = c % w, cy = (c - cx) / w;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx; if (dist[n] !== 65535) continue;
      dist[n] = dist[c] + 1; near[n] = near[c]; q[qt++] = n;
    }
  }
  const maxSteps = Math.round(P.maxSpreadKm * 1000 / mpp);
  const e = new Float32Array(N).fill(NaN);
  for (let k = 0; k < N; k++) if (near[k] >= 0 && g.elev[k] === g.elev[k]) e[k] = g.elev[k] - P.demOffsetM + slope * (cl[near[k]].ch - ch0);

  // ครอบเฉพาะ อ.บ้านโป่ง (+ ขอบ)
  const bb = TM.bboxOf(tambons), pad = 0.015;
  const cx0 = Math.max(0, Math.floor(M.lonToX(bb[0] - pad, Z) - g.x0)), cx1 = Math.min(w, Math.ceil(M.lonToX(bb[2] + pad, Z) - g.x0));
  const cy0 = Math.max(0, Math.floor(M.latToY(bb[3] + pad, Z) - g.y0)), cy1 = Math.min(h, Math.ceil(M.latToY(bb[1] - pad, Z) - g.y0));
  const SEED_ALL = process.argv.includes('--seed-all');

  // priority flood จากร่องน้ำ: ตลิ่งเฉพาะที่ = ตลิ่ง K.55A + ส่วนที่ตลิ่งสูงกว่าแนวโน้ม (เหมือนหน้าคาดการณ์หลัก)
  const thr = new Float32Array(N).fill(Infinity), heap = new Heap(N * 2);
  for (let k = 0; k < N; k++) {
    const ci = chan[k]; if (ci < 0) continue;
    const c = cl[ci], kx = k % w, ky = (k - kx) / w;
    // น้ำล้นเข้าพื้นที่เฉพาะจากตลิ่งช่วงที่ไหลผ่าน อ.บ้านโป่ง (ไม่ไหลย้อนจากจุดล้นที่อยู่ไกลออกไปหลายสิบ กม.)
    if (!SEED_ALL && (kx < cx0 || kx >= cx1 || ky < cy0 || ky >= cy1)) continue;
    const cross = c.dx * (ky - c.gy) - c.dy * (kx - c.gx);
    const d = cross < 0 ? dev.left[ci] : cross > 0 ? dev.right[ci] : Math.min(dev.left[ci], dev.right[ci]);
    thr[k] = bank + P.bankDemWeight * Math.max(0, d);
    heap.push(thr[k], k);
  }
  const done = new Uint8Array(N);
  while (heap.n) {
    const c = heap.pop(), t = heap.lastKey;
    if (done[c] || t > thr[c]) continue;
    done[c] = 1;
    const cx = c % w, cy = (c - cx) / w;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (done[n] || chan[n] >= 0 || !(e[n] === e[n]) || dist[n] > maxSteps) continue;
      const nt = Math.max(t, e[n]);
      if (nt < thr[n]) { thr[n] = nt; heap.push(nt, n); }
    }
  }

  const W = cx1 - cx0, H = cy1 - cy0;
  const A = new PNG({ width: W, height: H }), B = new PNG({ width: W, height: H });
  const enc = v => (v === v && isFinite(v)) ? Math.max(0, Math.min(65534, Math.round((v + 20) * 100))) : 65535;
  const order = tambons.map(f => f.properties.th);
  let inside = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = (cy0 + y) * w + (cx0 + x), j = (y * W + x) * 4;
    const [lat, lon] = M.gridLatLon(g, cx0 + x, cy0 + y);
    let ti = 255;
    for (let i = 0; i < tambons.length; i++) if (TM.pointInFeature(lon, lat, tambons[i])) { ti = i; break; }
    if (ti !== 255) inside++;
    const river = chan[k] >= 0;
    const tv = river ? 65535 : enc(thr[k]), ev = enc(e[k]);
    A.data[j] = tv >> 8; A.data[j + 1] = tv & 255; A.data[j + 2] = ti; A.data[j + 3] = 255;
    B.data[j] = ev >> 8; B.data[j + 1] = ev & 255; B.data[j + 2] = river ? 254 : lu[k]; B.data[j + 3] = 255;
  }
  const pa = PNG.sync.write(A), pb = PNG.sync.write(B);
  const meta = { z: Z, x0: g.x0 + cx0, y0: g.y0 + cy0, w: W, h: H, offset: 20, scale: 100, none: 65535, riverCode: 254,
    tambons: order, bank, slope, ch0: +ch0.toFixed(3), params: { bareEarth: P.bareEarth, bankDemWeight: P.bankDemWeight, maxSpreadKm: P.maxSpreadKm, waterBodyDepthM: P.waterBodyDepthM },
    ratingCurve: PS.ratingCurve, bankfullQ: PS.bankfullQ };
  fs.writeFileSync(path.join(ROOT, 'data/banpong-flood.js'),
    '// ตารางคาดการณ์น้ำท่วม อ.บ้านโป่ง (สร้างด้วย tools/build_flood_grid.js) — DEM: AWS Terrain Tiles, การใช้ที่ดิน: ESA WorldCover 2021\n' +
    '// a: R,G = thr (ระดับน้ำ K.55A ที่น้ำมาถึง, (ค่า/100) − offset ม.), B = ลำดับตำบล (255 = นอกอำเภอ)\n' +
    '// b: R,G = e (พื้นดินเทียบระดับ K.55A), B = การใช้ที่ดิน (254 = ลำน้ำ)\n' +
    'window.BANPONG_FLOOD = ' + JSON.stringify(Object.assign(meta, {
      a: 'data:image/png;base64,' + pa.toString('base64'), b: 'data:image/png;base64,' + pb.toString('base64') })) + ';\n');
  console.log(`grid ${W}x${H}, cells in Ban Pong ${inside}, png ${(pa.length / 1024).toFixed(0)}+${(pb.length / 1024).toFixed(0)} KB`);
})().catch(e => { console.error(e); process.exit(1); });
