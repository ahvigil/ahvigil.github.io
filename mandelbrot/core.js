"use strict";
/*
 * Mandelbrot math shared by the renderers: locations, palettes, per-pixel
 * orbit values (direct and by perturbation), and arbitrary-precision
 * fixed-point numbers for view centers and reference orbits.
 *
 * Pure: no DOM access, so it also loads in Node (for tests) and pieces of it
 * are shipped to workers via Function.prototype.toString().
 */

// [x, y, distance, maxColor], same as mb.py. The view's horizontal span is
// distance / 3, so framing matches the terminal version.
const LOCATIONS = [
  [-0.5, 0.0, 6.75, 256],
  [0.37865401, 0.669227668, 0.04, 111],
  [-1.2693, -0.4145, 0.2, 105],
  [-1.2693, -0.4145, 0.05, 97],
  [-1.2642, -0.4185, 0.01, 95],
  [-1.15, -0.28, 0.9, 94],
  [-1.15, -0.28, 0.3, 58],
  [-1.15, -0.28, 0.05, 26],
  [-1.401155, 0.0, 0.2, 51],          // Feigenbaum point: period-doubling cascade
  [-1.7685, 0.0, 0.2, 58],            // minibrot on the main antenna
  [-0.1011, 0.9563, 0.04, 86],        // Misiurewicz point: spiraling filaments
  [-0.660295, 0.438827, 0.1, 69],     // banded filaments off the main cardioid
  [-1.234948, 0.164974, 0.02, 26],    // just outside the period-2 bulb
  [-0.180977, 0.844923, 0.02, 36],    // edge of the period-3 bulb
  [-0.558794, 0.627494, 0.1, 61],     // tendrils between the cardioid and top bulb
  [0.393174, 0.370292, 0.02, 42],     // a bulb on the right edge of the cardioid
  [0.149181, 0.655944, 0.02, 52],     // side bulb on the upper-right shoulder
  [-0.465086, 0.625207, 0.005, 45],   // deep zoom: knotted bands
  [-0.735379, 0.290928, 0.005, 42],   // deep zoom: seahorse valley wall
  [-1.050426, 0.262645, 0.005, 30],   // deep zoom: outskirts of the period-2 bulb
  // HD only: these need continuous color and thousands of iterations, so
  // they render as a single glyph in mb.py.
  [-0.743643887037151, 0.131825904205330, 3e-9, 3],     // seahorse valley: spiral arm around a tiny minibrot
  [-0.7746806106269039, 0.1374168856037867, 3e-9, 3],   // seahorse valley: S-shaped twin spiral
  [-1.25066, 0.02012, 3e-4, 3],                         // period-2 neck: minibrot ringed by halos
  [-1.7796274664, -0.0002364244, 0.000003052, 3],       // deep in the antenna: beaded minibrot
  [-0.10109636384562, 0.95628651080914, 3e-9, 3],       // Misiurewicz point: branching dendrite
  [0.001643721971153, 0.822467633298876, 3e-10, 3],     // spoked spiral around a minibrot
];

const RAMP_STEPS = 80;
const LUT_SIZE = 1024;
const BAND_ROWS = 8;

// Port of Python's colorsys.hsv_to_rgb (hue wraps around 1.0).
function hsvToRgb(h, s, v) {
  if (s === 0) return [v, v, v];
  let i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  i %= 6;
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
}

// Palettes map s in [0, 1] to a color, where s = 1 is the orbit that came
// closest to the origin (the "#" glyph in mb.py, bright, hugging the set) and
// s = 0 the farthest ("." glyph, the dark background). Gradient palettes are
// lists of [position, [r, g, b]] stops; "terminal" is mb.py's HSV ramp.
const PALETTES = {
  ultra: [[0, [0, 4, 30]], [0.35, [20, 80, 180]], [0.7, [225, 245, 255]],
          [0.86, [255, 170, 0]], [1, [255, 245, 210]]],
  fire:  [[0, [0, 0, 0]], [0.3, [110, 8, 0]], [0.6, [225, 85, 0]],
          [0.85, [255, 200, 40]], [1, [255, 255, 225]]],
  ice:   [[0, [0, 2, 12]], [0.4, [8, 40, 115]], [0.75, [40, 170, 230]],
          [1, [235, 255, 255]]],
  neon:  [[0, [4, 0, 18]], [0.4, [75, 0, 135]], [0.7, [225, 30, 165]],
          [0.9, [255, 170, 220]], [1, [255, 255, 255]]],
  mono:  [[0, [0, 0, 0]], [1, [255, 255, 255]]],
  terminal: null,
};
const PALETTE_NAMES = Object.keys(PALETTES);

function buildLut(name) {
  const stops = PALETTES[name];
  const lut = new Uint8ClampedArray(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const s = i / (LUT_SIZE - 1);
    let rgb;
    if (!stops) {
      // mb.py's ramp; brightness stands in for glyph density.
      const u = s * (RAMP_STEPS - 1) / RAMP_STEPS;
      const k = 255 * (0.06 + 0.94 * Math.pow(s, 1.3));
      rgb = hsvToRgb(0.57 + u, 1 - u ** 3, 1).map((c) => c * k);
    } else {
      let j = 1;
      while (j < stops.length - 1 && stops[j][0] < s) j++;
      const [p0, c0] = stops[j - 1], [p1, c1] = stops[j];
      let f = (s - p0) / (p1 - p0);
      f = f * f * (3 - 2 * f);  // smoothstep between stops
      rgb = c0.map((c, k) => c + (c1[k] - c) * f);
    }
    lut.set(rgb, i * 3);
  }
  return lut;
}

// Orbit-trap value as in mb.py, left continuous for smooth gradients:
// 0 inside the set, otherwise 1..255 from the orbit's closest approach to 0.
// With `smooth`, instead the continuous escape time (iterations to reach a
// large bailout, fractional part from how far past it the orbit landed),
// which keeps varying at every zoom depth.
function orbitValue(cr, ci, iterations, smooth) {
  // Skip the main cardioid and period-2 bulb: always inside the set.
  const ci2 = ci * ci;
  const q = (cr - 0.25) * (cr - 0.25) + ci2;
  if (q * (q + (cr - 0.25)) <= 0.25 * ci2 || (cr + 1) * (cr + 1) + ci2 <= 0.0625) return 0;
  let zr = 0, zi = 0, mind2 = 4;
  const bailout = smooth ? 1e6 : 4;
  for (let i = 0; i < iterations; i++) {
    const t = zr * zr - zi * zi + cr;
    zi = 2 * zr * zi + ci;
    zr = t;
    const d2 = zr * zr + zi * zi;
    if (d2 >= bailout) {
      return smooth ? i + 5 - Math.log2(Math.log2(d2) / 2)
                    : Math.min(Math.sqrt(mind2) / 0.007, 254) + 1;
    }
    if (d2 < mind2) mind2 = d2;
  }
  return 0;
}

// The same value (orbit trap or smooth escape time) by perturbation: ref
// holds the reference orbit Z_0..Z_{refLen-1} (interleaved re, im) of the
// view center, and (dcr, dci) is this pixel's offset from the center.
// Iterates dz, where z = Z_m + dz:
//   dz' = 2 Z_m dz + dz^2 + dc
// When z gets closer to 0 than dz (where dz would lose precision), or the
// reference runs out (it escaped, or is shorter than needed), the orbit is
// rebased onto the start of the reference: dz = z, m = 0. That keeps the
// deltas accurate without any glitch detection.
function perturbValue(dcr, dci, ref, refLen, iterations, smooth) {
  let dzr = 0, dzi = 0, m = 0, mind2 = 4;
  const bailout = smooth ? 1e6 : 4;
  for (let i = 0; i < iterations; i++) {
    const Zr = ref[2 * m], Zi = ref[2 * m + 1];
    const t = 2 * (Zr * dzr - Zi * dzi) + dzr * dzr - dzi * dzi + dcr;
    dzi = 2 * (Zr * dzi + Zi * dzr + dzr * dzi) + dci;
    dzr = t;
    m++;
    const zr = ref[2 * m] + dzr, zi = ref[2 * m + 1] + dzi;
    const d2 = zr * zr + zi * zi;
    if (d2 >= bailout) {
      return smooth ? i + 5 - Math.log2(Math.log2(d2) / 2)
                    : Math.min(Math.sqrt(mind2) / 0.007, 254) + 1;
    }
    if (d2 < mind2) mind2 = d2;
    if (d2 < dzr * dzr + dzi * dzi || m === refLen - 1) {
      dzr = zr; dzi = zi; m = 0;
    }
  }
  return 0;
}

// Renders a band of rows to RGBA, mapping values in [lo, hi] across the
// palette. Shipped to the workers via toString() along with orbitValue and
// perturbValue, so it must not reference anything else. In high-resolution
// jobs (job.hd), xmin/ymin are offsets from the reference orbit's center.
// Orbit-trap values are brightest near the set (small values); smooth escape
// times are brightest near the set too, but there that means large values.
function renderBand(job, lut, ref) {
  const { width, y0, rows, xmin, ymin, step, iterations, lo, hi, quantiles, hd, smooth } = job;
  const refLen = ref ? ref.length >> 1 : 0;
  const qn = quantiles ? quantiles.length - 1 : 0;
  const out = new Uint8ClampedArray(width * rows * 4);
  const top = lut.length / 3 - 1;
  const span = Math.max(hi - lo, 1e-9);
  let o = 0;
  for (let r = 0; r < rows; r++) {
    const ci = ymin + (y0 + r) * step;
    for (let ix = 0; ix < width; ix++, o += 4) {
      out[o + 3] = 255;
      const value = hd
        ? perturbValue(xmin + ix * step, ci, ref, refLen, iterations, smooth)
        : orbitValue(xmin + ix * step, ci, iterations, smooth);
      if (value === 0) continue;  // inside the set: black
      let rank;
      if (quantiles) {
        // Histogram equalization: rank of this value among on-screen samples.
        let a = 0, b = qn;
        if (value <= quantiles[0]) rank = 0;
        else if (value >= quantiles[qn]) rank = 1;
        else {
          while (b - a > 1) { const m = (a + b) >> 1; if (quantiles[m] <= value) a = m; else b = m; }
          const gap = quantiles[b] - quantiles[a];
          rank = (a + (gap > 0 ? (value - quantiles[a]) / gap : 0)) / qn;
        }
      } else {
        rank = Math.min(Math.max((value - lo) / span, 0), 1);
      }
      const s = smooth ? rank : 1 - rank;
      const li = Math.round(s * top) * 3;
      out[o] = lut[li];
      out[o + 1] = lut[li + 1];
      out[o + 2] = lut[li + 2];
    }
  }
  return out;
}

// --- big numbers ------------------------------------------------------------------

// Fixed-point values { m, e } meaning m * 2^-e (m a BigInt), for view centers
// and the reference orbit, which need more precision than doubles carry.

// m * 2^-s, rounded (s may be negative).
function shr(m, s) {
  if (s <= 0) return m << BigInt(-s);
  return (m + (1n << BigInt(s - 1))) >> BigInt(s);
}

const rescale = (a, e) => ({ m: shr(a.m, a.e - e), e });

function bigAdd(a, b) {
  const e = Math.max(a.e, b.e);
  return { m: rescale(a, e).m + rescale(b, e).m, e };
}

// Exact: every double is a dyadic rational.
function bigFromDouble(v, e) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  if (biased) mant |= 1n << 52n;
  // v = mant * 2^(exponent - 1075)
  const m = shr(mant, 1075 - Math.max(biased, 1) - e);
  return { m: bits >> 63n ? -m : m, e };
}

// Parses decimal text such as "-1.77962746640001" or "3.05e-6" without
// rounding through a double first. Returns null if it isn't a number.
function bigFromString(text, e) {
  const match = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?\s*$/i.exec(text);
  if (!match || !(match[2] + (match[3] || ""))) return null;
  const digits = BigInt(match[2] + (match[3] || ""));
  const exp10 = parseInt(match[4] || "0", 10) - (match[3] || "").length;
  let m;
  if (exp10 >= 0) {
    m = (digits * 10n ** BigInt(exp10)) << BigInt(e);
  } else {
    const den = 10n ** BigInt(-exp10);
    m = ((digits << BigInt(e + 1)) + den) / (2n * den);  // rounded
  }
  return { m: match[1] === "-" ? -m : m, e };
}

function bigToDouble(a) {
  // Number() rounds correctly but overflows past 2^1024, so shift first.
  // Fast path for values near 1 (the reference orbit); tiny values keep 64
  // significant bits instead.
  let s = Math.max(0, a.e - 1000);
  let x = Number(shr(a.m, s));
  if (s > 0 && Math.abs(x) < 2 ** 64) {
    const bits = (a.m < 0n ? -a.m : a.m).toString(16).length * 4;
    s = Math.max(0, bits - 64);
    x = Number(shr(a.m, s));
  }
  const p = s - a.e;  // split the scaling so 2^p can't underflow on its own
  return x * 2 ** Math.ceil(p / 2) * 2 ** Math.floor(p / 2);
}

// Decimal text with `digits` places, trailing zeros trimmed.
function bigToString(a, digits) {
  const neg = a.m < 0n;
  const scaled = shr((neg ? -a.m : a.m) * 10n ** BigInt(digits), a.e);
  const s = scaled.toString().padStart(digits + 1, "0");
  const frac = s.slice(-digits).replace(/0+$/, "");
  const text = s.slice(0, -digits) + (frac ? "." + frac : "");
  return neg && scaled !== 0n ? "-" + text : text;
}

// Fractional bits for a view with this pixel step: enough to place the
// center well below one pixel, with headroom for the reference orbit.
const precisionFor = (step) => Math.max(64, Math.ceil(-Math.log2(step)) + 64);

// Reference orbit Z_0 = 0, Z_{n+1} = Z_n^2 + C in fixed point, stored as
// doubles. Extended on demand, stopping early once it escapes.
function makeReference(cx, cy) {
  return { cx: cx.m, cy: cy.m, e: cx.e, zx: 0n, zy: 0n, len: 1, escaped: false,
           data: new Float64Array(2 * 1024) };
}

function extendReference(ref, iters) {
  if (ref.escaped || ref.len > iters) return;
  const E = BigInt(ref.e), E1 = E - 1n, { cx, cy, e } = ref;
  let { zx, zy, len, data } = ref;
  if (data.length < 2 * (iters + 1)) {
    const grown = new Float64Array(2 * (iters + 1));
    grown.set(data.subarray(0, 2 * len));
    data = grown;
  }
  while (len <= iters) {
    const nx = ((zx * zx - zy * zy) >> E) + cx;
    zy = ((zx * zy) >> E1) + cy;
    zx = nx;
    const r = bigToDouble({ m: zx, e }), i = bigToDouble({ m: zy, e });
    data[2 * len] = r;
    data[2 * len + 1] = i;
    len++;
    if (r * r + i * i > 4) { ref.escaped = true; break; }
  }
  Object.assign(ref, { zx, zy, len, data });
}

const bigNeg = (a) => ({ m: -a.m, e: a.e });
const bigSub = (a, b) => bigAdd(a, bigNeg(b));

// Builds reference orbits in a background worker, so re-anchoring a deep view
// (thousands of BigInt iterations) doesn't stall animation frames. Falls back
// to the calling thread where workers aren't available.
//   refWorker.request({ x, y } (big, both with exponent e), iters)
//     -> Promise<{ cx, cy, e, len, escaped, data }>, data = Float64Array of
//        interleaved Z_0..Z_{len-1} (re, im), exactly what extendReference
//        would produce.
// Requests run in order; a request can't be cancelled, but callers can
// ignore stale results by comparing cx/cy/e with what they asked for.
const refWorker = (() => {
  let worker = null, nextId = 0, broken = false;
  const pending = new Map();
  const local = (cx, cy, e, iters) => {
    const ref = makeReference({ m: cx, e }, { m: cy, e });
    extendReference(ref, iters);
    return { cx, cy, e, len: ref.len, escaped: ref.escaped, data: ref.data.slice(0, 2 * ref.len) };
  };
  const SRC = `${shr}\n${bigToDouble}\n${makeReference}\n${extendReference}\nconst local = ${local};
onmessage = (msg) => {
  const { id, cx, cy, e, iters } = msg.data;
  const out = local(cx, cy, e, iters);
  postMessage({ id, ...out }, [out.data.buffer]);
};`;
  function start() {
    if (worker || broken) return;
    try {
      worker = new Worker(URL.createObjectURL(new Blob([SRC], { type: "text/javascript" })));
      worker.onmessage = (msg) => {
        const p = pending.get(msg.data.id);
        pending.delete(msg.data.id);
        if (p) p.resolve(msg.data);
      };
      worker.onerror = () => {
        // Finish everything outstanding locally and stop using the worker.
        broken = true;
        worker.terminate();
        worker = null;
        for (const [id, p] of pending) { pending.delete(id); p.resolve(local(p.cx, p.cy, p.e, p.iters)); }
      };
    } catch (err) {
      broken = true;
    }
  }
  return {
    request(center, iters) {
      const e = center.x.e, cx = center.x.m, cy = rescale(center.y, e).m;
      if (typeof Worker === "undefined") broken = true;
      start();
      if (!worker) return Promise.resolve(local(cx, cy, e, iters));
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, { resolve, cx, cy, e, iters });
        worker.postMessage({ id, cx, cy, e, iters });
      });
    },
  };
})();

if (typeof module !== "undefined") {
  module.exports = {
    LOCATIONS, PALETTES, PALETTE_NAMES, LUT_SIZE, buildLut, orbitValue, perturbValue, renderBand,
    shr, rescale, bigAdd, bigNeg, bigSub, bigFromDouble, bigFromString, bigToDouble, bigToString,
    precisionFor, makeReference, extendReference, refWorker,
  };
}
