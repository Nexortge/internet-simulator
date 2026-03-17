// Image degradation pipeline — runs entirely in the browser via Canvas API.
// Takes an array of pass configs and applies them sequentially.
//
// passConfig shape: { compression, noise, crop, rotation, colorDrift, scale }
//   compression: 1–100  (100 = original quality, 1 = worst JPEG)
//   noise:       0–100  (pixel noise intensity)
//   crop:        0–5    (% of image dimension to randomly crop per edge, max)
//   rotation:    0–10   (max degrees to randomly rotate)
//   colorDrift:  0–100  (color saturation loss + hue drift)
//   scale:       0–50   (% to scale down then back up; 0 = skip)

async function degradeImage(file, passConfigs) {
  const url = URL.createObjectURL(file);
  const img = await loadImage(url);
  URL.revokeObjectURL(url);

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  for (const cfg of passConfigs) {
    await applyPass(canvas, ctx, cfg);
  }

  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92); // final export at decent quality
  return { blob, originalSize: file.size, degradedSize: blob.size };
}

async function applyPass(canvas, ctx, cfg) {
  const w = canvas.width;
  const h = canvas.height;

  // 0. Pixelation — scale down then back up WITHOUT smoothing (nearest-neighbor).
  //    This creates visible blocky pixels. Doing it BEFORE the JPEG step means
  //    the codec then compresses the blocks, which is exactly what cheap platforms do.
  if (cfg.pixelate > 0) {
    const factor = 1 + (cfg.pixelate / 10) * 2.5; // 1.25× at pixelate=1, 3.5× at pixelate=10
    const pw = Math.max(4, Math.round(w / factor));
    const ph = Math.max(4, Math.round(h / factor));

    const tmp = offscreenCanvas(pw, ph);
    tmp.ctx.drawImage(canvas, 0, 0, pw, ph); // smooth scale-down preserves detail

    ctx.imageSmoothingEnabled = false; // nearest-neighbor on scale-up = blocky pixels
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(tmp.canvas, 0, 0, w, h);
    ctx.imageSmoothingEnabled = true;  // reset so later draws aren't affected
  }

  // 1. Scale down then back up (smooth interpolation blur)
  if (cfg.scale > 0) {
    const factor = 1 - cfg.scale / 100;
    const sw = Math.max(4, Math.round(w * factor));
    const sh = Math.max(4, Math.round(h * factor));

    const tmp = offscreenCanvas(sw, sh);
    tmp.ctx.drawImage(canvas, 0, 0, sw, sh);

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(tmp.canvas, 0, 0, w, h);
  }

  // 2. Random micro-crop (keeps content, just drifts framing slightly)
  //    crop is 0–5% of the shorter dimension, applied randomly per edge.
  //    We always resize back to the original dimensions so content stays intact.
  if (cfg.crop > 0) {
    const maxPx = Math.round(Math.min(w, h) * (cfg.crop / 100));
    if (maxPx >= 1) {
      const left   = Math.floor(Math.random() * maxPx);
      const top    = Math.floor(Math.random() * maxPx);
      const right  = Math.floor(Math.random() * maxPx);
      const bottom = Math.floor(Math.random() * maxPx);

      const srcW = w - left - right;
      const srcH = h - top - bottom;

      if (srcW > 0 && srcH > 0) {
        const tmp = offscreenCanvas(w, h);
        tmp.ctx.drawImage(canvas, left, top, srcW, srcH, 0, 0, w, h);
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(tmp.canvas, 0, 0);
      }
    }
  }

  // 3. Random slight rotation (always resizes back; content may be slightly clipped at edges)
  if (cfg.rotation > 0 && Math.random() > 0.4) {
    const angle = (Math.random() - 0.5) * 2 * (cfg.rotation * Math.PI / 180);
    const tmp = offscreenCanvas(w, h);
    tmp.ctx.translate(w / 2, h / 2);
    tmp.ctx.rotate(angle);
    tmp.ctx.drawImage(canvas, -w / 2, -h / 2);

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(tmp.canvas, 0, 0);
  }

  // 4. JPEG re-encode (the core degradation — lossy compression artifacts)
  const jpegQuality = Math.max(0.01, (cfg.compression / 100) * 0.95);
  const dataUrl = canvas.toDataURL('image/jpeg', jpegQuality);
  const reloaded = await loadImage(dataUrl);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(reloaded, 0, 0, w, h);

  // 5. Pixel-level noise
  if (cfg.noise > 0) {
    applyNoise(ctx, w, h, cfg.noise);
  }

  // 6. Color drift (simulate chroma subsampling and repeated color-space conversion loss)
  if (cfg.colorDrift > 0) {
    applyColorDrift(ctx, w, h, cfg.colorDrift);
  }
}

function applyNoise(ctx, w, h, noiseLevel) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const strength = (noiseLevel / 100) * 60; // max ~60 per channel

  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * strength;
    data[i]     = clamp(data[i]     + n);
    data[i + 1] = clamp(data[i + 1] + n);
    data[i + 2] = clamp(data[i + 2] + n);
  }

  ctx.putImageData(imageData, 0, 0);
}

function applyColorDrift(ctx, w, h, driftLevel) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const t = driftLevel / 100;

  // Simulate: very mild chroma loss + tiny per-channel warm/cool drift.
  // Keep values small — real platform compression causes subtle shifts, not hue inversions.
  // satMix stays close to 1 so compounding over many passes stays natural.
  const satMix = 1 - t * 0.08;               // max 8% desaturation per pass
  const rBias  = (Math.random() - 0.5) * t * 3;   // max ±1.5 per pass
  const gBias  = (Math.random() - 0.5) * t * 2;
  const bBias  = (Math.random() - 0.5) * t * 3;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    data[i]     = clamp(lum + (r - lum) * satMix + rBias);
    data[i + 1] = clamp(lum + (g - lum) * satMix + gBias);
    data[i + 2] = clamp(lum + (b - lum) * satMix + bBias);
  }

  ctx.putImageData(imageData, 0, 0);
}

function offscreenCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d') };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

function clamp(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}
