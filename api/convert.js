const sharp = require("sharp");

const TILE = 1024;
const MAX_DIM = 8192;
const TARGET_MAX = 4096;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`Source HTTP ${resp.status}`);

    const buf = Buffer.from(await resp.arrayBuffer());
    let meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) throw new Error("Not an image");
    if (meta.width > MAX_DIM || meta.height > MAX_DIM)
      throw new Error(`Too large: ${meta.width}x${meta.height}, max ${MAX_DIM}`);

    let pipeline = sharp(buf).ensureAlpha();
    if (meta.width > TARGET_MAX || meta.height > TARGET_MAX) {
      pipeline = pipeline.resize(TARGET_MAX, TARGET_MAX, {
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    const { data: fullRaw, info } = await pipeline
      .raw()
      .toBuffer({ resolveWithObject: true });

    const fullW = info.width;
    const fullH = info.height;
    const tilesX = Math.ceil(fullW / TILE);
    const tilesY = Math.ceil(fullH / TILE);

    // Calculate total binary size
    let totalSize = 20;
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const tw = Math.min(TILE, fullW - tx * TILE);
        const th = Math.min(TILE, fullH - ty * TILE);
        totalSize += 8 + tw * th * 4;
      }
    }

    const out = Buffer.alloc(totalSize);
    let offset = 0;

    out.writeUInt32LE(fullW, 0);
    out.writeUInt32LE(fullH, 4);
    out.writeUInt32LE(TILE, 8);
    out.writeUInt32LE(tilesX, 12);
    out.writeUInt32LE(tilesY, 16);
    offset = 20;

    const stride = fullW * 4;
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const left = tx * TILE;
        const top = ty * TILE;
        const tw = Math.min(TILE, fullW - left);
        const th = Math.min(TILE, fullH - top);

        out.writeUInt32LE(tw, offset);
        out.writeUInt32LE(th, offset + 4);
        offset += 8;

        for (let row = 0; row < th; row++) {
          const srcOff = (top + row) * stride + left * 4;
          fullRaw.copy(out, offset, srcOff, srcOff + tw * 4);
          offset += tw * 4;
        }
      }
    }

    res.setHeader("Content-Type", "application/octet-stream");
    return res.send(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
