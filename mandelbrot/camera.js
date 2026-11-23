"use strict";
/*
 * Camera: what's on screen (cam) versus where the page wants to be (target),
 * the animation frame loop, and pointer input. Implements the camera contract
 * described in index.html.
 *
 * The frame loop always runs. While the camera moves (animation, drag, pinch,
 * recent wheel) it sends draft targets; once everything settles it sends the
 * final target once and, when the renderer reports done, fires onRendered.
 *
 * Centers are big numbers and stay exact: every new center is an exact big
 * anchor plus a double offset (offsets are only ever a few screens wide, or,
 * during a dive, measured from whichever endpoint is nearer in time).
 */
const camera = (() => {
  const MAX_DISTANCE = 6.75 * 4;      // zoomed all the way out
  const DIVE_APEX = 6.75 * 2;         // highest a dive may climb
  // Fastest a click zoom or dive may go, in e-folds of zoom (or the
  // equivalent pan) per second at the peak of the ease, so both move at the
  // same pace: the page's anim.speed (settings: camera speed).
  const DEFAULT_SPEED = 2;
  const maxSpeed = () => (anim && anim.speed > 0 ? anim.speed : DEFAULT_SPEED);
  const WHEEL_SETTLE_MS = 150;
  const DRAG_PX = 4;

  let run = null;                     // { t0, dur, at(u) -> cam, end: target, pausedAt }
  let pauseShown = false;             // final render of a paused dive's view sent
  let wheelUntil = 0;
  let needFinal = false;              // a final target is owed once settled
  let forceFinal = false;
  let awaiting = false;               // final target sent; waiting for done
  let lastDraft = null;               // cam last sent as a draft
  let started = false;

  const pointers = new Map();         // id -> { x, y, sx, sy, dragging }
  let gesture = false;                // more than one pointer, or dragged: not a click
  let pinch = null;                   // { mx, my, d } last midpoint and spacing

  const stage = () => document.getElementById("stage");
  const size = () => { const s = stage(); return { w: s.clientWidth || 1, h: s.clientHeight || 1 }; };
  const bitsFor = (distance) => precisionFor(distance / 3 / 8192);
  // Sine ease in-out: gentle start and stop, peak speed pi/2 times average.
  const ease = (u) => (1 - Math.cos(Math.PI * u)) / 2;
  const EASE_PEAK = Math.PI / 2;
  const reduced = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

  // anchor + (dx, dy) as an exact big center at the precision of `distance`.
  function offsetCenter(anchor, dx, dy, distance) {
    // Never drop bits the anchor already has: zooming out and back in must
    // return to exactly the same deep center.
    const bits = Math.max(bitsFor(distance), anchor.x.e, anchor.y.e);
    return {
      x: bigAdd(rescale(anchor.x, bits), bigFromDouble(dx, bits)),
      y: bigAdd(rescale(anchor.y, bits), bigFromDouble(dy, bits)),
    };
  }

  // --- animations ---------------------------------------------------------------

  function zoomAnim(from, t) {
    const { w } = size();
    const d0 = from.distance, d1 = t.distance;
    const step0 = d0 / 3 / w;
    // The clicked point P = t.center starts s0 pixels from the screen center
    // and glides to it: center(u) = P - s0 (1 - e) step(u).
    const s0x = bigToDouble(bigSub(t.center.x, from.center.x)) / step0;
    const s0y = bigToDouble(bigSub(t.center.y, from.center.y)) / step0;
    const ratio = d1 / d0;
    // Zoom in e-folds and pan in view widths.
    const length = Math.hypot(Math.log(ratio), Math.hypot(s0x, s0y) / w);
    const at = (u) => {
      const e = ease(u);
      const distance = d0 * Math.pow(ratio, e);
      const k = (1 - e) * distance / 3 / w;
      return { center: offsetCenter(t.center, -s0x * k, -s0y * k, distance), distance };
    };
    return { at, minMs: EASE_PEAK * length / maxSpeed() * 1000 };
  }

  // van Wijk & Nuij smooth zoom and pan (as in d3.interpolateZoom), with
  // widths w0, w1 and center offset d (all in the same units).
  function wijkPath(w0, w1, d, rho) {
    const rho2 = rho * rho, rho4 = rho2 * rho2;
    if (d < 1e-9 * Math.max(w0, w1)) {
      const S = Math.log(w1 / w0) / rho;
      return { S, at: (t) => ({ f: t, w: w0 * Math.exp(rho * t * S) }) };
    }
    const b0 = (w1 * w1 - w0 * w0 + rho4 * d * d) / (2 * w0 * rho2 * d);
    const b1 = (w1 * w1 - w0 * w0 - rho4 * d * d) / (2 * w1 * rho2 * d);
    const r0 = -Math.asinh(b0), r1 = -Math.asinh(b1);  // ln(sqrt(b^2+1) - b)
    const S = (r1 - r0) / rho;
    const cosh0 = Math.cosh(r0), sinh0 = Math.sinh(r0);
    return {
      S,
      at: (t) => {
        const s = t * S, a = rho * s + r0;
        return {
          f: (w0 / (rho2 * d)) * (cosh0 * Math.tanh(a) - sinh0),
          w: Math.min(w0 * cosh0 / Math.cosh(a), 1e300),
        };
      },
    };
  }

  function diveAnim(from, t) {
    const S0 = from.center, T = t.center;
    const dx = bigToDouble(bigSub(T.x, S0.x)), dy = bigToDouble(bigSub(T.y, S0.y));
    const w0 = from.distance, w1 = t.distance;
    const scale = Math.max(Math.hypot(dx, dy), w0, w1);
    const apex = (path) => {
      let m = 0;
      for (let i = 0; i <= 64; i++) m = Math.max(m, path.at(i / 64).w);
      return m;
    };
    // Scale to ~1 so squares of tiny widths don't underflow; cap the apex.
    const nd = Math.hypot(dx, dy) / scale, n0 = w0 / scale, n1 = w1 / scale;
    const cap = DIVE_APEX / scale;
    let rho = Math.SQRT2, path = wijkPath(n0, n1, nd, rho);
    if (apex(path) > cap) {
      let lo = 0.02, hi = rho;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (apex(wijkPath(n0, n1, nd, mid)) > cap) hi = mid; else lo = mid;
      }
      path = wijkPath(n0, n1, nd, lo);
    }
    // Peak speed per unit of path time: e-folds of zoom combined with pans
    // measured in view widths (a view is distance / 3 wide). With the ease's
    // peak, this sets the shortest duration under the cap.
    let peak = 0;
    for (let i = 0, prev = path.at(0); i < 256; i++) {
      const next = path.at((i + 1) / 256);
      const zoom = Math.log(next.w / prev.w);
      const pan = (next.f - prev.f) * nd / ((next.w + prev.w) / 6);
      peak = Math.max(peak, Math.hypot(zoom, pan) * 256);
      prev = next;
    }
    const minMs = EASE_PEAK * peak / maxSpeed() * 1000;
    const at = (u) => {
      const { f, w } = path.at(ease(u));
      const distance = Math.min(Math.max(w * scale, Math.min(w0, w1) * 0.5), Math.max(DIVE_APEX, w0, w1));
      // Offsets from the nearer endpoint (by pan progress) keep both ends exact.
      const center = f < 0.5
        ? offsetCenter(S0, f * dx, f * dy, distance)
        : offsetCenter(T, (f - 1) * dx, (f - 1) * dy, distance);
      return { center, distance };
    };
    return { at, minMs };
  }

  // --- input --------------------------------------------------------------------

  // Moves the camera so the content under screen point (ax, ay) ends at
  // (bx, by) with the view `distance` wide. Reports the view to the page;
  // past the zoom limit the zoom is dropped and only the pan applies.
  function moveCamera(distance, ax, ay, bx, by) {
    const cam = api.cam;
    if (!cam) return;
    const { w, h } = size();
    distance = Math.min(distance, MAX_DISTANCE);
    for (let attempt = 0; attempt < 2; attempt++) {
      const step0 = cam.distance / 3 / w, step1 = distance / 3 / w;
      const dx = (ax - w / 2) * step0 - (bx - w / 2) * step1;
      const dy = (ay - h / 2) * step0 - (by - h / 2) * step1;
      if (dx === 0 && dy === 0 && distance === cam.distance) return;
      const center = offsetCenter(cam.center, dx, dy, distance);
      if (moveTo(center, distance) !== false) {
        run = null;
        api.cam = { center, distance };
        api.target = { center, distance, maxColor: api.target ? api.target.maxColor : undefined };
        needFinal = true;
        return;
      }
      if (distance >= cam.distance) return;
      distance = cam.distance;  // past the limit: keep the old zoom
    }
  }

  function localXY(e) {
    const r = stage().getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function onWheel(e) {
    e.preventDefault();
    if (!api.cam) return;
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= window.innerHeight;
    dy = Math.max(-300, Math.min(300, dy));
    if (!dy) return;
    const [x, y] = localXY(e);
    wheelUntil = performance.now() + WHEEL_SETTLE_MS;
    moveCamera(api.cam.distance * Math.exp(dy * (e.ctrlKey ? 0.01 : 0.002)), x, y, x, y);
  }

  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1) };
  }

  function onDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const [x, y] = localXY(e);
    pointers.set(e.pointerId, { x, y, sx: x, sy: y, dragging: false });
    try { stage().setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    if (pointers.size === 1) gesture = false;
    else { gesture = true; if (pointers.size === 2) pinch = pinchState(); }
  }

  function onMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p || !api.cam) return;
    const [x, y] = localXY(e);
    if (pointers.size === 1) {
      if (!p.dragging) {
        if (Math.hypot(x - p.sx, y - p.sy) <= DRAG_PX) return;
        p.dragging = true;
        gesture = true;
        stage().style.cursor = "grabbing";
        p.x = p.sx; p.y = p.sy;
      }
      const ox = p.x, oy = p.y;
      p.x = x; p.y = y;
      moveCamera(api.cam.distance, ox, oy, x, y);
    } else if (pointers.size === 2) {
      p.x = x; p.y = y;
      const next = pinchState();
      const prev = pinch || next;
      pinch = next;
      stage().style.cursor = "grabbing";
      moveCamera(api.cam.distance * prev.d / next.d, prev.mx, prev.my, next.mx, next.my);
    } else {
      p.x = x; p.y = y;
    }
  }

  function onUp(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const click = e.type === "pointerup" && !gesture && !p.dragging;
    pointers.delete(e.pointerId);
    try { stage().releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (pointers.size === 0) { stage().style.cursor = ""; pinch = null; }
    else if (pointers.size === 1) {
      const rest = pointers.values().next().value;  // carry on dragging with it
      rest.dragging = true; rest.sx = rest.x; rest.sy = rest.y;
      pinch = null;
    }
    if (click) {
      const [x, y] = localXY(e);
      zoom(x, y, e.shiftKey ? 4 : 0.25);
    }
  }

  // --- frame loop ---------------------------------------------------------------

  function loop(now) {
    requestAnimationFrame(loop);
    if (!api.cam) return;
    if (run && !run.pausedAt) {
      const u = (now - run.t0) / run.dur;
      if (u >= 1) {
        api.cam = { center: run.end.center, distance: run.end.distance };
        run = null;
      } else {
        api.cam = run.at(Math.max(u, 0));
      }
    }
    const paused = !!run && !!run.pausedAt;
    const moving = (!!run && !paused) || pointers.size > 0 || now < wheelUntil;
    if (moving) {
      // Click zoom-ins skip drafts: the current image, stretched, already
      // covers the screen (see startAnim).
      if (api.cam !== lastDraft && api.target && !(run && !run.drafts)) {
        lastDraft = api.cam;
        renderer.setTarget({ center: api.cam.center, distance: api.cam.distance, maxColor: api.target.maxColor, final: false });
      }
    } else if (paused) {
      // Frozen mid-dive: render what's on screen at full quality (without
      // reporting it as the page's target being done).
      if ((!pauseShown || forceFinal) && api.target) {
        renderer.setTarget({ center: api.cam.center, distance: api.cam.distance,
                             maxColor: api.target.maxColor, final: true, force: forceFinal });
        pauseShown = true;
        forceFinal = false;
        lastDraft = null;
      }
    } else if (needFinal && api.target) {
      sendFinal();
    }
    renderer.frame(api.cam);
    if (awaiting && !needFinal && renderer.status().done) {
      awaiting = false;
      if (api.onRendered) api.onRendered();
    }
  }

  function sendFinal() {
    const t = { ...api.target, final: true };
    if (forceFinal) t.force = true;
    needFinal = forceFinal = false;
    awaiting = true;
    lastDraft = null;
    renderer.setTarget(t);
  }

  function startAnim(t, how) {
    const from = { center: api.cam.center, distance: api.cam.distance };
    const path = how === "dive" ? diveAnim(from, t) : zoomAnim(from, t);
    const dur = Math.max(1, how === "dive" ? anim.diveMs : anim.clickMs, path.minMs);
    api.target = t;
    run = {
      t0: performance.now(),
      dur,
      at: path.at,
      end: t,
      // Zooming in only magnifies what's on screen, so reprojecting the last
      // image is the preview. Draft renders there would use the base
      // iteration count, which can paint slow-escaping filaments black.
      drafts: how === "dive" || t.distance >= from.distance,
    };
    needFinal = true;
    awaiting = false;
  }

  const api = {
    cam: null,          // { center: { x, y } (big), distance } on screen now
    target: null,       // { center, distance, maxColor } the page asked for
    onRendered: null,   // set by the page: final target finished rendering
    init() {
      if (started) return;
      started = true;
      const s = stage();
      s.addEventListener("wheel", onWheel, { passive: false });
      s.addEventListener("pointerdown", onDown);
      s.addEventListener("pointermove", onMove);
      s.addEventListener("pointerup", onUp);
      s.addEventListener("pointercancel", onUp);
      requestAnimationFrame(loop);
    },
    jumpTo(t) {
      run = null;
      wheelUntil = 0;
      api.target = t;
      api.cam = { center: t.center, distance: t.distance };
      needFinal = true;
      forceFinal = false;
      sendFinal();
    },
    animateTo(t, how) {
      if (!api.cam || reduced()) { api.jumpTo(t); return; }
      startAnim(t, how === "dive" ? "dive" : "zoom");
    },
    refresh() {
      if (!api.target) return;
      needFinal = true;
      forceFinal = true;
      awaiting = true;
    },
    // Freezes an animation where it is (resume() carries on from there).
    pause() {
      if (!run || run.pausedAt) return;
      run.pausedAt = performance.now();
      pauseShown = false;
    },
    resume() {
      if (!run || !run.pausedAt) return;
      run.t0 += performance.now() - run.pausedAt;
      run.pausedAt = 0;
      lastDraft = null;
    },
    animating() { return !!run; },
  };
  return api;
})();
