#!/usr/bin/env node
// คำนวณตารางสถานการณ์ตาม Rating Curve ของ K.55A จากบรรทัดคำสั่ง (ใช้แบบจำลองเดียวกับหน้าเว็บ)
// ใช้งาน: npm install && node tools/scenarios.js [ซูม DEM=12] [ชั่วโมงน้ำล้น=48] [--fast = แบบอ่างน้ำเท่านั้น] [--forecast = ตามกราฟคาดการณ์]
'use strict';
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const ROOT = path.join(__dirname, '..');
const CFG = require(path.join(ROOT, 'js/config.js'));
const M = require(path.join(ROOT, 'js/flood.js'));
const R = require(path.join(ROOT, 'js/rating.js'));
const HY = require(path.join(ROOT, 'js/hydro.js'));
const FC = require(path.join(ROOT, 'js/forecast.js'));

const sandbox = {};
new Function('window', fs.readFileSync(path.join(ROOT, 'data/maeklong-river.js'), 'utf8') +
  fs.readFileSync(path.join(ROOT, 'data/landcover.js'), 'utf8'))(sandbox);
const line = sandbox.MAEKLONG_RIVER, LC = sandbox.LANDCOVER;
const FLOW = !process.argv.includes('--fast');
const FORECAST = process.argv.includes('--forecast');

function landuseFor(g) {
  const png = PNG.sync.read(Buffer.from(LC.png.split(',')[1], 'base64'));
  const out = new Uint8Array(g.w * g.h), sc = 2 ** (LC.z - g.z);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const X = Math.floor((g.x0 + x + 0.5) * sc) - LC.x0, Y = Math.floor((g.y0 + y + 0.5) * sc) - LC.y0;
    out[y * g.w + x] = X < 0 || Y < 0 || X >= LC.w || Y >= LC.h ? 4 : Math.round(png.data[(Y * LC.w + X) * 4] / LC.scale);
  }
  return out;
}
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

// คาดการณ์ตามเวลา: จำลองการไหลตามกราฟระดับน้ำของแต่ละสถานการณ์ (ค่าสังเกต + ตารางคาดการณ์ใน js/config.js)
async function runForecast(grid, river, bankDev, anchor, qbf) {
  const P = CFG.params, PS = CFG.primaryStation, landuse = landuseFor(grid);
  const t = ms => new Date(ms).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  for (const key of ['best', 'mid', 'worst']) {
    const f = FC.build(Object.assign({}, CFG.forecast, FC.PRESETS[key], { bank: PS.bank, ratingCurve: PS.ratingCurve }));
    const hp = f.peak.h;
    const profile = M.makeProfile([{ chainage: anchor.chainage, ws: hp, leftBank: PS.bank, rightBank: PS.bank }], P.riverSlopeMPerKm);
    const bath = M.simulate(grid, river, profile, { demOffsetM: P.demOffsetM, maxSpreadKm: P.maxSpreadKm, bankDev,
      bankDevWeight: P.bankDemWeight, waterBodyDepthM: P.waterBodyDepthM });
    const t0 = f.start;
    const hs = HY.setup(grid, bath, landuse, { durationH: (f.end - t0) / 3600000, demOffsetM: P.demOffsetM,
      maxCells: P.flowMaxCells, waterBodyDepthM: P.waterBodyDepthM,
      inflowFn: s => f.qAt(t0 + s * 1000) - qbf, stageFn: s => f.hAt(t0 + s * 1000) - hp });
    HY.run(hs, Infinity);
    const S = HY.summarize(hs, { builtBahtPerM2: P.builtBahtPerM2, cropBahtPerRai: P.cropBahtPerRai,
      treeBahtPerRai: P.treeBahtPerRai, otherBahtPerRai: P.otherBahtPerRai, compensationBahtPerRai: P.damageBahtPerRai });
    console.log(`\n[${FC.PRESETS[key].label}] ยอด ${hp.toFixed(2)} ม. (Q≈${Math.round(f.peak.q)}) ${t(f.peak.t)} · เริ่มล้น ${t(f.start)} · ลดต่ำกว่าตลิ่ง ${f.recede ? t(f.recede) : 'หลัง ' + t(f.end)}`);
    console.log(`  ท่วมสูงสุด ${Math.round(S.areaRai).toLocaleString()} ไร่ · อันตราย ต่ำ/ปานกลาง/สูง/รุนแรงมาก ${S.hazardRai.map(v => Math.round(v).toLocaleString()).join('/')} ไร่` +
      ` · ความเร็ว P99 ${S.v99.toFixed(2)} ม./วิ · เสียหาย ${(S.lossBaht / 1e6).toFixed(0)} ล้านบาท · น้ำเข้า/กลับ ${(S.volInM3 / 1e6).toFixed(0)}/${(S.volOutM3 / 1e6).toFixed(0)} ล้าน ลบ.ม.`);
    const row = [];
    for (let i = 0; i < hs.snapshots.length; i += 12) {
      const d = HY.fineDepth(hs, hs.snapshots[i].h);
      let a = 0;
      for (let y = 0; y < grid.h; y++) {
        const mpp = M.metersPerPixel(M.yToLat(grid.y0 + y + 0.5, grid.z), grid.z);
        for (let x = 0; x < grid.w; x++) if (d[y * grid.w + x] > 0.02) a += mpp * mpp;
      }
      row.push(t(t0 + hs.snapshots[i].t * 1000) + ' ' + Math.round(a / 1600).toLocaleString());
    }
    console.log('  พื้นที่น้ำท่วม (ไร่) ทุก 12 ชม.: ' + row.join(' | '));
  }
}

(async () => {
  const P = CFG.params, PS = CFG.primaryStation;
  const grid = await loadGrid(CFG.bbox, Z);
  const river = M.rasterizeRiver(grid, line, P.channelHalfWidthM);
  const bankDev = M.bankDeviation(grid, river);
  const anchor = M.projectToLine(line, PS.lat, PS.lon);
  const qbf = R.dischargeFromLevel(PS.ratingCurve, Math.min(PS.leftBank, PS.rightBank));
  if (FORECAST) return runForecast(grid, river, bankDev, anchor, qbf);
  console.log(`DEM ซูม ${Z} (${grid.w}×${grid.h}), น้ำล้นตลิ่ง ${HOURS} ชม., Q ตลิ่งเต็ม ≈ ${qbf.toFixed(0)} ลบ.ม./วินาที`);
  const landuse = FLOW ? landuseFor(grid) : null;
  const P2 = CFG.params;
  console.log(FLOW
    ? 'Q\tระดับ\tท่วม (ไร่)\tอันตราย ต่ำ/ปานกลาง/สูง/รุนแรงมาก (ไร่)\tความเร็ว P99/สูงสุด (ม./วิ)\tไหลแรง≥1 (ไร่)\tเสียหาย (ล้านบาท)\tบ้านเรือน/เกษตร/สวน (ล้านบาท)\tน้ำเข้า/ค้างในแม่น้ำ (ล้าน ลบ.ม.)'
    : 'Q (ลบ.ม./วิ)\tระดับ (ม.รทก.)\tปริมาตร (ล้าน ลบ.ม.)\tคาดการณ์ (ไร่)\tเสี่ยงสูงสุด (ไร่)\tลึกเฉลี่ย (ม.)\tความเสียหาย (ล้านบาท)');
  const qs = [2900, 2950, ...PS.ratingCurve.map(p => p[0]).filter(q => q > 2900)];
  for (const q of qs) {
    const h = R.levelFromDischarge(PS.ratingCurve, q);
    const profile = M.makeProfile([{ chainage: anchor.chainage, ws: h, leftBank: PS.leftBank, rightBank: PS.rightBank }], P.riverSlopeMPerKm);
    const V = Math.max(0, q - qbf) * HOURS * 3600;
    const r = M.simulate(grid, river, profile, {
      demOffsetM: P.demOffsetM, maxSpreadKm: P.maxSpreadKm, bankDev, bankDevWeight: P.bankDemWeight,
      waterBodyDepthM: P.waterBodyDepthM, volumeM3: P.limitByVolume && !FLOW ? V : null
    });
    if (FLOW) {
      if (q <= qbf) { console.log([q, h.toFixed(2), 0].join('\t')); continue; }
      const hs = HY.setup(grid, r, landuse, { inflowQ: q - qbf, durationH: HOURS, demOffsetM: P.demOffsetM,
        maxCells: P.flowMaxCells, waterBodyDepthM: P.waterBodyDepthM });
      HY.run(hs, Infinity);
      const S = HY.summarize(hs, { builtBahtPerM2: P2.builtBahtPerM2, cropBahtPerRai: P2.cropBahtPerRai,
        treeBahtPerRai: P2.treeBahtPerRai, otherBahtPerRai: P2.otherBahtPerRai, compensationBahtPerRai: P2.damageBahtPerRai });
      const fmtR = v => Math.round(v).toLocaleString();
      console.log([q, h.toFixed(2), fmtR(S.areaRai), S.hazardRai.map(fmtR).join('/'), S.v99.toFixed(2) + '/' + S.vmax.toFixed(1),
        fmtR(S.fastRai), (S.lossBaht / 1e6).toFixed(0),
        ['built', 'crop', 'tree'].map(k => (S.groups[k].loss / 1e6).toFixed(1)).join('/'),
        (S.volInM3 / 1e6).toFixed(1) + '/' + (S.volLostM3 / 1e6).toFixed(1)].join('\t'));
      continue;
    }
    const s = r.stats;
    console.log([q, h.toFixed(2), (V / 1e6).toFixed(1), Math.round(s.areaRai).toLocaleString(),
      Math.round(r.envelopeStats.areaRai).toLocaleString(), s.meanDepth.toFixed(2),
      (s.areaRai * P.damageBahtPerRai / 1e6).toFixed(1)].join('\t'));
  }
})().catch(e => { console.error(e); process.exit(1); });
