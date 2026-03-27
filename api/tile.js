const sharp = require("sharp");

const TILE = 1024;
const TARGET_MAX = 4096;

// Cache the processed image in memory for 60s to avoid re-downloading
// for each tile request from the same import
const cache = new Map();
const CACHE_TTL = 60000;

function cleanCache() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.time > CACHE_TTL) cache.delete(key);
  }
}

async function getImage(url) {
  cleanCache();
  if (cache.has(url)) return cache.get(url);

  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Source HTTP ${resp.status}`);

  const buf = Buffer.from(await resp.arrayBuffer());
  let pipeline = sharp(buf).ensureAlpha();
  const meta = await sharp(buf).metadata();

  if (meta.width > TARGET_MAX || meta.height > TARGET_MAX) {
    pipeline = pipeline.resize(TARGET_MAX, TARGET_MAX, {
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  const { data, info } = await pipeline
    .raw()
    .toBuffer({ resolveWithObject: true });

  const entry = { data, width: info.width, height: info.height, time: Date.now() };
  cache.set(url, entry);
  return entry;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { url, tx, ty } = req.query;
  if (!url || tx === undefined || ty === undefined)
    return res.status(400).json({ error: "Missing params" });

  try {
    const img = await getImage(url);
    const ix = parseInt(tx),
      iy = parseInt(ty);
    const left = ix * TILE,
      top = iy * TILE;
    const tw = Math.min(TILE, img.width - left);
    const th = Math.min(TILE, img.height - top);
    if (tw <= 0 || th <= 0) throw new Error("Tile out of bounds");

    // 8 byte header + pixel data
    const out = Buffer.alloc(8 + tw * th * 4);
    out.writeUInt32LE(tw, 0);
    out.writeUInt32LE(th, 4);

    const stride = img.width * 4;
    let offset = 8;
    for (let row = 0; row < th; row++) {
      const srcOff = (top + row) * stride + left * 4;
      img.data.copy(out, offset, srcOff, srcOff + tw * 4);
      offset += tw * 4;
    }

    res.setHeader("Content-Type", "application/octet-stream");
    return res.send(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
