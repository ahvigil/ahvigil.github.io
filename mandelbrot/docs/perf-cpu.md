# CPU renderer performance (mandelbrot/cpu.js, core.js)

## Method

- Node 26, Apple Silicon (18 cores), 1600x1000 view, `navigator.hardwareConcurrency = 12`.
- cpu.js ran end to end in a `vm` context with stubs (canvas, ImageData, Blob/URL).
  Web Workers were emulated with `worker_threads` running the same `WORKER_SRC`.
  Timing ran from `setTarget({final: true})` until `status().done`, best of 3, at
  every `LOCATIONS` stop. Stops deeper than 1e-9 ran in hi-res (`hiRes = true`),
  using the app's iteration rule (`iterationsFor`, then `adaptIterations`).
- "main" is the time `setTarget` blocks the main thread. "total" is the time
  until the image is done.
- The baseline is master's core.js (with the faster reference orbits) and the
  original cpu.js. The machine was shared with other jobs, so expect about ±15%
  noise.

## Where the time went (before)

- Per-pixel iteration made up about 80% of the time. Interior pixels were only
  0–12% of the iteration work at the deep stops (31% at the small loc 6), so
  interior detection had little to win there.
- `adaptIterations` and `colorRange` sampling ran on the main thread before any
  worker started. That took 15–270 ms at most stops and 770 ms at loc 2, and it
  froze the UI for that long.
- The per-iteration cost was bound by the dependency chain: each step waits for
  the previous one, so most floating-point units sat idle.

## Results

| stop | distance | mode | iters | before main / total | after main / total |
|---|---|---|---|---|---|
| 0 | 6.75 | lo | 500 | 6 / 15 ms | 0 / 9 ms |
| 1 | 2.14e-17 | hd | 3500 | 66 / 394 | 0 / 202 |
| 2 | 1.88e-14 | hd | 23288 | 774 / 4206 | 0 / 2140 |
| 3 | 2.14e-12 | hd | 5000 | 263 / 1642 | 1 / 867 |
| 4 | 3.67e-10 | hd | 4106 | 221 / 1365 | 1 / 726 |
| 5 | 3.05e-6 | lo | 5076 | 120 / 566 | 0 / 271 |
| 6 | 1.26e-11 | hd | 2346 | 15 / 70 | 0 / 38 |
| 7 | 9.72e-18 | hd | 3568 | 48 / 293 | 0 / 152 |
| 8 | 1.01e-16 | hd | 6730 | 270 / 1931 | 1 / 1058 |
| 9 | 4.57e-13 | hd | 2634 | 130 / 1036 | 0 / 574 |
| 10 | 2.23e-20 | hd | 4096 | 312 / 2218 | 0 / 1214 |
| sum | | | | 13.7 s | 7.2 s |

Images: lo-res images are byte-identical. In hi-res, 0–43 isolated pixels per
1.6M (≤0.003%) flip between black and colored, in both directions. These are
pixels whose escape lands right at the iteration limit, and they flip because of
the new step's rounding.

## Changes

1. **core.js `perturbValue`**: the step is computed as `dz' = (2Z + dz)·dz + dc`
   instead of being expanded. The dependency chain is one rounding step shorter,
   and the kernel is about 1.3x faster. Z_{m+1} is also carried over between
   steps, which saves no time but leaves less to load. This change causes the
   pixel flips noted above.
2. **core.js `orbitValues`** (new): computes orbitValue/perturbValue for a
   strided grid, iterating two pixels per loop ("lanes"). Each lane is refilled
   with the next pixel as soon as its orbit ends. Results are bit-identical to
   the one-pixel functions; this was checked with `===` on every stop, in both
   trap and smooth modes. Measured on real rows: 1.65x for lo-res and 1.7x for
   hi-res. Three details matter for V8:
   - The hot loop runs until either lane ends, with the refill code outside it.
     With the refill inside, there was no gain.
   - There are no helper closures; a fresh closure per call caused
     "wrong call target" deopts.
   - Lo-res and hi-res have separate loops; sharing one cost hi-res about 20%.
   - The cardioid/period-2 bulb skip also applies in hi-res (`g.bulbs`, with the
     center as doubles). It is used only where `step >= 8·eps·max(|x|,|y|,1)`,
     the same threshold as lo-res `minDistance`, so deep views are unaffected.
3. **core.js `renderBand`**: now calls `orbitValues`, then colors the values. It
   takes an optional reusable values buffer.
4. **cpu.js**:
   - Sampling (`sampleView`, `adaptIterations`, `colorRange`) now runs in the
     workers, in chunks of grid rows, through one dispatcher (`runJobs`) that
     also renders the bands.
   - `render` is now async and cancels through a per-run token. The previous
     image stays on screen while sampling runs.
   - The reference orbit is posted to the workers only when it grows
     (`syncReference`).
   - Workers reuse their values buffer. Samples are Float64Arrays, sorted with
     the typed-array sort.
   - The main-thread fallback (no workers) now yields to the browser every 30 ms
     instead of every 8 bands.
5. **index.html**: the code-layout comment now mentions orbitValues.

## Evaluated, not done

- **Periodicity checking in `perturbValue`**: interior pixels are a small share
  of the work at the deep stops. A safe tolerance test also needs care: exterior
  pixels near a minibrot shadow its cycle for many periods. Not worth the risk
  or the per-iteration cost.
- **orbitValue square reuse** (reusing the `zr*zr` products): bit-identical but
  no measurable gain, so it was reverted.
- **Lo-res as perturbation against an all-zero reference**: one loop for both
  modes, but 1.7x slower in lo-res. It was replaced by a dedicated lo-res loop.
- **Avoiding per-band ImageData/Uint8ClampedArray allocation**: 51 KB per band
  against milliseconds of compute per band, so it is negligible. Not done.
- **Band size**: not measured; it stays at 8 rows. The workers were about 90%
  utilized before these changes.
- **Series approximation / BLA**: these skip iterations, so they would change the
  orbit-trap minimum and the images. Out of scope.

## Open follow-ups / not verified

- Nothing was tested in a real browser. Things to check:
  - the Worker/Blob path and the transferable values buffers;
  - the main-thread fallback (no Worker), including its 30 ms yields;
  - the progressive drawing while sampling now runs in the workers;
  - cancellation by moving the camera during sampling.
- While sampling, `status().range` and `effectiveIterations` still describe the
  previous view, until its bands start. The HUD may briefly show the old values.
- Inside a Node `vm` context, the two-lane hi-res loop showed no speedup. Plain
  scripts and workers did show it. Browsers run it as a plain worker script, but
  check in Chrome/Firefox/Safari, and on x86 (16 FP registers), whether two
  lanes still help.
- Three or more lanes were not tried.
