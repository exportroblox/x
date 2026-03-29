const sharp = require("sharp");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

let ffmpegPath;
try { ffmpegPath = require("ffmpeg-static"); } catch { ffmpegPath = null; }

const MAX_VIDEO_DIM = 480;
const MAX_VIDEO_FPS = 30;
const MAX_GIF_DIM = 512;
const MAX_RESPONSE = 20_000_000; // 20MB segments (was 4.5MB)
const DEFAULT_DELAY = 100;

// ─── CACHE ───────────────────────────────────────────────
// url → { format, width, height, fb, frameCount, delays, framesPerSeg, totalSegments, rawPath?, rawData?, ... }
const processCache = new Map();
const processingLocks = new Map(); // url → Promise

function clampEven(n) {
  n = Math.max(2, Math.round(n));
  return n % 2 === 1 ? n + 1 : n;
}

function fitSize(srcW, srcH, maxDim) {
  let w = srcW, h = srcH;
  if (w > maxDim || h > maxDim) {
    const s = Math.min(maxDim / w, maxDim / h);
    w = Math.round(w * s); h = Math.round(h * s);
  }
  return { w: clampEven(Math.max(2, w)), h: clampEven(Math.max(2, h)) };
}

function makeTmp(label) {
  const d = path.join(require("os").tmpdir(), `frm_${label}_${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function runFF(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr: stderr || (err && err.stderr ? err.stderr.toString() : "") });
    });
  });
}

// ─── Download + process ONCE, cache result ───────────────
async function processUrl(url) {
  if (processCache.has(url)) return processCache.get(url);
  if (processingLocks.has(url)) return await processingLocks.get(url);

  const promise = _doProcess(url);
  processingLocks.set(url, promise);
  try {
    const result = await promise;
    processCache.set(url, result);
    return result;
  } catch (e) {
    throw e;
  } finally {
    processingLocks.delete(url);
  }
}

async function _doProcess(url) {
  console.time(`process ${url}`);

  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Source HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  console.log(`Downloaded ${(buf.length / 1048576).toFixed(1)}MB from ${url}`);

  // Detect type
  let meta;
  try { meta = await sharp(buf).metadata(); } catch { meta = null; }

  if (meta && meta.pages && meta.pages > 1) {
    const r = await processGif(buf, meta);
    console.timeEnd(`process ${url}`);
    return r;
  }

  if (meta && meta.width && meta.height && (!meta.pages || meta.pages === 1)) {
    // Static image
    const r = await processImage(buf, meta);
    console.timeEnd(`process ${url}`);
    return r;
  }

  // Treat as video
  const r = await processVideo(buf);
  console.timeEnd(`process ${url}`);
  return r;
}

async function processImage(buf, meta) {
  const TARGET = 4096;
  let pipeline = sharp(buf).ensureAlpha();
  if (meta.width > TARGET || meta.height > TARGET)
    pipeline = pipeline.resize(TARGET, TARGET, { fit: "inside", withoutEnlargement: true });

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const fb = info.width * info.height * 4;

  console.log(`Image: ${info.width}x${info.height}`);
  return {
    format: "image",
    width: info.width,
    height: info.height,
    fb,
    frameCount: 1,
    delays: [0],
    framesPerSeg: 1,
    totalSegments: 1,
    imageData: data,
  };
}

async function processGif(buf, meta) {
  const pages = meta.pages || 1;
  const pageH = meta.pageHeight || meta.height;
  const srcDelays = [];
  for (let i = 0; i < pages; i++) srcDelays.push(meta.delay?.[i] || DEFAULT_DELAY);

  let { w, h } = fitSize(meta.width, pageH, MAX_GIF_DIM);
  let fb = w * h * 4;
  while (fb * pages > 400 * 1024 * 1024 && w > 64) {
    w = clampEven(Math.round(w * 0.7)); h = clampEven(Math.round(h * 0.7)); fb = w * h * 4;
  }

  const { data, info } = await sharp(buf, { pages: -1 })
    .resize(w, h, { fit: "fill" }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });

  const frameW = info.width;
  const frameH = Math.round(info.height / pages);
  fb = frameW * frameH * 4;
  const frameCount = Math.min(pages, Math.floor(data.length / fb));
  const delays = srcDelays.slice(0, frameCount);
  const framesPerSeg = Math.max(1, Math.floor(MAX_RESPONSE / fb));

  console.log(`GIF: ${frameW}x${frameH}, ${frameCount} frames, ${Math.ceil(frameCount / framesPerSeg)} segs`);
  return {
    format: "gif", width: frameW, height: frameH, fb, frameCount, delays,
    framesPerSeg, totalSegments: Math.ceil(frameCount / framesPerSeg),
    rawData: data,
  };
}

async function processVideo(buf) {
  if (!ffmpegPath) throw new Error("ffmpeg not available");

  const dir = makeTmp("vid");
  const inp = path.join(dir, "in");
  fs.writeFileSync(inp, buf);

  // Probe (async)
  const { stderr: probe } = await runFF(["-i", inp], 8000);

  let dur = 10;
  const dm = probe.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (dm) dur = +dm[1] * 3600 + +dm[2] * 60 + +dm[3] + +dm[4] / 100;

  const sm = probe.match(/,\s*(\d{2,5})x(\d{2,5})/);
  let sw = 640, sh = 480;
  if (sm) { sw = +sm[1]; sh = +sm[2]; }

  let sf = 30;
  const fm = probe.match(/(\d+(?:\.\d+)?)\s*fps/);
  if (fm) sf = parseFloat(fm[1]);

  const fps = Math.min(MAX_VIDEO_FPS, Math.round(sf));
  const { w: outW, h: outH } = fitSize(sw, sh, MAX_VIDEO_DIM);
  const fb = outW * outH * 4;

  // ONE ffmpeg call for ALL frames
  const rawPath = path.join(dir, "all.raw");
  console.log(`FFmpeg: ${sw}x${sh} → ${outW}x${outH} @${fps}fps, ${dur.toFixed(1)}s …`);

  const { err } = await runFF([
    "-y", "-i", inp,
    "-vf", `scale=${outW}:${outH}:flags=bilinear,fps=${fps}`,
    "-pix_fmt", "rgba", "-f", "rawvideo", rawPath,
  ], 180000);

  // Clean input immediately
  try { fs.unlinkSync(inp); } catch {}

  if (!fs.existsSync(rawPath)) throw new Error("FFmpeg produced no output");

  const rawSize = fs.statSync(rawPath).size;
  const frameCount = Math.floor(rawSize / fb);
  if (frameCount === 0) throw new Error("No frames extracted");

  const delayMs = Math.round(1000 / fps);
  const delays = Array(frameCount).fill(delayMs);
  const framesPerSeg = Math.max(1, Math.floor(MAX_RESPONSE / fb));
  const totalSegments = Math.ceil(frameCount / framesPerSeg);

  console.log(`Video: ${outW}x${outH}, ${frameCount} frames, ${totalSegments} segs, ${(rawSize / 1048576).toFixed(1)}MB raw`);

  return {
    format: "video", width: outW, height: outH, fps, duration: dur,
    fb, frameCount, delays, framesPerSeg, totalSegments, rawPath, dir,
  };
}

// ─── Handler ─────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { url, segment } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  try {
    const data = await processUrl(url);

    // ── Probe (no segment) ──
    if (segment === undefined) {
      return res.json({
        format: data.format,
        width: data.width,
        height: data.height,
        fps: data.fps || 0,
        duration: data.duration || 0,
        frameCount: data.frameCount,
        delays: data.delays,
        totalSegments: data.totalSegments,
      });
    }

    // ── Segment request ──
    const si = parseInt(segment);

    // Image: return header + pixel data
    if (data.format === "image") {
      const header = Buffer.alloc(8);
      header.writeUInt32LE(data.width, 0);
      header.writeUInt32LE(data.height, 4);
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(Buffer.concat([header, data.imageData]));
    }

    // Video / GIF: return frame slice
    const start = si * data.framesPerSeg;
    const end = Math.min(start + data.framesPerSeg, data.frameCount);
    const count = end - start;

    if (count <= 0) {
      const out = Buffer.alloc(4); out.writeUInt32LE(0, 0);
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(out);
    }

    const payloadSize = 4 + data.fb * count;
    const out = Buffer.alloc(payloadSize);
    out.writeUInt32LE(count, 0);

    if (data.format === "gif") {
      data.rawData.copy(out, 4, start * data.fb, start * data.fb + data.fb * count);
    } else {
      // Read slice from raw file (no re-download, no re-process!)
      const fd = fs.openSync(data.rawPath, "r");
      fs.readSync(fd, out, 4, data.fb * count, start * data.fb);
      fs.closeSync(fd);
    }

    res.setHeader("Content-Type", "application/octet-stream");
    return res.send(out);

  } catch (e) {
    console.error("frames error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
