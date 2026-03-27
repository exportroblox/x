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

const MAX_FRAME_DIM = 384;
const MAX_FPS = 24;
const MAX_DURATION = 60;
const DEFAULT_DELAY = 100;
const BATCH_BYTES = 3500000;

const cache = new Map();
const CACHE_TTL = 300000;

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

function fitSize(srcW, srcH, maxDim) {
  let w = srcW, h = srcH;
  if (w > maxDim || h > maxDim) {
    const scale = Math.min(maxDim / w, maxDim / h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  return { w: clampEven(Math.max(2, w)), h: clampEven(Math.max(2, h)) };
}

async function processAnimated(buf) {
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

  let { w, h } = fitSize(meta.width, pageHeight, MAX_FRAME_DIM);

  const { data: rawAll, info } = await sharp(buf, { pages: -1 })
    .resize(w, h, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const frameW = info.width;
  const frameH = Math.round(info.height / pages);
  const frameBytes = frameW * frameH * 4;

  const frames = [];
  const finalDelays = [];
  for (let i = 0; i < pages; i++) {
    const off = i * frameBytes;
    if (off + frameBytes > rawAll.length) break;
    const fb = Buffer.alloc(frameBytes);
    rawAll.copy(fb, 0, off, off + frameBytes);
    frames.push(fb);
    finalDelays.push(delays[i]);
  }

  return { width: frameW, height: frameH, frames, delays: finalDelays };
}

function processVideo(buf) {
  if (!ffmpegPath) throw new Error("ffmpeg not available");

  const tmpDir = path.join("/tmp", "v" + Date.now() + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmpDir, { recursive: true });
  const inp = path.join(tmpDir, "in");
  const out = path.join(tmpDir, "out.raw");
  fs.writeFileSync(inp, buf);

  try {
    let probe = "";
    try {
      probe = execSync(`${ffmpegPath} -i ${inp} 2>&1`, { encoding: "utf8", timeout: 3000 });
    } catch (e) {
      probe = (e.stderr || e.stdout || e.message || "").toString();
    }

    let dur = 10;
    const dm = probe.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (dm) dur = +dm[1] * 3600 + +dm[2] * 60 + +dm[3] + +dm[4] / 100;
    dur = Math.min(dur, MAX_DURATION);

    const sm = probe.match(/,\s*(\d{2,5})x(\d{2,5})/);
    let sw = 640, sh = 480;
    if (sm) { sw = +sm[1]; sh = +sm[2]; }

    let sf = 30;
    const fm = probe.match(/(\d+(?:\.\d+)?)\s*fps/);
    if (fm) sf = parseFloat(fm[1]);

    const fps = Math.min(MAX_FPS, Math.round(sf));
    const { w, h } = fitSize(sw, sh, MAX_FRAME_DIM);

    execSync(
      `${ffmpegPath} -y -i ${inp} -t ${dur} -vf "scale=${w}:${h},fps=${fps}" -pix_fmt rgba -f rawvideo ${out}`,
      { timeout: 9000 }
    );

    if (!fs.existsSync(out)) throw new Error("No output");
    const raw = fs.readFileSync(out);
    const fb = w * h * 4;
    const count = Math.floor(raw.length / fb);
    if (count === 0) throw new Error("No frames");

    const delayMs = Math.round(1000 / fps);
    const frames = [];
    const delays = [];
    for (let i = 0; i < count; i++) {
      const f = Buffer.alloc(fb);
      raw.copy(f, 0, i * fb, (i + 1) * fb);
      frames.push(f);
      delays.push(delayMs);
    }

    return { width: w, height: h, frames, delays };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function getOrProcess(url, buf) {
  cleanCache();
  if (cache.has(url)) {
    const c = cache.get(url);
    c.time = Date.now();
    return c;
  }

  let isAnim = false;
  try {
    const m = sharp(buf).metadata();
    // metadata() is async but we need sync check — use the buffer approach
  } catch {}

  // Try animated first (sync-ish with await in caller)
  return null; // caller handles
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

      let isAnim = false;
      try {
        const meta = await sharp(buf).metadata();
        if (meta.pages && meta.pages > 1) isAnim = true;
      } catch {}

      const result = isAnim ? await processAnimated(buf) : processVideo(buf);

      const frameBytes = result.width * result.height * 4;
      const fpb = Math.max(1, Math.floor(BATCH_BYTES / frameBytes));

      cached = {
        width: result.width,
        height: result.height,
        frameCount: result.frames.length,
        delays: result.delays,
        frames: result.frames,
        framesPerBatch: fpb,
        totalBatches: Math.ceil(result.frames.length / fpb),
        time: Date.now(),
      };
      cache.set(url, cached);
    } else {
      cached.time = Date.now();
    }

    // Info
    if (batch === undefined) {
      return res.json({
        width: cached.width,
        height: cached.height,
        frameCount: cached.frameCount,
        delays: cached.delays,
        totalBatches: cached.totalBatches,
        framesPerBatch: cached.framesPerBatch,
      });
    }

    // Batch
    const bi = parseInt(batch);
    if (isNaN(bi) || bi < 0 || bi >= cached.totalBatches)
      throw new Error("Batch out of range");

    const frameBytes = cached.width * cached.height * 4;
    const start = bi * cached.framesPerBatch;
    const end = Math.min(start + cached.framesPerBatch, cached.frameCount);
    const count = end - start;

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
    console.error("frames:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
