"use strict";
// Renders Mandelbrot views to PNG with mandelbrot/core.js (the CPU
// renderer's own perturbation code), for picking tour stops offline.
//
// usage: node mandelbrot/tools/preview.js OUTDIR "LABEL X Y DISTANCE" ...
//   X, Y      center as decimal text (as many digits as you have)
//   DISTANCE  view distance as in LOCATIONS (horizontal span = distance / 3)
// env: W=width (default 320), PALETTE=name (default ultra),
//      COLOR=escape|trap (default escape: what auto picks at deep stops)
//
// Iterations start at the page's iterationsFor(distance) and double while
// that still turns a meaningful share of "inside" pixels into escaped ones,
// as the renderers do. Colors are equal-area (the default mapping).
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const core = require("../core.js");

const [outDir, ...specs] = process.argv.slice(2);
if (!outDir || !specs.length) {
  console.error('usage: node mandelbrot/tools/preview.js OUTDIR "LABEL X Y DISTANCE" ...');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const W = Number(process.env.W) || 320, H = Math.round(W * 0.625);
const lut = core.buildLut(process.env.PALETTE || "ultra");
const smooth = (process.env.COLOR || "escape") !== "trap";

for (const spec of specs) {
  const t0 = Date.now();
  const [label, xs, ys, ds] = spec.trim().split(/\s+/);
  const dist = Number(ds), step = dist / 3 / W;
  const e = core.precisionFor(step);
  const ref = core.makeReference(core.bigFromString(xs, e), core.bigFromString(ys, e));
  const value = (i, j, it, sm) => {
    core.extendReference(ref, it);
    return core.perturbValue((i - W / 2) * step, (j - H / 2) * step, ref.data, ref.len, it, sm);
  };
  let iters = Math.min(65536, Math.max(500, Math.round(200 * Math.log10(6.75 / dist))));
  const inside = (it) => {
    let n = 0, c = 0;
    for (let j = 4; j < H; j += 8) for (let i = 4; i < W; i += 8) { c++; if (!value(i, j, it, false)) n++; }
    return n / c;
  };
  let f = inside(iters);
  while (iters < 65536) {
    const g = inside(iters * 2);
    if (f - g < 0.005 || f <= 0.002) break;
    iters *= 2;
    f = g;
  }
  // Equal-area colors from a sample grid, then every pixel.
  const samples = [];
  for (let j = 2; j < H; j += 4) for (let i = 2; i < W; i += 4) { const v = value(i, j, iters, smooth); if (v) samples.push(v); }
  samples.sort((a, b) => a - b);
  const quantiles = samples.length > 50
    ? Array.from({ length: 257 }, (_, i) => samples[Math.floor((i / 256) * (samples.length - 1))]) : null;
  core.extendReference(ref, iters);
  const rgba = core.renderBand({
    width: W, y0: 0, rows: H, xmin: -step * W / 2, ymin: -step * H / 2, step, iterations: iters,
    lo: 0, hi: 255, quantiles, hd: true, smooth, cx: Number(xs), cy: Number(ys),
  }, lut, ref.data.slice(0, 2 * ref.len));
  const file = path.join(outDir, `${label}.png`);
  fs.writeFileSync(file, png(W, H, rgba));
  console.log(`${file}  iterations ${iters}  inside ${(100 * f).toFixed(1)}%  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// Minimal PNG encoder (RGBA, no filtering).
function png(w, h, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), sum = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;  // 8-bit RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
