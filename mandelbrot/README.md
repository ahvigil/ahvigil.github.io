# Mandelbrot viewer: user guide

A full-screen, animated tour of the Mandelbrot set that runs in the browser:
https://arthurvigil.com/mandelbrot/

It plays a tour of deep zooms on its own. You can pause it at any point and
explore. It needs no install or sign-in, and works on phones and tablets as
well as desktops. (Developer notes are in `docs/README.md`.)

## The tour

When the page opens, the camera dives from the whole set to one stop after
another. It holds at each stop for 5 seconds once the image is finished,
then dives to the next. The 11 stops are minibrots (small copies of the set)
as deep as 1e-20, in places such as seahorse valley, the antenna and the
cusp. They play in random order, reshuffled each round, and stops close to
each other are kept apart. A dive between two deep stops takes 20–90 seconds
at the default speed.

The panel at the bottom right (the HUD) shows the stop number, its name and
the current magnification. It fades out after a few seconds and comes back
when you move the mouse or press a key.

| Key | Action |
|---|---|
| Space | Pause or resume (a dive freezes where it is) |
| → or `n` | Next stop |
| ← | Previous stop |
| `r` | Restart the built-in tour from the whole set |
| `s` | Open settings |

The button bar at the bottom left (‹ ▶ › ⚙) does the same as ←, Space, →
and `s`. It shows when you move the mouse; on touch screens it is always
visible.

## Exploring

Click anywhere (or tap) to leave the tour and explore from there. The tour
pauses while you explore.

| Input | Action |
|---|---|
| Click / tap | Zoom in 4× toward that point |
| Shift-click | Zoom out 4× |
| Wheel, pinch | Zoom smoothly |
| Drag | Pan |
| Esc, Space or ▶ | Back to the tour |

Keys that work while exploring:

| Key | Action |
|---|---|
| `-` / `+` | Halve / double the iterations (more iterations show more detail near the set, but render more slowly) |
| `[` / `]` | Narrow / widen the color range (switches off the auto color range) |
| `c` | Copy the view as `X Y DISTANCE MAX_COLOR` |

Keys that work anytime:

| Key | Action |
|---|---|
| `p` | Next palette |
| `a` | Auto color range on or off |
| `o` | Coloring: auto → orbit trap → escape time |
| `h` | Hi-res mode on or off (CPU renderer only, see below) |

While exploring, the HUD shows the coordinates, the iteration count and the
coloring in use. Iterations rise on their own as you zoom deeper.

**Saving and sharing a view.** The address bar always holds the current view
(`?at=…` while exploring, `?location=N` on the tour). Reloading picks up
where you were, and copying the URL shares that exact view.

**How deep you can go.** The GPU renderer, and the CPU renderer in hi-res,
reach far deeper than the tour does. The CPU renderer in lo-res stops at
about 1e-13: the HUD says "max zoom" and suggests `h`.

## Settings

Press `s` or the ⚙ button. Changes apply right away.

**Rendering**
- **Renderer**: *auto* (the GPU when the browser supports WebGL2, otherwise
  the CPU), *GPU* or *CPU*. The GPU is much faster. Only the GPU renderer
  animates dives between stops; the CPU renderer cuts straight to the next
  stop.
- **Precision (CPU)**: *lo-res* uses plain 64-bit floats and runs out of
  precision near 1e-13. *hi-res* uses perturbation and goes much deeper.
  The GPU always uses perturbation.
- **Iterations**: a multiplier from ×1/8 to ×16 on the automatic count.
  Raise it if a deep minibrot looks smudged; lower it on a slow machine.

**Color**
- **Coloring**: *orbit trap* gives the soft, glowing look. *Escape time*
  gives smooth bands. *Auto* uses orbit trap until it goes flat at deep
  zooms, then switches to escape time.
- **Escape-time mapping**: how escape times are spread over the palette.
  *Equal area* gives every color the same share of the screen. *Blend*,
  *bands* and *log cycles* keep more contrast in the center of deep
  minibrots, which equal area can wash out.
- **Auto color range**: stretch the colors to what is on screen.
- **Palette**: ultra, fire, ice, neon, mono, sunset, forest, copper, aurora,
  spectrum or terminal. Spectrum sweeps through every hue.

**Animation**
- **Camera speed**: slow, relaxed (the default), brisk or fast.
- **Tour dive**: animate between stops. Turn it off to cut straight to each
  stop.
- **Hold at stop**: how long to stay at each stop, from 0 to 60 seconds.

The browser remembers the renderer, palette, escape-time mapping and the
animation settings between visits.

## URL parameters

Add these to the address to start a certain way, for example
`https://arthurvigil.com/mandelbrot/?palette=fire&speed=slow`. Values that
aren't valid are ignored.

| Parameter | Effect |
|---|---|
| `location=N` | Start the tour at stop N (0–10) |
| `at=X,Y,DISTANCE[,MAX_COLOR]` | Show one view and stay there. DISTANCE is the zoom depth (6.75 is the whole set; the view is DISTANCE/3 wide). X and Y keep every digit you give. |
| `once` | Show the first stop and don't advance |
| `hold=SECONDS` | Time at each stop (default 5) |
| `speed=slow\|relaxed\|brisk\|fast` | Camera speed |
| `dive=0` | Cut between stops instead of diving |
| `palette=NAME` | ultra, fire, ice, neon, mono, sunset, forest, copper, aurora, spectrum, terminal |
| `color=auto\|trap\|escape` | Coloring |
| `map=equal\|blend\|bands\|cycles` | Escape-time mapping |
| `auto=0` | Fixed color range |
| `iterations=N` | Minimum iteration count (default 500) |
| `scale=N` | Iteration multiplier, 1/8 to 16 |
| `renderer=auto\|gpu\|cpu` | Renderer (`gpu=0` also picks the CPU) |
| `hd=1` | Hi-res mode for the CPU renderer |

Parameters set this way apply to this visit and aren't saved unless you
change the setting in the dialog.

## Terminal versions

The same idea in text characters:

- **`terminal.html`** (https://arthurvigil.com/mandelbrot/terminal.html):
  draws the set as colored characters and steps through its own list of
  stops. Space pauses; → / `n` / click goes to the next stop; ← goes back.
  It takes `?at=`, `?once` and `?speed=`.
- **`mb.py`**: a terminal screensaver in Python 3 with no dependencies.
  Press Ctrl-C to quit.

  ```sh
  curl -s https://arthurvigil.com/mandelbrot/mb.py | python3 -
  python3 mb.py --once                    # draw one frame and exit
  python3 mb.py --at X Y DISTANCE MAX_COLOR   # draw a view copied with c
  ```

  Other options: `--speed` (row delay multiplier, 0 = as fast as possible),
  `--iterations`, `--location`, `--no-color`. Run `python3 mb.py --help`
  for the full list.

## Troubleshooting

- **Slow or choppy**: check that the renderer is GPU in settings. If the
  GPU isn't available, lower Iterations or zoom less deep.
- **Deep minibrot looks like a smudge**: raise Iterations (`+` or the
  setting).
- **Center of a minibrot washed out**: set Escape-time mapping to blend,
  bands or log cycles.
- **Can't zoom deeper**: on the CPU renderer, press `h` for hi-res.
