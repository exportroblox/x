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
const MAX_DURATION = 120;
const DEFAULT_DELAY = 100;
const SEGMENT_SECONDS = 5;
const BATCH_BYTES = 3500000;

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

function tmpDir() {
  const d = path.join("/tmp", "f" + Date.now() + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cleanDir(d) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

// GIF: process all at once (small enough)
async function handleGif(buf, batchIdx) {
  const meta = await sharp(buf, { pages: -1 }).metadata();
  const pages = meta.pages || 1;
  const pageHeight = meta.pageHeight || meta.height;

  const delays = [];
  for (let i = 0; i < pages; i++) {
    delays.push(meta.delay?.[i] || DEFAULT_DELAY);
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

  const fpb = Math.max(1, Math.floor(BATCH_BYTES / frameBytes));
  const totalBatches = Math.ceil(frames.length / fpb);

  // Info mode
  if (batchIdx === undefined) {
    return {
      json: {
        mode: "gif",
        width: frameW,
        height: frameH,
        frameCount: frames.length,
        delays: finalDelays,
        totalBatches,
        framesPerBatch: fpb,
      }
    };
  }

  // Batch mode
  const bi = parseInt(batchIdx);
  if (bi < 0 || bi >= totalBatches) throw new Error("Batch out of range");
  const start = bi * fpb;
  const end2 = Math.min(start + fpb, frames.length);
  const count = end2 - start;

  const out = Buffer.alloc(4 + frameBytes * count);
  out.writeUInt32LE(count, 0);
  let offset = 4;
  for (let i = start; i < end2; i++) {
    frames[i].copy(out, offset, 0, frameBytes);
    offset += frameBytes;
  }
  return { binary: out };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { url, batch, seg } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) throw new Error(`Source HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());

    // Detect animated
    let isAnim = false;
    try {
      const meta = await sharp(buf).metadata();
      if (meta.pages && meta.pages > 1) isAnim = true;
    } catch {}

    // ── GIF ──
    if (isAnim) {
      const result = await handleGif(buf, batch);
      if (result.json) return res.json(result.json);
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(result.binary);
    }

    // ── Video ──
    if (!ffmpegPath) throw new Error("ffmpeg not available");

    const dir = tmpDir();
    const inp = path.join(dir, "in");
    fs.writeFileSync(inp, buf);

    try {
      // Always probe (fast, <1s)
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
      const { w: outW, h: outH } = fitSize(sw, sh, MAX_FRAME_DIM);
      const frameBytes = outW * outH * 4;
      const totalSegments = Math.ceil(dur / SEGMENT_SECONDS);

      // ── INFO mode (no seg param) ──
      if (seg === undefined) {
        const estFrames = Math.ceil(dur * fps);
        const delayMs = Math.round(1000 / fps);
        const delays = Array(estFrames).fill(delayMs);

        return res.json({
          mode: "video",
          width: outW,
          height: outH,
          fps,
          duration: dur,
          frameCount: estFrames,
          delays,
          totalSegments,
          segmentSeconds: SEGMENT_SECONDS,
        });
      }

      // ── SEGMENT mode ──
      const si = parseInt(seg);
      const startTime = si * SEGMENT_SECONDS;
      const segDur = Math.min(SEGMENT_SECONDS, dur - startTime);

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
      const count = Math.floor(raw.length / frameBytes);

      const out = Buffer.alloc(4 + frameBytes * count);
      out.writeUInt32LE(count, 0);
      let offset = 4;
      for (let i = 0; i < count; i++) {
        raw.copy(out, offset, i * frameBytes, (i + 1) * frameBytes);
        offset += frameBytes;
      }

      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(out);
    } finally {
      cleanDir(dir);
    }
  } catch (e) {
    console.error("frames:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
