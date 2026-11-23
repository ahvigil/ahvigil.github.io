"use strict";
// Unit tests for mandelbrot/core.js (pure math, no DOM). Run from mandelbrot/: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

const {
  LOCATIONS, orbitValue, perturbValue, orbitValues, bigFromString, bigFromDouble, bigToDouble,
  bigToString, bigSub, precisionFor, makeReference, extendReference,
} = core;

// A tour stop's exact center at the precision the page uses.
function centerOf([x, y, d]) {
  const bits = precisionFor(d / 3 / 8192);
  const big = (v) => (typeof v === "string" ? bigFromString(v, bits) : bigFromDouble(v, bits));
  return { x: big(x), y: big(y), bits };
}

// The reference orbit the straightforward way: no cycle detection, no
// shortcuts. extendReference must match it bit for bit.
function naiveReference(cx, cy, iters) {
  const e = cx.e, E = BigInt(e), E1 = E - 1n;
  let zx = 0n, zy = 0n, len = 1, escaped = false;
  const data = [0, 0];
  while (len <= iters) {
    const nx = ((zx * zx - zy * zy) >> E) + cx.m;
    zy = ((zx * zy) >> E1) + cy.m;
    zx = nx;
    const r = bigToDouble({ m: zx, e }), i = bigToDouble({ m: zy, e });
    data.push(r, i);
    len++;
    if (r * r + i * i > 4) { escaped = true; break; }
  }
  return { len, escaped, data };
}

function assertSameOrbit(ref, naive, label) {
  assert.equal(ref.len, naive.len, `${label}: len`);
  assert.equal(ref.escaped, naive.escaped, `${label}: escaped`);
  for (let k = 0; k < 2 * naive.len; k++) {
    if (!Object.is(ref.data[k], naive.data[k])) {
      assert.fail(`${label}: data[${k}] = ${ref.data[k]}, expected ${naive.data[k]}`);
    }
  }
}

test("tour stops are well formed", () => {
  assert.ok(LOCATIONS.length >= 2);
  for (const [i, stop] of LOCATIONS.entries()) {
    const [x, y, d, maxColor, name] = stop;
    assert.equal(stop.length, 5, `stop ${i}: [x, y, distance, maxColor, name]`);
    assert.ok(typeof name === "string" && name.length > 0, `stop ${i}: name`);
    assert.ok(Number.isFinite(Number(x)) && Number.isFinite(Number(y)), `stop ${i}: center`);
    assert.ok(d >= 1e-20 && d <= 6.75, `stop ${i}: distance ${d} within [1e-20, 6.75]`);
    assert.ok(maxColor > 0, `stop ${i}: maxColor`);
    if (typeof x === "string") assert.ok(bigFromString(x, 64), `stop ${i}: x parses`);
    if (typeof y === "string") assert.ok(bigFromString(y, 64), `stop ${i}: y parses`);
  }
});

test("decimal text round-trips through big numbers", () => {
  for (const s of ["-0.743643887037159272051", "0.2549870375310423776490622441", "-1.999999117587260825"]) {
    const v = bigFromString(s, 200);
    const back = bigToString(v, s.split(".")[1].length);
    assert.equal(Number(back), Number(s));
    assert.equal(back.replace(/0+$/, ""), s.replace(/0+$/, ""));
  }
  const a = bigFromString("0.1", 128), b = bigFromString("0.3", 128);
  assert.ok(Math.abs(bigToDouble(bigSub(b, a)) - 0.2) < 1e-15);
});

test("extendReference matches naive iteration at every tour stop", () => {
  for (const [i, stop] of LOCATIONS.entries()) {
    const c = centerOf(stop);
    for (const iters of [100, 3000, 20000]) {
      const ref = makeReference(c.x, c.y);
      extendReference(ref, iters);
      assertSameOrbit(ref, naiveReference(c.x, c.y, iters), `stop ${i} at ${iters}`);
    }
  }
});

test("extendReference extended in steps matches one long run", () => {
  const c = centerOf(LOCATIONS[4]);
  const ref = makeReference(c.x, c.y);
  for (const iters of [10, 500, 501, 4000, 4100, 9000]) extendReference(ref, iters);
  assertSameOrbit(ref, naiveReference(c.x, c.y, 9000), "stepped");
  // Off-nucleus points: escaping and non-repeating orbits.
  for (const [x, y] of [["0.3", "0.5"], ["-0.7436", "0.1318"], ["-1.25066", "0.0201"]]) {
    const cx = bigFromString(x, 120), cy = bigFromString(y, 120);
    const r = makeReference(cx, cy);
    extendReference(r, 300);
    extendReference(r, 5000);
    assertSameOrbit(r, naiveReference(cx, cy, 5000), `${x}, ${y}`);
  }
});

test("orbitValues equals orbitValue pixel for pixel (low resolution)", () => {
  const cols = 40, rows = 25, step = 0.012;
  for (const smooth of [false, true]) {
    const g = { cols, rows, x0: 0, y0: 0, stride: 1, xmin: -0.9, ymin: -0.15, step, iterations: 800, smooth, hd: false };
    const out = orbitValues(g, null, new Float64Array(cols * rows));
    for (let p = 0; p < cols * rows; p++) {
      const want = orbitValue(g.xmin + (p % cols) * step, g.ymin + Math.floor(p / cols) * step, 800, smooth);
      assert.ok(Object.is(out[p], want), `smooth=${smooth} pixel ${p}: ${out[p]} vs ${want}`);
    }
  }
});

test("orbitValues equals perturbValue pixel for pixel (high resolution)", () => {
  const stop = LOCATIONS[4], c = centerOf(stop);
  const cols = 32, rows = 20, step = stop[2] / 3 / cols, iterations = 6000;
  const ref = makeReference(c.x, c.y);
  extendReference(ref, iterations);
  const data = ref.data.slice(0, 2 * ref.len);
  for (const smooth of [false, true]) {
    const g = {
      cols, rows, x0: 0, y0: 0, stride: 1, xmin: -step * cols / 2, ymin: -step * rows / 2, step,
      iterations, smooth, hd: true, cx: bigToDouble(c.x), cy: bigToDouble(c.y),
    };
    const out = orbitValues(g, data, new Float64Array(cols * rows));
    for (let p = 0; p < cols * rows; p++) {
      const want = perturbValue(g.xmin + (p % cols) * step, g.ymin + Math.floor(p / cols) * step,
                                data, ref.len, iterations, smooth);
      assert.ok(Object.is(out[p], want), `smooth=${smooth} pixel ${p}: ${out[p]} vs ${want}`);
    }
  }
});

test("perturbation agrees with direct iteration where doubles still resolve the view", () => {
  // Distance 1e-6 near the seahorse valley: plain doubles are exact enough,
  // so both methods must classify (almost) every pixel the same way.
  const cx0 = -0.7436438, cy0 = 0.1318259, d = 1e-6, cols = 48, rows = 30, iterations = 3000;
  const step = d / 3 / cols;
  const cx = bigFromDouble(cx0, 128), cy = bigFromDouble(cy0, 128);
  const ref = makeReference(cx, cy);
  extendReference(ref, iterations);
  let differ = 0, close = 0, both = 0;
  for (let p = 0; p < cols * rows; p++) {
    const dx = (p % cols - cols / 2) * step, dy = (Math.floor(p / cols) - rows / 2) * step;
    const a = orbitValue(cx0 + dx, cy0 + dy, iterations, true);
    const b = perturbValue(dx, dy, ref.data, ref.len, iterations, true);
    if ((a === 0) !== (b === 0)) differ++;
    else if (a && b) { both++; if (Math.abs(a - b) < 0.01 * Math.max(1, a)) close++; }
  }
  assert.ok(differ <= cols * rows * 0.002, `inside/outside disagree on ${differ} pixels`);
  // Direct iteration in doubles drifts near the boundary over thousands of
  // iterations (chaos amplifies rounding), so a few escape times differ.
  assert.ok(close >= both * 0.95, `escape times close on ${close}/${both} pixels`);
});

test("perturbation agrees with an exact reference at a deep stop", () => {
  // Pixels iterated directly in big numbers (slow but exact) against
  // perturbValue around the deep neck stop: they must agree on which
  // pixels are inside.
  const stop = LOCATIONS[4], c = centerOf(stop), iterations = 4000;
  const step = stop[2] / 3 / 24;
  const ref = makeReference(c.x, c.y);
  extendReference(ref, iterations);
  const e = c.bits + 16, E = BigInt(e), E1 = E - 1n, four = 4n << E;
  let checked = 0, differ = 0;
  for (let k = 0; k < 24; k++) {
    const dx = (k - 12) * step * 0.9, dy = ((k * 7) % 24 - 12) * step * 0.6;
    const pcx = bigAddDouble(c.x, dx, e), pcy = bigAddDouble(c.y, dy, e);
    let zx = 0n, zy = 0n, inside = true;
    for (let i = 0; i < iterations; i++) {
      const nx = ((zx * zx - zy * zy) >> E) + pcx;
      zy = ((zx * zy) >> E1) + pcy;
      zx = nx;
      if (((zx * zx + zy * zy) >> E) > four) { inside = false; break; }
    }
    const v = perturbValue(dx, dy, ref.data, ref.len, iterations, false);
    checked++;
    if (inside !== (v === 0)) differ++;
  }
  assert.ok(differ <= 1, `${differ}/${checked} pixels disagree with exact iteration`);
});

function bigAddDouble(a, v, e) {
  const x = core.rescale(a, e), d = bigFromDouble(v, e);
  return x.m + d.m;
}

test("auto coloring treats a flat or repetitive orbit trap as flat", () => {
  const { trapIsFlat } = core;
  const ramp = (n, lo, hi) => Float64Array.from({ length: n }, (_, i) => lo + (hi - lo) * i / (n - 1));
  assert.equal(trapIsFlat(ramp(1000, 1, 200), 0), false, "a normal spread of values");
  assert.equal(trapIsFlat(ramp(1000, 1.0008, 1.9), 0), true, "all within a unit (deep minibrot glow)");
  assert.equal(trapIsFlat(ramp(1000, 1, 200), 0.2), true, "many exact repeats");
  assert.equal(trapIsFlat(ramp(20, 1, 1.1), 0), false, "too few samples to judge");
});

test("every escape-time color mapping produces palette colors", () => {
  const { renderBand, buildLut, PALETTE_NAMES } = core;
  const width = 64, rows = 8, step = 0.02;
  const lut = buildLut("ultra");
  const job = { width, y0: 0, rows, xmin: -1.0, ymin: 0.2, step, iterations: 500, smooth: true, hd: false };
  // Equal-area quantiles from the band's own values, as the renderers do.
  const vals = [];
  for (let p = 0; p < width * rows; p++) {
    const v = core.orbitValue(job.xmin + (p % width) * step, job.ymin + Math.floor(p / width) * step, 500, true);
    if (v) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const quantiles = Array.from({ length: 257 }, (_, i) => vals[Math.floor((i / 256) * (vals.length - 1))]);
  const colors = new Set();
  for (let i = 0; i < lut.length; i += 3) colors.add(`${lut[i]},${lut[i + 1]},${lut[i + 2]}`);
  for (const map of [0, 1, 2, 3]) {
    const out = renderBand({ ...job, lo: vals[5], hi: vals[vals.length - 5], quantiles, map }, lut, null);
    let distinct = new Set();
    for (let o = 0; o < out.length; o += 4) {
      const c = `${out[o]},${out[o + 1]},${out[o + 2]}`;
      assert.equal(out[o + 3], 255, `map ${map}: opaque`);
      assert.ok(c === "0,0,0" || colors.has(c), `map ${map}: ${c} is a palette color`);
      distinct.add(c);
    }
    assert.ok(distinct.size > 20, `map ${map}: uses the palette (${distinct.size} colors)`);
  }
  assert.ok(PALETTE_NAMES.length >= 2);
});

test("tour stop names are unique", () => {
  const names = LOCATIONS.map((l) => l[4]);
  assert.equal(new Set(names).size, names.length);
});
