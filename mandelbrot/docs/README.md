# Mandelbrot viewer: developer notes

Notes for working on `mandelbrot/` (the browser viewer at
https://arthurvigil.com/mandelbrot/). Nothing under `docs/`, `tests/`,
`tools/`, `package.json` or `CLAUDE.md` is published: `_config.yml` at the
repo root excludes them from the Jekyll build.

## Layout

No build step and no dependencies: classic scripts loaded by `index.html`,
each defining one global object. The big comment at the top of
`index.html`'s script documents the Renderer and camera contracts and every
URL parameter; read it first.

| File | What it does |
|---|---|
| `core.js` | Pure math, no DOM (also loads in Node): tour stops (`LOCATIONS`), palettes, per-pixel kernels (`orbitValue`, `perturbValue`, `orbitValues`, `renderBand`), big fixed-point numbers, reference orbits (`makeReference` / `extendReference`, `refWorker`), `trapIsFlat` |
| `gpu.js` | WebGL2 renderer: perturbation in float32 (floatexp below a pixel step of 1e-30), resumable iteration, drafts while moving, async stats readback, equal-area coloring |
| `cpu.js` | Fallback renderer in Web Workers; hi-res mode (`h`, `?hd=1`) uses perturbation |
| `camera.js` | Animation loop, dives between stops (van Wijk smooth zoom), click zoom, pointer/wheel input, pause, speed cap |
| `settings.js` | Settings dialog and the on-screen button bar |
| `index.html` | Page state, setters, HUD, URL sync, keys, tour order |
| `terminal.html`, `mb.py` | Separate terminal-style versions with their own stop lists |

## Running and testing

- Open `index.html` directly (`file://` works) or serve the repo root:
  `python3 -m http.server 8000` and go to `http://localhost:8000/mandelbrot/`.
- `cd mandelbrot && npm test` runs everything with Node's built-in runner
  (Node 22+; no packages to install):
  - `tests/core.test.js`: unit tests for `core.js`. Reference orbits must
    match naive BigInt iteration bit for bit, `orbitValues` must match
    `orbitValue` / `perturbValue` pixel for pixel, perturbation must agree
    with direct and exact iteration, and the stops must be well formed.
  - `tests/browser.test.js`: headless Chrome (skipped if Chrome isn't
    found; set `CHROME=`). The page must load and dive with no exceptions
    or `console.error`. At deep minibrots the GPU and CPU renderers, at the
    same iteration count, must agree on which pixels are inside the set.
    This test catches float32 precision glitches.
  - To check an old commit: `git archive <rev> mandelbrot | tar -x -C /tmp/old`,
    then `SITE=/tmp/old npm test`.
- Headless Chrome on a Mac uses the real GPU, so the GPU path really is
  tested. If a port is busy, another server may be serving a different
  copy of the code. The tests pick a free port themselves.

## Deploying

Pushing to `master` deploys through GitHub Pages in about a minute
(`gh run list` shows it). The site sits behind **Cloudflare, which caches
`.js` files for up to 4 hours**, while the HTML isn't cached. So after a
push, visitors can get new HTML with stale scripts. Purge the cache in the
Cloudflare dashboard (Caching → Configuration), or check the live version
with a cache-busting query: `curl "https://arthurvigil.com/mandelbrot/core.js?nocache=1"`.

## Adding tour stops

Stops live in `LOCATIONS` in `core.js` as `[x, y, distance, maxColor, name]`.
Deep stops give x and y as decimal text, since they need more digits than a
double has. The view's horizontal span is distance / 3. Keep stops at or
above distance 1e-20.

1. Find a minibrot near a seed: `python3 mandelbrot/tools/minibrot.py X Y 1e-10`
   prints the period, the nucleus and a size estimate in about 0.1 s.
   Different box sizes (1e-8 to 1e-14) give different minibrots.
2. Preview it: `node mandelbrot/tools/preview.js /tmp/prev "name X Y DISTANCE"`.
   - Use about 60× the size for a tight view of the minibrot and its halo.
   - Use about 1000–3000× the size for a wider view with context.
   - A size estimate larger than the box means Newton landed on a doubled
     period. Skip that one.
3. Add the stop with a name, then run `npm test`. The stops test checks the
   format and the 1e-20 floor.

The tour shuffles the stops each round and keeps stops within 0.05 of each
other apart. Dives between deep stops take 20–90 s at the default camera
speed.

## Pitfalls learned the hard way

- **Never iterate past a reference orbit's end in float32.** When a pixel
  rebases onto a non-escaped reference's start with `dz = z` and `z` is
  still O(1), float32 rounds away the ~1e-13 differences between
  neighboring pixels. Whole regions then collapse onto one orbit, cutting
  straight-edged wedges into deep minibrots (fixed in f6c8ffb).
  - `gpu.js` `service()` now waits for a longer reference instead.
  - `pass()` logs `console.error` if it ever happens, and the browser test
    fails on that.
- **Compare renderers at equal iteration counts.** The CPU's iteration
  growth can stop early at deep minibrots: 4k iterations against the GPU's
  8–16k. The minibrot then looks like a smudge. That's a quality difference,
  not a precision bug.
- **Auto coloring:** the orbit trap goes flat at deep zooms in two ways:
  - exact repeats
  - every value within a unit or two of the others, near minibrots, which
    gives one smooth glow

  `trapIsFlat` (`core.js`) switches to escape time in both cases.
- **Escape-time mapping:** equal-area coloring can wash out the center of
  deep minibrots, because a few pixels span most of the escape-time range.
  That's what the **Escape-time mapping** setting / `?map=` is for: blend,
  bands, log cycles. The GPU shader (`FS_COLOR`) and `renderBand` must
  implement the same mappings.
- **The GPU iteration budget** comes from timer queries. Rates are kept per
  job, because an image's last passes are about 10× cheaper than its first.
  Averaging across jobs made the first frames of each new draft overshoot
  to 100–170 ms.
- **Worker code is stringified**: `renderBand`, `orbitValue`,
  `perturbValue`, `orbitValues` and the reference-orbit functions are
  shipped to workers with `Function.prototype.toString`. Keep them
  self-contained, with no closures over module state.

## Performance notes

See `perf-reference-orbits.md`, `perf-gpu.md` and `perf-cpu.md` in this
folder. Each covers what was measured and changed, and what was tried and
rejected.

Open ideas:
- Request a reference twice as long ahead of time, so a final never idles
  while it raises its iteration count.
- Start the final render as soon as a click zoom-in begins, since the GPU
  sits idle during the ~1 s animation.
- Let the CPU's iteration growth go further at deep minibrots.
