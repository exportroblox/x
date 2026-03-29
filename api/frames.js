const sharp = require("sharp");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let ffmpegPath;
try { ffmpegPath = require("ffmpeg-static"); } catch { ffmpegPath = null; }

const MAX_VIDEO_DIM = 480;
const MAX_VIDEO_FPS = 30;
const MAX_GIF_DIM = 512;
const MAX_RESPONSE = 4500000;
const DEFAULT_DELAY = 100;

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

function urlHash(url) {
  return crypto.createHash("md5").update(url).digest("hex");
}

// ─── /tmp cache: survives across requests on same Vercel instance ───
function getCacheDir(url) {
  return path.join("/tmp", "vc_" + urlHash(url));
}

function readMeta(cacheDir) {
  const p = path.join(cacheDir, "meta.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function writeMeta(cacheDir, meta) {
  fs.writeFileSync(path.join(cacheDir, "meta.json"), JSON.stringify(meta));
}

// Download source once, cache in /tmp
async function ensureSource(url) {
  const cacheDir = getCacheDir(url);
  const srcPath = path.join(cacheDir, "src");

  if (fs.existsSync(srcPath)) {
    return { cacheDir, srcPath, buf: null };
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new Error(`Source HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(srcPath, buf);
  return { cacheDir, srcPath, buf };
}

function getSourceBuf(srcPath, cached) {
  if (cached) return cached;
  return fs.readFileSync(srcPath);
}

// ─── GIF processing (process all frames once, cache) ───
async function ensureGifProcessed(url) {
  const { cacheDir, srcPath, buf: dlBuf } = await ensureSource(url);
  const meta = readMeta(cacheDir);
  if (meta && meta.format === "gif") return { cacheDir, meta };

  const buf = getSourceBuf(srcPath, dlBuf);
  const sharpMeta = await sharp(buf, { pages: -1 }).metadata();
  const pages = sharpMeta.pages || 1;
  const pageH = sharpMeta.pageHeight || sharpMeta.height;
  const delays = [];
  for (let i = 0; i < pages; i++) delays.push(sharpMeta.delay?.[i] || DEFAULT_DELAY);

  let { w, h } = fitSize(sharpMeta.width, pageH, MAX_GIF_DIM);
  let fb = w * h * 4;
  while (fb * pages > 400 * 1024 * 1024 && w > 64) {
    w = clampEven(Math.round(w * 0.7));
    h = clampEven(Math.round(h * 0.7));
    fb = w * h * 4;
  }

  const { data, info } = await sharp(buf, { pages: -1 })
    .resize(w, h, { fit: "fill" }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });

  const frameW = info.width, frameH = Math.round(info.height / pages);
  fb = frameW * frameH * 4;
  const frameCount = Math.min(pages, Math.floor(data.length / fb));

  // Write all raw frame data to single file
  const rawPath = path.join(cacheDir, "frames.raw");
  fs.writeFileSync(rawPath, data.subarray(0, frameCount * fb));

  const framesPerSeg = Math.max(1, Math.floor(MAX_RESPONSE / fb));

  const gifMeta = {
    format: "gif", width: frameW, height: frameH, fb,
    frameCount, delays: delays.slice(0, frameCount),
    framesPerSeg, totalSegments: Math.ceil(frameCount / framesPerSeg),
  };
  writeMeta(cacheDir, gifMeta);
  return { cacheDir, meta: gifMeta };
}

// ─── Video: probe once, process ALL frames once with single ffmpeg call ───
async function ensureVideoProcessed(url) {
  const { cacheDir, srcPath } = await ensureSource(url);
  const meta = readMeta(cacheDir);
  if (meta && meta.format === "video") {
    const rawPath = path.join(cacheDir, "frames.raw");
    if (fs.existsSync(rawPath)) return { cacheDir, meta };
  }

  if (!ffmpegPath) throw new Error("ffmpeg not available");

  // Probe
  let probe = "";
  try {
    probe = execSync(`${ffmpegPath} -i ${srcPath} 2>&1`, { encoding: "utf8", timeout: 5000 });
  } catch (e) {
    probe = (e.stderr || e.stdout || e.message || "").toString();
  }

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
  const rawPath = path.join(cacheDir, "frames.raw");
  execSync(
    `${ffmpegPath} -y -i ${srcPath} ` +
    `-vf "scale=${outW}:${outH}:flags=bilinear,fps=${fps}" ` +
    `-pix_fmt rgba -f rawvideo ${rawPath}`,
    { timeout: 25000, maxBuffer: 10 * 1024 * 1024 }
  );

  if (!fs.existsSync(rawPath)) throw new Error("FFmpeg produced no output");

  const rawSize = fs.statSync(rawPath).size;
  const frameCount = Math.floor(rawSize / fb);
  if (frameCount === 0) throw new Error("No frames extracted");

  const delayMs = Math.round(1000 / fps);
  const framesPerSeg = Math.max(1, Math.floor(MAX_RESPONSE / fb));

  const videoMeta = {
    format: "video", width: outW, height: outH, fps, duration: dur, fb,
    frameCount, delays: Array(frameCount).fill(delayMs),
    framesPerSeg, totalSegments: Math.ceil(frameCount / framesPerSeg),
  };
  writeMeta(cacheDir, videoMeta);
  return { cacheDir, meta: videoMeta };
}

// ─── Unified handler: images too ───
async function ensureImageProcessed(url) {
  const { cacheDir, srcPath, buf: dlBuf } = await ensureSource(url);
  const meta = readMeta(cacheDir);
  if (meta && meta.format === "image") return { cacheDir, meta };

  const buf = getSourceBuf(srcPath, dlBuf);
  const TARGET = 4096;
  let pipeline = sharp(buf).ensureAlpha();
  const sharpMeta = await sharp(buf).metadata();

  if (sharpMeta.width > TARGET || sharpMeta.height > TARGET)
    pipeline = pipeline.resize(TARGET, TARGET, { fit: "inside", withoutEnlargement: true });

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });

  const rawPath = path.join(cacheDir, "image.raw");
  fs.writeFileSync(rawPath, data);

  const imgMeta = {
    format: "image", width: info.width, height: info.height,
    fb: info.width * info.height * 4, totalSegments: 1,
  };
  writeMeta(cacheDir, imgMeta);
  return { cacheDir, meta: imgMeta };
}

// ─── Detect type and process ───
async function ensureProcessed(url) {
  const cacheDir = getCacheDir(url);
  const existing = readMeta(cacheDir);
  if (existing) {
    const rawFile = existing.format === "image" ? "image.raw" : "frames.raw";
    if (fs.existsSync(path.join(cacheDir, rawFile))) {
      return { cacheDir, meta: existing };
    }
  }

  // Download source
  const { srcPath, buf: dlBuf } = await ensureSource(url);
  const buf = getSourceBuf(srcPath, dlBuf);

  // Detect type
  let sharpMeta;
  try { sharpMeta = await sharp(buf).metadata(); } catch { sharpMeta = null; }

  if (sharpMeta && sharpMeta.pages && sharpMeta.pages > 1) {
    return await ensureGifProcessed(url);
  }

  if (sharpMeta && sharpMeta.width && sharpMeta.height) {
    return await ensureImageProcessed(url);
  }

  return await ensureVideoProcessed(url);
}

// ─── Main handler ───
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  const { url, segment } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  try {
    const { cacheDir, meta } = await ensureProcessed(url);

    // ── Probe (no segment) ──
    if (segment === undefined) {
      return res.json({
        format: meta.format,
        width: meta.width,
        height: meta.height,
        fps: meta.fps || 0,
        duration: meta.duration || 0,
        frameCount: meta.frameCount || 1,
        delays: meta.delays || [0],
        totalSegments: meta.totalSegments,
      });
    }

    const si = parseInt(segment);

    // ── Image ──
    if (meta.format === "image") {
      const rawPath = path.join(cacheDir, "image.raw");
      const data = fs.readFileSync(rawPath);
      const header = Buffer.alloc(8);
      header.writeUInt32LE(meta.width, 0);
      header.writeUInt32LE(meta.height, 4);
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(Buffer.concat([header, data]));
    }

    // ── Video / GIF segments: just read slice from cached raw file ──
    const rawPath = path.join(cacheDir, "frames.raw");
    const start = si * meta.framesPerSeg;
    const end2 = Math.min(start + meta.framesPerSeg, meta.frameCount);
    const count = end2 - start;

    if (count <= 0) {
      const out = Buffer.alloc(4);
      out.writeUInt32LE(0, 0);
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(out);
    }

    const payloadBytes = meta.fb * count;
    const out = Buffer.alloc(4 + payloadBytes);
    out.writeUInt32LE(count, 0);

    // Read just the slice we need (not the entire file)
    const fd = fs.openSync(rawPath, "r");
    fs.readSync(fd, out, 4, payloadBytes, start * meta.fb);
    fs.closeSync(fd);

    res.setHeader("Content-Type", "application/octet-stream");
    return res.send(out);

  } catch (e) {
    console.error("frames:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
