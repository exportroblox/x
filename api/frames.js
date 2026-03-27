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

const MAX_RAW_PER_REQUEST = 4000000; // 4MB response limit
const DEFAULT_DELAY = 100;
const SEGMENT_DURATION = 3; // seconds per segment — safe for 10s timeout

function clampEven(n) {
  n = Math.max(2, Math.round(n));
  return n % 2 === 1 ? n + 1 : n;
}

// ── GIF: self-contained, no caching needed ──

async function processGif(buf, userMaxRes) {
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

  // Memory guard
  let frameBytes = resizeW * resizeH * 4;
  while (frameBytes * pages > 500 * 1024 * 1024 && (resizeW > 64 || resizeH > 64)) {
    resizeW = Math.round(resizeW * 0.7);
    resizeH = Math.round(resizeH * 0.7);
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
  const frameH = Math.round(info.height / pages);
  frameBytes = frameW * frameH * 4;

  const frames = [];
  const finalDelays = [];
  for (let i = 0; i < pages; i++) {
    const offset = i * frameBytes;
    if (offset + frameBytes > rawAll.length) break;
    const frameBuf = Buffer.alloc(frameBytes);
    rawAll.copy(frameBuf, 0, offset, offset + frameBytes);
    frames.push(frameBuf);
    finalDelays.push(delays[i]);
  }

  return {
    type: "gif_complete",
    width: frameW,
    height: frameH,
    srcWidth: meta.width,
    srcHeight: pageHeight,
    frameCount: frames.length,
    delays: finalDelays,
    frames,
  };
}

// ── Video: probe only ──

function probeVideo(buf) {
  if (!ffmpegPath) throw new Error("ffmpeg not available");

  const tmpDir = path.join("/tmp", "probe_" + Date.now() + "_" + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmpDir, { recursive: true });
  const inputPath = path.join(tmpDir, "input");
  fs.writeFileSync(inputPath, buf);

  try {
    let probeOut = "";
    try {
      probeOut = execSync(`${ffmpegPath} -i ${inputPath} 2>&1`, {
        encoding: "utf8",
        timeout: 3000,
      });
    } catch (e) {
      probeOut = (e.stderr || e.stdout || e.message || "").toString();
    }

    let duration = 10;
    const durMatch = probeOut.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (durMatch) {
      duration =
        parseInt(durMatch[1]) * 3600 +
        parseInt(durMatch[2]) * 60 +
        parseInt(durMatch[3]) +
        parseInt(durMatch[4]) / 100;
    }

    const dimMatch = probeOut.match(/,\s*(\d{2,5})x(\d{2,5})/);
    let srcW = 640, srcH = 480;
    if (dimMatch) {
      srcW = parseInt(dimMatch[1]);
      srcH = parseInt(dimMatch[2]);
    }

    let srcFps = 30;
    const fpsMatch = probeOut.match(/(\d+(?:\.\d+)?)\s*fps/);
    if (fpsMatch) srcFps = parseFloat(fpsMatch[1]);

    return { duration, srcW, srcH, srcFps };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Video: extract one time segment ──

function extractSegment(buf, startTime, segDuration, outW, outH, fps) {
  const tmpDir = path.join("/tmp", "seg_" + Date.now() + "_" + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmpDir, { recursive: true });
  const inputPath = path.join(tmpDir, "input");
  const rawPath = path.join(tmpDir, "out.raw");
  fs.writeFileSync(inputPath, buf);

  try {
    execSync(
      `${ffmpegPath} -y -ss ${startTime.toFixed(3)} -i ${inputPath} -t ${segDuration.toFixed(3)} ` +
        `-vf "scale=${outW}:${outH},fps=${fps}" ` +
        `-pix_fmt rgba -f rawvideo ${rawPath}`,
      { timeout: 8000 }
    );

    if (!fs.existsSync(rawPath)) return [];

    const rawData = fs.readFileSync(rawPath);
    const frameBytes = outW * outH * 4;
    const count = Math.floor(rawData.length / frameBytes);

    const frames = [];
    for (let i = 0; i < count; i++) {
      const offset = i * frameBytes;
      const frameBuf = Buffer.alloc(frameBytes);
      rawData.copy(frameBuf, 0, offset, offset + frameBytes);
      frames.push(frameBuf);
    }
    return frames;
  } catch (e) {
    console.error("segment extract error:", e.message);
    return [];
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { url, segment, maxres, maxfps } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  try {
    // Download source
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`Source HTTP ${resp.status}`);

    const buf = Buffer.from(await resp.arrayBuffer());

    // Check if animated image
    let isAnimated = false;
    try {
      const meta = await sharp(buf).metadata();
      if (meta.pages && meta.pages > 1) isAnimated = true;
    } catch {}

    // ── GIF: return everything at once ──
    if (isAnimated) {
      const result = await processGif(buf, maxres ? parseInt(maxres) : undefined);
      const frameBytes = result.width * result.height * 4;
      const framesPerBatch = Math.max(1, Math.floor(MAX_RAW_PER_REQUEST / frameBytes));
      const totalBatches = Math.ceil(result.frameCount / framesPerBatch);

      // If requesting a specific batch
      if (segment !== undefined) {
        const si = parseInt(segment);
        const start = si * framesPerBatch;
        const end = Math.min(start + framesPerBatch, result.frameCount);
        const count = end - start;

        const out = Buffer.alloc(4 + frameBytes * count);
        out.writeUInt32LE(count, 0);
        let offset = 4;
        for (let i = start; i < end; i++) {
          result.frames[i].copy(out, offset, 0, frameBytes);
          offset += frameBytes;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        return res.send(out);
      }

      // Info response
      return res.json({
        format: "gif",
        width: result.width,
        height: result.height,
        srcWidth: result.srcWidth,
        srcHeight: result.srcHeight,
        srcFps: 0,
        frameCount: result.frameCount,
        delays: result.delays,
        totalSegments: totalBatches,
      });
    }

    // ── Video ──

    // Info mode
    if (segment === undefined) {
      const probe = probeVideo(buf);

      let outW = probe.srcW;
      let outH = probe.srcH;
      const userMaxRes = maxres ? parseInt(maxres) : undefined;
      if (userMaxRes && (outW > userMaxRes || outH > userMaxRes)) {
        const scale = Math.min(userMaxRes / outW, userMaxRes / outH);
        outW = Math.round(outW * scale);
        outH = Math.round(outH * scale);
      }
      // Memory guard: max ~4MB per frame
      while (outW * outH * 4 > 4 * 1024 * 1024) {
        outW = Math.round(outW * 0.8);
        outH = Math.round(outH * 0.8);
      }
      outW = clampEven(outW);
      outH = clampEven(outH);

      const fps = maxfps ? Math.min(parseInt(maxfps), probe.srcFps) : Math.min(30, probe.srcFps);
      const totalSegments = Math.ceil(probe.duration / SEGMENT_DURATION);
      const estFrames = Math.ceil(probe.duration * fps);

      // Build delays array
      const delayMs = Math.round(1000 / fps);
      const delays = [];
      for (let i = 0; i < estFrames; i++) delays.push(delayMs);

      return res.json({
        format: "video",
        width: outW,
        height: outH,
        srcWidth: probe.srcW,
        srcHeight: probe.srcH,
        srcFps: Math.round(probe.srcFps),
        fps,
        duration: probe.duration,
        frameCount: estFrames,
        delays,
        totalSegments,
        segmentDuration: SEGMENT_DURATION,
      });
    }

    // Segment mode — extract just this time range
    const si = parseInt(segment);
    const probe = probeVideo(buf);

    let outW = probe.srcW;
    let outH = probe.srcH;
    const userMaxRes = maxres ? parseInt(maxres) : undefined;
    if (userMaxRes && (outW > userMaxRes || outH > userMaxRes)) {
      const scale = Math.min(userMaxRes / outW, userMaxRes / outH);
      outW = Math.round(outW * scale);
      outH = Math.round(outH * scale);
    }
    while (outW * outH * 4 > 4 * 1024 * 1024) {
      outW = Math.round(outW * 0.8);
      outH = Math.round(outH * 0.8);
    }
    outW = clampEven(outW);
    outH = clampEven(outH);

    const fps = maxfps ? Math.min(parseInt(maxfps), probe.srcFps) : Math.min(30, probe.srcFps);
    const startTime = si * SEGMENT_DURATION;
    const segDur = Math.min(SEGMENT_DURATION, probe.duration - startTime);

    if (segDur <= 0) {
      // Empty segment
      const out = Buffer.alloc(4);
      out.writeUInt32LE(0, 0);
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(out);
    }

    const frames = extractSegment(buf, startTime, segDur, outW, outH, fps);
    const frameBytes = outW * outH * 4;

    const out = Buffer.alloc(4 + frameBytes * frames.length);
    out.writeUInt32LE(frames.length, 0);
    let offset = 4;
    for (const frame of frames) {
      frame.copy(out, offset, 0, frameBytes);
      offset += frameBytes;
    }

    res.setHeader("Content-Type", "application/octet-stream");
    return res.send(out);
  } catch (e) {
    console.error("frames error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
