const sharp = require("sharp");

const MAX_DIM = 25000;
const TARGET_MAX = 4096;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  try {
    // Quick HEAD request first to check content type without downloading
    let contentType = "";
    try {
      const head = await fetch(url, {
        method: "HEAD",
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(5000),
      });
      contentType = (head.headers.get("content-type") || "").toLowerCase();
    } catch {
      // HEAD failed, try GET below
    }

    // If it's clearly a video, don't download at all
    if (
      contentType.startsWith("video/") ||
      contentType.includes("mp4") ||
      contentType.includes("webm") ||
      contentType.includes("quicktime") ||
      contentType.includes("matroska")
    ) {
      return res.json({ type: "video" });
    }

    // Check URL extension as fallback
    const lower = url.toLowerCase().split("?")[0];
    if (
      lower.endsWith(".mp4") ||
      lower.endsWith(".mov") ||
      lower.endsWith(".webm") ||
      lower.endsWith(".mkv") ||
      lower.endsWith(".avi")
    ) {
      return res.json({ type: "video" });
    }

    // Download and try as image
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`Source HTTP ${resp.status}`);

    const buf = Buffer.from(await resp.arrayBuffer());

    let meta;
    try {
      meta = await sharp(buf).metadata();
    } catch {
      // sharp can't read it — assume video
      return res.json({ type: "video" });
    }

    if (!meta.width || !meta.height) throw new Error("Not an image");

    // Animated GIF/WebP
    if (meta.pages && meta.pages > 1) {
      return res.json({ type: "animated" });
    }

    // Static image
    if (meta.width > MAX_DIM || meta.height > MAX_DIM)
      throw new Error(`Too large: ${meta.width}x${meta.height}`);

    let pipeline = sharp(buf).ensureAlpha();
    if (meta.width > TARGET_MAX || meta.height > TARGET_MAX) {
      pipeline = pipeline.resize(TARGET_MAX, TARGET_MAX, {
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    const { data, info } = await pipeline
      .raw()
      .toBuffer({ resolveWithObject: true });

    const header = Buffer.alloc(8);
    header.writeUInt32LE(info.width, 0);
    header.writeUInt32LE(info.height, 4);

    res.setHeader("Content-Type", "application/octet-stream");
    return res.send(Buffer.concat([header, data]));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
