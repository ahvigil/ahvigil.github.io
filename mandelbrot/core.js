"use strict";
/*
 * Mandelbrot math shared by the renderers: locations, palettes, per-pixel
 * orbit values (direct and by perturbation), and arbitrary-precision
 * fixed-point numbers for view centers and reference orbits.
 *
 * Pure: no DOM access, so it also loads in Node (for tests) and pieces of it
 * are shipped to workers via Function.prototype.toString().
 */

// Tour stops: [x, y, distance, maxColor, name] (mb.py keeps its own list).
// The view's horizontal span is distance / 3, so framing matches the
// terminal version. Deep stops are minibrots found by Newton's method on
// their nucleus (period in the comment); their centers are past double
// precision, so x and y are decimal text.
const LOCATIONS = [
  [-0.5, 0.0, 6.75, 256, "the whole set"],
  ["-0.774680159922181496040663", "0.137416181816513136424547", 2.14e-17, 3, "seahorse valley: minibrot in a ring of petals"],  // period 104
  ["-0.743643887037159272051", "0.131825904205312773330", 1.88e-14, 3, "seahorse valley: haloed minibrot"],  // period 1996
  ["-0.743643887033966697174", "0.131825905961948466072", 2.14e-12, 3, "seahorse valley: minibrot in a lattice"],  // period 973
  ["-1.25065946995766675", "0.02012025532177806", 3.67e-10, 3, "period-2 neck: ringed minibrot"],  // period 474
  [-1.7796274664, -0.0002364244, 0.000003052, 3, "deep in the antenna: beaded minibrot"],
  ["-1.999999117587260825", "0", 1.26e-11, 3, "antenna tip: star-shaped minibrot"],  // period 12
  ["-0.101096364173753089038111", "0.956286510868534825551945", 9.72e-18, 3, "Misiurewicz point: sunburst minibrot"],  // period 73
  ["-0.160701350082826767863022", "1.037566500011069953631349", 1.01e-16, 3, "top tendril: minibrot with spiral arms"],  // period 824
  ["0.254987024152377390669", "0.000567988193082191722", 4.57e-13, 3, "near the cusp: four-lobed minibrot in ribbons"],  // period 494
  ["0.2549870375310423776490622441", "0.0005679790525271306303794810", 2.23e-20, 3, "near the cusp: minibrot in concentric rings"],  // period 883
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
// The step is computed as dz' = (2 Z_m + dz) dz + dc, which is one rounding
// step shorter on the dependency chain than expanding it.
//
// orbitValue and perturbValue are the one-pixel definitions; orbitValues
// below computes exactly the same numbers for a grid of pixels, faster.
function perturbValue(dcr, dci, ref, refLen, iterations, smooth) {
  let dzr = 0, dzi = 0, m = 0, mind2 = 4;
  let Zr = 0, Zi = 0;  // Z_m, carried over from the previous step's Z_{m+1}
  const bailout = smooth ? 1e6 : 4;
  for (let i = 0; i < iterations; i++) {
    const ar = 2 * Zr + dzr, ai = 2 * Zi + dzi;
    const t = ar * dzr - ai * dzi + dcr;
    dzi = ar * dzi + ai * dzr + dci;
    dzr = t;
    m++;
    Zr = ref[2 * m];
    Zi = ref[2 * m + 1];
    const zr = Zr + dzr, zi = Zi + dzi;
    const d2 = zr * zr + zi * zi;
    if (d2 >= bailout) {
      return smooth ? i + 5 - Math.log2(Math.log2(d2) / 2)
                    : Math.min(Math.sqrt(mind2) / 0.007, 254) + 1;
    }
    if (d2 < mind2) mind2 = d2;
    if (d2 < dzr * dzr + dzi * dzi || m === refLen - 1) {
      dzr = zr; dzi = zi; m = 0; Zr = 0; Zi = 0;
    }
  }
  return 0;
}

// orbitValue / perturbValue for a grid of pixels, into out (row-major). The
// point in row r, column k is pixel (x0 + k * stride, y0 + r * stride) of a
// view whose pixel (px, py) is c = (xmin + px * step, ymin + py * step); in
// high-resolution grids (g.hd) that c is an offset from the center of the
// reference orbit `ref`.
//
// Each step of one orbit waits on the previous one, so a single orbit leaves
// most of the CPU's floating-point units idle. Iterating two pixels together
// (lanes a and b, each refilled with the next pixel as soon as its orbit
// ends) runs about 1.7x as many iterations per second. The arithmetic per
// lane is exactly orbitValue's (low resolution) or perturbValue's.
//
// Points in the main cardioid and period-2 bulb are skipped, as orbitValue
// does. Hi-res grids opt in with g.bulbs and the center (g.cx, g.cy) as
// doubles, which is only accurate where doubles still resolve pixels.
// Shipped to the workers via toString(), so it must not reference anything
// else.
function orbitValues(g, ref, out) {
  const { cols, rows, x0, y0, stride, xmin, ymin, step, iterations, smooth, hd } = g;
  const bulbs = !hd || g.bulbs;
  const cx = hd ? g.cx : 0, cy = hd ? g.cy : 0;
  const bailout = smooth ? 1e6 : 4;
  const n = cols * rows;
  // Pixels left to iterate, in order (the bulbs' insides are 0 already).
  const todo = new Int32Array(n);
  let count = 0;
  for (let p = 0; p < n; p++) {
    if (bulbs) {
      const cr = cx + (xmin + (x0 + (p % cols) * stride) * step);
      const ci = cy + (ymin + (y0 + Math.floor(p / cols) * stride) * step), ci2 = ci * ci;
      const q = (cr - 0.25) * (cr - 0.25) + ci2;
      if (q * (q + (cr - 0.25)) <= 0.25 * ci2 || (cr + 1) * (cr + 1) + ci2 <= 0.0625) { out[p] = 0; continue; }
    }
    todo[count++] = p;
  }
  if (!count) return out;
  // Lane state: pixel p (-1 once there are none left: the lane then idles
  // on c = 0 until the other one finishes), c, iteration i, closest
  // approach min, and |z|^2 at the last step. The hot loops run until
  // either lane ends; refilling lanes stays outside them, which keeps V8's
  // code for the loops tight (with it inside, they ran no faster than one
  // pixel at a time). No helper closures either: a fresh closure per call
  // makes V8 deoptimize.
  let next = 0;
  let pa = todo[next++], pb = next < count ? todo[next++] : -1;
  let acr = xmin + (x0 + (pa % cols) * stride) * step, aci = ymin + (y0 + Math.floor(pa / cols) * stride) * step;
  let bcr = pb < 0 ? 0 : xmin + (x0 + (pb % cols) * stride) * step;
  let bci = pb < 0 ? 0 : ymin + (y0 + Math.floor(pb / cols) * stride) * step;
  let ai = 0, amin = 4, ad2 = 0, bi = 0, bmin = 4, bd2 = 0;
  let aEnd = false, bEnd = false;
  // z for low resolution; dz and Z_m for high resolution.
  let azr = 0, azi = 0, bzr = 0, bzi = 0;
  let aZr = 0, aZi = 0, am = 0, bZr = 0, bZi = 0, bm = 0;
  const last = hd ? (ref.length >> 1) - 1 : 0;  // rebase when m reaches the end of ref
  // Low and high resolution get separate loops, refills included: sharing
  // one costs high resolution about 20%.
  if (!hd) {
    // orbitValue's loop, two lanes.
    for (;;) {
      for (;;) {
        const at = azr * azr - azi * azi + acr;
        const bt = bzr * bzr - bzi * bzi + bcr;
        azi = 2 * azr * azi + aci;
        bzi = 2 * bzr * bzi + bci;
        azr = at;
        bzr = bt;
        ad2 = azr * azr + azi * azi;
        bd2 = bzr * bzr + bzi * bzi;
        aEnd = ad2 >= bailout;
        bEnd = bd2 >= bailout;
        if (!aEnd) {
          if (ad2 < amin) amin = ad2;
          aEnd = ++ai === iterations;
        }
        if (!bEnd) {
          if (bd2 < bmin) bmin = bd2;
          bEnd = ++bi === iterations;
        }
        if (aEnd || bEnd) break;
      }
      if (aEnd) {
        if (pa >= 0) {
          out[pa] = ad2 < bailout ? 0 : smooth ? ai + 5 - Math.log2(Math.log2(ad2) / 2)
                                               : Math.min(Math.sqrt(amin) / 0.007, 254) + 1;
        }
        pa = next < count ? todo[next++] : -1;
        if (pa < 0 && pb < 0) break;
        acr = pa < 0 ? 0 : xmin + (x0 + (pa % cols) * stride) * step;
        aci = pa < 0 ? 0 : ymin + (y0 + Math.floor(pa / cols) * stride) * step;
        azr = 0; azi = 0; ai = 0; amin = 4;
      }
      if (bEnd) {
        if (pb >= 0) {
          out[pb] = bd2 < bailout ? 0 : smooth ? bi + 5 - Math.log2(Math.log2(bd2) / 2)
                                               : Math.min(Math.sqrt(bmin) / 0.007, 254) + 1;
        }
        pb = next < count ? todo[next++] : -1;
        if (pa < 0 && pb < 0) break;
        bcr = pb < 0 ? 0 : xmin + (x0 + (pb % cols) * stride) * step;
        bci = pb < 0 ? 0 : ymin + (y0 + Math.floor(pb / cols) * stride) * step;
        bzr = 0; bzi = 0; bi = 0; bmin = 4;
      }
    }
    return out;
  }
  // perturbValue's loop, two lanes (azr, azi hold dz).
  for (;;) {
    for (;;) {
      const a2r = 2 * aZr + azr, a2i = 2 * aZi + azi;
      const b2r = 2 * bZr + bzr, b2i = 2 * bZi + bzi;
      const at = a2r * azr - a2i * azi + acr;
      const bt = b2r * bzr - b2i * bzi + bcr;
      azi = a2r * azi + a2i * azr + aci;
      bzi = b2r * bzi + b2i * bzr + bci;
      azr = at;
      bzr = bt;
      am++;
      bm++;
      aZr = ref[2 * am];
      aZi = ref[2 * am + 1];
      bZr = ref[2 * bm];
      bZi = ref[2 * bm + 1];
      const zar = aZr + azr, zai = aZi + azi, zbr = bZr + bzr, zbi = bZi + bzi;
      ad2 = zar * zar + zai * zai;
      bd2 = zbr * zbr + zbi * zbi;
      aEnd = ad2 >= bailout;
      bEnd = bd2 >= bailout;
      if (!aEnd) {
        if (ad2 < amin) amin = ad2;
        if (ad2 < azr * azr + azi * azi || am === last) {
          azr = zar; azi = zai; am = 0; aZr = 0; aZi = 0;
        }
        aEnd = ++ai === iterations;
      }
      if (!bEnd) {
        if (bd2 < bmin) bmin = bd2;
        if (bd2 < bzr * bzr + bzi * bzi || bm === last) {
          bzr = zbr; bzi = zbi; bm = 0; bZr = 0; bZi = 0;
        }
        bEnd = ++bi === iterations;
      }
      if (aEnd || bEnd) break;
    }
    if (aEnd) {
      if (pa >= 0) {
        out[pa] = ad2 < bailout ? 0 : smooth ? ai + 5 - Math.log2(Math.log2(ad2) / 2)
                                             : Math.min(Math.sqrt(amin) / 0.007, 254) + 1;
      }
      pa = next < count ? todo[next++] : -1;
      if (pa < 0 && pb < 0) break;
      acr = pa < 0 ? 0 : xmin + (x0 + (pa % cols) * stride) * step;
      aci = pa < 0 ? 0 : ymin + (y0 + Math.floor(pa / cols) * stride) * step;
      azr = 0; azi = 0; aZr = 0; aZi = 0; am = 0; ai = 0; amin = 4;
    }
    if (bEnd) {
      if (pb >= 0) {
        out[pb] = bd2 < bailout ? 0 : smooth ? bi + 5 - Math.log2(Math.log2(bd2) / 2)
                                             : Math.min(Math.sqrt(bmin) / 0.007, 254) + 1;
      }
      pb = next < count ? todo[next++] : -1;
      if (pa < 0 && pb < 0) break;
      bcr = pb < 0 ? 0 : xmin + (x0 + (pb % cols) * stride) * step;
      bci = pb < 0 ? 0 : ymin + (y0 + Math.floor(pb / cols) * stride) * step;
      bzr = 0; bzi = 0; bZr = 0; bZi = 0; bm = 0; bi = 0; bmin = 4;
    }
  }
  return out;
}

// Renders a band of rows to RGBA, mapping values in [lo, hi] across the
// palette. Shipped to the workers via toString() along with orbitValues, so
// it must not reference anything else. In high-resolution jobs (job.hd),
// xmin/ymin are offsets from the reference orbit's center. `values` is an
// optional Float64Array to reuse (at least width * rows long).
// Orbit-trap values are brightest near the set (small values); smooth escape
// times are brightest near the set too, but there that means large values.
function renderBand(job, lut, ref, values) {
  const { width, rows, lo, hi, quantiles, smooth } = job;
  const n = width * rows;
  if (!values || values.length < n) values = new Float64Array(n);
  orbitValues({ ...job, cols: width, x0: 0, stride: 1 }, ref, values);
  const qn = quantiles ? quantiles.length - 1 : 0;
  const out = new Uint8ClampedArray(n * 4);
  const top = lut.length / 3 - 1;
  const span = Math.max(hi - lo, 1e-9);
  for (let p = 0, o = 0; p < n; p++, o += 4) {
    out[o + 3] = 255;
    const value = values[p];
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
//
// Points inside the set (every tour stop is a minibrot nucleus, and dives
// toward one stay inside its component) are attracted to a cycle, and the
// fixed-point map, being deterministic on a finite state, then repeats
// exactly. Brent's cycle detection (compare each state with one saved at the
// last power of two) finds that within a couple of periods, after which the
// rest of the orbit is a copy: bit-for-bit what iterating would produce, at
// none of the BigInt cost. period = 0 until a cycle is found; (sx, sy) is the
// saved state Z_mark.
function makeReference(cx, cy) {
  return { cx: cx.m, cy: cy.m, e: cx.e, zx: 0n, zy: 0n, len: 1, escaped: false,
           period: 0, sx: 0n, sy: 0n, mark: 0, data: new Float64Array(2 * 1024) };
}

function extendReference(ref, iters) {
  if (ref.escaped || ref.len > iters) return;
  const E = BigInt(ref.e), E1 = E - 1n, { cx, cy, e } = ref;
  let { zx, zy, len, data, period, sx, sy, mark } = ref;
  if (data.length < 2 * (iters + 1)) {
    // Grow geometrically: the GPU renderer doubles its limit step by step.
    const grown = new Float64Array(2 * Math.max(iters + 1, data.length));
    grown.set(data.subarray(0, 2 * len));
    data = grown;
  }
  // bigToDouble inlined, minus its allocations and constant work: the same
  // rounded shift (none below 1000 bits), Number() and two powers of two.
  // Its rescue path for values under 2^64 after the shift (Z within 2^-936
  // of 0) is left to bigToDouble itself.
  const s = Math.max(0, e - 1000), S = BigInt(s), half = s ? 1n << BigInt(s - 1) : 0n;
  const sa = 2 ** Math.ceil((s - e) / 2), sb = 2 ** Math.floor((s - e) / 2);
  const toDouble = (m) => {
    if (!s) return Number(m) * sa * sb;
    const x = Number((m + half) >> S);
    return Math.abs(x) < 2 ** 64 ? bigToDouble({ m, e }) : x * sa * sb;
  };
  while (!period && len <= iters) {
    // (zx + zy)(zx - zy) is exactly zx^2 - zy^2 with one multiply fewer.
    const nx = (((zx + zy) * (zx - zy)) >> E) + cx;
    zy = ((zx * zy) >> E1) + cy;
    zx = nx;
    const r = toDouble(zx), i = toDouble(zy);
    data[2 * len] = r;
    data[2 * len + 1] = i;
    if (r * r + i * i > 4) { len++; ref.escaped = true; break; }
    if (zx === sx && zy === sy) period = len - mark;
    else if (len === 2 * mark || mark === 0) { sx = zx; sy = zy; mark = len; }
    len++;
  }
  if (period) {
    for (let k = 2 * len, end = 2 * (iters + 1); k < end; k++) data[k] = data[k - 2 * period];
    len = Math.max(len, iters + 1);
  }
  Object.assign(ref, { zx, zy, len, data, period, sx, sy, mark });
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
  // The last orbit is kept and extended when the same center comes back with
  // a higher limit (the GPU renderer doubles its limit as a final image
  // settles), instead of starting over. The reply is cut to what a fresh
  // orbit of `iters` would be, so a longer cached one changes nothing.
  let last = null;
  const local = (cx, cy, e, iters) => {
    if (!last || last.cx !== cx || last.cy !== cy || last.e !== e) last = makeReference({ m: cx, e }, { m: cy, e });
    const ref = last;
    extendReference(ref, iters);
    const len = Math.min(ref.len, iters + 1);
    return { cx, cy, e, len, escaped: ref.escaped && len === ref.len, data: ref.data.slice(0, 2 * len) };
  };
  const SRC = `${shr}\n${bigToDouble}\n${makeReference}\n${extendReference}\nlet last = null;\nconst local = ${local};
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
    LOCATIONS, PALETTES, PALETTE_NAMES, LUT_SIZE, buildLut, orbitValue, perturbValue, orbitValues,
    renderBand,
    shr, rescale, bigAdd, bigNeg, bigSub, bigFromDouble, bigFromString, bigToDouble, bigToString,
    precisionFor, makeReference, extendReference, refWorker,
  };
}
