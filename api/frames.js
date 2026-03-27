const sharp = require("sharp");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

let ffmpegPath;
try {
  ffmpegPath = require("ffmpeg-static");
} catch {
  ffmpegPath = null;
}

// Realistic limits that actually work on Vercel free tier (10s timeout)
const MAX_RES = 256;       // pixels — keeps frames small enough to stream
const MAX_FPS = 10;        // more than enough for smooth playback
const MAX_DURATION = 30;   // seconds — Vercel can handle this
const DEFAULT_DELAY = 100;
const MAX_FRAMES = 300;    // hard cap

const cache = new Map();
const CACHE_TTL = 120000;

function cleanCache() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.time > CACHE_TTL) cache.delete(key);
  }
}

async function processGif(buf) {
  const meta = await sharp(buf, { pages: -1 }).metadata();
  const pages = meta.pages || 1;
  const pageHeight = meta.pageHeight || meta.height;

  const delays = [];
  for (let i = 0; i < pages; i++) {
    delays.push(
      meta.delay && Array.isArray(meta.delay) && meta.delay[i]
        ? meta.delay[i]
        : DEFAULT_DELAY
    );
  }

  let resizeW = meta.width;
  let resizeH = pageHeight;
  if (resizeW > MAX_RES || resizeH > MAX_RES) {
    const scale = Math.min(MAX_RES / resizeW, MAX_RES / resizeH);
    resizeW = Math.round(resizeW * scale);
    resizeH = Math.round(resizeH * scale);
  }
  resizeW = Math.max(2, resizeW);
  resizeH = Math.max(2, resizeH);

  const { data: rawAll, info } = await sharp(buf, { pages: -1 })
    .resize(resizeW, resizeH, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const frameW = info.width;
  const totalH = info.height;
  const frameH = Math.round(totalH / pages);
  const frameBytes = frameW * frameH * 4;

  let frames = [];
  let finalDelays = [];
  const maxFrames = Math.min(pages, MAX_FRAMES);

  // Subsample if too many frames
  const step = pages > MAX_FRAMES ? Math.ceil(pages / MAX_FRAMES) : 1;

  for (let i = 0; i < pages && frames.length < MAX_FRAMES; i += step) {
    const offset = i * frameBytes;
    if (offset + frameBytes > rawAll.length) break;
    const frameBuf = Buffer.alloc(frameBytes);
    rawAll.copy(frameBuf, 0, offset, offset + frameBytes);
    frames.push(frameBuf);
    finalDelays.push(delays[i] * step);
  }

  return {
    width: frameW,
    height: frameH,
    frameCount: frames.length,
    delays: finalDelays,
    frames,
  };
}

function processVideo(buf) {
  if (!ffmpegPath) throw new Error("ffmpeg not available — install ffmpeg-static");

  const tmpDir = path.join("/tmp", "vid_" + Date.now() + "_" + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmpDir, { recursive: true });
  const inputPath = path.join(tmpDir, "input");
  fs.writeFileSync(inputPath, buf);

  try {
    // Probe
    let probeOut = "";
    try {
      probeOut = execSync(`${ffmpegPath} -i ${inputPath} -f null - 2>&1`, {
        encoding: "utf8",
        timeout: 5000,
      });
    } catch (e) {
      probeOut = (e.stderr || e.stdout || e.message || "").toString();
    }

    // Duration
    let duration = 10;
    const durMatch = probeOut.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (durMatch) {
      duration =
        parseInt(durMatch[1]) * 3600 +
        parseInt(durMatch[2]) * 60 +
        parseInt(durMatch[3]) +
        parseInt(durMatch[4]) / 100;
    }
    duration = Math.min(duration, MAX_DURATION);

    // Dimensions
    const dimMatch = probeOut.match(/,\s*(\d{2,5})x(\d{2,5})/);
    let srcW = 320,
      srcH = 240;
    if (dimMatch) {
      srcW = parseInt(dimMatch[1]);
      srcH = parseInt(dimMatch[2]);
    }

    let outW = srcW,
      outH = srcH;
    if (outW > MAX_RES || outH > MAX_RES) {
      const scale = Math.min(MAX_RES / outW, MAX_RES / outH);
      outW = Math.round(outW * scale);
      outH = Math.round(outH * scale);
    }
    outW = outW % 2 === 1 ? outW + 1 : outW;
    outH = outH % 2 === 1 ? outH + 1 : outH;
    outW = Math.max(2, outW);
    outH = Math.max(2, outH);

    const fps = MAX_FPS;
    const rawPath = path.join(tmpDir, "out.raw");

    execSync(
      `${ffmpegPath} -y -i ${inputPath} -t ${duration} ` +
        `-vf "scale=${outW}:${outH},fps=${fps}" ` +
        `-pix_fmt rgba -f rawvideo ${rawPath}`,
      { timeout: 8000 } // leave headroom for Vercel's 10s limit
    );

    if (!fs.existsSync(rawPath)) throw new Error("ffmpeg produced no output");
    const rawData = fs.readFileSync(rawPath);
    const frameBytes = outW * outH * 4;
    let actualFrames = Math.floor(rawData.length / frameBytes);
    actualFrames = Math.min(actualFrames, MAX_FRAMES);

    if (actualFrames === 0) throw new Error("No frames extracted");

    const delayMs = Math.round(1000 / fps);
    const frames = [];
    const delays = [];
    for (let i = 0; i < actualFrames; i++) {
      const offset = i * frameBytes;
      const frameBuf = Buffer.alloc(frameBytes);
      rawData.copy(frameBuf, 0, offset, offset + frameBytes);
      frames.push(frameBuf);
      delays.push(delayMs);
    }

    return { width: outW, height: outH, frameCount: actualFrames, delays, frames };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { url, batch } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  try {
    cleanCache();
    let cached = cache.get(url);

    if (!cached) {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) throw new Error(`Source HTTP ${resp.status}`);

      const buf = Buffer.from(await resp.arrayBuffer());

      let isAnimated = false;
      try {
        const meta = await sharp(buf).metadata();
        if (meta.pages && meta.pages > 1) isAnimated = true;
      } catch {}

      let result;
      if (isAnimated) {
        result = await processGif(buf);
      } else {
        result = processVideo(buf);
      }

      const frameBytes = result.width * result.height * 4;
      const framesPerBatch = Math.max(1, Math.floor(4000000 / frameBytes));

      cached = {
        ...result,
        framesPerBatch,
        totalBatches: Math.ceil(result.frameCount / framesPerBatch),
        time: Date.now(),
      };
      cache.set(url, cached);
    } else {
      cached.time = Date.now();
    }

    // Info mode
    if (batch === undefined) {
      return res.json({
        width: cached.width,
        height: cached.height,
        frameCount: cached.frameCount,
        delays: cached.delays,
        framesPerBatch: cached.framesPerBatch,
        totalBatches: cached.totalBatches,
      });
    }

    // Batch mode
    const bi = parseInt(batch);
    if (isNaN(bi) || bi < 0 || bi >= cached.totalBatches)
      throw new Error("Batch out of range");

    const start = bi * cached.framesPerBatch;
    const end = Math.min(start + cached.framesPerBatch, cached.frameCount);
    const count = end - start;
    const frameBytes = cached.width * cached.height * 4;

    const out = Buffer.alloc(4 + frameBytes * count);
    out.writeUInt32LE(count, 0);
    let offset = 4;
    for (let i = start; i < end; i++) {
      cached.frames[i].copy(out, offset, 0, frameBytes);
      offset += frameBytes;
    }

    res.setHeader("Content-Type", "application/octet-stream");
    return res.send(out);
  } catch (e) {
    console.error("frames error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
