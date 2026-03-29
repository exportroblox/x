const sharp = require("sharp");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let ffmpegPath;
try { ffmpegPath = require("ffmpeg-static"); } catch { ffmpegPath = null; }

const MAX_VIDEO_DIM = 450;
const MAX_VIDEO_FPS = 30;
const MAX_GIF_DIM = 512;
const MAX_RESPONSE = 4500000;
const DEFAULT_DELAY = 100;
const MAX_VIDEO_DURATION = 300;

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

function getCacheDir(url) {
  const d = path.join("/tmp", "vc_" + urlHash(url));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readMeta(cacheDir) {
  const p = path.join(cacheDir, "meta.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function writeMeta(cacheDir, meta) {
  fs.writeFileSync(path.join(cacheDir, "meta.json"), JSON.stringify(meta));
}

// Clean old cache dirs (keep /tmp from filling up)
function cleanOldCache() {
  try {
    const now = Date.now();
    const entries = fs.readdirSync("/tmp").filter(f => f.startsWith("vc_"));
    for (const e of entries) {
      const full = path.join("/tmp", e);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > 10 * 60 * 1000) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

// Download source once
async function ensureSource(url) {
  const cacheDir = getCacheDir(url);
  const srcPath = path.join(cacheDir, "src");
  if (fs.existsSync(srcPath) && fs.statSync(srcPath).size > 0) {
    return { cacheDir, srcPath };
  }
  cleanOldCache();
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Source HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(srcPath, buf);
  return { cacheDir, srcPath };
}

// Detect what type of media this is
async function detectType(srcPath) {
  const buf = fs.readFileSync(srcPath);
  try {
    const meta = await sharp(buf).metadata();
    if (meta && meta.pages && meta.pages > 1) return "gif";
    if (meta && meta.width && meta.height) return "image";
  } catch {}
  return "video";
}

// Process GIF
async function processGif(cacheDir, srcPath) {
  const buf = fs.readFileSync(srcPath);
  const sharpMeta = await sharp(buf, { pages: -1 }).metadata();
  const pages = sharpMeta.pages || 1;
  const pageH = sharpMeta.pageHeight || sharpMeta.height;
  const delays = [];
  for (let i = 0; i < pages; i++) delays.push(sharpMeta.delay?.[i] || DEFAULT_DELAY);

  let { w, h } = fitSize(sharpMeta.width, pageH, MAX_GIF_DIM);
  let fb = w * h * 4;
  while (fb * pages > 300 * 1024 * 1024 && w > 64) {
    w = clampEven(Math.round(w * 0.7)); h = clampEven(Math.round(h * 0.7)); fb = w * h * 4;
  }

  const { data, info } = await sharp(buf, { pages: -1 })
    .resize(w, h, { fit: "fill" }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });

  const frameW = info.width, frameH = Math.round(info.height / pages);
  fb = frameW * frameH * 4;
  const frameCount = Math.min(pages, Math.floor(data.length / fb));

  const rawPath = path.join(cacheDir, "frames.raw");
  fs.writeFileSync(rawPath, data.subarray(0, frameCount * fb));

  const framesPerSeg = Math.max(1, Math.floor(MAX_RESPONSE / fb));
  const meta = {
    format: "gif", width: frameW, height: frameH, fb, frameCount,
    delays: delays.slice(0, frameCount),
    framesPerSeg, totalSegments: Math.ceil(frameCount / framesPerSeg),
  };
  writeMeta(cacheDir, meta);
  return meta;
}

// Process static image
async function processImage(cacheDir, srcPath) {
  const buf = fs.readFileSync(srcPath);
  const TARGET = 4096;
  let pipeline = sharp(buf).ensureAlpha();
  const sharpMeta = await sharp(buf).metadata();
  if (sharpMeta.width > TARGET || sharpMeta.height > TARGET)
    pipeline = pipeline.resize(TARGET, TARGET, { fit: "inside", withoutEnlargement: true });

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });

  const rawPath = path.join(cacheDir, "image.raw");
  fs.writeFileSync(rawPath, data);

  const meta = {
    format: "image", width: info.width, height: info.height,
    fb: info.width * info.height * 4, totalSegments: 1,
  };
  writeMeta(cacheDir, meta);
  return meta;
}

// Process video — fast settings to fit in Vercel time limit
async function processVideo(cacheDir, srcPath) {
  if (!ffmpegPath) throw new Error("ffmpeg not available");

  // Probe
  let probe = "";
  try {
    probe = execSync(`${ffmpegPath} -i ${srcPath} 2>&1`, { encoding: "utf8", timeout: 4000 });
  } catch (e) {
    probe = (e.stderr || e.stdout || e.message || "").toString();
  }

  let dur = 10;
  const dm = probe.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (dm) dur = +dm[1] * 3600 + +dm[2] * 60 + +dm[3] + +dm[4] / 100;

  // Cap duration for Vercel time limits
  dur = Math.min(dur, MAX_VIDEO_DURATION);

  const sm = probe.match(/,\s*(\d{2,5})x(\d{2,5})/);
  let sw = 640, sh = 480;
  if (sm) { sw = +sm[1]; sh = +sm[2]; }

  let sf = 30;
  const fm = probe.match(/(\d+(?:\.\d+)?)\s*fps/);
  if (fm) sf = parseFloat(fm[1]);

  const fps = Math.min(MAX_VIDEO_FPS, Math.round(sf));
  const { w: outW, h: outH } = fitSize(sw, sh, MAX_VIDEO_DIM);
  const fb = outW * outH * 4;

  const rawPath = path.join(cacheDir, "frames.raw");

  // Use fast bilinear scaling, limit duration
  execSync(
    `${ffmpegPath} -y -t ${dur.toFixed(3)} -i ${srcPath} ` +
    `-vf "scale=${outW}:${outH}:flags=bilinear,fps=${fps}" ` +
    `-pix_fmt rgba -f rawvideo ${rawPath}`,
    { timeout: 22000, maxBuffer: 10 * 1024 * 1024 }
  );

  if (!fs.existsSync(rawPath)) throw new Error("FFmpeg produced no output");

  const rawSize = fs.statSync(rawPath).size;
  const frameCount = Math.floor(rawSize / fb);
  if (frameCount === 0) throw new Error("No frames");

  const delayMs = Math.round(1000 / fps);
  const framesPerSeg = Math.max(1, Math.floor(MAX_RESPONSE / fb));

  const meta = {
    format: "video", width: outW, height: outH, fps, duration: dur, fb,
    frameCount, delays: Array(frameCount).fill(delayMs),
    framesPerSeg, totalSegments: Math.ceil(frameCount / framesPerSeg),
  };
  writeMeta(cacheDir, meta);
  return meta;
}

// Main: ensure fully processed
async function ensureProcessed(url) {
  const { cacheDir, srcPath } = await ensureSource(url);

  // Check if already processed
  const existing = readMeta(cacheDir);
  if (existing) {
    const rawFile = existing.format === "image" ? "image.raw" : "frames.raw";
    if (fs.existsSync(path.join(cacheDir, rawFile))) {
      return { cacheDir, meta: existing };
    }
  }

  // Detect and process
  const type = await detectType(srcPath);
  let meta;
  if (type === "gif") meta = await processGif(cacheDir, srcPath);
  else if (type === "image") meta = await processImage(cacheDir, srcPath);
  else meta = await processVideo(cacheDir, srcPath);

  return { cacheDir, meta };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  const { url, segment } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  try {
    const { cacheDir, meta } = await ensureProcessed(url);

    // Probe
    if (segment === undefined) {
      return res.json({
        format: meta.format,
        width: meta.width, height: meta.height,
        fps: meta.fps || 0, duration: meta.duration || 0,
        frameCount: meta.frameCount || 1,
        delays: meta.delays || [0],
        totalSegments: meta.totalSegments,
      });
    }

    const si = parseInt(segment);

    // Image
    if (meta.format === "image") {
      const rawPath = path.join(cacheDir, "image.raw");
      const data = fs.readFileSync(rawPath);
      const header = Buffer.alloc(8);
      header.writeUInt32LE(meta.width, 0);
      header.writeUInt32LE(meta.height, 4);
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(Buffer.concat([header, data]));
    }

    // Video/GIF segment
    const rawPath = path.join(cacheDir, "frames.raw");
    const start = si * meta.framesPerSeg;
    const end2 = Math.min(start + meta.framesPerSeg, meta.frameCount);
    const count = end2 - start;

    if (count <= 0) {
      const out = Buffer.alloc(4); out.writeUInt32LE(0, 0);
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(out);
    }

    const out = Buffer.alloc(4 + meta.fb * count);
    out.writeUInt32LE(count, 0);

    const fd = fs.openSync(rawPath, "r");
    fs.readSync(fd, out, 4, meta.fb * count, start * meta.fb);
    fs.closeSync(fd);

    res.setHeader("Content-Type", "application/octet-stream");
    return res.send(out);

  } catch (e) {
    console.error("frames:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
