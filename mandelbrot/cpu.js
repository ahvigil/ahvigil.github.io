"use strict";
/*
 * CPU renderer: per-pixel rendering in background workers (or the main thread
 * if workers can't run). Low resolution iterates each pixel directly in
 * doubles; high resolution (page global hiRes) uses perturbation against a
 * reference orbit at the view center.
 *
 * Images render into an offscreen layer; frame() draws the last complete
 * layer and the one in progress onto #cpu, reprojected to the camera, so
 * panning and zooming move the existing image until a new one is rendered.
 * Drafts (target.final === false) are ignored: the CPU only renders when the
 * motion has settled.
 *
 * Implements the Renderer contract described in index.html.
 */
const cpuRenderer = (() => {
  const BAND_ROWS = 8;
  const canvas = document.getElementById("cpu");
  const ctx = canvas.getContext("2d");

  // Two kinds of job: { grid } computes orbit values for sampling (see
  // sampleView), { job } renders a band. The values buffer is reused across
  // bands; results go back as transferred buffers.
  const WORKER_SRC = `${orbitValues.toString()}
${renderBand.toString()}
let lut = null, ref = null, values = null;
onmessage = (e) => {
  const d = e.data;
  if (d.lut) { lut = d.lut; return; }
  if (d.ref) { ref = d.ref; return; }
  let out;
  if (d.grid) {
    out = orbitValues(d.grid, ref, new Float64Array(d.grid.cols * d.grid.rows));
  } else {
    const n = d.job.width * d.job.rows;
    if (!values || values.length < n) values = new Float64Array(n);
    out = renderBand(d.job, lut, ref, values);
  }
  postMessage({ gen: d.gen, id: d.id, out }, [out.buffer]);
};`;

  let workers = [];
  let reference = null;   // reference orbit for the current hi-res render
  let refData = null;     // reference.data as last sent to the workers
  let gen = 0, cancel = null;
  let range = null, effectiveIterations = 0;
  let target = null;      // last final target passed to setTarget
  let doneKey = null;     // key of the last target that finished rendering
  // Layers: front = last complete image, back = render in progress.
  // Each { canvas, ctx, center, distance }.
  let front = null, back = null;
  let dirty = true, lastCam = null;

  function startWorkers() {
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
      const count = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 12));
      for (let k = 0; k < count; k++) {
        const w = new Worker(url);
        w.postMessage({ lut: LUT });
        // If workers can't run here, fall back to the main thread once.
        w.addEventListener("error", () => {
          if (!workers.length) return;
          workers.forEach((x) => x.terminate());
          workers = [];
          if (target) render(target);
        }, { once: true });
        workers.push(w);
      }
    } catch (err) {
      workers = [];  // fall back to rendering on the main thread
    }
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
  const keyOf = (t) => `${t.center.x.m},${t.center.x.e},${t.center.y.m},${t.center.y.e},${t.distance},${t.maxColor}`;

  function makeLayer(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return { canvas: c, ctx: c.getContext("2d"), center: null, distance: 0 };
  }

  // Runs messages ({ grid } or { job }) on the workers, or on this thread in
  // between animation frames if there are none, calling done(i, out) for
  // each result. Resolves once all are in; never, if `run` is cancelled
  // (run.live = false) first, and results of cancelled runs are dropped.
  function runJobs(run, msgs, done) {
    return new Promise((resolve) => {
      let next = 0, left = msgs.length;
      if (!left) { resolve(); return; }
      const finish = (i, out) => {
        if (!run.live) return;
        done(i, out);
        if (--left === 0) resolve();
      };
      if (workers.length) {
        const feed = (w) => {
          if (run.live && next < msgs.length) { w.postMessage({ gen: run.gen, id: next, ...msgs[next] }); next++; }
        };
        for (const w of workers) {
          w.onmessage = (e) => {
            if (e.data.gen !== run.gen) return;
            finish(e.data.id, e.data.out);
            feed(w);
          };
          feed(w);
        }
      } else {
        (async () => {
          let yielded = performance.now();
          for (let i = 0; i < msgs.length && run.live; i++) {
            const m = msgs[i];
            finish(i, m.grid
              ? orbitValues(m.grid, refData, new Float64Array(m.grid.cols * m.grid.rows))
              : renderBand(m.job, LUT, refData));
            if (performance.now() - yielded > 30) { await nextFrame(); yielded = performance.now(); }
          }
        })();
      }
    });
  }

  // Hi-res: makes the reference orbit cover `iters` and sends it to the
  // workers if it grew.
  function syncReference(run, iters) {
    if (!run.geo.hd) return;
    extendReference(reference, iters);
    if (refData && refData.length === 2 * reference.len) return;
    refData = reference.data.slice(0, 2 * reference.len);
    workers.forEach((w) => w.postMessage({ ref: refData }));
  }

  // Orbit values on a coarse grid of about `count` points across the view
  // (0 for points that never escaped), computed by the workers in chunks of
  // grid rows so the main thread stays free.
  async function sampleView(run, width, height, iters, count, smooth = false) {
    const k = Math.max(1, Math.ceil(Math.sqrt((width * height) / count)));
    const x0 = k >> 1;
    const cols = Math.ceil((width - x0) / k), rows = Math.ceil((height - x0) / k);
    syncReference(run, iters);
    const chunk = Math.max(1, Math.ceil(rows / (4 * Math.max(1, workers.length))));
    const msgs = [];
    for (let r = 0; r < rows; r += chunk) {
      msgs.push({ grid: { ...run.geo, cols, rows: Math.min(chunk, rows - r), x0, y0: x0 + r * k, stride: k,
                          iterations: iters, smooth } });
    }
    const values = new Float64Array(cols * rows);
    await runJobs(run, msgs, (i, out) => values.set(out, i * chunk * cols));
    return values;
  }

  // Some regions (the antenna especially) escape far more slowly than zoom
  // depth suggests. Keep doubling iterations while that still turns a
  // meaningful share of "inside" samples into escaped ones.
  async function adaptIterations(run, width, height, iters) {
    const stuck = async (it) => {
      const values = await sampleView(run, width, height, it, 4000);
      let zeros = 0;
      for (const v of values) if (v === 0) zeros++;
      return zeros / 4000;
    };
    let current = await stuck(iters);
    while (iters < (1 << 16) && current > 0.002) {
      const next = await stuck(iters * 2);
      if (current - next < 0.005) break;
      iters *= 2;
      current = next;
    }
    return iters;
  }

  // How values map onto the palette. Auto mode equalizes: colors are assigned by
  // rank among on-screen samples, so the whole palette is used even when the
  // values bunch up. Otherwise it reproduces mb.py's (value + 1) / max_color.
  // lo/hi (1st-98th percentile) are kept for the max_color shown and copied.
  //
  // Deep in, the orbit trap stops working (trapIsFlat in core.js); then
  // switch to (equalized) smooth escape time, which keeps varying.
  async function colorRange(run, width, height, iters, maxColor) {
    // values: Float64Array of escaped samples (its numeric sort beats Array's).
    const equalize = (values) => {
      if (values.length < 50) return null;
      values.sort();
      const lo = values[Math.floor(values.length * 0.01)];
      const hi = values[Math.floor(values.length * 0.98)];
      const quantiles = Array.from({ length: 257 }, (_, i) =>
        values[Math.floor((i / 256) * (values.length - 1))]);
      return { lo, hi: Math.max(hi, lo + 1), quantiles, smooth: false };
    };
    const escape = async () => {
      const r = equalize((await sampleView(run, width, height, iters, 20000, true)).filter((v) => v));
      return r && { ...r, smooth: true };
    };
    if (colorMode === "escape") {
      const r = await escape();
      if (r) return r;
    }
    const samples = (await sampleView(run, width, height, iters, 20000)).filter((v) => v);
    const repeats = 1 - new Set(samples).size / samples.length;
    const trap = equalize(samples);  // sorts samples
    if (colorMode === "auto" && trap && trapIsFlat(samples, repeats)) {
      const r = await escape();
      if (r) return r;
    }
    if (autoRange && trap) return trap;
    return { lo: -1, hi: maxColor - 1, quantiles: null, smooth: false };
  }

  // Renders a target progressively into the back layer, then swaps it to the
  // front. Sampling (iterations, color range) runs in the workers first; the
  // previous image stays on screen meanwhile.
  function render(t) {
    if (cancel) cancel();
    const key = keyOf(t);
    const width = canvas.width, height = canvas.height;
    const { center, distance, maxColor } = t;
    const step = distance / 3 / width;
    let geo;
    if (hiRes) {
      // Pixels are offsets from the exact center, whose orbit is the reference.
      const e = precisionFor(step);
      const cx = rescale(center.x, e), cy = rescale(center.y, e);
      if (!reference || reference.cx !== cx.m || reference.cy !== cy.m || reference.e !== e) {
        reference = makeReference(cx, cy);
        refData = null;
      }
      // Skipping the main cardioid and period-2 bulb needs absolute
      // coordinates, which doubles only give where lo-res would still work.
      const x = bigToDouble(center.x), y = bigToDouble(center.y);
      const bulbs = step >= 8 * Number.EPSILON * Math.max(Math.abs(x), Math.abs(y), 1);
      geo = { xmin: -(step * width) / 2, ymin: -(step * height) / 2, step, hd: true, cx: x, cy: y, bulbs };
    } else {
      const x = bigToDouble(center.x), y = bigToDouble(center.y);
      geo = { xmin: x - (step * width) / 2, ymin: y - (step * height) / 2, step, hd: false };
    }
    // { xmin, ymin, step, hd[, cx, cy, bulbs] }: see orbitValues.
    const run = { gen: ++gen, live: true, geo };
    cancel = () => { run.live = false; };

    (async () => {
      const iters = Math.min(1 << 16, Math.max(50, Math.round(
        (await adaptIterations(run, width, height, iterationsFor(distance))) * iterationScale)));
      const r = await colorRange(run, width, height, iters, maxColor);
      if (!run.live) return;
      effectiveIterations = iters;
      range = r;
      syncReference(run, iters);
      const msgs = [];
      for (let y0 = 0; y0 < height; y0 += BAND_ROWS) {
        msgs.push({ job: { width, y0, rows: Math.min(BAND_ROWS, height - y0), ...geo, iterations: iters, ...range } });
      }

      if (!back || back.canvas.width !== width || back.canvas.height !== height) back = makeLayer(width, height);
      back.ctx.clearRect(0, 0, width, height);
      back.center = center;
      back.distance = distance;
      const layer = back;
      dirty = true;
      await runJobs(run, msgs, (i, out) => {
        const { y0, rows } = msgs[i].job;
        layer.ctx.putImageData(new ImageData(out, width, rows), 0, y0);
        dirty = true;
      });
      if (!run.live) return;
      cancel = null;
      [front, back] = [back, front];
      if (back) back.center = null;  // the old front: nothing to show until reused
      doneKey = key;
      dirty = true;
    })();
  }

  // Draws a layer so that its pixels land where they belong for camera `cam`.
  function drawLayer(layer, cam) {
    const w = canvas.width, h = canvas.height;
    const camStep = cam.distance / 3 / w;
    const dw = w * (layer.distance / cam.distance);
    const dh = dw * (layer.canvas.height / layer.canvas.width);
    const dx = bigToDouble(bigSub(layer.center.x, cam.center.x)) / camStep;
    const dy = bigToDouble(bigSub(layer.center.y, cam.center.y)) / camStep;
    ctx.drawImage(layer.canvas, w / 2 + dx - dw / 2, h / 2 + dy - dh / 2, dw, dh);
  }

  const sameCam = (a, b) => b && a.distance === b.distance &&
    a.center.x.m === b.center.x.m && a.center.x.e === b.center.x.e &&
    a.center.y.m === b.center.y.m && a.center.y.e === b.center.y.e;

  return {
    name: "cpu",
    available: true,
    canvas,
    init() { startWorkers(); },
    resize(w, h) {
      canvas.width = w;
      canvas.height = h;
      dirty = true;
    },
    setPalette(lut) {
      workers.forEach((w) => w.postMessage({ lut }));
    },
    stop() {
      if (cancel) cancel();
      cancel = null;
      target = null;  // so the next final target renders again
    },
    setTarget(t) {
      if (!t.final) return;  // drafts: keep reprojecting the last image
      if (!t.force && target && keyOf(t) === keyOf(target) && (cancel || doneKey === keyOf(t))) return;
      target = t;
      render(t);
    },
    frame(cam) {
      if (!dirty && sameCam(cam, lastCam)) return;
      dirty = false;
      lastCam = cam;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const layer of [front, back]) if (layer && layer.center) drawLayer(layer, cam);
    },
    status() {
      return { done: !!target && !cancel && doneKey === keyOf(target), range, effectiveIterations };
    },
    // Smallest view distance that still renders sharply. In low resolution,
    // any deeper and neighboring pixels round to the same 64-bit float, so the
    // image turns into blocks (with headroom for rounding error that builds up
    // during iteration). In high resolution only the per-pixel offsets are
    // doubles, so the limit is where they would underflow.
    minDistance(x, y) {
      if (hiRes) return 1e-290;
      const minStep = 8 * Number.EPSILON * Math.max(Math.abs(x), Math.abs(y), 1);
      return 3 * canvas.width * minStep;
    },
  };
})();
