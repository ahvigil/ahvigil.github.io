# Mandelbrot: reference-orbit performance

Notes on the speedup of reference-orbit computation in `mandelbrot/core.js`
(`makeReference`, `extendReference`, `refWorker`), merged as commit 3caefd1.
The output is bit-for-bit identical to the previous code: the same `data`
(interleaved doubles), `len` and `escaped`.

## Measurement

The benchmark ran in Node 26. It loaded `core.js` with `vm.runInContext` and
used its `module.exports`. Each case was run once to warm up, then the best
of 3 runs was taken.

Cases (17 in all):

- the 11 tour stops in `LOCATIONS`, at `precisionFor(distance / 3 / 2000)`
  bits (74 to 142 bits)
- 3 dive midpoints: the center of stop 1, 7 or 10, at the geometric mean of
  6.75 and that stop's distance (103 to 108 bits)
- 3 off-nucleus points: the same stops with x shifted by 0.37 of the span.
  These escape after 358 to 2871 iterations and never repeat.

Iteration counts were 4096, 17000 (about the most the tour uses) and 65536
(`MAX_ITERS` in gpu.js).

| Iterations | Before (17 cases) | After (17 cases) |
|-----------:|------------------:|-----------------:|
| 4096       | 48.4 ms           | 6.2 ms           |
| 17000      | 182.8 ms          | 6.2 ms           |
| 65536      | 691.8 ms          | 6.7 ms           |

Single cases:

| Case | Before | After |
|---|---:|---:|
| stop 10 (2.23e-20, 142 bits), 17000 iterations | 13.9 ms | 1.1 ms |
| stop 10, 65536 iterations | 53.7 ms | 1.1 ms |
| dive midpoint, 17000 iterations | about 13.7 ms | 0.06 to 0.4 ms |
| off-nucleus point, escapes at 2871, 142 bits | 2.37 ms | 0.60 ms |
| same orbit, 400 bits | 2.68 ms | 0.81 ms |
| same orbit, 990 bits | 3.52 ms | 1.37 ms |
| same orbit, 1100 bits | 4.65 ms | 2.07 ms |

For orbits that never repeat, a step costs about 0.82 µs before and about
0.22 µs after, at 142 bits.

## Where the time went

- **Converting to doubles.** Each step called `bigToDouble` twice. Each call
  built an object and ran `shr(m, 0)`, which creates a BigInt and shifts by
  zero, plus some branch work. Removing this accounted for most of the
  per-step cost: on a 17000-iteration orbit that never repeats, time fell
  from 13.9 ms to 3.7 ms.
- **Iterating to the limit at minibrot nuclei.** All but one tour stop sits
  on a nucleus, so the orbit cycles. It was still computed in BigInts all
  the way to the limit.
- **Restarting from zero.** The GPU renderer doubles `j.limit` while a final
  image settles. Each doubling requested the same center again, and the
  worker computed it from scratch.

## Changes

1. **Detect repeating orbits** (`makeReference`, `extendReference`).
   - Inside the set, the orbit is drawn into an attracting cycle. Because
     the fixed-point map is deterministic on a finite set of states, it then
     repeats exactly.
   - Brent's method finds this: compare each state (zx, zy) with one saved
     at the last power of two, and resave at each power of two.
   - Once a repeat is found, `period` is set. The rest of `data` (and any
     later extension) is copied from `period` entries earlier, which is
     exactly what iterating would produce.
   - The periods found match the `LOCATIONS` comments: 104, 1996, 973, 474,
     12, 73, 824, 494 and 883. Stop 0 settles into a period of 1 or 2,
     depending on precision. Stop 5 escapes.
   - Detection happens 32 to 8192 iterations in.
   - New fields on the reference object: `period`, `sx`, `sy`, `mark`.
   - Effect: 13.9 ms to 1.1 ms for stop 10 at 17000 iterations. The cost no
     longer grows with the limit once a repeat is found.
2. **Inline `bigToDouble`** (the `toDouble` helper in `extendReference`).
   - It does the same operations as `bigToDouble`, in the same order: a
     rounded shift by `max(0, e - 1000)` (no shift below 1000 bits), then
     `Number()`, then two precomputed powers of two.
   - Above 1000 bits, values whose shifted form is under 2^64 (Z within
     2^-936 of 0) are still handed to `bigToDouble`, which keeps its special
     path for them.
   - Effect: about 3.7x on orbits that never repeat at 142 bits. At 1100
     bits it gives 4.24 ms to 2.07 ms, measured with change 3 already in
     place.
3. **Compute zx² - zy² as (zx + zy)(zx - zy).** This is exactly equal in
   integers and saves one multiply per step. It makes no difference at about
   140 bits (3.77 ms vs 3.72 ms). At 990 bits it is about 20% faster
   (1.67 ms to 1.33 ms).
4. **Grow the data buffer by doubling.** Before, it was reallocated to
   exactly the new limit on every extension. This avoids repeated copies as
   the GPU renderer doubles its limit.
5. **Cache the last orbit in `refWorker`.**
   - `local` keeps the last reference and extends it when the same
     (cx, cy, e) comes back, instead of starting over.
   - The reply is cut to what a fresh orbit of `iters` would be:
     `len = min(ref.len, iters + 1)`, and `escaped` is true only if the
     escape falls within that length. So the documented contract ("exactly
     what extendReference would produce") still holds.
   - The worker now holds one orbit, up to about 1 MB at 65536 iterations.
   - Effect, estimated from the per-step costs above: for an orbit that
     never repeats, the 4096, 8192, 16384 sequence costs about the 16384
     run alone, instead of the sum of all three.

## Ideas evaluated and not adopted

- **Lowering precision below `precisionFor`.** There was no proof it is
  always enough, and the gains above made it unnecessary.
- **Reusing a reference for nearby centers.** gpu.js already does this
  (`refUsable`, within 2 spans). On settle it wants an exactly centered
  reference.
- **Changing worker messages and transfers.** Each reply copies `data` once
  (`slice`) and hands the buffer over without a further copy. That takes
  about 0.05 ms for 17k iterations. It is needed now that the worker keeps
  its cached copy.
- **Computing zx·zy as ((zx + zy)² - zx² - zy²) / 2.** With change 3, the
  step already uses only two multiplies, (zx + zy)(zx - zy) and zx·zy, so
  this would not reduce the count.

## Correctness checks

Every check compared the new code against a saved copy of the original
`core.js`, value for value, using `Object.is` on each double.

- **The 51 benchmark orbits** (17 cases at 3 iteration counts): `data`,
  `len` and `escaped` all identical.
- **744 orbits built in random steps**, each compared with a one-shot
  original:
  - the tour stops at 4 precisions (the 2000- and 8192-pixel precisions,
    300 bits and 1100 bits)
  - 400 random points near the stops, at various scales
  - 300 random points across the plane at 64 to 164 bits
- **84 cases with tiny values at 1000 to 1500 bits**, which exercise the
  path left to `bigToDouble`.
- **`refWorker` through a fake Worker** that runs the shipped worker source.
  The requests covered the same center at a higher limit, a lower limit, a
  changed center, and returning to the first center. Every reply was
  compared with a fresh original orbit.
- `node --check mandelbrot/core.js` passes.

Not verified: running in a real browser and Web Worker.

## Open follow-ups

- **GPU texture build** (`makeRef` in gpu.js). It converts the whole orbit
  to float32 (x, y, |Z|² split into two floats) on the main thread and
  uploads it on every new reference. That is now likely the larger
  main-thread cost. It could be done in the worker, or extended in place
  for a longer orbit with the same center.
- **Restarts on settle in gpu.js.** These are untouched. A settle that
  re-anchors at the exact center still pays one new reference, which is
  cheap now for nucleus stops.
- **Orbits that never repeat at high precision** (escaping off-nucleus
  points, boundary points) still cost about 0.2 to 0.7 µs per step,
  depending on bits.
