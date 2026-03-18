# Internet Slop Simulator

> **⚠️ Heads up:** This is a vibe-coded app. The code is not fully optimized and may not be up to professional standards. It's been decently tested but is not bug-free — use it for fun, not production.

Degrade any image, video, or audio file by simulating its journey through multiple online platforms — every re-upload, re-compression, and bad format conversion makes it a little worse.

---

## Quick Start (absolute beginner guide)

### Step 1 — Install Node.js

Node.js is the runtime that powers the server.

1. Go to **https://nodejs.org**
2. Download the **LTS** version (the big green button)
3. Run the installer — keep all defaults and click Next through everything
4. When it's done, open a terminal:
   - **Windows**: press `Win + R`, type `cmd`, press Enter
   - **Mac**: press `Cmd + Space`, type `Terminal`, press Enter
5. Type `node --version` and press Enter. You should see something like `v20.11.0`. If you do, Node is installed.

### Step 2 — Install FFmpeg (for video and audio)

FFmpeg is a free tool that handles video and audio processing. **Images work without it** — skip this step if you only want to degrade images.

**Windows:**
1. Go to **https://ffmpeg.org/download.html**
2. Under "Get packages & executable files", click the Windows icon → **Windows builds from gyan.dev**
3. Download the `ffmpeg-release-essentials.zip`
4. Extract it somewhere permanent, e.g. `C:\ffmpeg`
5. Add FFmpeg to your PATH:
   - Press `Win + S`, search **"Edit the system environment variables"**, open it
   - Click **Environment Variables**
   - Under "System variables", find **Path**, click **Edit**
   - Click **New**, paste the path to the `bin` folder (e.g. `C:\ffmpeg\bin`)
   - Click OK on all windows
6. Open a **new** terminal and type `ffmpeg -version`. If it prints version info, it's working.

**Mac:**
```bash
# Install Homebrew first if you don't have it: https://brew.sh
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt install ffmpeg
```

### Step 3 — Download this project

**Option A — With Git** (if you have Git installed):
```bash
git clone https://github.com/YOUR_USERNAME/internet-slop-simulator.git
cd internet-slop-simulator
```

**Option B — Without Git**:
1. Click the green **Code** button on the GitHub page
2. Click **Download ZIP**
3. Extract the ZIP somewhere on your computer
4. Open a terminal and navigate into the folder:
   - **Windows**: right-click inside the extracted folder → **Open in Terminal**
   - **Mac**: drag the folder onto the Terminal icon

### Step 4 — Install dependencies

In your terminal, inside the project folder, run:
```bash
npm install
```

This downloads the Node.js packages the app needs. It only takes a few seconds.

### Step 5 — Start the app

```bash
npm start
```

You should see:
```
Internet Slop Simulator → http://localhost:3000
```

Open **http://localhost:3000** in your browser. Done.

> **To stop the server**, press `Ctrl + C` in the terminal.

> **To restart automatically when you edit code**, use `npm run dev` instead of `npm start`.

---

## How to Use

### 1. Drop a file
Drag and drop an image, video, or audio file onto the upload zone, or click it to browse. Max file size is 500 MB.

### 2. Pick a mode

**✨ Magic Slop** *(default)*
One slider, 1–10. Each level maps to a real internet scenario:

| Level | Vibe |
|-------|------|
| 1 | Just Browsed It |
| 3 | Discord Upload |
| 5 | Peak Internet |
| 7 | WhatsApp Forward |
| 10 | ☠ Maximum Slop ☠ |

**⚙️ Custom**
Full per-pass control. Choose how many passes (1–20) and configure each one independently. Use **Apply Pass 1 to All** to copy your first pass's settings to every other pass.

### 3. Video-only effects (Magic Slop mode)

| Effect | What it does |
|--------|-------------|
| **Encoding Lag** | Simulates an encoder that can't keep up — random frames are dropped and held, producing irregular stutter. A **Lag Frequency** slider controls how often and how hard. |
| **FPS Drops** | Freezes random sections of the video while audio continues. A **Freeze Frequency** slider and **Freeze Style** (Stutter ↔ Hold) give further control. |
| **Datamorphing** | After each freeze, corrupts the first keyframe so the frozen image "bleeds" into the next frames. Requires FPS Drops. |

### 4. Export option

**Fit for upload (< 99 MB)** — re-encodes the output to stay under 99 MB so you can upload it directly to platforms that enforce that limit. No additional degradation is introduced.

### 5. Compare and download

- Images: side-by-side comparison with file sizes shown
- Video/Audio: side-by-side players (original left, slopped right)
- Click **Download Slopped File** to save

---

## Features & Implementation

### Image degradation (client-side, no upload)

Implemented in `public/image-degrader.js` using the browser's Canvas API. No file ever leaves your machine.

Each pass runs this pipeline:
1. **Scale down → scale back up** — interpolation blur from resampling at a lower resolution
2. **Random micro-crop** — crops up to the configured % on each edge, then stretches back, simulating content drift from repeated cropping and resizing
3. **Slight random rotation** — sub-degree rotation with bicubic resampling, causing edge softening
4. **Misaligned resample** — two coupled sub-steps that simulate a platform encoding to a non-standard pixel grid:
   - Scale down by a random 2–8 px offset (magnitude scales with slop level) and back up with bilinear interpolation — each pass accumulates a little more smear, producing the authentic "forwarded image" softness that's distinct from JPEG blockiness
   - Ratio drift: squish the content into a canvas that's a few pixels wider or taller and stretch back — simulates platforms snapping to a fixed pixel grid without preserving the exact aspect ratio
5. **JPEG re-encode** — draws to canvas and exports via `toDataURL('image/jpeg', quality)`. Quality floor is raised (0.34 + compression × 0.55) so individual passes stay above the macro-blocking threshold; the accumulated damage across many passes is what destroys the image, not a single brutal quality setting
6. **Noise injection** — iterates over raw pixel data and randomly perturbs R, G, B channels
7. **Color drift** — adjusts saturation and applies a warm/cool hue shift to simulate repeated JPEG chroma subsampling

### Video & audio degradation (server-side, FFmpeg)

Implemented in `server.js`. The uploaded file is processed through a pipeline of FFmpeg passes and optional effect stages.

**Compression passes** (`buildFFmpegArgs`):
- **Pixelation**: scale down by a factor, then scale back up — pass 1 uses nearest-neighbor (`flags=neighbor`) for hard blockiness, later passes switch to bicubic to mimic what Instagram/WhatsApp do (smooth the blocks into blur)
- **Scale down/up**: bilinear resampling — introduces blur from resolution loss, same pass-aware upscale flag as pixelation
- **Misaligned resample**: same two-step approach as images but in FFmpeg filter syntax — scale down by an even pixel offset and back up with bicubic, then pad 1–2 random sides by the same offset and scale back, squishing the padding into the content
- **Noise**: FFmpeg `noise=alls=N:allf=t+u` — adds temporal + uniform noise to every frame
- **Color drift**: FFmpeg `eq=saturation=X:brightness=Y` — desaturates and shifts brightness slightly each pass
- **FPS reduction**: `fps=N` filter — drops frames to simulate low-quality encoding settings
- **Bad cropping**: `pad` filter adds bars on 1–3 randomly chosen sides (2–9% thick each) using real platform UI colours (Instagram dark, TikTok dark/white, Discord dark), then a `scale` filter squishes back — the aspect ratio mismatch produces the subtle stretch of a badly re-cropped video. Probability scales with slop level.
- **Compression**: libx264 CRF encoding (CRF 20 at slop 1 → CRF 43 at slop 10) — kept deliberately moderate so compression supports the resampling artefacts rather than dominating them

**Audio degradation** (`buildAudioFilters`, applied to both video audio tracks and standalone audio files):

Each pass probabilistically applies a chain of `-af` filters that simulate what platforms do to audio on every re-upload:

- **Sync drift** (`adelay`, video only): per-pass delay of 5–50 ms that accumulates across passes — at slop 10 the expected total is ~350 ms of A/V desync. Skipped for audio-only files since there is no video reference to drift against.
- **Sample rate artefacts** (`aresample`): downsamples to a misaligned intermediate rate (22 050 → 16 000 → 11 025 Hz as slop increases) then back up to 48 000 Hz (video) or 44 100 Hz (audio). The lossy round-trip introduces aliasing shimmer on high frequencies.
- **Clipping / loudness normalisation** (`volume` + hard clip): boosts gain by 1.0–1.8× then hard-clips to [-1, 1], producing flat-top waveform distortion — the sound of a file normalised too hot. Uses the best available clip filter in the current FFmpeg build (`aclip` → `asoftclip=type=hard` → `aeval` fallback, detected at startup).
- **Pre-echo / codec ghosting** (`aecho`): 5–15 ms ghost at 0.02–0.15 gain — nearly inaudible at low slop, a faint shimmer by slop 7–8, simulating psychoacoustic smearing from repeated MP3/AAC encoding.
- **Stereo collapse / one-ear** (`pan`): at mid–high slop levels, randomly either collapses stereo to mono-in-stereo (both channels summed equally) or hard-pans to a single channel. Mutually exclusive — one roll picks the branch. Skipped when the signal is already being forced to mono.

**Pipeline ordering** (random FX insertion):
Compression passes are numbered 1…N. Each enabled video effect (lag, freeze, datamorphing) is assigned a random slot between passes and sorted in, so the effects can land before, between, or after compression — not always at the end.

**Encoding Lag** (`applyEncodingLag`):
1. `ffprobe` reads the video's frame rate and duration
2. Window count is density-based: `glitches_per_minute × duration` — so a 10-minute video gets proportionally more windows than a 10-second one
3. Per window: `select='gt(random(n),threshold)+lt(n,1)'` randomly drops frames (higher threshold = more dropped), then `fps=original` bakes held frames as real duplicates in the output. The random seed is per-frame-index so gap lengths are irregular — which is what real encoder lag looks like
4. The lag filter only touches the video stream; audio is re-muxed from the original to keep sync

**FPS Drops / Freeze Frames** (`applyFreezeEffect`):
1. Generates random non-overlapping freeze intervals scaled to slop level and freeze frequency
2. Builds a `filter_complex` that `split`s the input, trims each segment, and for freeze segments: loops a tiny source window (tight = 1–2 frames, loose = 0.5s) using `loop`/`aloop` to fill the freeze duration
3. All segments are concatenated with `concat=n=N:v=1:a=1` — video and audio are frozen together

**Datamorphing** (`applyDatamorph`):
Real I-frame bitstream corruption, not a filter:
1. Encode to MPEG4/xvid AVI with `-g 250 -sc_threshold 0` — suppresses auto-keyframes so I-frames only appear where the encoder would naturally place them
2. `ffprobe -show_packets` finds every keyframe's byte offset and size in the AVI
3. For each freeze, a random 0.5–4.0s window after the freeze end is selected; any I-frame in that window is a target
4. The raw AVI bytes are read, and for each target: the VOP start code (`00 00 01 B6`) is found, and bits 7–6 of the next byte are flipped from `00` (I-frame) to `01` (P-frame)
5. The corrupted AVI is transcoded back to H264 — the decoder's artifacts (frozen image bleeding into motion-vector-displaced frames) become real pixel data
6. Original audio is re-muxed back to restore sync

**Fit for upload** (`fitFileSize`):
Checks current file size; if over the target, calculates `target_bits / duration` to find the maximum total bitrate that will fit, then re-encodes with `-b:v` and `-maxrate` for video, or `-b:a` for audio. Uses the gentlest possible settings so no extra degradation is added beyond what's needed to hit the limit.

**Progress reporting (SSE)**:
The client generates a `jobId` (UUID), opens a `GET /api/progress/:jobId` Server-Sent Events stream, then sends the POST. The server emits `{ step, total, message }` JSON events as each pipeline stage completes, and the browser updates the progress bar in real time.

---

## Project Structure

```
server.js                  Express server — handles /api/degrade, /api/ffmpeg-check, /api/progress/:jobId
public/
  index.html               App shell and UI markup
  style.css                Styles (dark theme)
  app.js                   UI logic, mode switching, form building, SSE client
  image-degrader.js        Canvas-based image degradation pipeline (fully client-side)
```

---

## Troubleshooting

**`npm install` fails**
Make sure you're running the command inside the project folder (you should see `package.json` if you run `ls` or `dir`).

**Video/audio processing fails**
Run `ffmpeg -version` in a terminal. If it says "command not found", FFmpeg isn't in your PATH — revisit Step 2 above.

**GIF animation is lost**
The Canvas API captures the first frame only. Animated GIF support is not implemented.

**Large images are slow**
Image processing runs in your browser. A 20+ megapixel photo with 8 passes can take several seconds — this is expected.

**Port already in use**
Run on a different port:
```bash
# Mac/Linux
PORT=4000 npm start

# Windows (Command Prompt)
set PORT=4000 && npm start
```
