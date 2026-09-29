#!/usr/bin/env node
// เซิร์ฟเวอร์ไฟล์ static + ตัวกลาง (proxy) ดึงข้อมูล ThaiWater ไม่ต้องติดตั้งแพ็กเกจเพิ่ม (Node 18+)
// ใช้งาน: node server.js  แล้วเปิด http://localhost:8080
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const ROOT = __dirname;
const TW_BASE = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/';
const ROUTES = { '/api/thaiwater/waterlevel': 'waterlevel_load' };
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8'
};

async function proxy(res, upstreamPath) {
  const hit = cache.get(upstreamPath);
  if (hit && Date.now() - hit.t < CACHE_MS) return send(res, 200, hit.body, 'application/json; charset=utf-8');
  try {
    const r = await fetch(TW_BASE + upstreamPath, { headers: { Accept: 'application/json', 'User-Agent': 'maeklong-flood-map/1.0' } });
    const body = await r.text();
    if (!r.ok) return send(res, 502, JSON.stringify({ error: 'upstream HTTP ' + r.status }), 'application/json');
    cache.set(upstreamPath, { t: Date.now(), body });
    send(res, 200, body, 'application/json; charset=utf-8');
  } catch (e) {
    send(res, 502, JSON.stringify({ error: e.message }), 'application/json');
  }
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(body);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (ROUTES[url.pathname]) return proxy(res, ROUTES[url.pathname]);
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`แผนที่คาดการณ์น้ำล้นตลิ่ง: http://localhost:${PORT}`));
