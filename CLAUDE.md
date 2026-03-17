# Internet Slop Simulator

A web app that degrades media files by simulating their journey through multiple online platforms — every re-upload, screenshot, and format conversion makes things a little worse.

## Working conventions

- **Always explain changes**: Every code change must be accompanied by a plain-English sentence explaining what was changed and why. The goal is to help the developer learn from each edit.

## Stack

- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **Backend**: Node.js + Express — only used for video/audio FFmpeg processing
- **Image processing**: Canvas API (fully client-side, no upload needed)
- **Video/Audio processing**: FFmpeg via child_process (server-side)

## Getting Started

```bash
npm install
npm start
# → http://localhost:3000
```

### Requirements

- Node.js 18+
- FFmpeg installed and available in PATH (only required for video/audio features)
  - macOS: `brew install ffmpeg`
  - Ubuntu: `sudo apt install ffmpeg`
  - Windows: download from https://ffmpeg.org and add to PATH

## Project Structure

```
server.js                  Express server, handles /api/degrade for video/audio
public/
  index.html               App shell
  style.css                Styles (dark theme)
  app.js                   UI logic and orchestration
  image-degrader.js        Canvas-based image degradation pipeline (client-side)
```

## Modes

### ✨ Magic Slop (default)
Single 1–10 slider. Automatically configures passes, compression, noise, etc.

| Level | Vibe                       | Passes | JPEG Quality |
|-------|----------------------------|--------|--------------|
| 1     | Just Browsed It            | 1      | ~85%         |
| 3     | Discord Upload             | 2      | ~58%         |
| 5     | Peak Internet              | 4      | ~35%         |
| 7     | WhatsApp Forward           | 6      | ~18%         |
| 10    | ☠ Maximum Slop ☠           | 8      | ~7%          |

### ⚙️ Custom
- Choose number of passes (1–20)
- Per-pass control of: compression quality, noise, crop %, rotation °, color drift, scale-down %
- "Apply Pass 1 to All" button for quick uniform configuration
- Crop is capped at 5% max — content always remains intact

## Degradation Pipeline

### Images (client-side, Canvas API)
Per pass:
1. Scale down → scale back up (interpolation artifacts)
2. Random crop + resize back (content drift)
3. Random slight rotation (framing drift)
4. JPEG re-encode at low quality (compression artifacts)
5. Noise injection (random pixel perturbation)
6. Color shift / chroma desaturation (simulate repeated JPEG chroma subsampling)

### Video (server-side, FFmpeg)
- Scale down → scale back up
- Noise filter (allf=t+u)
- CRF increases with slop level (18 → 52)
- Audio bitrate reduces with slop level (128k → 18k)
- Up to 3 passes at high slop levels

### Audio (server-side, FFmpeg)
- Bitrate reduction (128k → 8k)
- Mono conversion at slop 7+
- Low-pass filter at slop 8+ (simulate phone audio)
- High-pass filter at slop 9+ (thin, hollow sound)

## API

`POST /api/degrade`
- Body: multipart form — `file` (video/* or audio/*), `slopLevel` (1-10)
- Returns: degraded file with headers `X-Original-Size`, `X-Degraded-Size`

`GET /api/ffmpeg-check`
- Returns: `{ available: true/false }`

## Notes

- Images processed entirely in the browser — no file is uploaded for images
- GIF input loses animation (canvas captures first frame only)
- Very large images may be slow to process client-side — this is expected
- Temp files for video/audio are written to the OS temp directory and cleaned up after each request
