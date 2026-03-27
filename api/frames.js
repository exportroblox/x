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

// Hard limits (Vercel constraints)
const VERCEL_TIMEOUT = 9;       // seconds, leave 1s headroom
const VERCEL_MEMORY = 1024;     // MB
const MAX_RAW_BYTES = 800 * 1024 * 1024; // 800MB raw frame budget
const BATCH_TARGET = 500000;    // 500KB per batch response
const DEFAULT_DELAY = 100;

const cache = new Map();
const CACHE_TTL = 180000;

function cleanCache() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.time > CACHE_TTL) cache.delete(key);
  }
}

function clampEven(n) {
  n = Math.max(2, Math.round(n));
  return n % 2 === 1 ? n + 1 : n;
}

// Calculate the best resolution and fps that fits in memory and time
function calcSettings(srcW, srcH, srcFps, duration, userMaxRes, userMaxFps) {
  let fps = Math.min(srcFps || 30, userMaxFps || 30);
  let totalFrames = Math.ceil(duration * fps);

  let outW = srcW;
  let outH = srcH;

  // Scale down if user requested max res
  if (userMaxRes && (outW > userMaxRes || outH > userMaxRes)) {
    const scale = Math.min(userMaxRes / outW, userMaxRes / outH);
    outW = Math.round(outW * scale);
    outH = Math.round(outH * scale);
  }

  // Check if total raw bytes fit in memory
  let frameBytes = outW * outH * 4;
  let totalBytes = frameBytes * totalFrames;

  // If too much, reduce resolution first
  while (totalBytes > MAX_RAW_BYTES && (outW > 64 || outH > 64)) {
    outW = Math.round(outW * 0.8);
    outH = Math.round(outH * 0.8);
    frameBytes = outW * outH * 4;
    totalBytes = frameBytes * totalFrames;
  }

  // If still too much, reduce fps
  while (totalBytes > MAX_RAW_BYTES && fps > 5) {
    fps = Math.max(5, fps - 5);
    totalFrames = Math.ceil(duration * fps);
    totalBytes = frameBytes * totalFrames;
  }

  outW = clampEven(outW);
  outH = clampEven(outH);

  return { outW, outH, fps, totalFrames };
}

async function processGif(buf, userMaxRes, userMaxFps) {
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

  if (userMaxRes && (resizeW > userMaxRes || resizeH > userMaxRes)) {
    const scale = Math.min(userMaxRes / resizeW, userMaxRes / resizeH);
    resizeW = Math.round(resizeW * scale);
    resizeH = Math.round(resizeH * scale);
  }

  // Check memory
  let frameBytes = resizeW * resizeH * 4;
  while (frameBytes * pages > MAX_RAW_BYTES && (resizeW > 64 || resizeH > 64)) {
    resizeW = Math.round(resizeW * 0.8);
    resizeH = Math.round(resizeH * 0.8);
    frameBytes = resizeW * resizeH * 4;
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
  frameBytes = frameW * frameH * 4;

  // Subsample by fps if requested
  let step = 1;
  if (userMaxFps && delays.length > 0) {
    const avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
    const srcFps = 1000 / Math.max(10, avgDelay);
    if (userMaxFps < srcFps) {
      step = Math.max(1, Math.round(srcFps / userMaxFps));
    }
  }

  const frames = [];
  const finalDelays = [];
  for (let i = 0; i < pages; i += step) {
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
    srcWidth: meta.width,
    srcHeight: pageHeight,
    srcFps: Math.round(1000 / (delays[0] || 100)),
    frameCount: frames.length,
    delays: finalDelays,
    frames,
  };
}

function processVideo(buf, userMaxRes, userMaxFps) {
  if (!ffmpegPath) throw new Error("ffmpeg not available — install ffmpeg-static");

  const tmpDir = path.join(
    "/tmp",
    "vid_" + Date.now() + "_" + Math.random().toString(36).slice(2)
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  const inputPath = path.join(tmpDir, "input");
  fs.writeFileSync(inputPath, buf);

  try {
    // Probe
    let probeOut = "";
    try {
      probeOut = execSync(`${ffmpegPath} -i ${inputPath} 2>&1`, {
        encoding: "utf8",
        timeout: 3000,
      });
    } catch (e) {
      probeOut = (e.stderr || e.stdout || e.message || "").toString();
    }

    // Duration
    let duration = 30;
    const durMatch = probeOut.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (durMatch) {
      duration =
        parseInt(durMatch[1]) * 3600 +
        parseInt(durMatch[2]) * 60 +
        parseInt(durMatch[3]) +
        parseInt(durMatch[4]) / 100;
    }

    // Source dimensions
    const dimMatch = probeOut.match(/,\s*(\d{2,5})x(\d{2,5})/);
    let srcW = 640, srcH = 480;
    if (dimMatch) {
      srcW = parseInt(dimMatch[1]);
      srcH = parseInt(dimMatch[2]);
    }

    // Source FPS
    let srcFps = 30;
    const fpsMatch = probeOut.match(/(\d+(?:\.\d+)?)\s*fps/);
    if (fpsMatch) {
      srcFps = parseFloat(fpsMatch[1]);
    }

    // Calculate optimal settings
    const settings = calcSettings(
      srcW, srcH, srcFps, duration,
      userMaxRes || srcW,  // if no max, use source
      userMaxFps || srcFps // if no max, use source
    );

    const { outW, outH, fps, totalFrames } = settings;
    const rawPath = path.join(tmpDir, "out.raw");

    // Calculate timeout: give ffmpeg proportional time but cap it
    const ffmpegTimeout = Math.min(
      Math.max(Math.ceil(duration * 1.5), 5) * 1000,
      VERCEL_TIMEOUT * 1000
    );

    execSync(
      `${ffmpegPath} -y -i ${inputPath} -t ${duration} ` +
        `-vf "scale=${outW}:${outH},fps=${fps}" ` +
        `-pix_fmt rgba -f rawvideo ${rawPath}`,
      { timeout: ffmpegTimeout }
    );

    if (!fs.existsSync(rawPath)) throw new Error("ffmpeg produced no output");
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

    return {
      width: outW,
      height: outH,
      srcWidth: srcW,
      srcHeight: srcH,
      srcFps: Math.round(srcFps),
      frameCount: actualFrames,
      delays,
      frames,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { url, batch, maxres, maxfps } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  const userMaxRes = maxres ? parseInt(maxres) : undefined;
  const userMaxFps = maxfps ? parseInt(maxfps) : undefined;

  // Cache key includes quality settings
  const cacheKey = `${url}|${userMaxRes || "auto"}|${userMaxFps || "auto"}`;

  try {
    cleanCache();
    let cached = cache.get(cacheKey);

    if (!cached) {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(4000),
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
        result = await processGif(buf, userMaxRes, userMaxFps);
      } else {
        result = processVideo(buf, userMaxRes, userMaxFps);
      }

      const frameBytes = result.width * result.height * 4;
      const framesPerBatch = Math.max(1, Math.floor(BATCH_TARGET / frameBytes));

      cached = {
        ...result,
        framesPerBatch,
        totalBatches: Math.ceil(result.frameCount / framesPerBatch),
        time: Date.now(),
      };
      cache.set(cacheKey, cached);
    } else {
      cached.time = Date.now();
    }

    if (batch === undefined) {
      return res.json({
        width: cached.width,
        height: cached.height,
        srcWidth: cached.srcWidth,
        srcHeight: cached.srcHeight,
        srcFps: cached.srcFps,
        frameCount: cached.frameCount,
        delays: cached.delays,
        framesPerBatch: cached.framesPerBatch,
        totalBatches: cached.totalBatches,
      });
    }

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
