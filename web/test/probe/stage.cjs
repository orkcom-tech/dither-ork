// Stages the manual browser probe: fixture images, and the harness beside them.
//
//   docker compose exec -T web sh -c 'cd /app/web && node test/probe/stage.cjs'
//
// The harness lives in `web/test/probe/` and is *copied* into `web/public/probe/`
// rather than living there, because everything in `public/` is copied verbatim
// into `dist/` — the fixtures alone are several megabytes and none of it belongs
// in a production build. `web/public/probe/` is gitignored and is created only
// by running this.
//
// Plain zlib and a hand-written PNG chunk writer, so it needs no dependency.
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o] = 0; // filter: none
    o += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = rgb(x, y);
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      o += 3;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A smooth field with structure at several scales: gradients dither into visible
// texture, and the discs give the edge-aware effects something to find.
function scene(width, height, phase) {
  return (x, y) => {
    const u = x / width;
    const v = y / height;
    let r = 255 * (0.5 + 0.45 * Math.sin(6.0 * u + phase));
    let g = 255 * (0.5 + 0.45 * Math.sin(5.0 * v + phase * 1.7 + 2.1));
    let b = 255 * (0.5 + 0.45 * Math.sin(4.0 * (u + v) + phase * 0.6 + 4.2));
    for (let i = 0; i < 12; i += 1) {
      const cx = ((i * 0.137 + 0.11 + phase * 0.01) % 1) * width;
      const cy = ((i * 0.311 + 0.07) % 1) * height;
      const rad = (0.03 + ((i * 7) % 5) * 0.015) * width;
      const d = Math.hypot(x - cx, y - cy);
      if (d < rad) {
        const k = 1 - d / rad;
        r += 120 * k * ((i % 3) - 1);
        g += 120 * k * (((i + 1) % 3) - 1);
        b += 120 * k * (((i + 2) % 3) - 1);
      }
    }
    const clamp = (n) => (n < 0 ? 0 : n > 255 ? 255 : n | 0);
    return [clamp(r), clamp(g), clamp(b)];
  };
}

const staged = path.join(__dirname, "..", "..", "public", "probe");
const out = path.join(staged, "images");
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(__dirname, "probe.js"), path.join(staged, "probe.js"));
process.stdout.write(`staged ${path.relative(process.cwd(), staged)}\n`);

const wanted = [
  ["big.png", 2400, 1800, 0],
  ["batch-1.png", 640, 480, 0.4],
  ["batch-2.png", 800, 600, 1.3],
  ["batch-3.png", 512, 512, 2.2],
  ["batch-4.png", 900, 700, 3.1],
];

for (const [name, w, h, phase] of wanted) {
  const bytes = png(w, h, scene(w, h, phase));
  fs.writeFileSync(path.join(out, name), bytes);
  process.stdout.write(`${name} ${w}x${h} ${bytes.length} bytes\n`);
}

// One file that is not a picture, for the "a bad file does not kill the run"
// case. The extension lies on purpose — decoding is what has to reject it.
const broken = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("this is not an image, and the decoder is what must say so", "ascii"),
]);
fs.writeFileSync(path.join(out, "batch-broken.png"), broken);
process.stdout.write(`batch-broken.png ${broken.length} bytes (deliberately corrupt)\n`);
