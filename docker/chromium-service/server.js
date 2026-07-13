// Minimal ephemeral headless-Chromium screenshot service.
//
// Exists because the Homebridge container (Ubuntu, armhf) can't get a working
// Chromium: Ubuntu's chromium-browser/firefox packages are snap-transitional
// stubs, and snapd doesn't run in plain containers. Alpine ships a real,
// working, non-snap `chromium` package for this same 32-bit ARM architecture
// (it's also what ffmpeg-for-homebridge itself targets), so this runs as a
// small separate container instead of inside the Homebridge image.
//
// One HTTP endpoint, no framework, no dependencies beyond Node's stdlib.
// Each request spawns a fresh chromium process and exits -- same ephemeral,
// no-persistent-browser design as localRenderer.ts's local-binary path,
// just reached over localhost instead of a local child_process.spawn.
'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || 'chromium-browser';
const RENDER_SETTLE_MS = Number(process.env.RENDER_SETTLE_MS || 4000);
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8MB -- generous for rendered HTML, bounds memory use

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method !== 'POST' || req.url !== '/screenshot') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  const chunks = [];
  let bodyBytes = 0;
  req.on('data', (chunk) => {
    bodyBytes += chunk.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('request too large');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    if (bodyBytes > MAX_BODY_BYTES) {
      return;
    }
    try {
      const { html, width, height } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof html !== 'string' || !Number.isFinite(width) || !Number.isFinite(height)) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('expected JSON body: { html: string, width: number, height: number }');
        return;
      }

      const png = await screenshotHtml(html, width, height);
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
    } catch (error) {
      console.error('screenshot failed:', error);
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`screenshot failed: ${error.message}`);
    }
  });
});

async function screenshotHtml(html, width, height) {
  const dir = await mkdtemp(path.join(tmpdir(), 'render-'));
  try {
    const htmlPath = path.join(dir, 'page.html');
    const pngPath = path.join(dir, 'shot.png');
    await writeFile(htmlPath, html, 'utf8');
    await runChromiumScreenshot(htmlPath, pngPath, width, height);
    return await readFile(pngPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runChromiumScreenshot(htmlPath, pngPath, width, height) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CHROMIUM_PATH, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--virtual-time-budget=${RENDER_SETTLE_MS}`,
      `--screenshot=${pngPath}`,
      `--window-size=${width},${height}`,
      `file://${htmlPath}`,
    ]);

    const stderr = [];
    proc.stderr.on('data', (chunk) => stderr.push(chunk));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`chromium exited with code ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
      }
    });
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`chromium-service listening on 127.0.0.1:${PORT} (chromium: ${CHROMIUM_PATH})`);
});
