// ── State ─────────────────────────────────────────────────
let currentFile = null;
let degradedBlob = null;
let ffmpegAvailable = false;

// ── Magic Slop presets ────────────────────────────────────
const MAGIC_VIBES = {
  1:  'Just Browsed It',
  2:  'Reddit Repost',
  3:  'Discord Upload',
  4:  'Facebook Share',
  5:  'Peak Internet',
  6:  'Reposted 20 Times',
  7:  'WhatsApp Forward',
  8:  'Screenshot of Screenshot',
  9:  'TikTok Watermark Chain',
  10: '☠ MAXIMUM SLOP ☠'
};

// Returns array of per-pass config objects for a magic slop level (1–10)
function magicConfigs(level) {
  const t = (level - 1) / 9; // 0 → 1
  const passes = Math.round(1 + t * 7); // 1 → 8

  // Noise: only on the first 20% of passes, and only when passes > 3
  const noisePassCount = passes > 3 ? Math.max(1, Math.ceil(passes * 0.2)) : 0;
  const noiseStrength  = Math.round(t * 60);

  const base = {
    compression: Math.round(85 - t * 78),  // 85 → 7
    noise:       0,                         // set per-pass below
    crop:        parseFloat((t * 3).toFixed(2)),  // 0 → 3% (small, content stays)
    rotation:    0,                         // not used — real platform compression doesn't rotate
    colorDrift:  Math.round(t * 30),        // 0 → 30  (subtle; real compression ≠ hue inversion)
    scale:       Math.round(t * 45),        // 0 → 45% scale-down
    fps: level <= 3 ? 0 : level <= 5 ? 24 : level <= 7 ? 20 : level <= 9 ? 15 : 10,
    // Pixelation kicks in from level 5 onwards — subtle at first, more visible at max slop.
    // Formula keeps it at 0 below level 5, then ramps from 1 to ~8.
    pixelate: Math.max(0, Math.round((t - 0.4) * 13.3)),
    // Bad crop probability (0–100): stays 0 below slop 3, reaches ~60 at slop 10.
    // Applied per-pass, so at high levels it almost certainly hits at least once.
    badCrop: Math.max(0, Math.round((t - 0.3) * 85)),
  };

  return Array.from({ length: passes }, (_, i) => ({
    ...base,
    noise: i < noisePassCount ? noiseStrength : 0,
  }));
}

// ── DOM refs ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const uploadZone    = $('upload-zone');
const fileInput     = $('file-input');
const controlsPanel = $('controls-panel');
const progressPanel = $('progress-panel');
const progressText  = $('progress-text');
const progressFill  = document.querySelector('.progress-fill');
const resultsPanel  = $('results-panel');

const btnMagic      = $('btn-magic');
const btnCustom     = $('btn-custom');
const modeMagic     = $('mode-magic');
const modeCustom    = $('mode-custom');

const slopSlider    = $('slop-slider');
const magicLevelDsp = $('magic-level-display');
const magicVibe     = $('magic-vibe');

const passesInput   = $('passes-input');
const passesRange   = $('passes-range');
const passList      = $('pass-list');
const btnApplyAll   = $('btn-apply-all');
const btnResetCustom= $('btn-reset-custom');

const slopifyBtn    = $('slopify-btn');
const sizeCapCheck  = $('size-cap-check');

const imgCompare    = $('img-compare');
const compareOrig   = $('compare-original');
const compareDeg    = $('compare-degraded');
const imgOrigSize   = $('img-original-size');
const imgDegSize    = $('img-degraded-size');

const avCompare     = $('av-compare');
const avOriginal    = $('av-original');
const avDegraded    = $('av-degraded');
const avOrigSize    = $('av-original-size');
const avDegSize     = $('av-degraded-size');

const sizeInfo      = $('size-info');
const downloadBtn   = $('download-btn');
const resetBtn      = $('reset-btn');

const videoFxPanel      = $('video-fx');
const encodingLagCheck  = $('encoding-lag-check');
const lagFreqSlider     = $('lag-freq-slider');
const lagFreqVal        = $('lag-freq-val');
const lagFreqRow        = $('lag-freq-row');
const fpsDropsCheck     = $('fps-drops-check');
const datamorphCheck    = $('datamorph-check');
const datamorphRow      = $('datamorph-row');
const freezeFreqSlider  = $('freeze-freq-slider');
const freezeFreqVal     = $('freeze-freq-val');
const freezeFreqRow     = $('freeze-freq-row');
const freezeStyleSlider = $('freeze-style-slider');
const freezeStyleRow    = $('freeze-style-row');

// ── Init ──────────────────────────────────────────────────
(async () => {
  try {
    const r = await fetch('/api/ffmpeg-check');
    const d = await r.json();
    ffmpegAvailable = d.available;
  } catch { ffmpegAvailable = false; }
})();

// ── Upload zone ──────────────────────────────────────────
// ── FX checkbox wiring ────────────────────────────────────
// When Encoding Lag is toggled, enable/disable its frequency slider.
encodingLagCheck.addEventListener('change', () => {
  lagFreqRow.classList.toggle('enabled', encodingLagCheck.checked);
});

// Live-update the lag frequency value display.
lagFreqSlider.addEventListener('input', () => {
  lagFreqVal.textContent = Math.max(1, parseInt(lagFreqSlider.value));
});

// When FPS Drops is toggled, enable/disable all dependent controls.
// The sliders and Datamorphing have no effect without a freeze to trigger them.
fpsDropsCheck.addEventListener('change', () => {
  const on = fpsDropsCheck.checked;
  datamorphCheck.disabled = !on;
  datamorphRow.classList.toggle('enabled', on);
  freezeFreqRow.classList.toggle('enabled', on);
  freezeStyleRow.classList.toggle('enabled', on);
  if (!on) datamorphCheck.checked = false;
});

// Live-update the frequency value display as the slider moves.
freezeFreqSlider.addEventListener('input', () => {
  freezeFreqVal.textContent = Math.max(1, parseInt(freezeFreqSlider.value));
});

// ── Upload zone ───────────────────────────────────────────
uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});
fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

function handleFile(file) {
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/') && !file.type.startsWith('audio/')) {
    alert('Unsupported file type. Please use an image, video, or audio file.');
    return;
  }
  if (!ffmpegAvailable && (file.type.startsWith('video/') || file.type.startsWith('audio/'))) {
    alert('FFmpeg is not available on this server.\nVideo and audio processing requires FFmpeg to be installed and in PATH.\n\nImages work without FFmpeg.');
    if (!file.type.startsWith('image/')) return;
  }

  currentFile = file;
  degradedBlob = null;

  uploadZone.classList.add('hidden');
  controlsPanel.classList.remove('hidden');
  resultsPanel.classList.add('hidden');
  progressPanel.classList.add('hidden');
  slopifyBtn.disabled = false;

  syncMagicSlider();
  renderPassList(parseInt(passesInput.value));

  // Show the video FX panel only for video files — freeze/datamorph make no sense for images/audio.
  // Also reset checkboxes so state doesn't bleed from a previous file.
  const isVideo = file.type.startsWith('video/');
  videoFxPanel.classList.toggle('hidden', !isVideo);
  encodingLagCheck.checked = false;
  lagFreqSlider.value      = 3;
  lagFreqVal.textContent   = '3';
  lagFreqRow.classList.remove('enabled');
  fpsDropsCheck.checked   = false;
  datamorphCheck.checked  = false;
  datamorphCheck.disabled = true;
  datamorphRow.classList.remove('enabled');
  freezeFreqSlider.value  = 5;
  freezeFreqVal.textContent = '5';
  freezeFreqRow.classList.remove('enabled');
  freezeStyleSlider.value = 50;
  freezeStyleRow.classList.remove('enabled');
}

// ── Mode toggle ──────────────────────────────────────────
let currentMode = 'magic';

btnMagic.addEventListener('click', () => setMode('magic'));
btnCustom.addEventListener('click', () => setMode('custom'));

function setMode(mode) {
  currentMode = mode;
  btnMagic.classList.toggle('active', mode === 'magic');
  btnCustom.classList.toggle('active', mode === 'custom');
  modeMagic.classList.toggle('hidden', mode !== 'magic');
  modeCustom.classList.toggle('hidden', mode !== 'custom');
}

// ── Magic slider ─────────────────────────────────────────
slopSlider.addEventListener('input', syncMagicSlider);
function syncMagicSlider() {
  const v = Math.max(1, parseInt(slopSlider.value));
  magicLevelDsp.textContent = v;
  magicVibe.textContent = MAGIC_VIBES[v];
  // Tint the level number by intensity
  const hue = Math.round(145 - (v - 1) * 14); // green → red
  magicLevelDsp.style.color = `hsl(${hue}, 90%, 55%)`;
}

// ── Custom mode — pass list ───────────────────────────────
// pixelate: 0 = off. 1–10 controls how aggressively to scale down before the nearest-neighbor scale-up.
const DEFAULT_PASS = { compression: 50, noise: 0, crop: 1, rotation: 0, colorDrift: 8, scale: 20, fps: 0, pixelate: 0, badCrop: 0 };

const PASS_FIELDS = [
  { key: 'compression', min: 1,   max: 100, step: 1,   unit: '%'  },
  { key: 'noise',       min: 0,   max: 100, step: 1,   unit: ''   },
  { key: 'crop',        min: 0,   max: 5,   step: 0.1, unit: '%'  },
  { key: 'rotation',    min: 0,   max: 10,  step: 0.1, unit: '°'  },
  { key: 'colorDrift',  min: 0,   max: 100, step: 1,   unit: ''   },
  { key: 'scale',       min: 0,   max: 50,  step: 1,   unit: '%'  },
  { key: 'fps',         min: 0,   max: 60,  step: 1,   unit: 'fps'},
  // Nearest-neighbor scale-down/up. 0=off, higher=blockier. Applied before JPEG so codec compresses the blocks.
  { key: 'pixelate',    min: 0,   max: 10,  step: 1,   unit: ''   },
  // Probability (0–100%) that a bad-crop bar appears on this pass.
  { key: 'badCrop',     min: 0,   max: 100, step: 5,   unit: '%'  },
];

function renderPassList(count) {
  // Preserve existing values where possible
  const existing = getPassConfigs();
  passList.innerHTML = '';

  for (let i = 0; i < count; i++) {
    const vals = existing[i] || { ...DEFAULT_PASS };
    const row = document.createElement('div');
    row.className = 'pass-row';
    row.dataset.passIndex = i;

    const numCell = document.createElement('div');
    numCell.className = 'pass-num';
    numCell.textContent = i + 1;
    row.appendChild(numCell);

    for (const field of PASS_FIELDS) {
      const cell = document.createElement('div');
      cell.className = 'pass-cell';

      const range = document.createElement('input');
      range.type = 'range';
      range.min = field.min;
      range.max = field.max;
      range.step = field.step;
      range.value = vals[field.key] ?? DEFAULT_PASS[field.key];
      range.dataset.field = field.key;

      const valDisplay = document.createElement('div');
      valDisplay.className = 'pass-val';
      valDisplay.textContent = range.value + field.unit;

      range.addEventListener('input', () => {
        valDisplay.textContent = range.value + field.unit;
      });

      cell.appendChild(range);
      cell.appendChild(valDisplay);
      row.appendChild(cell);
    }

    passList.appendChild(row);
  }
}

function getPassConfigs() {
  return Array.from(passList.querySelectorAll('.pass-row')).map(row => {
    const cfg = {};
    row.querySelectorAll('input[type="range"]').forEach(input => {
      cfg[input.dataset.field] = parseFloat(input.value);
    });
    return cfg;
  });
}

passesInput.addEventListener('input', () => {
  const v = Math.max(1, Math.min(20, parseInt(passesInput.value) || 1));
  passesRange.value = v;
  renderPassList(v);
});
passesRange.addEventListener('input', () => {
  passesInput.value = passesRange.value;
  renderPassList(parseInt(passesRange.value));
});

btnApplyAll.addEventListener('click', () => {
  const rows = passList.querySelectorAll('.pass-row');
  if (rows.length < 2) return;
  const firstRow = rows[0];
  const firstVals = {};
  firstRow.querySelectorAll('input[type="range"]').forEach(i => { firstVals[i.dataset.field] = i.value; });

  for (let r = 1; r < rows.length; r++) {
    rows[r].querySelectorAll('input[type="range"]').forEach(input => {
      input.value = firstVals[input.dataset.field];
      input.nextElementSibling.textContent = input.value + PASS_FIELDS.find(f => f.key === input.dataset.field).unit;
    });
  }
});

btnResetCustom.addEventListener('click', () => {
  renderPassList(parseInt(passesInput.value));
});

// ── Slopify ───────────────────────────────────────────────
slopifyBtn.addEventListener('click', async () => {
  if (!currentFile) return;

  const configs = currentMode === 'magic'
    ? magicConfigs(Math.max(1, parseInt(slopSlider.value)))
    : getPassConfigs();

  if (configs.length === 0) { alert('Add at least one pass.'); return; }

  slopifyBtn.disabled = true;
  progressPanel.classList.remove('hidden');
  resultsPanel.classList.add('hidden');
  progressFill.style.width = '3%';
  progressText.textContent = 'Starting…';

  try {
    let result;
    if (currentFile.type.startsWith('image/')) {
      result = await degradeImage(currentFile, configs);
    } else {
      result = await degradeServerSide(currentFile, configs);
    }

    degradedBlob = result.blob;
    showResults(result);
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    progressPanel.classList.add('hidden');
    slopifyBtn.disabled = false;
  }
});

async function degradeServerSide(file, passConfigs) {
  const slopLevel = currentMode === 'magic' ? Math.max(1, parseInt(slopSlider.value)) : 5;

  // Generate a unique job ID so the server can push progress events to this tab only.
  const jobId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36);

  // Open the SSE channel BEFORE sending the POST so we don't miss early events.
  // On each event the server sends { step, total, message } and we update the bar.
  const sse = new EventSource(`/api/progress/${jobId}`);
  sse.onmessage = (e) => {
    try {
      const { step, total, message } = JSON.parse(e.data);
      const pct = total > 0 ? Math.round((step / total) * 100) : 0;
      progressFill.style.width = `${pct}%`;
      progressText.textContent  = message;
    } catch {}
  };

  const form = new FormData();
  form.append('file', file);
  form.append('passConfigs', JSON.stringify(passConfigs));
  form.append('jobId', jobId);
  if (sizeCapCheck.checked) form.append('sizeCap', 'true');

  if (encodingLagCheck.checked) {
    form.append('lagConfig', JSON.stringify({
      enabled:      true,
      slopLevel,
      lagFrequency: Math.max(1, parseInt(lagFreqSlider.value)),
    }));
  }

  if (fpsDropsCheck.checked) {
    form.append('freezeConfig', JSON.stringify({
      enabled:          true,
      datamorphEnabled: datamorphCheck.checked,
      slopLevel,
      freezeFrequency:  Math.max(1, parseInt(freezeFreqSlider.value)),
      loopTypeBias:     parseInt(freezeStyleSlider.value),
    }));
  }

  try {
    const res = await fetch('/api/degrade', { method: 'POST', body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Server error' }));
      throw new Error(err.error || 'Server error');
    }

    const origSize = parseInt(res.headers.get('X-Original-Size')) || file.size;
    const degSize  = parseInt(res.headers.get('X-Degraded-Size')) || 0;
    const blob     = await res.blob();

    progressFill.style.width = '100%';
    return { blob, originalSize: origSize, degradedSize: degSize || blob.size };
  } finally {
    sse.close();
  }
}

// ── Show results ──────────────────────────────────────────
function showResults({ blob, originalSize, degradedSize }) {
  resultsPanel.classList.remove('hidden');

  const origUrl = URL.createObjectURL(currentFile);
  const degUrl  = URL.createObjectURL(blob);

  if (currentFile.type.startsWith('image/')) {
    // Simple side-by-side: original on the left, slopped on the right
    avCompare.classList.add('hidden');
    imgCompare.classList.remove('hidden');

    compareOrig.src = origUrl;
    compareDeg.src  = degUrl;
    imgOrigSize.textContent = 'Size: ' + fmtBytes(originalSize);
    imgDegSize.textContent  = 'Size: ' + fmtBytes(degradedSize);
  } else {
    imgCompare.classList.add('hidden');
    avCompare.classList.remove('hidden');

    avOriginal.innerHTML = '';
    avDegraded.innerHTML = '';

    if (currentFile.type.startsWith('video/')) {
      avOriginal.appendChild(makeVideo(origUrl));
      avDegraded.appendChild(makeVideo(degUrl));
    } else {
      avOriginal.appendChild(makeAudio(origUrl));
      avDegraded.appendChild(makeAudio(degUrl));
    }

    avOrigSize.textContent = 'Size: ' + fmtBytes(originalSize);
    avDegSize.textContent  = 'Size: ' + fmtBytes(degradedSize);
  }

  const diff = originalSize - degradedSize;
  const pct  = Math.abs((diff / originalSize) * 100).toFixed(1);
  if (diff > 0) {
    sizeInfo.innerHTML = `${fmtBytes(originalSize)} → <span class="good">${fmtBytes(degradedSize)}</span> &nbsp;(−${pct}% saved)`;
  } else {
    sizeInfo.innerHTML = `${fmtBytes(originalSize)} → <span class="hi">${fmtBytes(degradedSize)}</span> &nbsp;(+${pct}% re-encode overhead)`;
  }

  downloadBtn.onclick = () => downloadBlob(blob, currentFile);
}

// ── Reset ─────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  currentFile = null;
  degradedBlob = null;
  fileInput.value = '';
  resultsPanel.classList.add('hidden');
  controlsPanel.classList.add('hidden');
  uploadZone.classList.remove('hidden');
});

// ── Helpers ───────────────────────────────────────────────
function makeVideo(src) {
  const v = document.createElement('video');
  v.src = src; v.controls = true; v.muted = true;
  return v;
}
function makeAudio(src) {
  const a = document.createElement('audio');
  a.src = src; a.controls = true;
  return a;
}

function downloadBlob(blob, originalFile) {
  const ext   = blob.type === 'video/mp4' ? '.mp4'
              : blob.type === 'audio/mpeg' ? '.mp3'
              : '.jpg';
  const base  = originalFile.name.replace(/\.[^.]+$/, '');
  const url   = URL.createObjectURL(blob);
  const a     = Object.assign(document.createElement('a'), { href: url, download: `slopped_${base}${ext}` });
  a.click();
  URL.revokeObjectURL(url);
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}
