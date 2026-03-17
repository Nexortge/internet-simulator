'use strict';
// Tests use Node's built-in test runner (Node 18+): node test.js
// Or via: npm test

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');

const PORT = 3099; // separate port so tests never clash with a running dev server
const BASE = `http://localhost:${PORT}`;
let server;

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(PORT) },
    });

    const timeout = setTimeout(
      () => reject(new Error('Server did not start within 8 s')),
      8000
    );

    server.stdout.on('data', chunk => {
      if (chunk.toString().includes('localhost')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('error', err => { clearTimeout(timeout); reject(err); });
  });
}

// ── Helpers ───────────────────────────────────────────────
function fakeBlob(mimeType) {
  // Tiny non-empty buffer — enough to pass multer's size check
  return new Blob([new Uint8Array(256).fill(0xff)], { type: mimeType });
}

function validPassConfigs() {
  return JSON.stringify([{ compression: 50, noise: 0, crop: 0, rotation: 0, colorDrift: 0, scale: 0 }]);
}

// ── Suite ─────────────────────────────────────────────────
describe('Internet Slop Simulator', async () => {
  before(startServer);
  after(() => server?.kill());

  // --- Launch ---

  test('server starts and serves index.html', async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('INTERNET SLOP SIMULATOR'), 'page should contain app title');
  });

  test('all static assets are reachable', async () => {
    const assets = ['index.html', 'style.css', 'app.js', 'image-degrader.js'];
    for (const file of assets) {
      const res = await fetch(`${BASE}/${file}`);
      assert.equal(res.status, 200, `${file} should be served with 200`);
    }
  });

  test('unknown routes return 404', async () => {
    const res = await fetch(`${BASE}/does-not-exist`);
    assert.equal(res.status, 404);
  });

  // --- FFmpeg check ---

  test('/api/ffmpeg-check returns valid JSON with an "available" boolean', async () => {
    const res = await fetch(`${BASE}/api/ffmpeg-check`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok('available' in json, 'response must have an "available" key');
    assert.equal(typeof json.available, 'boolean');
  });

  // --- Degrade endpoint validation ---

  test('/api/degrade — no file returns 400', async () => {
    const form = new FormData();
    form.append('passConfigs', validPassConfigs());
    const res = await fetch(`${BASE}/api/degrade`, { method: 'POST', body: form });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.ok(json.error, 'error field should be present');
  });

  test('/api/degrade — missing passConfigs returns 400', async () => {
    const form = new FormData();
    form.append('file', fakeBlob('audio/mpeg'), 'test.mp3');
    // passConfigs intentionally omitted → JSON.parse(undefined) throws
    const res = await fetch(`${BASE}/api/degrade`, { method: 'POST', body: form });
    assert.equal(res.status, 400);
  });

  test('/api/degrade — malformed passConfigs JSON returns 400', async () => {
    const form = new FormData();
    form.append('file', fakeBlob('audio/mpeg'), 'test.mp3');
    form.append('passConfigs', '{{NOT_JSON}}');
    const res = await fetch(`${BASE}/api/degrade`, { method: 'POST', body: form });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.ok(json.error);
  });

  test('/api/degrade — image file is rejected (endpoint is video/audio only)', async () => {
    const form = new FormData();
    form.append('file', fakeBlob('image/jpeg'), 'photo.jpg');
    form.append('passConfigs', validPassConfigs());
    const res = await fetch(`${BASE}/api/degrade`, { method: 'POST', body: form });
    // multer fileFilter rejects the type; Express returns 500 without a custom error handler
    assert.notEqual(res.status, 200, 'image uploads should not succeed');
  });
});
