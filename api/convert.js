const sharp = require("sharp");

const TILE = 512;
const MAX  = 4096;

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
    const img = sharp(buf).ensureAlpha();
    const meta = await img.metadata();

    if (!meta.width || !meta.height) throw new Error("Not an image");
    if (meta.width > MAX || meta.height > MAX)
      throw new Error(`Too large: ${meta.width}x${meta.height}, max ${MAX}`);

    const tilesX = Math.ceil(meta.width / TILE);
    const tilesY = Math.ceil(meta.height / TILE);

    // Get full raw RGBA buffer once
    const { data: fullRaw } = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const fullW = meta.width;
    const fullH = meta.height;

    // Build a binary payload:
    // Header: 20 bytes
    //   [0..3]   u32 LE  width
    //   [4..7]   u32 LE  height
    //   [8..11]  u32 LE  tileSize
    //   [12..15] u32 LE  tilesX
    //   [16..19] u32 LE  tilesY
    // Then for each tile (row-major):
    //   8-byte tile header:
    //     [0..3] u32 LE  tileWidth
    //     [4..7] u32 LE  tileHeight
    //   Then tileWidth * tileHeight * 4 bytes of RGBA

    // Calculate total size
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

    // Write header
    out.writeUInt32LE(fullW, 0);
    out.writeUInt32LE(fullH, 4);
    out.writeUInt32LE(TILE, 8);
    out.writeUInt32LE(tilesX, 12);
    out.writeUInt32LE(tilesY, 16);
    offset = 20;

    // Write tiles — extract from the full raw buffer directly (no re-decode)
    const stride = fullW * 4;
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const left = tx * TILE;
        const top  = ty * TILE;
        const tw   = Math.min(TILE, fullW - left);
        const th   = Math.min(TILE, fullH - top);

        out.writeUInt32LE(tw, offset);
        out.writeUInt32LE(th, offset + 4);
        offset += 8;

        // Copy row by row from the full image
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
