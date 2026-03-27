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

const MAX_RES = 256;
const MAX_FPS = 20;
const MAX_DURATION = 30; // seconds
const DEFAULT_DELAY = 100; // ms

// In-memory cache (same instance reuse)
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

  // Get frame delays
  const delays = [];
  if (meta.delay && Array.isArray(meta.delay)) {
    for (let i = 0; i < pages; i++) {
      delays.push(meta.delay[i] || DEFAULT_DELAY);
    }
  } else {
    for (let i = 0; i < pages; i++) {
      delays.push(DEFAULT_DELAY);
    }
  }

  // Resize all frames at once
  let resizeW = meta.width;
  let resizeH = pageHeight;
  if (resizeW > MAX_RES || resizeH > MAX_RES) {
    const scale = Math.min(MAX_RES / resizeW, MAX_RES / resizeH);
    resizeW = Math.round(resizeW * scale);
    resizeH = Math.round(resizeH * scale);
  }
  // Ensure even
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

  const frames = [];
  for (let i = 0; i < pages; i++) {
    const offset = i * frameBytes;
    const frameBuf = Buffer.alloc(frameBytes);
    rawAll.copy(frameBuf, 0, offset, Math.min(offset + frameBytes, rawAll.length));
    frames.push(frameBuf);
  }

  // Subsample if too many frames
  let finalFrames = frames;
  let finalDelays = delays;
  if (pages > MAX_FPS * MAX_DURATION) {
    const step = Math.ceil(pages / (MAX_FPS * MAX_DURATION));
    finalFrames = [];
    finalDelays = [];
    for (let i = 0; i < pages; i += step) {
      finalFrames.push(frames[i]);
      finalDelays.push(delays[i] * step);
    }
  }

  return {
    width: frameW,
    height: frameH,
    frameCount: finalFrames.length,
    delays: finalDelays,
    frames: finalFrames,
  };
}

function processVideo(buf) {
  if (!ffmpegPath) throw new Error("ffmpeg not available");

  const tmpDir = path.join("/tmp", "vid_" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const inputPath = path.join(tmpDir, "input");
  fs.writeFileSync(inputPath, buf);

  try {
    // Probe
    const probeCmd = `${ffmpegPath} -i ${inputPath} -f null - 2>&1`;
    let probeOut;
    try {
      probeOut = execSync(probeCmd, { encoding: "utf8", timeout: 10000 });
    } catch (e) {
      probeOut = e.stderr || e.stdout || "";
    }

    // Parse duration
    let duration = MAX_DURATION;
    const durMatch = probeOut.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (durMatch) {
      duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 +
        parseInt(durMatch[3]) + parseInt(durMatch[4]) / 100;
    }
    duration = Math.min(duration, MAX_DURATION);

    // Parse dimensions
    const dimMatch = probeOut.match(/(\d{2,5})x(\d{2,5})/);
    let srcW = 320, srcH = 240;
    if (dimMatch) {
      srcW = parseInt(dimMatch[1]);
      srcH = parseInt(dimMatch[2]);
    }

    // Calculate output size
    let outW = srcW, outH = srcH;
    if (outW > MAX_RES || outH > MAX_RES) {
      const scale = Math.min(MAX_RES / outW, MAX_RES / outH);
      outW = Math.round(outW * scale);
      outH = Math.round(outH * scale);
    }
    // ffmpeg needs even dimensions
    outW = outW % 2 === 1 ? outW + 1 : outW;
    outH = outH % 2 === 1 ? outH + 1 : outH;
    outW = Math.max(2, outW);
    outH = Math.max(2, outH);

    const fps = MAX_FPS;
    const totalFrames = Math.min(Math.ceil(duration * fps), MAX_FPS * MAX_DURATION);

    const rawPath = path.join(tmpDir, "out.raw");

    execSync(
      `${ffmpegPath} -y -i ${inputPath} -t ${duration} ` +
      `-vf "scale=${outW}:${outH},fps=${fps}" ` +
      `-pix_fmt rgba -f rawvideo ${rawPath}`,
      { timeout: 25000 }
    );

    const rawData = fs.readFileSync(rawPath);
    const frameBytes = outW * outH * 4;
    const actualFrames = Math.floor(rawData.length / frameBytes);

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

    // Check cache
    let cached = cache.get(url);

    if (!cached) {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) throw new Error(`Source HTTP ${resp.status}`);

      const buf = Buffer.from(await resp.arrayBuffer());

      // Try as animated image first
      let result;
      let isAnimated = false;
      try {
        const meta = await sharp(buf).metadata();
        if (meta.pages && meta.pages > 1) {
          isAnimated = true;
        }
      } catch {}

      if (isAnimated) {
        result = await processGif(buf);
      } else {
        result = processVideo(buf);
      }

      // Calculate batching: ~4MB max per response
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
    if (bi < 0 || bi >= cached.totalBatches)
      throw new Error("Batch out of range");

    const start = bi * cached.framesPerBatch;
    const end = Math.min(start + cached.framesPerBatch, cached.frameCount);
    const count = end - start;
    const frameBytes = cached.width * cached.height * 4;

    // Binary: 4 bytes frameCount + (frameBytes * count)
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
    return res.status(500).json({ error: e.message });
  }
};
