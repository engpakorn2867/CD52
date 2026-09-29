// โหลดแบบจำลองระดับความสูงเชิงเลข (DEM) จาก AWS Terrain Tiles (รูปแบบ Terrarium)
// ความสูง (ม.) = (R * 256 + G + B / 256) - 32768 — อ้างอิงระดับน้ำทะเลปานกลาง (ใกล้เคียง ม.รทก.)
(function (root) {
  var URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  var TIMEOUT_MS = 20000, RETRIES = 3, CONCURRENCY = 8;

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), done = false;
      var timer = setTimeout(function () { if (!done) { done = true; img.src = ''; reject(new Error('หมดเวลา')); } }, TIMEOUT_MS);
      img.crossOrigin = 'anonymous';
      img.onload = function () { if (!done) { done = true; clearTimeout(timer); resolve(img); } };
      img.onerror = function () { if (!done) { done = true; clearTimeout(timer); reject(new Error('โหลดไม่ได้')); } };
      img.src = src;
    });
  }

  function loadWithRetry(src, attempt) {
    attempt = attempt || 0;
    var url = attempt ? src + (src.indexOf('?') < 0 ? '?' : '&') + 'r=' + attempt : src;
    return loadImage(url).catch(function (e) {
      if (attempt + 1 >= RETRIES) throw e;
      return new Promise(function (r) { setTimeout(r, 500 * (attempt + 1)); }).then(function () { return loadWithRetry(src, attempt + 1); });
    });
  }

  // bbox: {south, west, north, east}; onProgress(done, total, failed)
  // แผ่นที่โหลดไม่ได้จะเป็น NaN (ไม่มีข้อมูล → ไม่ถูกนับว่าท่วม) และรายงานใน grid.missingTiles
  function loadGrid(bbox, z, onProgress) {
    var M = root.FloodModel;
    var x0 = Math.floor(M.lonToX(bbox.west, z)), x1 = Math.ceil(M.lonToX(bbox.east, z));
    var y0 = Math.floor(M.latToY(bbox.north, z)), y1 = Math.ceil(M.latToY(bbox.south, z));
    var tx0 = Math.floor(x0 / 256), tx1 = Math.floor((x1 - 1) / 256);
    var ty0 = Math.floor(y0 / 256), ty1 = Math.floor((y1 - 1) / 256);
    var w = x1 - x0, h = y1 - y0;
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var tiles = [];
    for (var ty = ty0; ty <= ty1; ty++) for (var tx = tx0; tx <= tx1; tx++) tiles.push([tx, ty]);
    var total = tiles.length, done = 0, failed = [], next = 0;

    function worker() {
      if (next >= tiles.length) return Promise.resolve();
      var t = tiles[next++];
      var src = URL.replace('{z}', z).replace('{x}', t[0]).replace('{y}', t[1]);
      return loadWithRetry(src).then(function (img) {
        ctx.drawImage(img, t[0] * 256 - x0, t[1] * 256 - y0);
      }, function () {
        failed.push(t);
      }).then(function () {
        done++;
        if (onProgress) onProgress(done, total, failed.length);
        return worker();
      });
    }
    var workers = [];
    for (var i = 0; i < CONCURRENCY; i++) workers.push(worker());

    return Promise.all(workers).then(function () {
      if (failed.length === total) throw new Error('โหลด DEM ไม่ได้เลย (ตรวจสอบการเชื่อมต่อ s3.amazonaws.com)');
      var px = ctx.getImageData(0, 0, w, h).data;
      var elev = new Float32Array(w * h);
      for (var k = 0, j = 0; k < elev.length; k++, j += 4) {
        elev[k] = px[j + 3] === 0 ? NaN : (px[j] * 256 + px[j + 1] + px[j + 2] / 256) - 32768;
      }
      return { z: z, x0: x0, y0: y0, w: w, h: h, elev: elev, missingTiles: failed.length, totalTiles: total };
    });
  }

  root.DEM = { loadGrid: loadGrid, url: URL };
})(this);
