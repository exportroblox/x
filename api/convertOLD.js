const sharp = require("sharp");

const TILE = 512;
const MAX = 4096;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");

  const { url, tx, ty } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`Source HTTP ${resp.status}`);

    const buf = Buffer.from(await resp.arrayBuffer());
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) throw new Error("Not an image");
    if (meta.width > MAX || meta.height > MAX)
      throw new Error(`Too large: ${meta.width}x${meta.height}, max ${MAX}`);

    // ── INFO mode (no tx/ty) ──
    if (tx === undefined || ty === undefined) {
      return res.json({
        width: meta.width,
        height: meta.height,
        tileSize: TILE,
        tilesX: Math.ceil(meta.width / TILE),
        tilesY: Math.ceil(meta.height / TILE),
      });
    }

    // ── TILE mode ──
    const ix = parseInt(tx),
      iy = parseInt(ty);
    const left = ix * TILE,
      top = iy * TILE;
    const tw = Math.min(TILE, meta.width - left);
    const th = Math.min(TILE, meta.height - top);
    if (tw <= 0 || th <= 0) throw new Error("Tile out of bounds");

    const { data, info } = await sharp(buf)
      .extract({ left, top, width: tw, height: th })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return res.json({
      x: ix,
      y: iy,
      width: info.width,
      height: info.height,
      data: data.toString("base64"),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
