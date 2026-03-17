const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(os.tmpdir(), 'slop-simulator');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const id = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname) || (file.mimetype.startsWith('video') ? '.mp4' : '.mp3');
    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video and audio files are accepted'));
    }
  }
});

app.use(express.static('public'));
app.use(express.urlencoded({ extended: false })); // parse non-multipart body fields (jobId in plain POSTs)

// ── SSE progress sessions ─────────────────────────────────
// Each processing job opens a persistent SSE channel the client listens to.
// The server emits { step, total, message } as each FFmpeg pass completes.
const jobSessions = new Map();

app.get('/api/progress/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  jobSessions.set(req.params.jobId, res);
  req.on('close', () => jobSessions.delete(req.params.jobId));
});

function emitProgress(jobId, step, total, message) {
  const sse = jobSessions.get(jobId);
  if (!sse) return;
  sse.write(`data: ${JSON.stringify({ step, total, message })}\n\n`);
}

app.get('/api/ffmpeg-check', (req, res) => {
  const proc = spawn('ffmpeg', ['-version']);
  proc.on('close', code => res.json({ available: code === 0 }));
  proc.on('error', () => res.json({ available: false }));
});

// passConfigs is JSON array: [{compression,noise,crop,rotation,colorDrift,scale}, ...]
// freezeConfig (optional): { enabled, datamorphEnabled, slopLevel }
// lagConfig    (optional): { enabled, slopLevel }
// jobId        (optional): SSE channel identifier for progress updates
app.post('/api/degrade', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  let passConfigs;
  try {
    passConfigs = JSON.parse(req.body.passConfigs);
  } catch {
    return res.status(400).json({ error: 'Invalid passConfigs JSON' });
  }

  let freezeConfig = null;
  try { freezeConfig = req.body.freezeConfig ? JSON.parse(req.body.freezeConfig) : null; } catch {}

  let lagConfig = null;
  try { lagConfig = req.body.lagConfig ? JSON.parse(req.body.lagConfig) : null; } catch {}

  const jobId  = req.body.jobId || null;
  const isVideo = req.file.mimetype.startsWith('video/');

  // Pre-compute total steps so the client bar fills proportionally.
  // Each compression pass is one step; FX stages each count as one additional step.
  const sizeCap    = req.body.sizeCap === 'true';
  const totalSteps = passConfigs.length
    + (isVideo && lagConfig?.enabled             ? 1 : 0)
    + (isVideo && freezeConfig?.enabled          ? 1 : 0)
    + (isVideo && freezeConfig?.datamorphEnabled ? 1 : 0)
    + (sizeCap                                   ? 1 : 0);

  let currentStep = 0;
  const progress = (message) => {
    currentStep++;
    emitProgress(jobId, currentStep, totalSteps, message);
  };

  const inputPath  = req.file.path;
  const outputExt  = isVideo ? '.mp4' : '.mp3';
  const outputPath = inputPath.replace(path.extname(inputPath), `_out${outputExt}`);

  try {
    // ── Build a flat sorted pipeline ─────────────────────────────
    // Compression pass i gets slot (i+1).  Each enabled FX gets a random
    // integer slot in [0..n], so it can land before, between, or after passes.
    // Sorting by slot (compress beats FX on ties) gives the final order.
    const n   = passConfigs.length;
    const ops = [];

    passConfigs.forEach((cfg, i) => {
      ops.push({ type: 'compress', slot: i + 1, cfg, label: `Compressing… (pass ${i + 1}/${n})` });
    });

    if (isVideo && lagConfig?.enabled) {
      ops.push({ type: 'lag', slot: Math.floor(Math.random() * (n + 1)) });
    }
    if (isVideo && freezeConfig?.enabled) {
      ops.push({ type: 'freeze', slot: Math.floor(Math.random() * (n + 1)) });
    }

    ops.sort((a, b) => {
      if (a.slot !== b.slot) return a.slot - b.slot;
      // At the same slot: run compression before FX so the pass degrades first
      if (a.type === 'compress' && b.type !== 'compress') return -1;
      if (b.type === 'compress' && a.type !== 'compress') return  1;
      return 0;
    });

    // ── Execute pipeline ──────────────────────────────────────────
    let cur      = inputPath;
    const tmpFiles = [];

    for (let i = 0; i < ops.length; i++) {
      const op     = ops[i];
      const isLast = i === ops.length - 1;
      const out    = isLast
        ? outputPath
        : path.join(path.dirname(inputPath), `pl_${i}_${crypto.randomBytes(4).toString('hex')}${outputExt}`);
      if (!isLast) tmpFiles.push(out);

      if (op.type === 'compress') {
        progress(op.label);
        await runFFmpegPass(cur, out, op.cfg, isVideo);
      } else if (op.type === 'lag') {
        progress('Encoding lag…');
        await applyEncodingLag(cur, out, lagConfig.slopLevel, lagConfig.lagFrequency ?? 3);
      } else if (op.type === 'freeze') {
        // applyFreezeEffect calls progress internally for each sub-step
        await applyFreezeEffect(cur, out, freezeConfig, progress);
      }

      cur = out;
    }

    for (const f of tmpFiles) fs.unlink(f, () => {});

    if (sizeCap) {
      progress('Fitting for upload…');
      const fitTemp = outputPath + '.fit' + outputExt;
      await fitFileSize(outputPath, fitTemp, isVideo);
      fs.unlinkSync(outputPath);
      fs.renameSync(fitTemp, outputPath);
    }

    const originalSize = fs.statSync(inputPath).size;
    const degradedSize = fs.statSync(outputPath).size;

    res.setHeader('Content-Type', isVideo ? 'video/mp4' : 'audio/mpeg');
    res.setHeader('X-Original-Size', originalSize);
    res.setHeader('X-Degraded-Size', degradedSize);
    res.setHeader('Content-Disposition', `attachment; filename="slopped${outputExt}"`);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => {
      fs.unlink(inputPath, () => {});
      fs.unlink(outputPath, () => {});
    });
    stream.on('error', () => {
      fs.unlink(inputPath, () => {});
      fs.unlink(outputPath, () => {});
    });
  } catch (err) {
    fs.unlink(inputPath, () => {});
    fs.unlink(outputPath, () => {});
    res.status(500).json({ error: err.message });
  }
});

async function degradeFile(inputPath, outputPath, passConfigs, isVideo, onPass) {
  const n = passConfigs.length;

  if (n === 1) {
    onPass && onPass(`Compressing… (pass 1/1)`);
    await runFFmpegPass(inputPath, outputPath, passConfigs[0], isVideo);
    return;
  }

  const ext = isVideo ? '.mp4' : '.mp3';
  const dir = path.dirname(inputPath);
  const tempFiles = [];
  let current = inputPath;

  for (let i = 0; i < n; i++) {
    onPass && onPass(`Compressing… (pass ${i + 1}/${n})`);
    const isLast = i === n - 1;
    const out = isLast ? outputPath : path.join(dir, `tmp_${i}_${Date.now()}${ext}`);
    if (!isLast) tempFiles.push(out);
    await runFFmpegPass(current, out, passConfigs[i], isVideo);
    current = out;
  }

  for (const f of tempFiles) fs.unlink(f, () => {});
}

function runFFmpegPass(inputPath, outputPath, cfg, isVideo) {
  return new Promise((resolve, reject) => {
    const args = buildFFmpegArgs(inputPath, outputPath, cfg, isVideo);
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg error: ${stderr.slice(-400)}`));
    });
    proc.on('error', err => {
      reject(new Error(`FFmpeg not found. Install FFmpeg and add to PATH. (${err.message})`));
    });
  });
}

function buildFFmpegArgs(inputPath, outputPath, cfg, isVideo) {
  // cfg.compression: 1–100 (100=best quality, 1=worst)
  // cfg.scale: 0–50 (% to scale down; 0=no scaling, 50=scale to 50% then back)
  // cfg.noise: 0–100
  // cfg.rotation: 0–10 (degrees, applied as metadata/crop trick — skipped for video, too complex)
  // cfg.colorDrift: 0–100 (saturation/hue shift via eq filter)

  const args = ['-y', '-i', inputPath];

  if (isVideo) {
    const crf = Math.round(51 - (cfg.compression / 100) * 33); // compression 100→crf18, 1→crf51
    const audioBitrate = Math.max(16, Math.round((cfg.compression / 100) * 128));

    const vfParts = [];

    // Pixelation: scale down then back up using nearest-neighbor (flags=neighbor).
    // Applied first so the codec compresses the blocky result — same as real platform re-encoding.
    if (cfg.pixelate > 0) {
      const factor = Math.max(2, Math.round(1 + (cfg.pixelate / 10) * 2.5));
      vfParts.push(`scale=iw/${factor}:ih/${factor}`);
      vfParts.push(`scale=iw*${factor}:ih*${factor}:flags=neighbor`);
    }

    if (cfg.scale > 0) {
      const down = Math.round(100 - cfg.scale);
      const up = Math.round(10000 / down);
      vfParts.push(`scale=iw*${down}/100:ih*${down}/100`);
      vfParts.push(`scale=iw*${up}/100:ih*${up}/100`);
    }
    // Always enforce even dimensions for h264
    vfParts.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');

    if (cfg.noise > 0) {
      const strength = Math.round((cfg.noise / 100) * 40);
      vfParts.push(`noise=alls=${strength}:allf=t+u`);
    }

    if (cfg.colorDrift > 0) {
      // FFmpeg eq: brightness is an OFFSET from 0 (range -1 to 1). Keep tiny.
      const sat    = Math.max(0.4, 1 - (cfg.colorDrift / 100) * 0.35).toFixed(2);
      const bright = ((Math.random() - 0.5) * (cfg.colorDrift / 100) * 0.06).toFixed(3);
      vfParts.push(`eq=saturation=${sat}:brightness=${bright}`);
    }

    // FPS reduction — 0 means keep original
    if (cfg.fps > 0) {
      vfParts.push(`fps=${cfg.fps}`);
    }

    // Bad cropping: add black/white bars on 1–3 random sides (simulating a UI element
    // bleeding into the frame during a screen recording or bad crop), then scale back
    // to the original dimensions — the slight mismatch introduces a subtle stretch.
    if (cfg.badCrop > 0 && Math.random() * 100 < cfg.badCrop) {
      const allSides = ['left', 'right', 'top', 'bottom'].sort(() => Math.random() - 0.5);
      const sides = allSides.slice(0, 1 + Math.floor(Math.random() * 2.5)); // 1–3 sides
      let plPct = 0, prPct = 0, ptPct = 0, pbPct = 0;
      for (const side of sides) {
        const pct = 0.02 + Math.random() * 0.07; // 2–9% bar thickness
        if (side === 'left')   plPct = pct;
        if (side === 'right')  prPct = pct;
        if (side === 'top')    ptPct = pct;
        if (side === 'bottom') pbPct = pct;
      }
      const color  = Math.random() < 0.85 ? 'black' : 'white';
      const totalW = (1 + plPct + prPct).toFixed(5);
      const totalH = (1 + ptPct + pbPct).toFixed(5);
      // pad adds the bars (iw/ih here = pre-pad dimensions), then scale squishes back —
      // the slight aspect ratio distortion is the intended effect.
      // trunc(…/2)*2 forces even pixel dimensions — FFmpeg requires integer, even dims for h264.
      vfParts.push(
        `pad=trunc(iw*${totalW}/2)*2:trunc(ih*${totalH}/2)*2:trunc(iw*${plPct.toFixed(5)}):trunc(ih*${ptPct.toFixed(5)}):${color},` +
        `scale=trunc(iw/${totalW}/2)*2:trunc(ih/${totalH}/2)*2`
      );
      console.log(`[bad-crop] sides=${sides.join('+')}  color=${color}  W×${totalW}  H×${totalH}`);
    }

    args.push(
      '-vf', vfParts.join(','),
      '-c:v', 'libx264',
      '-crf', String(crf),
      '-preset', 'ultrafast',
      '-c:a', 'aac',
      '-b:a', `${audioBitrate}k`,
      '-movflags', '+faststart',
      outputPath
    );
  } else {
    // Audio
    const bitrate = Math.max(8, Math.round((cfg.compression / 100) * 128));
    const afParts = [];

    if (cfg.colorDrift > 60) afParts.push('lowpass=f=8000');
    if (cfg.colorDrift > 80) afParts.push('highpass=f=300');

    // Mono at very low compression
    const mono = cfg.compression < 25;

    args.push('-c:a', 'libmp3lame', '-b:a', `${bitrate}k`);
    if (mono) args.push('-ac', '1');
    if (afParts.length > 0) args.push('-af', afParts.join(','));
    args.push(outputPath);
  }

  return args;
}

// ── Freeze / Datamorph ────────────────────────────────────

// Run ffprobe to get the video duration in seconds.
// ffprobe ships with FFmpeg — if ffmpeg works, ffprobe is there too.
function getVideoDuration(filePath) {
  // We need duration AND audio sample rate.
  // Sample rate is required so aloop can loop the right number of samples during a freeze.
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet', '-print_format', 'json',
      '-show_format', '-show_streams', filePath
    ]);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      try {
        const data = JSON.parse(out);
        const audio = data.streams.find(s => s.codec_type === 'audio');
        resolve({
          duration:   parseFloat(data.format.duration),
          sampleRate: audio ? parseInt(audio.sample_rate) : 44100,
        });
      } catch { reject(new Error('Could not parse video info')); }
    });
    proc.on('error', err => reject(new Error(`ffprobe not found: ${err.message}`)));
  });
}

// Generate random, non-overlapping freeze intervals within the video.
// Count scales with slopLevel (base) and freezeFrequency (user multiplier).
// loopTypeBias: 0 = all tight (stutter), 100 = all loose (hold), 50 = 50/50.
function generateFreezeIntervals(duration, slopLevel, freezeFrequency = 5, loopTypeBias = 50) {
  const t         = (slopLevel - 1) / 9;
  const baseCount = Math.round(1 + t * 6);          // 1–7 based on slop level
  // Frequency slider: 5 = no change, 1 = ~20%, 10 = ~200% of base count
  const count     = Math.max(1, Math.round(baseCount * (freezeFrequency / 5)));
  const minDur    = 0.2 + t * 0.6;                   // 0.2–0.8 s min freeze
  const maxDur    = 0.5 + t * 3.0;                   // 0.5–3.5 s max freeze
  const padding   = 1.0;                              // leave 1 s at each end

  const intervals = [];
  // Attempt up to 5× the desired count to find non-overlapping slots
  for (let attempt = 0; attempt < count * 5 && intervals.length < count; attempt++) {
    const dur   = minDur + Math.random() * (maxDur - minDur);
    const start = padding + Math.random() * Math.max(0, duration - padding * 2 - dur);
    const end   = start + dur;

    // Keep 0.5 s gap between any two freezes so the video can breathe
    const clash = intervals.some(iv => start < iv.end + 0.5 && end > iv.start - 0.5);
    if (!clash && end < duration - padding) {
      // loopTypeBias: 0=all tight (stutter), 100=all loose (hold)
      const loopType = Math.random() < (loopTypeBias / 100) ? 'loose' : 'tight';
      const tightEnd = loopType === 'tight'
        ? start + 0.5 + Math.random() * 0.5  // 0.5–1.0 s
        : end;                                // keep the duration that was already rolled
      intervals.push({ start, end: tightEnd, loopType });
    }
  }

  return intervals.sort((a, b) => a.start - b.start);
}

// Run an arbitrary FFmpeg command (args array). Used for freeze/datamorph
// which builds its own args rather than going through buildFFmpegArgs.
function runFFmpegRaw(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg error (freeze): ${stderr.slice(-400)}`));
    });
    proc.on('error', err => reject(new Error(`FFmpeg not found: ${err.message}`)));
  });
}

// Split the video timeline into alternating normal/freeze segments.
// e.g. freezes=[(3,5),(10,12)], duration=15 →
//   normal 0-3, freeze 3-5, normal 5-10, freeze 10-12, normal 12-15
function buildSegments(freezes, duration) {
  const segs = [];
  let cursor = 0;
  for (const f of freezes) {
    if (f.start > cursor + 0.01) segs.push({ type: 'normal', start: cursor, end: f.start });
    segs.push({ type: 'freeze', start: f.start, end: f.end, loopType: f.loopType });
    cursor = f.end;
  }
  if (cursor < duration - 0.01) segs.push({ type: 'normal', start: cursor, end: duration });
  return segs;
}

// Build a single -filter_complex string that:
//   • Trims each normal segment and passes it through unchanged
//   • For each freeze segment: grabs ~0.5 s of video/audio at the freeze point
//     and loops it to fill the freeze duration (no freeze filter needed)
//   • Concatenates everything back into one stream
//
// Using split/asplit lets us reference [0:v] and [0:a] multiple times —
// without it FFmpeg would error "Input pad ... already connected".
function buildFreezeFilterGraph(segments, sampleRate) {
  const n = segments.length;
  const parts = [];
  const vOuts = [], aOuts = [];

  // Create one copy of each input stream per segment via split/asplit
  const vLabels = segments.map((_, i) => `[vs${i}]`).join('');
  const aLabels = segments.map((_, i) => `[as${i}]`).join('');
  parts.push(`[0:v]split=${n}${vLabels}`);
  parts.push(`[0:a]asplit=${n}${aLabels}`);

  for (let i = 0; i < n; i++) {
    const { type, start, end, loopType } = segments[i];
    const s   = start.toFixed(4);
    const e   = end.toFixed(4);
    const dur = (end - start).toFixed(4);

    if (type === 'normal') {
      parts.push(`[vs${i}]trim=${s}:${e},setpts=PTS-STARTPTS[v${i}]`);
      parts.push(`[as${i}]atrim=${s}:${e},asetpts=PTS-STARTPTS[a${i}]`);
    } else {
      // Tight: loop 1 or 2 frames (~0.033–0.067 s of source).
      // Looks like a true single-frame stutter — the video just locks on one moment.
      // Loose (current): loop 0.5 s of source, giving slight micro-motion in the freeze.
      const tight     = loopType === 'tight';
      const srcDur    = tight
        ? (Math.random() < 0.5 ? 0.034 : 0.067)  // ~1 frame or ~2 frames at ~30 fps
        : 0.5;
      const srcEnd    = (start + srcDur).toFixed(4);
      const frameSize = tight ? 4 : 500;           // frames to buffer: tiny for tight, large for loose
      const loops     = Math.ceil((end - start) / srcDur) + 5;

      parts.push(
        `[vs${i}]trim=${s}:${srcEnd},setpts=PTS-STARTPTS,` +
        `loop=${loops}:${frameSize}:0,` +
        `trim=0:${dur},setpts=PTS-STARTPTS[v${i}]`
      );

      const aSamples = Math.round(sampleRate * srcDur);
      parts.push(
        `[as${i}]atrim=${s}:${srcEnd},asetpts=PTS-STARTPTS,` +
        `aloop=${loops}:${aSamples}:0,` +
        `atrim=0:${dur},asetpts=PTS-STARTPTS[a${i}]`
      );
    }

    vOuts.push(`[v${i}]`);
    aOuts.push(`[a${i}]`);
  }

  // concat expects inputs interleaved by segment: [v0][a0][v1][a1]...
  // NOT all-video-then-all-audio — that's what caused the "media type mismatch at pad 1" error.
  const interleaved = segments.map((_, i) => `[v${i}][a${i}]`).join('');
  parts.push(`${interleaved}concat=n=${n}:v=1:a=1[vout][aout]`);
  return parts.join(';');
}

// Get all keyframe (I-frame) packet info from a video file using ffprobe.
// Returns array of { pos, size, pts_time } for each keyframe packet.
function getIFramePackets(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-select_streams', 'v:0',
      '-show_packets',
      '-print_format', 'json',
      filePath,
    ]);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('ffprobe packet analysis failed'));
      try {
        const data = JSON.parse(out);
        const keyframes = (data.packets || [])
          .filter(p => p.flags && p.flags.includes('K') && p.pos != null)
          .map(p => ({
            pos:      parseInt(p.pos),
            size:     parseInt(p.size),
            pts_time: parseFloat(p.pts_time || p.dts_time || 0),
          }));
        resolve(keyframes);
      } catch { reject(new Error('Could not parse packet info')); }
    });
    proc.on('error', err => reject(new Error(`ffprobe not found: ${err.message}`)));
  });
}

// Find the MPEG4 VOP start code (000001B6) in a buffer slice and flip the
// VOP coding type from I-frame (00) to P-frame (01).  With no I-frame to
// reset the decoder it continues using the frozen frame as reference —
// motion vectors then apply to that frozen image, producing the datamosh bleed.
// Returns true if a patch was applied.
function patchVopType(buf, offset, size) {
  const end = Math.min(offset + size, buf.length - 4);
  for (let i = offset; i < end - 3; i++) {
    if (buf[i] === 0x00 && buf[i+1] === 0x00 && buf[i+2] === 0x01 && buf[i+3] === 0xB6) {
      // VOP start code found. Bits 7–6 of the next byte are vop_coding_type:
      //   00 = I, 01 = P, 10 = B, 11 = S
      if (i + 4 < buf.length) {
        const b = buf[i + 4];
        if ((b >> 6) === 0) {              // I-frame?
          buf[i + 4] = (b & 0x3F) | 0x40; // Patch to P-frame (01xx xxxx)
          return true;
        }
      }
      break; // VOP found but not I — stop scanning this chunk
    }
  }
  return false;
}

// Real datamoshing via I-frame bitstream corruption.
//
// Pipeline:
//   1. Encode freeze-processed video to xvid AVI — creates a clean I+P frame
//      structure we can manipulate at the byte level.
//   2. Use ffprobe to locate every keyframe packet in the AVI.
//   3. For each freeze, find the first I-frame that falls within 1 s after the
//      freeze end — that frame would normally "reset" the decoder; we corrupt it.
//   4. Patch those I-frames to P-frames in the raw AVI data.  The P-frames now
//      have no valid I-frame reference so the decoder bleeds the frozen image
//      forward as motion vectors are applied to it.
//   5. Transcode the corrupted AVI to H264 — the decoder artifacts become real
//      pixel data baked into the output.
//   6. Re-mux with original audio to restore sync.
async function applyDatamorph(inputPath, outputPath, freezes) {
  const dir = path.dirname(inputPath);
  const id  = crypto.randomBytes(4).toString('hex');
  const avi = path.join(dir, `${id}_dm.avi`);
  const vid = path.join(dir, `${id}_dv.mp4`);

  try {
    // 1. Encode to MPEG4/xvid.  -g 250 + -sc_threshold 0 suppress auto-keyframes
    //    so only chosen I-frames exist, maximising the bleed-through window.
    await runFFmpegRaw([
      '-y', '-i', inputPath,
      '-c:v', 'libxvid', '-qscale:v', '4',
      '-g', '250', '-sc_threshold', '0',
      '-an',
      avi,
    ]);

    // 2. Locate all keyframe packets in the AVI.
    const iframes = await getIFramePackets(avi);

    // 3. For each freeze, pick a random datamosh duration (0.5–4.0 s) and patch
    //    every I-frame that falls inside that window after the freeze ends.
    //    More I-frames patched = longer bleed before the decoder resets itself.
    const targets = new Set();
    for (const freeze of freezes) {
      const moshDur = 0.5 + Math.random() * 3.5; // 0.5 – 4.0 s
      for (const f of iframes) {
        if (f.pts_time > freeze.end && f.pts_time < freeze.end + moshDur) {
          targets.add(f);
        }
      }
    }

    if (targets.size === 0) {
      fs.copyFileSync(inputPath, outputPath);
      return;
    }

    // 4. Patch targeted I-frames → P-frames in the raw AVI data.
    //    AVI chunk layout: [4B fourCC][4B size][N bytes data].
    //    ffprobe pos points to the chunk start (before the 8-byte header).
    const buf = fs.readFileSync(avi);
    for (const frame of targets) {
      patchVopType(buf, frame.pos + 8, frame.size);
    }
    fs.writeFileSync(avi, buf);

    // 5. Transcode corrupted AVI to H264 MP4 (video only).
    //    The decoder's output for the patched P-frames — artifacts, smear,
    //    frozen-image bleed — is captured as real pixel data by the H264 encoder.
    await runFFmpegRaw([
      '-y', '-i', avi,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'ultrafast',
      '-an',
      vid,
    ]);

    // 6. Re-mux datamorphed video with original audio to restore timecode sync.
    await runFFmpegRaw([
      '-y',
      '-i', vid,
      '-i', inputPath,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ]);

  } finally {
    fs.unlink(avi, () => {});
    fs.unlink(vid, () => {});
  }
}

// ── Encoding Lag ────────────────────────────────────

// Get basic video info: duration and framerate
function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet', '-print_format', 'json',
      '-show_streams', filePath
    ]);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      try {
        const data = JSON.parse(out);
        const video = data.streams.find(s => s.codec_type === 'video');
        if (!video) return reject(new Error('No video stream found'));

        // Parse framerate: could be "30" or "30/1" or "29.97"
        const fpsStr = video.r_frame_rate || '30/1';
        const [num, den] = fpsStr.split('/').map(Number);
        const fps = den ? num / den : num;
        const duration = parseFloat(video.duration || 0);

        resolve({ fps, duration });
      } catch { reject(new Error('Could not parse video info')); }
    });
    proc.on('error', err => reject(new Error(`ffprobe not found: ${err.message}`)));
  });
}

// Generate lag (stutter) intervals.
// Returns array of { start, end, threshold } where threshold is the select-filter
// keep-probability: higher threshold → fewer frames kept → longer per-frame holds.
//
// lagFrequency drives BOTH how often windows occur AND how hard each one hits:
//   freq=1  → rare, mild  (threshold ~0.72 → 28% kept → ~0.12 s avg hold at 30 fps)
//   freq=3  → default     (threshold ~0.83 → 17% kept → ~0.20 s avg hold)
//   freq=5  → noticeable  (threshold ~0.88 → 12% kept → ~0.28 s avg hold)
//   freq=10 → brutal      (threshold ~0.97 →  3% kept → ~1.10 s avg hold)
function generateLagIntervals(duration, slopLevel, lagFrequency = 3) {
  const t = (slopLevel - 1) / 9;          // 0→1 from slop slider
  const f = (lagFrequency - 1) / 9;       // 0→1 from frequency slider

  // Window count is density-based so glitch frequency feels the same regardless
  // of video length.  lagFrequency=10 targets ~18 glitches/minute; shorter videos
  // get proportionally fewer windows, longer videos get proportionally more.
  // freq=1 → 1.8/min, freq=5 → 9/min, freq=10 → 18/min
  const glitchesPerMinute = lagFrequency * 1.8;
  const count = Math.max(1, Math.round(glitchesPerMinute * (duration / 60)));

  // Window duration also grows with frequency so heavy windows last longer.
  const minDur = 0.3 + f * 0.5;   // 0.35 s → 0.80 s
  const maxDur = 0.7 + f * 1.5;   // 0.87 s → 2.20 s

  // Threshold is driven primarily by lagFrequency — this is what actually makes
  // the slider feel different.  Slop adds a small additional push on top.
  const baseThreshold = 0.72 + f * 0.25 + t * 0.03; // 0.75 → 0.97

  const padding = 0.5;
  const intervals = [];

  for (let attempt = 0; attempt < count * 5 && intervals.length < count; attempt++) {
    const dur   = minDur + Math.random() * (maxDur - minDur);
    const start = padding + Math.random() * Math.max(0, duration - padding * 2 - dur);
    const end   = start + dur;

    const clash = intervals.some(iv => start < iv.end + 0.4 && end > iv.start - 0.4);
    if (!clash && end < duration - padding) {
      // Per-window jitter so consecutive windows don't feel identical.
      const threshold = Math.min(0.97, Math.max(0.65, baseThreshold + (Math.random() - 0.5) * 0.06));
      intervals.push({ start, end, threshold });
    }
  }

  return intervals.sort((a, b) => a.start - b.start);
}

// Build filter_complex for encoding lag.
//
// Per lag window:
//   1. trim + reset PTS
//   2. select='gt(random(n),threshold)+lt(n,1)' — keep each frame with probability
//      (1-threshold), always keeping frame 0 so the window is never empty.
//      Because random(n) is seeded by frame index, the gaps between kept frames
//      are irregular, which is exactly what real encoder lag looks like.
//   3. fps=original — duplicates each kept frame to fill the gap before the next
//      kept frame, baking variable-length holds as real duplicate frames in H264.
//   4. trim=0:dur — clip to original window length (fps may add a tiny overshoot).
function buildLagFilterGraph(segments, fps) {
  const n      = segments.length;
  const fpsStr = fps.toFixed(3);
  const parts  = [];
  const vOuts  = [];

  const vLabels = segments.map((_, i) => `[vs${i}]`).join('');
  parts.push(`[0:v]split=${n}${vLabels}`);

  for (let i = 0; i < n; i++) {
    const { type, start, end, threshold } = segments[i];
    const s   = start.toFixed(4);
    const e   = end.toFixed(4);
    const dur = (end - start).toFixed(4);

    if (type === 'normal') {
      parts.push(`[vs${i}]trim=${s}:${e},setpts=PTS-STARTPTS[v${i}]`);
    } else {
      const thr = (threshold || 0.85).toFixed(3);
      parts.push(
        `[vs${i}]trim=${s}:${e},setpts=PTS-STARTPTS,` +
        `select='gt(random(n),${thr})+lt(n,1)',` +
        `fps=${fpsStr},trim=0:${dur},setpts=PTS-STARTPTS[v${i}]`
      );
    }

    vOuts.push(`[v${i}]`);
  }

  parts.push(`${vOuts.join('')}concat=n=${n}:v=1[vout]`);
  return parts.join(';');
}

// Split timeline into alternating normal/lag segments
function buildLagSegments(lags, duration) {
  const segs = [];
  let cursor = 0;
  for (const lag of lags) {
    if (lag.start > cursor + 0.01) segs.push({ type: 'normal', start: cursor, end: lag.start });
    segs.push({ type: 'lag', start: lag.start, end: lag.end, threshold: lag.threshold });
    cursor = lag.end;
  }
  if (cursor < duration - 0.01) segs.push({ type: 'normal', start: cursor, end: duration });
  return segs;
}

// Apply encoding lag (frame skip stutters) to a video file.
// Preserves audio sync and output duration.
async function applyEncodingLag(inputPath, outputPath, slopLevel, lagFrequency = 3) {
  let info;
  try {
    info = await getVideoInfo(inputPath);
  } catch (err) {
    console.log(`[lag] ffprobe failed (${err.message}), skipping`);
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  const { fps, duration } = info;
  console.log(`[lag] slop=${slopLevel}  fps=${fps.toFixed(2)}  duration=${duration.toFixed(2)}s`);

  if (duration < 1.5) {
    console.log('[lag] video too short, skipping');
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  const lags = generateLagIntervals(duration, slopLevel, lagFrequency);
  if (lags.length === 0) {
    console.log('[lag] no intervals generated, skipping');
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  console.log(`[lag] ${lags.length} stutter window(s):`);
  lags.forEach((l, i) =>
    console.log(`  [lag]  #${i + 1}  ${l.start.toFixed(2)}s–${l.end.toFixed(2)}s  threshold=${l.threshold.toFixed(3)}  (${((1-l.threshold)*100).toFixed(0)}% kept)`)
  );

  const segments     = buildLagSegments(lags, duration);
  const filterGraph  = buildLagFilterGraph(segments, fps);

  // Process video with lag filter, keep audio unmodified, then re-mux
  const tempVid = outputPath + '.lagvid.mp4';

  try {
    // Pass 1: apply lag to video only (no audio)
    await runFFmpegRaw([
      '-y', '-i', inputPath,
      '-filter_complex', filterGraph,
      '-map', '[vout]',
      '-c:v', 'libx264', '-crf', '18', '-preset', 'ultrafast',
      '-an',
      tempVid,
    ]);

    // Pass 2: re-mux laggy video with original audio to preserve sync
    await runFFmpegRaw([
      '-y',
      '-i', tempVid,
      '-i', inputPath,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ]);
    console.log('[lag] done');
  } finally {
    fs.unlink(tempVid, () => {});
  }
}

// Apply freeze frames and optional datamorphing to a video file.
async function applyFreezeEffect(inputPath, outputPath, { datamorphEnabled, slopLevel, freezeFrequency = 5, loopTypeBias = 50 }, onStep) {
  let info;
  try {
    info = await getVideoDuration(inputPath);
  } catch {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  const { duration, sampleRate } = info;
  if (duration < 2.5) { fs.copyFileSync(inputPath, outputPath); return; }

  const t       = (slopLevel - 1) / 9;
  const freezes = generateFreezeIntervals(duration, slopLevel, freezeFrequency, loopTypeBias);
  if (freezes.length === 0) { fs.copyFileSync(inputPath, outputPath); return; }

  const segments    = buildSegments(freezes, duration);
  const filterGraph = buildFreezeFilterGraph(segments, sampleRate);

  // Pass 1: bake the freeze frames into the video using the filter graph.
  // If datamorphing is also requested we write to a temp file first.
  onStep && onStep('Applying FPS drops…');
  const pass1Out = datamorphEnabled ? outputPath + '.p1.mp4' : outputPath;

  await runFFmpegRaw([
    '-y', '-i', inputPath,
    '-filter_complex', filterGraph,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'ultrafast',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    pass1Out,
  ]);

  if (!datamorphEnabled) return;

  onStep && onStep('Datamorphing…');
  // Pass 2: real datamoshing via I-frame bitstream corruption.
  // Encodes the freeze-processed video to xvid AVI, patches the I-frames that
  // fall just after each freeze end to P-frames, then transcodes back to H264.
  // If libxvid is unavailable or anything goes wrong, fall back gracefully.
  try {
    await applyDatamorph(pass1Out, outputPath, freezes);
  } catch (err) {
    console.error('Datamorphing failed, using freeze-only output:', err.message);
    fs.renameSync(pass1Out, outputPath);
    return;
  }

  fs.unlink(pass1Out, () => {});
}

// ── Fit for upload ────────────────────────────────────────
// Re-encodes the file only if it exceeds the target size.
// Computes the required bitrate from duration so the output just fits.
// Uses the gentlest encode settings possible (high quality CRF + constrained
// bitrate) so no extra degradation is introduced beyond what's needed to hit
// the size limit.
async function fitFileSize(inputPath, outputPath, isVideo, targetMB = 98) {
  const currentMB = fs.statSync(inputPath).size / (1024 * 1024);
  if (currentMB <= targetMB) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  let duration;
  try {
    const info = await getVideoDuration(inputPath);
    duration = info.duration;
  } catch {
    // Can't determine duration — just copy as-is
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  // Target slightly under the cap to account for container overhead
  const targetBits    = targetMB * 0.97 * 1024 * 1024 * 8;
  const totalBitrate  = Math.floor(targetBits / duration);          // bits/s

  console.log(`[fit] ${currentMB.toFixed(1)} MB → targeting ≤${targetMB} MB  (${Math.round(totalBitrate / 1000)} kbps total)`);

  if (isVideo) {
    const audioBitrate = 128_000;                                   // 128 kbps
    const videoBitrate = Math.max(50_000, totalBitrate - audioBitrate);
    const vbr          = Math.floor(videoBitrate / 1000);

    await runFFmpegRaw([
      '-y', '-i', inputPath,
      '-c:v', 'libx264',
      '-b:v', `${vbr}k`, '-maxrate', `${vbr}k`, '-bufsize', `${vbr * 2}k`,
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath,
    ]);
  } else {
    const abr = Math.max(8, Math.floor(totalBitrate / 1000));
    await runFFmpegRaw([
      '-y', '-i', inputPath,
      '-c:a', 'libmp3lame', '-b:a', `${abr}k`,
      outputPath,
    ]);
  }
}

app.listen(PORT, () => {
  console.log(`Internet Slop Simulator → http://localhost:${PORT}`);
});
