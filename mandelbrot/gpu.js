"use strict";
/*
 * GPU renderer (WebGL2). Perturbation-only Mandelbrot with chunked, resumable
 * iteration on the GPU. Implements the Renderer contract described in
 * index.html.
 *
 * Structure:
 *   constants / shader sources     GLSL for the iteration passes (f32 and
 *                                  floatexp variants), stats reduce, colorize
 *                                  and the reprojecting display pass
 *   references                     reference orbits from refWorker, uploaded as
 *                                  RGBA32F textures; re-anchoring policy
 *   jobs                           one job = one image (draft or final): state
 *                                  textures (ping-pong MRT), iteration passes,
 *                                  async stats readback, growth by resuming
 *   coloring                       colorRange port of cpu.js, colorize pass
 *   frame loop                     budget (timer query or rAF feedback), draw
 *
 * Per-pixel state (two RGBA32F textures, ping-ponged):
 *   S0 = (dz.re, dz.im, m, dz exponent)   S1 = (trap, smooth, done, min|z|^2 hi)
 *   S2 = (min|z|^2 lo, trap correction, raw trap value, spare)
 * The iteration count is implicit: global iteration index, shared by all
 * pixels, so a job can be resumed with a larger limit.
 */
const gpuRenderer = (() => {
  // Pixel steps above this use plain float32 deltas; below it, floatexp
  // (float mantissa + integer exponent). Set from the numerical study.
  const F32_MIN_STEP = 1e-30;

  const REF_W = 4096;            // reference texture width
  const MAX_ITERS = 65536;
  const PASS_MAX = 512;          // iterations per pass (shader loop bound is 1024)
  const TARGET_MS = 9;           // GPU time per frame spent iterating
  // ... and once the camera has settled on a final view: nothing moves then, so
  // a frame can give more of itself to finishing the image sooner.
  const SETTLED_MS = 13;
  const STATS_SAMPLES = 16000;
  const ZERO_E = -1000000;       // exponent of a zero floatexp value
  const DRAFT_MAX_FRAMES = 8;
  const DRAFT_BLEND = 0.4;       // share of the way each draft moves the colors

  const canvas = document.getElementById("gl");

  let gl = null, available = false, lost = false;
  let timerExt = null;

  // --- shaders ----------------------------------------------------------------

  const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

  const VS = `${HEAD}
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const ITER_COMMON = `
uniform sampler2D uS0, uS1, uS2, uRef;
uniform float uOne;   // 1.0; stops the compiler regrouping two-float differences
uniform int uBase, uEnd, uRefLen;
uniform vec2 uImg;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
// (Z.re, Z.im, |Z|^2 hi, |Z|^2 lo)
vec4 refAt(int m) { return texelFetch(uRef, ivec2(m & 4095, m >> 12), 0); }
// Trap bookkeeping in two-float precision (the orbit trap value is a minimum of
// |Z + dz|^2 = |Z|^2 + delta; plain float32 would merge neighboring pixels that
// double precision tells apart, and the auto color mode relies on that).
// State: mh = S1.w, ml = S2.x (min |z|^2 = mh + ml); trapLo = S2.y.
void trapUpdate(vec4 Zn, float delta, bool escaped, inout float trap, inout float trapRaw, inout float trapLo,
                inout float mh, inout float ml) {
  float ch = Zn.z, cl = Zn.w + delta;
  float one = uOne;
  if (escaped) {
    // value = sqrt(mh + ml) / 0.007 as a raw float plus a first-order correction.
    float sq = sqrt(mh), Th, Tl = 0.0;
    if (mh > 0.0 && abs(ml) < 0.01 * mh) { Th = sq / 0.007; Tl = ml / (2.0 * sq) / 0.007; }
    else Th = sqrt(max(mh + ml, 0.0)) / 0.007;
    if (Th >= 254.0) { Th = 254.0; Tl = 0.0; }
    trap = Th + 1.0;
    trapRaw = Th;
    trapLo = Tl;
  } else if ((ch - mh) * one + (cl - ml) < 0.0) {
    mh = ch; ml = cl;
  }
}
`;

  // perturbValue in float32. Rebase test is done on values scaled by 2^40 so
  // the squares don't underflow when z and dz are tiny.
  const FS_F32 = `${HEAD}${ITER_COMMON}
uniform vec2 uOff;
uniform float uStep;
const float SC = 1099511627776.0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s0 = texelFetch(uS0, p, 0);
  vec4 s1 = texelFetch(uS1, p, 0);
  vec4 s2 = texelFetch(uS2, p, 0);
  if (s1.z > 0.5) { o0 = s0; o1 = s1; o2 = s2; return; }
  vec2 dc = uOff + (vec2(p) - 0.5 * uImg) * uStep;
  vec2 dz = s0.xy;
  int m = int(s0.z);
  float trap = s1.x, sm = s1.y, mh = s1.w, ml = s2.x, trapLo = s2.y, trapRaw = s2.z;
  float done = 0.0;
  for (int k = 0; k < 1024; k++) {
    int i = uBase + k;
    if (i >= uEnd) break;
    vec2 Z = refAt(m).xy;
    dz = vec2(2.0 * (Z.x * dz.x - Z.y * dz.y) + dz.x * dz.x - dz.y * dz.y,
              2.0 * (Z.x * dz.y + Z.y * dz.x + dz.x * dz.y)) + dc;
    m++;
    vec4 Zn = refAt(m);
    vec2 z = Zn.xy + dz;
    float d2 = dot(z, z);
    if (trap == 0.0) trapUpdate(Zn, 2.0 * dot(Zn.xy, dz) + dot(dz, dz), d2 >= 4.0, trap, trapRaw, trapLo, mh, ml);
    if (d2 >= 1e6) { sm = float(i) + 5.0 - log2(log2(d2) / 2.0); done = 1.0; break; }
    vec2 zs = z * SC, ds = dz * SC;
    if (dot(zs, zs) < dot(ds, ds) || m == uRefLen - 1) { dz = z; m = 0; }
  }
  o0 = vec4(dz, float(m), 0.0);
  o1 = vec4(trap, sm, done, mh);
  o2 = vec4(ml, trapLo, trapRaw, 0.0);
}`;

  // The same with dz and dc as (vec2 mantissa, int exponent).
  const FS_FE = `${HEAD}${ITER_COMMON}
uniform vec2 uOffM;
uniform int uOffE, uStepE;
uniform float uStepM;
const int ZE = ${ZERO_E};
struct FE { vec2 m; int e; };
float pow2(int e) { return intBitsToFloat((clamp(e, -126, 127) + 127) << 23); }
float scl(int d) { return d < -100 ? 0.0 : pow2(d); }
FE norm(vec2 m, int e) {
  float a = max(abs(m.x), abs(m.y));
  if (a < 1e-30) { m *= 1.8446744e19; a *= 1.8446744e19; e -= 64; }
  if (a < 1e-30) return FE(vec2(0.0), ZE);
  int x = ((floatBitsToInt(a) >> 23) & 255) - 127;
  return FE(m * pow2(-x), e + x);
}
FE sum3(vec2 a, int ea, vec2 b, int eb, vec2 c, int ec) {
  int E = max(ea, max(eb, ec));
  return norm(a * scl(ea - E) + b * scl(eb - E) + c * scl(ec - E), E);
}
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s0 = texelFetch(uS0, p, 0);
  vec4 s1 = texelFetch(uS1, p, 0);
  vec4 s2 = texelFetch(uS2, p, 0);
  if (s1.z > 0.5) { o0 = s0; o1 = s1; o2 = s2; return; }
  vec2 pm = (vec2(p) - 0.5 * uImg) * uStepM;
  FE dc = sum3(uOffM, uOffE, pm, uStepE, vec2(0.0), ZE);
  FE dz = FE(s0.xy, int(s0.w));
  if (dz.m == vec2(0.0)) dz.e = ZE;
  int m = int(s0.z);
  float trap = s1.x, sm = s1.y, mh = s1.w, ml = s2.x, trapLo = s2.y, trapRaw = s2.z;
  float done = 0.0;
  for (int k = 0; k < 1024; k++) {
    int i = uBase + k;
    if (i >= uEnd) break;
    vec2 Z = refAt(m).xy;
    dz = sum3(cmul(2.0 * Z, dz.m), dz.e, cmul(dz.m, dz.m), 2 * dz.e, dc.m, dc.e);
    m++;
    vec4 Zn = refAt(m);
    FE zn = norm(Zn.xy, 0);
    FE z = sum3(zn.m, zn.e, dz.m, dz.e, vec2(0.0), ZE);
    float d2 = z.e > -60 ? dot(z.m, z.m) * pow2(2 * z.e) : 0.0;
    if (trap == 0.0) {
      float delta = 0.0;
      if (dz.e > -100) { vec2 dzf = dz.m * pow2(dz.e); delta = 2.0 * dot(Zn.xy, dzf) + dot(dzf, dzf); }
      trapUpdate(Zn, delta, d2 >= 4.0, trap, trapRaw, trapLo, mh, ml);
    }
    if (d2 >= 1e6) { sm = float(i) + 5.0 - log2(log2(d2) / 2.0); done = 1.0; break; }
    float zz = dot(z.m, z.m), dd = dot(dz.m, dz.m);
    bool reb;
    if (dd == 0.0) reb = false;
    else if (zz == 0.0) reb = true;
    else {
      int de = z.e - dz.e;
      reb = de >= 64 ? false : (de <= -64 ? true : zz * scl(2 * de) < dd);
    }
    if (reb || m == uRefLen - 1) { dz = z; m = 0; }
  }
  o0 = vec4(dz.m, float(m), float(dz.e));
  o1 = vec4(trap, sm, done, mh);
  o2 = vec4(ml, trapLo, trapRaw, 0.0);
}`;

  const FS_REDUCE = `${HEAD}
uniform sampler2D uS1, uS2;
uniform vec2 uImg, uGrid;
out vec4 o;
void main() {
  vec2 g = floor(gl_FragCoord.xy);
  ivec2 p = min(ivec2((g + 0.5) * uImg / uGrid), ivec2(uImg) - 1);
  vec4 s = texelFetch(uS1, p, 0);
  vec4 t = texelFetch(uS2, p, 0);
  o = vec4(s.x, s.y, t.z, t.y);   // trap, smooth, raw trap value, its correction
}`;

  const FS_COLOR = `${HEAD}
uniform sampler2D uS1, uS2, uLut, uQ;
uniform int uSmooth, uHasQ, uComplete, uTop;
uniform float uLo, uHi;
out vec4 o;
// Quantiles and trap values are (float, float) pairs: the orbit trap differs
// between pixels far below float32 resolution at deep zooms.
vec2 q(int i) { return texelFetch(uQ, ivec2(i, 0), 0).rg; }
uniform float uOne;   // 1.0; keeps the compiler from regrouping the two-float difference
float dif(vec2 a, vec2 b) { return (a.x - b.x) * uOne + (a.y - b.y); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uS1, p, 0);
  vec4 t = texelFetch(uS2, p, 0);
  float v1 = uSmooth == 1 ? s.y : s.x;
  if (v1 == 0.0) { o = vec4(0.0, 0.0, 0.0, uComplete == 1 ? 1.0 : 0.0); return; }
  float rank;
  if (uHasQ == 1) {
    vec2 v = uSmooth == 1 ? vec2(s.y, 0.0) : vec2(t.z, t.y);   // trap: value - 1
    if (dif(v, q(0)) <= 0.0) rank = 0.0;
    else if (dif(v, q(256)) >= 0.0) rank = 1.0;
    else {
      int a = 0, b = 256;
      for (int k = 0; k < 10; k++) {
        if (b - a <= 1) break;
        int mid = (a + b) >> 1;
        if (dif(v, q(mid)) >= 0.0) a = mid; else b = mid;
      }
      float gap = dif(q(b), q(a));
      rank = (float(a) + (gap > 0.0 ? dif(v, q(a)) / gap : 0.0)) / 256.0;
    }
  } else {
    float v = uSmooth == 1 ? s.y : t.z + 1.0 + t.y;
    rank = clamp((v - uLo) / max(uHi - uLo, 1e-9), 0.0, 1.0);
  }
  float sv = uSmooth == 1 ? rank : 1.0 - rank;
  int li = int(floor(sv * float(uTop) + 0.5));
  o = vec4(texelFetch(uLut, ivec2(li, 0), 0).rgb, 1.0);
}`;

  const FS_DRAW = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uImg, uTexSize, uCanvas, uCenter, uSize;
uniform float uAlpha;
out vec4 o;
void main() {
  vec2 sp = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec2 uv = (sp - uCenter) / uSize + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0) discard;
  o = texture(uTex, clamp(uv * uImg, vec2(0.5), uImg - 0.5) / uTexSize);
  o.a *= uAlpha;
}`;

  // --- GL plumbing --------------------------------------------------------------

  const progs = {};

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error("shader: " + log);
    }
    return s;
  }

  function program(fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
    return { prog: p, loc: {} };
  }

  function use(P) {
    gl.useProgram(P.prog);
    return P;
  }
  function uni(P, name) {
    let l = P.loc[name];
    if (l === undefined) l = P.loc[name] = gl.getUniformLocation(P.prog, name);
    return l;
  }
  const u1i = (P, n, v) => gl.uniform1i(uni(P, n), v);
  const u1f = (P, n, v) => gl.uniform1f(uni(P, n), v);
  const u2f = (P, n, a, b) => gl.uniform2f(uni(P, n), a, b);

  function tex2d(internal, w, h, filter) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  function bindTex(unit, t) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
  }

  function fbo(attachments) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    attachments.forEach((t, i) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
    });
    gl.drawBuffers(attachments.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    return ok ? f : null;
  }

  // Per-size render targets: two ping-pong state sets, two color images.
  let T = null;
  let cur = 0;  // index of the state set holding the current values

  function freeTargets() {
    if (!T) return;
    T.s0.concat(T.s1, T.s2, T.color).forEach((t) => gl.deleteTexture(t));
    T.sf.concat(T.cf).forEach((f) => gl.deleteFramebuffer(f));
    T = null;
  }

  // Abandons the current job (and its pending stats readback, if any).
  function dropJob() {
    if (job && job.fence) gl.deleteSync(job.fence);
    job = null;
    queuedDraft = null;
    fade = null;
  }

  function ensureTargets() {
    const w = canvas.width, h = canvas.height;
    if (T && T.w === w && T.h === h) return true;
    freeTargets();
    front = null;
    dropJob();
    const mk = (f) => tex2d(f, w, h, gl.NEAREST);
    const s0 = [mk(gl.RGBA32F), mk(gl.RGBA32F)], s1 = [mk(gl.RGBA32F), mk(gl.RGBA32F)];
    const s2 = [mk(gl.RGBA32F), mk(gl.RGBA32F)];
    const color = [tex2d(gl.RGBA8, w, h, gl.LINEAR), tex2d(gl.RGBA8, w, h, gl.LINEAR)];
    const sf = [fbo([s0[0], s1[0], s2[0]]), fbo([s0[1], s1[1], s2[1]])];
    const cf = [fbo([color[0]]), fbo([color[1]])];
    T = { w, h, s0, s1, s2, color, sf, cf };
    if (sf.includes(null) || cf.includes(null)) return fail();
    cur = 0;
    dirty = true;
    return true;
  }

  function fail() {
    if (!available) return false;
    available = api.available = false;
    if (typeof setRenderer === "function" && typeof rendererPref !== "undefined") setRenderer(rendererPref);
    return false;
  }

  // --- palette and quantile textures --------------------------------------------

  let lutTex = null, qTex = null, qOwner = null;
  let pendingLut = null;

  function uploadLut(lut) {
    if (!gl || !lutTex) { pendingLut = lut; return; }
    bindTex(0, lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, lut.length / 3, 1, gl.RGB, gl.UNSIGNED_BYTE, lut);
    dirty = true;
  }

  function useRange(range) {
    if (qOwner === range) return;
    qOwner = range;
    if (!range.quantiles) return;
    bindTex(0, qTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const off = range.smooth ? 0 : 1, pairs = new Float32Array(514);
    range.quantiles.forEach((v, i) => {
      const hi = Math.fround(v - off);
      pairs[2 * i] = hi;
      pairs[2 * i + 1] = v - off - hi;
    });
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 257, 1, gl.RG, gl.FLOAT, pairs);
  }

  // --- references -----------------------------------------------------------------

  let ref = null;          // latest reference (uploaded)
  let inflight = 0;        // id of the outstanding refWorker request, 0 if none
  let reqId = 0;
  const allRefs = [];

  const spanOf = (t) => t.distance / 3;
  const stepOf = (t) => t.distance / 3 / canvas.width;

  function refOffset(r, t) {
    return {
      x: bigToDouble(bigSub(t.center.x, r.cx)),
      y: bigToDouble(bigSub(t.center.y, r.cy)),
    };
  }

  function refUsable(r, t) {
    if (!r || r.e < precisionFor(stepOf(t))) return false;
    const o = refOffset(r, t);
    return Math.max(Math.abs(o.x), Math.abs(o.y)) <= 2 * spanOf(t);
  }

  function refCentered(r, t) {
    const o = refOffset(r, t);
    return Math.max(Math.abs(o.x), Math.abs(o.y)) < 0.01 * stepOf(t);
  }

  const sameCenter = (a, b) => a.cx.m === b.cx.m && a.cy.m === b.cy.m && a.e === b.e;

  function makeRef(r) {
    const rows = Math.ceil(r.len / REF_W);
    const f = new Float32Array(rows * REF_W * 4);
    for (let i = 0; i < r.len; i++) {
      const x = r.data[2 * i], y = r.data[2 * i + 1], sq = x * x + y * y, hi = Math.fround(sq);
      f[4 * i] = x; f[4 * i + 1] = y; f[4 * i + 2] = hi; f[4 * i + 3] = sq - hi;
    }
    const tex = tex2d(gl.RGBA32F, REF_W, rows, gl.NEAREST);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, REF_W, rows, gl.RGBA, gl.FLOAT, f);
    const o = { cx: { m: r.cx, e: r.e }, cy: { m: r.cy, e: r.e }, e: r.e, len: r.len, escaped: r.escaped, tex };
    allRefs.push(o);
    return o;
  }

  function gcRefs() {
    for (let i = allRefs.length - 1; i >= 0; i--) {
      const r = allRefs[i];
      if (r !== ref && !(job && job.ref === r)) {
        gl.deleteTexture(r.tex);
        allRefs.splice(i, 1);
      }
    }
  }

  function needRef(j) {
    if (!ref) return true;
    const t = j.t;
    if (ref.e < precisionFor(stepOf(t))) return true;
    const o = refOffset(ref, t);
    if (Math.max(Math.abs(o.x), Math.abs(o.y)) > 2 * spanOf(t)) return true;
    if (j.final && !refCentered(ref, t)) return true;
    if (!ref.escaped && ref.len < j.limit + 2) return true;  // see service(): iterating needs len >= limit + 2
    return false;
  }

  function ensureRef(j) {
    if (!j || inflight || !needRef(j)) return;
    const t = j.t;
    const bits = precisionFor(stepOf(t));
    const c = { x: rescale(t.center.x, bits), y: rescale(t.center.y, bits) };
    const id = inflight = ++reqId;
    refWorker.request(c, j.limit + 1).then((r) => {
      if (id !== reqId || !available) return;
      inflight = 0;
      onRef(r);
    });
  }

  function onRef(r) {
    const nr = makeRef(r);
    if (want && !refUsable(nr, want)) {
      // Stale: the view moved on while this was computed.
      ref = ref || null;
      gl.deleteTexture(nr.tex);
      allRefs.pop();
      ensureRef(job);
      return;
    }
    ref = nr;
    if (job) {
      if (job.stage === "waitref") {
        tryBegin(job);
      } else if (job.ref && sameCenter(job.ref, nr)) {
        job.ref = nr;                       // longer orbit, same prefix: swap in
      } else if (job.final && refCentered(nr, job.t)) {
        startJob(job.t, true);              // anchor the settled view at its center
      }
    }
    gcRefs();
    ensureRef(job);
  }

  // --- coloring (port of cpu.js colorRange) ---------------------------------------

  // Every draft measures its colors, so this runs a few times a second during
  // dives: values are sorted once, in place (Float64Array sorts numerically),
  // and the sorted arrays serve the repeat count and every later recolor.
  // `values` must be sorted.
  function equalize(values) {
    if (values.length < 50) return null;
    const lo = values[Math.floor(values.length * 0.01)];
    const hi = values[Math.floor(values.length * 0.98)];
    const quantiles = Array.from({ length: 257 }, (_, i) =>
      values[Math.floor((i / 256) * (values.length - 1))]);
    return { lo, hi: Math.max(hi, lo + 1), quantiles, smooth: false };
  }

  // samples[key], sorted in place on first use (only the kinds colorRange
  // actually reads get sorted).
  function sorted(samples, key) {
    if (!samples.sorted[key]) {
      samples[key].sort();
      samples.sorted[key] = true;
    }
    return samples[key];
  }

  // Share of values equal to another one (1 - distinct / count), from sorted
  // values: what new Set(values).size gives, without building the set.
  function repeatShare(sorted) {
    let distinct = sorted.length ? 1 : 0;
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i], b = sorted[i - 1];
      if (a !== b && (a === a || b === b)) distinct++;  // NaNs count once, as in a Set
    }
    return 1 - distinct / sorted.length;
  }

  // samples = { trap: Float64Array (nonzero), smooth: Float64Array (nonzero), sorted: {} }
  function colorRange(samples, maxColor) {
    const escape = () => {
      const r = equalize(sorted(samples, "smooth"));
      return r && { ...r, smooth: true };
    };
    if (colorMode === "escape") {
      const r = escape();
      if (r) return r;
    }
    const trapValues = sorted(samples, "trap");
    // Flat orbit trap: switch to escape time (before equalizing the trap
    // values, which would then go unused). See trapIsFlat in core.js.
    if (colorMode === "auto" && trapIsFlat(trapValues, repeatShare(trapValues))) {
      const r = escape();
      if (r) return r;
    }
    const trap = equalize(trapValues);
    if (autoRange && trap) return trap;
    return { lo: -1, hi: maxColor - 1, quantiles: null, smooth: false };
  }

  // A step from range a toward b (both from colorRange), so colors follow the
  // view gradually while the camera moves. Ranges of different kinds (orbit
  // trap vs escape time, equalized vs fixed) can't be mixed: take b.
  function blendRange(a, b, t) {
    if (!a || a.smooth !== b.smooth || !a.quantiles !== !b.quantiles) return b;
    const mix = (x, y) => x + (y - x) * t;
    return {
      lo: mix(a.lo, b.lo),
      hi: mix(a.hi, b.hi),
      quantiles: b.quantiles && b.quantiles.map((v, i) => mix(a.quantiles[i], v)),
      smooth: b.smooth,
    };
  }

  function colorize(j, complete, ci, range = j.range || lastRange) {
    if (!range) return false;
    useRange(range);
    const P = use(progs.color);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.cf[ci]);
    gl.viewport(0, 0, j.w, j.h);
    bindTex(0, T.s1[cur]);
    bindTex(1, lutTex);
    bindTex(2, qTex);
    bindTex(3, T.s2[cur]);
    u1i(P, "uS1", 0); u1i(P, "uLut", 1); u1i(P, "uQ", 2); u1i(P, "uS2", 3);
    u1i(P, "uSmooth", range.smooth ? 1 : 0);
    u1i(P, "uHasQ", range.quantiles ? 1 : 0);
    u1i(P, "uComplete", complete ? 1 : 0);
    u1i(P, "uTop", lutSize - 1);
    u1f(P, "uOne", 1);
    u1f(P, "uLo", range.lo);
    u1f(P, "uHi", range.hi);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    dirty = true;
    return true;
  }
  let lutSize = 1024;

  // --- jobs -------------------------------------------------------------------------

  let want = null;           // latest target passed to setTarget
  let queuedDraft = null;    // draft waiting for the current job to finish
  let lastDraftGeom = null;
  let job = null;
  let front = null;          // { ci, w, h, center, distance, geom }: last completed image
  let lastRange = null;       // range of the colors on screen
  // Color crossfade: when a settled view (or a settings change) brings a new
  // color range, the old coloring of the same pixels stays in the other color
  // texture and fades out over FADE_MS, instead of the colors jumping.
  const FADE_MS = 400;
  let fade = null;           // { ci, start }: image colored the old way, fading out
  const reducedMotion = typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Colors complete job j with `range` into the other color texture and fades
  // from front's current colors (front must show j's pixels) to it.
  function recolorFaded(j, range) {
    const oldCi = front.ci, newCi = 1 - oldCi;
    colorize(j, true, newCi, range);
    front = { ...front, ci: newCi };
    j.workCi = newCi;
    fade = reducedMotion ? null : { ci: oldCi, start: performance.now() };
  }
  let effIter = 0;
  let dirty = true, lastCam = null;
  let draftScale = 0.5;

  const geomOf = (t) => `${t.center.x.m},${t.center.x.e},${t.center.y.m},${t.center.y.e},${t.distance}`;
  const limitFor = (t) => Math.min(MAX_ITERS, Math.max(50, Math.round(iterationsFor(t.distance) * iterationScale)));
  const sigOf = (t) => `${geomOf(t)}|${limitFor(t)}|${canvas.width}x${canvas.height}`;

  const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
  function expOf(v) { f64[0] = v; return ((u32[1] >>> 20) & 0x7ff) - 1023; }
  function ldexp(v, e) { const h = e >> 1; return v * 2 ** h * 2 ** (e - h); }
  function toFE(x, y) {
    const m = Math.max(Math.abs(x), Math.abs(y));
    if (m === 0) return { mx: 0, my: 0, e: ZERO_E };
    const e = expOf(m);
    return { mx: ldexp(x, -e), my: ldexp(y, -e), e };
  }

  function startJob(t, final) {
    if (!ensureTargets()) return;
    const cw = canvas.width, ch = canvas.height;
    const scale = final ? 1 : draftScale;
    const w = Math.max(1, Math.round(cw * scale)), h = Math.max(1, Math.round(ch * scale));
    const fullStep = t.distance / 3 / cw;
    const limit = limitFor(t);
    if (job && job.fence) gl.deleteSync(job.fence);  // abandoned mid-stats
    job = {
      final, t, geom: geomOf(t), sig: sigOf(t), maxColor: t.maxColor, w, h,
      rstep: fullStep * cw / w, fullStep,
      variant: fullStep > F32_MIN_STEP ? "f32" : "fe",
      limit, iterDone: 0, stage: "waitref", ref: null, centered: false, off: null,
      samples: null, range: null, prevInside: null, age: 0, frames: 0, overlay: false,
      workCi: front ? 1 - front.ci : 0, doneOk: false, fence: null, rate: 0,
    };
    fade = null;  // job.workCi is the texture the fade was drawing from
    if (final) effIter = limit;
    tryBegin(job);
    ensureRef(job);
    gcRefs();
  }

  function tryBegin(j) {
    if (!ref || !refUsable(ref, j.t)) return;
    j.ref = ref;
    j.off = refOffset(ref, j.t);
    j.centered = Math.max(Math.abs(j.off.x), Math.abs(j.off.y)) < 0.01 * j.fullStep;
    j.stage = "iter";
    // Initial state: dz = 0, m = 0, mind2 = 4, nothing recorded.
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.sf[cur]);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 4]);
    gl.clearBufferfv(gl.COLOR, 2, [0, 0, 0, 0]);
  }

  function pass(j, base, end) {
    // Invariant (see service()): a pass never runs off the end of a reference
    // that hasn't escaped; rebasing there loses float32 precision and glitches
    // the image. Logged loudly so tests/browser.test.js fails on it.
    if (!j.ref.escaped && end > j.ref.len - 2) {
      console.error(`gpu: pass to ${end} runs past the reference (len ${j.ref.len})`);
    }
    const fe = j.variant === "fe";
    const P = use(fe ? progs.fe : progs.f32);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.sf[1 - cur]);
    gl.viewport(0, 0, j.w, j.h);
    bindTex(0, T.s0[cur]);
    bindTex(1, T.s1[cur]);
    bindTex(2, T.s2[cur]);
    bindTex(3, j.ref.tex);
    u1i(P, "uS0", 0); u1i(P, "uS1", 1); u1i(P, "uS2", 2); u1i(P, "uRef", 3);
    u1f(P, "uOne", 1);
    u1i(P, "uBase", base); u1i(P, "uEnd", end);
    u1i(P, "uRefLen", j.ref.len);
    u2f(P, "uImg", j.w, j.h);
    if (fe) {
      const o = toFE(j.off.x, j.off.y), se = expOf(j.rstep);
      u2f(P, "uOffM", o.mx, o.my);
      u1i(P, "uOffE", o.e);
      u1f(P, "uStepM", ldexp(j.rstep, -se));
      u1i(P, "uStepE", se);
    } else {
      u2f(P, "uOff", j.off.x, j.off.y);
      u1f(P, "uStep", j.rstep);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    cur = 1 - cur;
  }

  // --- budget -----------------------------------------------------------------------

  // A pixel-iteration's cost varies tenfold with content: an image's first
  // passes iterate every pixel, its later ones mostly skip pixels that have
  // escaped. So timer measurements are kept per job (later passes only get
  // cheaper, so a job's last measurement is a safe rate for the rest of it),
  // and a new job starts from what first frames have cost (`rate`), not from
  // the cheap tail of the previous image, which overshot the budget several
  // times over (frames of 50-150 ms in deep dives).
  let pxIterPerFrame = 2e7;      // pixel-iterations submitted per frame (no timer)
  let rate = 0;                  // measured pixel-iterations per ms on jobs' first frames
  let timerSeen = false;
  const queries = [];
  let lastT = 0, workedPrev = false, slowFrames = 0;

  function beginTimer() {
    if (!timerExt || queries.length > 6) return null;
    const q = gl.createQuery();
    gl.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
    return q;
  }

  function pollTimers() {
    while (queries.length) {
      const e = queries[0];
      if (!gl.getQueryParameter(e.q, gl.QUERY_RESULT_AVAILABLE)) break;
      queries.shift();
      const bad = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
      if (!bad) {
        const ms = gl.getQueryParameter(e.q, gl.QUERY_RESULT) / 1e6;
        if (ms > 0.05) {
          const r = e.pxIters / ms;
          e.job.rate = r;
          if (e.first) rate = !rate ? r : r < rate ? r : rate * 0.8 + r * 0.2;  // drops at once
          timerSeen = true;
        }
      }
      gl.deleteQuery(e.q);
    }
  }

  function adaptFromFrameTime(dt) {
    if (timerSeen || dt <= 0 || dt > 500) return;
    if (dt < 20) pxIterPerFrame = Math.min(5e10, pxIterPerFrame * 1.25);
    else if (dt > 26) pxIterPerFrame = Math.max(1e6, pxIterPerFrame * 0.6);
    slowFrames = dt > 26 ? slowFrames + 1 : 0;
  }

  // --- stats readback ---------------------------------------------------------------

  let R = null;  // { gw, gh, tex, fbo, pbo }

  function issueReduce(j) {
    const gw = Math.max(1, Math.min(j.w, Math.round(Math.sqrt(STATS_SAMPLES * j.w / j.h))));
    const gh = Math.max(1, Math.min(j.h, Math.round(STATS_SAMPLES / gw)));
    if (!R || R.gw !== gw || R.gh !== gh) {
      if (R) { gl.deleteTexture(R.tex); gl.deleteFramebuffer(R.fbo); gl.deleteBuffer(R.pbo); }
      const tex = tex2d(gl.RGBA32F, gw, gh, gl.NEAREST);
      const pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, gw * gh * 16, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      R = { gw, gh, tex, fbo: fbo([tex]), pbo };
    }
    const P = use(progs.reduce);
    gl.bindFramebuffer(gl.FRAMEBUFFER, R.fbo);
    gl.viewport(0, 0, gw, gh);
    bindTex(0, T.s1[cur]);
    bindTex(1, T.s2[cur]);
    u1i(P, "uS1", 0); u1i(P, "uS2", 1);
    u2f(P, "uImg", j.w, j.h);
    u2f(P, "uGrid", gw, gh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, R.pbo);
    gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    j.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    j.grid = { gw, gh };
    gl.flush();
    j.stage = "stats";
  }

  function pollStats(j) {
    const r = gl.clientWaitSync(j.fence, 0, 0);
    if (r !== gl.ALREADY_SIGNALED && r !== gl.CONDITION_SATISFIED) return;
    gl.deleteSync(j.fence);
    j.fence = null;
    const n = j.grid.gw * j.grid.gh;
    const buf = new Float32Array(n * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, R.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buf);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const trap = new Float64Array(n), smooth = new Float64Array(n);
    let inside = 0, nt = 0, ns = 0;
    for (let i = 0; i < n; i++) {
      const tv = buf[4 * i], sv = buf[4 * i + 1];
      if (tv === 0) inside++; else trap[nt++] = buf[4 * i + 2] + 1 + buf[4 * i + 3];
      if (sv) smooth[ns++] = sv;
    }
    const samples = { trap: trap.subarray(0, nt), smooth: smooth.subarray(0, ns), sorted: {} };
    j.samples = samples;
    j.range = colorRange(samples, j.maxColor);
    // Drafts move the colors part of the way toward what's on screen now.
    if (!j.final) j.range = blendRange(lastRange, j.range, DRAFT_BLEND);
    const f = inside / n;
    if (j.final) {
      // Grow by resuming: probe one doubling, then keep doubling while the last
      // one still dropped the inside fraction by at least 0.005 (cpu.js).
      const grow = j.limit < MAX_ITERS && f > 0.002 && (j.prevInside === null || j.prevInside - f >= 0.005);
      if (grow) {
        j.prevInside = f;
        j.limit = Math.min(MAX_ITERS, j.limit * 2);
        effIter = j.limit;
        j.stage = "iter";
        j.overlay = true;
        ensureRef(j);
        return;
      }
    }
    finish(j);
  }

  function finish(j) {
    if (!j.range) j.range = lastRange;
    const before = lastRange;
    if (j.final && before && j.range !== before && !reducedMotion) {
      // Color the new image the old way first, then fade to its own range.
      colorize(j, true, j.workCi, before);
      front = { ci: j.workCi, w: j.w, h: j.h, center: j.t.center, distance: j.t.distance, geom: j.geom };
      recolorFaded(j, j.range);
    } else {
      colorize(j, true, j.workCi);
      front = { ci: j.workCi, w: j.w, h: j.h, center: j.t.center, distance: j.t.distance, geom: j.geom };
    }
    if (j.samples) lastRange = j.range;
    j.stage = "complete";
    j.overlay = false;
    if (j.final) {
      effIter = j.limit;
      j.doneOk = j.centered || !inflight;
    } else {
      if (j.frames > 4) draftScale = Math.max(0.25, draftScale * 0.8);
      else if (j.frames <= 2) draftScale = Math.min(1, draftScale * 1.25);
    }
    dirty = true;
  }

  // --- per-frame work -----------------------------------------------------------------

  function service(settled) {
    if (queuedDraft) {
      const stale = !job || job.stage === "complete" || job.final ||
        (!job.final && (job.frames > DRAFT_MAX_FRAMES || job.stage === "waitref"));
      if (stale) {
        if (job && !job.final && job.stage !== "complete") draftScale = Math.max(0.25, draftScale * 0.75);
        lastDraftGeom = geomOf(queuedDraft);
        const t = queuedDraft;
        queuedDraft = null;
        startJob(t, false);
      }
    }
    if (!job) return false;
    const j = job;
    j.age++;
    let worked = false;
    if (j.stage === "waitref") tryBegin(j);
    // Never iterate past the end of a reference that hasn't escaped. A pixel
    // that runs off the end is rebased onto the start with dz = z while z is
    // still O(1), and in float32 that rounds away the ~1e-13 differences
    // between neighboring pixels: whole regions collapse onto one orbit
    // (straight-edged glitches in deep minibrots). When a job outgrows its
    // reference (a final growing its limit), wait for the longer one, which
    // ensureRef has asked for; the swap in onRef then carries on exactly.
    // (The shader rebases once m reaches len - 1, and m <= i + 1 in pass i.)
    const refEnd = j.stage === "iter" && !j.ref.escaped ? Math.min(j.limit, j.ref.len - 2) : j.limit;
    if (j.stage === "iter" && j.iterDone >= refEnd && refEnd < j.limit) {
      ensureRef(j);
      j.frames++;
      return false;
    }
    if (j.stage === "iter") {
      const px = j.w * j.h;
      const ms = j.final && settled ? SETTLED_MS : TARGET_MS;
      const budget = timerSeen && (j.rate || rate)
        ? Math.min(5e10, Math.max(1e6, (j.rate || rate) * ms)) : pxIterPerFrame;
      const ipf = Math.max(16, Math.round(budget / px));
      const size = Math.min(ipf, PASS_MAX);
      let done = 0;
      const q = beginTimer();
      while (done < ipf && j.iterDone < refEnd) {
        const n = Math.min(size, refEnd - j.iterDone);
        pass(j, j.iterDone, j.iterDone + n);
        j.iterDone += n;
        done += n;
      }
      if (q) {
        gl.endQuery(timerExt.TIME_ELAPSED_EXT);
        queries.push({ q, pxIters: done * px, job: j, first: j.frames === 0 });
      }
      j.frames++;
      worked = true;
      // Every image, drafts too, measures its colors (see pollStats).
      if (j.iterDone >= j.limit) {
        // A growing final shows its progress: color its last passes once here,
        // not on every frame spent waiting for the readback.
        if (j.range && j.overlay) colorize(j, false, j.workCi, lastRange || j.range);
        issueReduce(j);
      } else if (j.range || lastRange) {
        j.overlay = colorize(j, false, j.workCi, lastRange || j.range);
      }
    }
    if (j.stage === "stats") pollStats(j);
    if (j.stage === "complete" && j.final && !j.doneOk && !inflight) j.doneOk = true;
    return worked;
  }

  // --- drawing --------------------------------------------------------------------------

  function drawImage(ci, meta, cam, alpha = 1) {
    const cw = canvas.width, ch = canvas.height;
    const camStep = cam.distance / 3 / cw;
    const dw = cw * (meta.distance / cam.distance);
    const dh = dw * (meta.h / meta.w);
    if (!(dw > 1e-3 && dw < 1e8)) return;
    const dx = bigToDouble(bigSub(meta.center.x, cam.center.x)) / camStep;
    const dy = bigToDouble(bigSub(meta.center.y, cam.center.y)) / camStep;
    const P = use(progs.draw);
    bindTex(0, T.color[ci]);
    u1i(P, "uTex", 0);
    u2f(P, "uImg", meta.w, meta.h);
    u2f(P, "uTexSize", T.w, T.h);
    u2f(P, "uCanvas", cw, ch);
    u2f(P, "uCenter", cw / 2 + dx, ch / 2 + dy);
    u2f(P, "uSize", dw, dh);
    u1f(P, "uAlpha", alpha);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function draw(cam) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (front) drawImage(front.ci, front, cam);
    if (fade && front) {
      const u = Math.min(1, (performance.now() - fade.start) / FADE_MS);
      if (u < 1) drawImage(fade.ci, front, cam, 1 - u * u * (3 - 2 * u));
      else fade = null;
    }
    if (job && job.overlay && job.stage !== "complete") {
      drawImage(job.workCi, { w: job.w, h: job.h, center: job.t.center, distance: job.t.distance }, cam);
    }
    gl.disable(gl.BLEND);
  }

  const sameCam = (a, b) => b && a.distance === b.distance &&
    a.center.x.m === b.center.x.m && a.center.x.e === b.center.x.e &&
    a.center.y.m === b.center.y.m && a.center.y.e === b.center.y.e;

  // --- init ----------------------------------------------------------------------------

  function init() {
    try {
      gl = canvas.getContext("webgl2", {
        alpha: false, antialias: false, depth: false, stencil: false,
        powerPreference: "high-performance",
      });
      if (!gl || !gl.getExtension("EXT_color_buffer_float")) return;
      timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      progs.f32 = program(FS_F32);
      progs.fe = program(FS_FE);
      progs.reduce = program(FS_REDUCE);
      progs.color = program(FS_COLOR);
      progs.draw = program(FS_DRAW);
      // Can we render to MRT float targets here?
      const a = tex2d(gl.RGBA32F, 4, 4, gl.NEAREST), b = tex2d(gl.RGBA32F, 4, 4, gl.NEAREST);
      const f = fbo([a, b]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteTexture(a); gl.deleteTexture(b);
      if (!f) return;
      gl.deleteFramebuffer(f);
      lutTex = tex2d(gl.RGB8, lutSize, 1, gl.NEAREST);
      qTex = tex2d(gl.RG32F, 257, 1, gl.NEAREST);
      gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(gl.createVertexArray());
      available = true;
      canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        lost = true;
        fail();
      });
      uploadLut(pendingLut || (typeof LUT !== "undefined" ? LUT : null) || new Uint8ClampedArray(lutSize * 3));
    } catch (err) {
      console.warn("gpu renderer unavailable:", err);
      available = false;
    }
    api.available = available;
  }

  const api = {
    name: "gpu",
    available: false,
    canvas,
    init,
    resize(w, h) {
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      dirty = true;
      lastCam = null;
      if (gl && available) ensureTargets();
    },
    setPalette(lut) {
      uploadLut(lut);
    },
    stop() {
      // Work only advances inside frame(), which stops being called; drop the
      // job so switching back starts a fresh final render.
      if (gl && available) dropJob();
      want = null;
    },
    setTarget(t) {
      if (!available) return;
      if (!ensureTargets()) return;
      want = t;
      const geom = geomOf(t);
      if (!t.final) {
        if (geom === lastDraftGeom || (front && front.geom === geom)) return;
        queuedDraft = t;
        return;
      }
      queuedDraft = null;
      lastDraftGeom = null;
      const sig = sigOf(t);
      if (job && job.final && job.sig === sig && job.stage !== "waitref") {
        if (job.stage === "complete") {
          if (t.force || t.maxColor !== job.maxColor) {
            // Same iterations, new settings: recolor from the stored samples.
            job.maxColor = t.maxColor;
            job.range = colorRange(job.samples, job.maxColor);
            lastRange = job.range;
            recolorFaded(job, job.range);
            job.doneOk = job.centered || !inflight;
          }
          return;
        }
        if (!t.force) return;
      } else if (job && job.final && job.sig === sig && !t.force) {
        return;
      }
      startJob(t, true);
    },
    frame(cam) {
      if (!available) return;
      if (!ensureTargets()) return;
      const now = performance.now();
      const dt = now - lastT;
      lastT = now;
      pollTimers();
      if (workedPrev) adaptFromFrameTime(dt);
      const settled = !!job && sameCam(cam, { center: job.t.center, distance: job.t.distance });
      workedPrev = service(settled);
      if (dirty || !sameCam(cam, lastCam)) {
        draw(cam);
        dirty = !!fade;  // a color fade keeps redrawing until it ends
        lastCam = cam;
      }
    },
    status() {
      const done = !!job && job.final && job.stage === "complete" && job.doneOk &&
        !!want && job.geom === geomOf(want) && want.final !== false;
      return {
        done,
        range: job && job.final && job.range ? job.range : lastRange,
        effectiveIterations: effIter,
      };
    },
    minDistance(x, y) { return 1e-290; },
  };
  return api;
})();
