#!/usr/bin/env node
// คำนวณตารางสถานการณ์ตาม Rating Curve ของ K.55A จากบรรทัดคำสั่ง (ใช้แบบจำลองเดียวกับหน้าเว็บ)
// ใช้งาน: npm install && node tools/scenarios.js [ซูม DEM=12] [ชั่วโมงน้ำล้น=48]
'use strict';
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const ROOT = path.join(__dirname, '..');
const CFG = require(path.join(ROOT, 'js/config.js'));
const M = require(path.join(ROOT, 'js/flood.js'));
const R = require(path.join(ROOT, 'js/rating.js'));

const sandbox = {};
new Function('window', fs.readFileSync(path.join(ROOT, 'data/maeklong-river.js'), 'utf8'))(sandbox);
const line = sandbox.MAEKLONG_RIVER;
const Z = parseInt(process.argv[2] || CFG.params.demZoom, 10);
const HOURS = parseFloat(process.argv[3] || CFG.params.overflowHours);
const CACHE = path.join(ROOT, '.cache', 'dem');

async function tile(z, x, y) {
  const f = path.join(CACHE, `${z}_${x}_${y}.png`);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(f, buf);
      return buf;
    } catch (e) { if (a >= 3) throw e; }
  }
}

async function loadGrid(b, z) {
  const x0 = Math.floor(M.lonToX(b.west, z)), x1 = Math.ceil(M.lonToX(b.east, z));
  const y0 = Math.floor(M.latToY(b.north, z)), y1 = Math.ceil(M.latToY(b.south, z));
  const w = x1 - x0, h = y1 - y0, elev = new Float32Array(w * h).fill(NaN);
  const list = [];
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

(async () => {
  const P = CFG.params, PS = CFG.primaryStation;
  const grid = await loadGrid(CFG.bbox, Z);
  const river = M.rasterizeRiver(grid, line, P.channelHalfWidthM);
  const bankDev = M.bankDeviation(grid, river);
  const anchor = M.projectToLine(line, PS.lat, PS.lon);
  const qbf = R.dischargeFromLevel(PS.ratingCurve, Math.min(PS.leftBank, PS.rightBank));
  console.log(`DEM ซูม ${Z} (${grid.w}×${grid.h}), น้ำล้นตลิ่ง ${HOURS} ชม., Q ตลิ่งเต็ม ≈ ${qbf.toFixed(0)} ลบ.ม./วินาที`);
  console.log('Q (ลบ.ม./วิ)\tระดับ (ม.รทก.)\tปริมาตร (ล้าน ลบ.ม.)\tคาดการณ์ (ไร่)\tเสี่ยงสูงสุด (ไร่)\tลึกเฉลี่ย (ม.)\tความเสียหาย (ล้านบาท)');
  const qs = [2900, 2950, ...PS.ratingCurve.map(p => p[0]).filter(q => q > 2900)];
  for (const q of qs) {
    const h = R.levelFromDischarge(PS.ratingCurve, q);
    const profile = M.makeProfile([{ chainage: anchor.chainage, ws: h, leftBank: PS.leftBank, rightBank: PS.rightBank }], P.riverSlopeMPerKm);
    const V = Math.max(0, q - qbf) * HOURS * 3600;
    const r = M.simulate(grid, river, profile, {
      demOffsetM: P.demOffsetM, maxSpreadKm: P.maxSpreadKm, bankDev, bankDevWeight: P.bankDemWeight,
      waterBodyDepthM: P.waterBodyDepthM, volumeM3: P.limitByVolume ? V : null
    });
    const s = r.stats;
    console.log([q, h.toFixed(2), (V / 1e6).toFixed(1), Math.round(s.areaRai).toLocaleString(),
      Math.round(r.envelopeStats.areaRai).toLocaleString(), s.meanDepth.toFixed(2),
      (s.areaRai * P.damageBahtPerRai / 1e6).toFixed(1)].join('\t'));
  }
})().catch(e => { console.error(e); process.exit(1); });
