# GPU renderer performance notes (mandelbrot/gpu.js)

## How it was measured

- Headless Chrome 157 (`--headless=new --use-angle=metal`), with WebGL2 on the
  real GPU (ANGLE Metal, Apple M5 Pro) and timer queries available. Window
  1600x1000, device scale 1 and 2 (the canvas is 1600x913 or 3200x1826). Driven
  over the DevTools protocol, serving master's core.js (with the faster
  reference orbits) in place of the worktree's copy.
- Scenario: settle at stop 0, tour dive 0 -> 10 (to 2.23e-20, about 23 s), dive
  10 -> 1 (about 58 s), then three click zoom-ins at the deep stop.
- Recorded per frame: rAF interval, main-thread time inside `gpuRenderer.frame`,
  job stage, iterations done, budget. Also counted GL calls and timer query
  results, plus a CPU profile. Time-to-final ("settle") runs from the first
  frame with the final job to `status().done`.
- The CPU side of draft stats (sample collection, `colorRange`, `blendRange`)
  was also timed in Node on synthetic 16k-sample buffers, checking old and new
  give identical ranges.

## Where the time goes

- **GPU budget overshoot (the main problem).** The budget was
  `rate * TARGET_MS`, with `rate` an average of timer measurements in
  pixel-iterations per ms. But what a pixel-iteration costs varies about tenfold:
  an image's first passes iterate every pixel, and its later passes mostly skip
  pixels that have already escaped. The cheap tail of one draft inflated `rate`,
  so the next draft's first frame submitted 5-15x too much work. At device scale
  2, timer queries showed 100-170 ms frames in the deep part of a dive (56-69
  frames over 25 ms per dive, up to 100 ms between frames). Draft scale grew to
  1.0 anyway, because it adapts on frame *count* and the overlong frames were few.
  Timer queries were accurate, just 3-5 frames late.
- **Draft stats on the CPU.** These cost about 0.5-1.1 ms per draft on this
  machine (sorting 16k samples, a `Set` for the repeat test, and an orbit trap
  equalize that gets thrown away when auto mode switches to escape time). This
  is the largest JS cost in the profile, but small next to the GPU.
- **Not significant here:** reference uploads (`makeRef`/`texSubImage2D` came
  to under 10 ms in total over about 85 s), the `useRange` quantile upload
  (2 KB per draft), and draw/reduce passes. With the fast core.js there were no
  final-job restarts on a centered reference in these runs.

## Changes (all in mandelbrot/gpu.js)

1. **Per-job iteration budget.** Each timer result is stored on its job
   (`job.rate`). A job's later passes only get cheaper, so its last measurement
   is a safe rate for the rest of it. The global `rate` now tracks only jobs'
   *first* frames: it drops at once and rises slowly (20% per measurement). A
   new job's budget therefore comes from what first frames cost, not from the
   previous image's tail. The frame-time fallback without timer queries is
   unchanged.
2. **Larger budget once settled.** When the camera sits on the final job's view,
   the budget is `SETTLED_MS = 13` instead of `TARGET_MS = 9`. Nothing is moving
   then, and this wins back most of the time-to-final lost by no longer
   overshooting.
3. **Cheaper draft stats.** Samples are collected into Float64Arrays and sorted
   in place, once, and only for the kinds `colorRange` actually reads. The repeat
   share is counted from the sorted values (the same result as `new Set`, NaNs
   included). Auto mode checks the repeats before equalizing the orbit trap
   values, so the unused equalize is gone. Output is bit-identical to before in
   Node across trap, escape and auto modes, with flat, medium and smooth data,
   including the stored-sample recolor path.
4. **No repeated colorize while waiting for a readback.** A growing final
   recolored its overlay (and redrew) on every frame spent waiting for the stats
   fence. It now colors once, just before issuing the reduce.

## Effect (device scale 2, before -> after)

| | before | after |
|---|---|---|
| dive 0->10, frames > 25 ms | 56-69 | 0 |
| dive 0->10, worst frame interval | 76-101 ms | 17.6-17.9 ms |
| dive 10->1, frames > 25 ms / worst | 3-8 / 201-249 ms | 0 / 17.8 ms |
| drafts completed, dive 0->10 | 207-229 | 304-316 |
| settle after dive 0->10 | 404-469 ms | 486 ms (685-1237 ms without change 2) |
| settle after clicks | 386 / 700 / 151 ms | 456 / 735 / 203 ms |
| `colorRange` + collect per draft (Node) | 0.4-0.93 ms | 0.18-0.68 ms |

At device scale 1 the baseline was already smooth on this GPU, with no frames
over 25 ms, so that size wasn't re-measured. Settle times vary between runs by
about ±30%. Finals are slightly slower than before, because the old code
finished them by overshooting the frame budget, which caused visible stalls.

## Evaluated and not done

- **Uploading only the new rows of an extended reference:** measured
  negligible here (see above).
- **Not restarting a nearly finished final when a centered reference
  arrives:** it never happened in these runs with the fast core.js, and the
  centered reference is part of the precision design.
- **A smaller sample grid for drafts:** after change 3 it would save only
  about 0.2 ms, and it would make quantiles noisier (a visual risk).
- **Skipping identical `useRange` uploads:** it is already skipped when the
  range object is the same, and blended draft ranges differ every time anyway.

## Follow-ups / not verified

- Only one GPU (Apple M5 Pro, headless Chrome) was tested: no other GPUs,
  browsers or displays, no 120 Hz screens, and no devices without timer queries,
  where the frame-time fallback is used and was not changed.
- Colors were not compared pixel by pixel in a browser. The color math is
  identical by construction (Node check), and the budget only changes how many
  iterations run per frame, not the result.
- Larger idea, which needs camera.js: start the final render at the start of a
  click zoom-in. Zoom-ins send no drafts, so the GPU sits idle for the roughly
  600 ms animation. Starting there could cut time-to-final after a click by
  about that much.
