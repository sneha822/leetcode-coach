/* generate-icons.js — writes src/icons/icon{16,48,128}.png with no external
   dependencies (uses Node's zlib). The icon is a rounded violet tile with a
   lighter diamond (matching the ◆ logo). Run: node tools/generate-icons.js */
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.22;                  // corner radius
  const cx = size / 2, cy = size / 2, dr = size * 0.3; // diamond half-size
  const tile = [0x6d, 0x5c, 0xf0], diamond = [0xcb, 0xbc, 0xff];
  function inRounded(x, y) {
    const nx = Math.min(x, size - 1 - x), ny = Math.min(y, size - 1 - y);
    if (nx >= r || ny >= r) return true;
    const dx = r - nx, dy = r - ny;
    return dx * dx + dy * dy <= r * r;
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRounded(x + 0.5, y + 0.5)) { buf[i + 3] = 0; continue; }
      const diamondDist = Math.abs(x + 0.5 - cx) + Math.abs(y + 0.5 - cy);
      const col = diamondDist <= dr ? diamond : tile;
      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = 255;
    }
  }
  return png(size, size, buf);
}

const dir = path.join(__dirname, "..", "src", "icons");
fs.mkdirSync(dir, { recursive: true });
[16, 48, 128].forEach(function (s) {
  fs.writeFileSync(path.join(dir, "icon" + s + ".png"), render(s));
  console.log("wrote icon" + s + ".png");
});
