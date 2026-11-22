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

  const WORKER_SRC = `${orbitValue.toString()}
${perturbValue.toString()}
${renderBand.toString()}
let lut = null, ref = null;
onmessage = (e) => {
  const d = e.data;
  if (d.lut) { lut = d.lut; return; }
  if (d.ref) { ref = d.ref; return; }
  const out = renderBand(d.job, lut, ref);
  postMessage({ gen: d.gen, y0: d.job.y0, rows: d.job.rows, out }, [out.buffer]);
};`;

  let workers = [];
  let geometry = null;    // { xmin, ymin, step, hd } of the render in progress
  let reference = null;   // reference orbit for the current hi-res render
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

  // Orbit values on a coarse grid of about `count` points across the view
  // (0 for points that never escaped).
  function sampleView(width, height, iters, count, smooth = false) {
    const k = Math.max(1, Math.ceil(Math.sqrt((width * height) / count)));
    const { xmin, ymin, step, hd } = geometry;
    if (hd) extendReference(reference, iters);
    const values = [];
    for (let py = k >> 1; py < height; py += k) {
      for (let px = k >> 1; px < width; px += k) {
        const cr = xmin + px * step, ci = ymin + py * step;
        values.push(hd
          ? perturbValue(cr, ci, reference.data, reference.len, iters, smooth)
          : orbitValue(cr, ci, iters, smooth));
      }
    }
    return values;
  }

  // Some regions (the antenna especially) escape far more slowly than zoom
  // depth suggests. Keep doubling iterations while that still turns a
  // meaningful share of "inside" samples into escaped ones.
  function adaptIterations(width, height, iters) {
    const stuck = (it) => sampleView(width, height, it, 4000).filter((v) => v === 0).length / 4000;
    let current = stuck(iters);
    while (iters < (1 << 16) && current > 0.002) {
      const next = stuck(iters * 2);
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
  // Deep in, the orbit trap stops working: it's set within the first few
  // iterations, where neighboring pixels' orbits are identical in doubles, so
  // many pixels get exactly the same value. When repeats show up on screen
  // (normal views have essentially none), switch to (equalized) smooth escape
  // time, which doesn't.
  function colorRange(width, height, iters, maxColor) {
    const equalize = (values) => {
      if (values.length < 50) return null;
      values.sort((a, b) => a - b);
      const lo = values[Math.floor(values.length * 0.01)];
      const hi = values[Math.floor(values.length * 0.98)];
      const quantiles = Array.from({ length: 257 }, (_, i) =>
        values[Math.floor((i / 256) * (values.length - 1))]);
      return { lo, hi: Math.max(hi, lo + 1), quantiles, smooth: false };
    };
    const escape = () => {
      const r = equalize(sampleView(width, height, iters, 20000, true).filter((v) => v));
      return r && { ...r, smooth: true };
    };
    if (colorMode === "escape") {
      const r = escape();
      if (r) return r;
    }
    const samples = sampleView(width, height, iters, 20000).filter((v) => v);
    const repeats = 1 - new Set(samples).size / samples.length;
    const trap = equalize(samples);
    if (colorMode === "auto" && trap && repeats > 0.05) {
      const r = escape();
      if (r) return r;
    }
    if (autoRange && trap) return trap;
    return { lo: -1, hi: maxColor - 1, quantiles: null, smooth: false };
  }

  // Renders a target progressively into the back layer, then swaps it to the
  // front.
  function render(t) {
    if (cancel) cancel();
    const my = ++gen;
    const key = keyOf(t);
    const width = canvas.width, height = canvas.height;
    const { center, distance, maxColor } = t;
    const step = distance / 3 / width;
    if (hiRes) {
      // Pixels are offsets from the exact center, whose orbit is the reference.
      const e = precisionFor(step);
      const cx = rescale(center.x, e), cy = rescale(center.y, e);
      if (!reference || reference.cx !== cx.m || reference.cy !== cy.m || reference.e !== e) {
        reference = makeReference(cx, cy);
      }
      geometry = { xmin: -(step * width) / 2, ymin: -(step * height) / 2, step, hd: true };
    } else {
      const x = bigToDouble(center.x), y = bigToDouble(center.y);
      geometry = { xmin: x - (step * width) / 2, ymin: y - (step * height) / 2, step, hd: false };
    }
    const iters = effectiveIterations = Math.min(1 << 16, Math.max(50, Math.round(
      adaptIterations(width, height, iterationsFor(distance)) * iterationScale)));
    range = colorRange(width, height, iters, maxColor);
    let ref = null;
    if (hiRes) {
      extendReference(reference, iters);
      ref = reference.data.slice(0, 2 * reference.len);
      workers.forEach((w) => w.postMessage({ ref }));
    }
    const jobs = [];
    for (let y0 = 0; y0 < height; y0 += BAND_ROWS) {
      jobs.push({ width, y0, rows: Math.min(BAND_ROWS, height - y0), ...geometry, iterations: iters, ...range });
    }

    if (!back || back.canvas.width !== width || back.canvas.height !== height) back = makeLayer(width, height);
    back.ctx.clearRect(0, 0, width, height);
    back.center = center;
    back.distance = distance;
    const layer = back;
    dirty = true;
    const draw = (y0, rows, out) => {
      layer.ctx.putImageData(new ImageData(out, width, rows), 0, y0);
      dirty = true;
    };

    let next = 0, done = 0, live = true;
    cancel = () => { live = false; };
    const complete = () => {
      if (++done === jobs.length && live) {
        cancel = null;
        [front, back] = [back, front];
        if (back) back.center = null;  // the old front: nothing to show until reused
        doneKey = key;
        dirty = true;
      }
    };
    if (workers.length) {
      const feed = (w) => { if (live && next < jobs.length) w.postMessage({ gen: my, job: jobs[next++] }); };
      for (const w of workers) {
        w.onmessage = (e) => {
          const d = e.data;
          if (d.gen !== my) return;
          draw(d.y0, d.rows, d.out);
          complete();
          feed(w);
        };
        feed(w);
      }
    } else {
      (async () => {
        for (const job of jobs) {
          if (!live) return;
          draw(job.y0, job.rows, renderBand(job, LUT, ref));
          complete();
          if (job.y0 % (BAND_ROWS * 8) === 0) await nextFrame();
        }
      })();
    }
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
