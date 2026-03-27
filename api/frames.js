const sharp = require("sharp");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

let ffmpegPath;
try { ffmpegPath = require("ffmpeg-static"); } catch { ffmpegPath = null; }

const MAX_VIDEO_DIM = 320;
const MAX_VIDEO_FPS = 30;
const MAX_GIF_DIM = 512;
const MAX_RESPONSE = 3500000; // 3.5MB safety margin under Vercel's 4.5MB limit
const DEFAULT_DELAY = 100;

function clampEven(n) {
  n = Math.max(2, Math.round(n));
  return n % 2 === 1 ? n + 1 : n;
}

function fitSize(srcW, srcH, maxDim) {
  let w = srcW, h = srcH;
  if (w > maxDim || h > maxDim) {
    const s = Math.min(maxDim / w, maxDim / h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  return { w: clampEven(Math.max(2, w)), h: clampEven(Math.max(2, h)) };
}

function makeTmp() {
  const d = path.join("/tmp", "f" + Date.now() + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function processGif(buf) {
  const meta = await sharp(buf, { pages: -1 }).metadata();
  const pages = meta.pages || 1;
  const pageH = meta.pageHeight || meta.height;
  const delays = [];
  for (let i = 0; i < pages; i++) delays.push(meta.delay?.[i] || DEFAULT_DELAY);

  let { w, h } = fitSize(meta.width, pageH, MAX_GIF_DIM);
  let fb = w * h * 4;
  while (fb * pages > 400 * 1024 * 1024 && w > 64) {
    w = clampEven(Math.round(w * 0.7));
    h = clampEven(Math.round(h * 0.7));
    fb = w * h * 4;
  }

  const { data, info } = await sharp(buf, { pages: -1 })
    .resize(w, h, { fit: "fill" }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });

  const frameW = info.width;
  const frameH = Math.round(info.height / pages);
  fb = frameW * frameH * 4;

  const frames = [], finalDelays = [];
  for (let i = 0; i < pages; i++) {
    const off = i * fb;
    if (off + fb > data.length) break;
    const f = Buffer.alloc(fb);
    data.copy(f, 0, off, off + fb);
    frames.push(f);
    finalDelays.push(delays[i]);
  }

  const fpb = Math.max(1, Math.floor(MAX_RESPONSE / fb));
  return {
    width: frameW, height: frameH, frameCount: frames.length,
    delays: finalDelays, frames, framesPerBatch: fpb,
    totalBatches: Math.ceil(frames.length / fpb),
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { url, segment } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) throw new Error(`Source HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());

    let isAnim = false;
    try { const m = await sharp(buf).metadata(); if (m.pages > 1) isAnim = true; } catch {}

    // ── GIF ──
    if (isAnim) {
      const gif = await processGif(buf);
      const fb = gif.width * gif.height * 4;

      if (segment === undefined) {
        return res.json({
          format: "gif", width: gif.width, height: gif.height,
          frameCount: gif.frameCount, delays: gif.delays,
          totalSegments: gif.totalBatches,
        });
      }

      const si = parseInt(segment);
      const start = si * gif.framesPerBatch;
      const end2 = Math.min(start + gif.framesPerBatch, gif.frameCount);
      const count = end2 - start;
      const out = Buffer.alloc(4 + fb * count);
      out.writeUInt32LE(count, 0);
      let off = 4;
      for (let i = start; i < end2; i++) { gif.frames[i].copy(out, off, 0, fb); off += fb; }
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(out);
    }

    // ── Video ──
    if (!ffmpegPath) throw new Error("ffmpeg not available");
    const dir = makeTmp();
    const inp = path.join(dir, "in");
    fs.writeFileSync(inp, buf);

    try {
      let outW, outH, fps, dur;

      // Skip probe if dimensions passed
      if (req.query.ow && req.query.oh && req.query.ofps && req.query.dur) {
        outW = parseInt(req.query.ow);
        outH = parseInt(req.query.oh);
        fps = parseInt(req.query.ofps);
        dur = parseFloat(req.query.dur);
      } else {
        let probe = "";
        try {
          probe = execSync(`${ffmpegPath} -i ${inp} 2>&1`, { encoding: "utf8", timeout: 3000 });
        } catch (e) { probe = (e.stderr || e.stdout || e.message || "").toString(); }

        dur = 10;
        const dm = probe.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (dm) dur = +dm[1] * 3600 + +dm[2] * 60 + +dm[3] + +dm[4] / 100;

        const sm = probe.match(/,\s*(\d{2,5})x(\d{2,5})/);
        let sw = 640, sh = 480;
        if (sm) { sw = +sm[1]; sh = +sm[2]; }

        let sf = 30;
        const fm = probe.match(/(\d+(?:\.\d+)?)\s*fps/);
        if (fm) sf = parseFloat(fm[1]);

        fps = Math.min(MAX_VIDEO_FPS, Math.round(sf));
        const fit = fitSize(sw, sh, MAX_VIDEO_DIM);
        outW = fit.w; outH = fit.h;
      }

      // Dynamic segment sizing: guarantee response fits under MAX_RESPONSE
      const fb = outW * outH * 4;
      const maxFramesPerSeg = Math.max(1, Math.floor(MAX_RESPONSE / fb));
      const segSec = Math.min(maxFramesPerSeg / fps, 5);
      const totalSegments = Math.ceil(dur / segSec);

      // Info mode
      if (segment === undefined) {
        const estFrames = Math.ceil(dur * fps);
        const delayMs = Math.round(1000 / fps);
        return res.json({
          format: "video", width: outW, height: outH,
          fps, duration: dur, frameCount: estFrames,
          delays: Array(estFrames).fill(delayMs),
          totalSegments, segSec,
        });
      }

      // Segment mode
      const si = parseInt(segment);
      const startTime = si * segSec;
      const segDur = Math.min(segSec, dur - startTime);

      if (segDur <= 0) {
        const out = Buffer.alloc(4);
        out.writeUInt32LE(0, 0);
        res.setHeader("Content-Type", "application/octet-stream");
        return res.send(out);
      }

      const rawPath = path.join(dir, "o.raw");
      execSync(
        `${ffmpegPath} -y -ss ${startTime.toFixed(3)} -i ${inp} -t ${segDur.toFixed(3)} ` +
          `-vf "scale=${outW}:${outH},fps=${fps}" -pix_fmt rgba -f rawvideo ${rawPath}`,
        { timeout: 8000 }
      );

      if (!fs.existsSync(rawPath)) {
        const out = Buffer.alloc(4);
        out.writeUInt32LE(0, 0);
        res.setHeader("Content-Type", "application/octet-stream");
        return res.send(out);
      }

      const raw = fs.readFileSync(rawPath);
      const count = Math.floor(raw.length / fb);
      const out = Buffer.alloc(4 + fb * count);
      out.writeUInt32LE(count, 0);
      let off = 4;
      for (let i = 0; i < count; i++) { raw.copy(out, off, i * fb, (i + 1) * fb); off += fb; }

      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(out);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  } catch (e) {
    console.error("frames:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
