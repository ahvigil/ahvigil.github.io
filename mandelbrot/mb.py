#!/usr/bin/env python3
"""Terminal Mandelbrot screensaver.

Draws the Mandelbrot set character by character, then zooms through a
handful of interesting locations forever. Press Ctrl-C to quit.

    python3 mb.py                  # run the screensaver
    python3 mb.py --once           # draw one frame and exit
    curl -s https://arthurvigil.com/mandelbrot/mb.py | python3 - --speed 0.5
"""
import argparse
import colorsys
import os
import random
import shutil
import sys
import time

OUT = sys.stderr

GLYPHS = [".", ".", "+", "*", "%", "#"]

# (x, y, distance, max_color): lower distance zooms in; max_color stretches
# the color/glyph ramp to suit how deep each view's orbits get.
LOCATIONS = [
    (-0.5, 0.0, 6.75, 256),
    (0.37865401, 0.669227668, 0.04, 111),
    (-1.2693, -0.4145, 0.2, 105),
    (-1.2693, -0.4145, 0.05, 97),
    (-1.2642, -0.4185, 0.01, 95),
    (-1.15, -0.28, 0.9, 94),
    (-1.15, -0.28, 0.3, 58),
    (-1.15, -0.28, 0.05, 26),
    (-1.401155, 0.0, 0.2, 51),     # Feigenbaum point: period-doubling cascade
    (-1.7685, 0.0, 0.2, 58),       # minibrot on the main antenna
    (-0.1011, 0.9563, 0.04, 86),   # Misiurewicz point: spiraling filaments
    (-0.660295, 0.438827, 0.1, 69),   # banded filaments off the main cardioid
    (-1.234948, 0.164974, 0.02, 26),  # just outside the period-2 bulb
    (-0.180977, 0.844923, 0.02, 36),  # edge of the period-3 bulb
    (-0.558794, 0.627494, 0.1, 61),   # tendrils between the cardioid and top bulb
    (0.393174, 0.370292, 0.02, 42),   # a bulb on the right edge of the cardioid
    (0.149181, 0.655944, 0.02, 52),   # side bulb on the upper-right shoulder
    (-0.465086, 0.625207, 0.005, 45),  # deep zoom: knotted bands
    (-0.735379, 0.290928, 0.005, 42),  # deep zoom: seahorse valley wall
    (-1.050426, 0.262645, 0.005, 30),  # deep zoom: outskirts of the period-2 bulb
]

RAMP_STEPS = 80


# --- color ----------------------------------------------------------------

def ramp_hsv(u):
    """The palette's HSV curve, for u in [0, 1)."""
    return 0.57 + u, 1 - u ** 3, 1.0


def hsv_to_ansi256(h, s, v):
    """Map an HSV color onto the xterm 256-color cube (or grayscale ramp)."""
    if s < 0.1:
        return int(v * 23) + 232
    r, g, b = (int(x * 5) for x in colorsys.hsv_to_rgb(h, s, v))
    return 16 + r * 36 + g * 6 + b


def detect_color_mode(no_color=False):
    if no_color or "NO_COLOR" in os.environ or not OUT.isatty():
        return "none"
    if os.environ.get("COLORTERM", "").lower() in ("truecolor", "24bit"):
        return "truecolor"
    if "256" in os.environ.get("TERM", ""):
        return "256"
    return "8"


def build_palette(mode):
    """Return a list of SGR parameter strings, ordered along the ramp."""
    if mode == "none":
        return [None]
    if mode == "8":
        return ["39", "34", "35", "36", "31", "33", "32", "37"]
    if mode == "256":
        return ["38;5;%d" % hsv_to_ansi256(*ramp_hsv(i / RAMP_STEPS))
                for i in range(RAMP_STEPS)]
    # truecolor: same curve, sampled finely for a smooth gradient
    steps = 256
    palette = []
    for i in range(steps):
        u = i / steps * (RAMP_STEPS - 1) / RAMP_STEPS
        r, g, b = (int(x * 255) for x in colorsys.hsv_to_rgb(*ramp_hsv(u)))
        palette.append("38;2;%d;%d;%d" % (r, g, b))
    return palette


# --- terminal -------------------------------------------------------------

def terminal_width():
    try:
        width = os.get_terminal_size(OUT.fileno()).columns
    except (OSError, ValueError, AttributeError):
        width = shutil.get_terminal_size((80, 24)).columns
    return width if width >= 40 else 80


# --- fractal --------------------------------------------------------------

class Mandelbrot:
    ASPECT_RATIO = 1 / 3.0  # compensates for tall terminal cells

    def __init__(self, width, height=100, x_pos=-0.5, y_pos=0.0,
                 distance=6.75, iterations=170):
        self.width = width
        self.height = height
        self.iterations = iterations
        yscale = float(distance) / width
        xscale = yscale * self.ASPECT_RATIO
        xmin = x_pos - xscale * width / 2
        ymin = y_pos - yscale * height / 2
        self.xs = [xmin + xscale * ix for ix in range(width)]
        self.ys = [ymin + yscale * iy for iy in range(height)]

    def rows(self):
        """Yield one row at a time as a generator of per-pixel values.

        A value of 0 means the point is in the set; otherwise it is 1..255,
        derived from how close the orbit came to the origin before escaping.
        """
        for y in self.ys:
            yield (self.pixel(complex(x, y)) for x in self.xs)

    def pixel(self, c):
        z = 0j
        mind = 2.0
        for _ in range(self.iterations):
            z = z * z + c
            d = abs(z)
            if d >= 2:
                return min(int(mind / 0.007), 254) + 1
            if d < mind:
                mind = d
        return 0


# --- screensaver ----------------------------------------------------------

class Screensaver:
    def __init__(self, palette, iterations=170, speed=1.0, invert=True,
                 location=0):
        self.palette = palette
        self.iterations = iterations
        self.speed = speed
        self.invert = invert
        self.location = location % len(LOCATIONS)
        self.current_esc = None
        self.mid_line = False

    def run(self, once=False):
        while True:
            if not self.draw_frame():
                continue  # terminal resized: redraw the same location
            if once:
                return
            self.location = (self.location + 1) % len(LOCATIONS)
            OUT.write("\n")

    def draw_frame(self):
        """Draw the current location. Returns False if interrupted by a resize."""
        x, y, distance, max_color = LOCATIONS[self.location]
        width = terminal_width()
        fractal = Mandelbrot(width, x_pos=x, y_pos=y, distance=distance,
                             iterations=self.iterations)
        for row in fractal.rows():
            if terminal_width() != width:
                self.end_line()
                return False
            for value in row:
                self.put(value, max_color)
            self.end_line()
            if self.speed > 0:
                time.sleep(random.random() / 10 * self.speed)
        return True

    def put(self, value, max_color):
        t = min((value + 1) / max_color, 1.0)
        if self.invert:
            t = 1.0 - t
        glyph = GLYPHS[min(int(t * (len(GLYPHS) - 1)), len(GLYPHS) - 1)]
        esc = self.palette[min(int(t * (len(self.palette) - 1)),
                               len(self.palette) - 1)]
        if esc != self.current_esc:
            OUT.write("\x1b[%sm" % esc if esc else "\x1b[0m")
            self.current_esc = esc
        OUT.write(glyph)
        OUT.flush()
        self.mid_line = True

    def end_line(self):
        if self.current_esc:
            OUT.write("\x1b[0m")
            self.current_esc = None
        OUT.write("\n")
        OUT.flush()
        self.mid_line = False


def main(argv=None):
    parser = argparse.ArgumentParser(description="Terminal Mandelbrot screensaver.")
    parser.add_argument("--speed", type=float, default=1.0,
                        help="row delay multiplier; 0 draws as fast as possible (default: 1)")
    parser.add_argument("--iterations", type=int, default=170,
                        help="max iterations per point (default: 170)")
    parser.add_argument("--location", type=int, default=0,
                        help="starting location index, 0-%d (default: 0)" % (len(LOCATIONS) - 1))
    parser.add_argument("--once", action="store_true",
                        help="draw a single frame and exit")
    parser.add_argument("--no-color", action="store_true",
                        help="disable color output")
    parser.add_argument("--at", type=float, nargs="+",
                        metavar="N",
                        help="render a custom location X Y DISTANCE [MAX_COLOR] "
                             "(implies --once; MAX_COLOR defaults to 256)")
    args = parser.parse_args(argv)
    if args.at:
        if len(args.at) not in (3, 4):
            parser.error("--at takes X Y DISTANCE [MAX_COLOR]")
        x, y, distance = args.at[:3]
        max_color = args.at[3] if len(args.at) == 4 else 256
        LOCATIONS[:] = [(x, y, distance, max_color)]
        args.location, args.once = 0, True

    palette = build_palette(detect_color_mode(args.no_color))
    saver = Screensaver(palette, iterations=args.iterations, speed=args.speed,
                        location=args.location)
    tty = OUT.isatty()
    if tty:
        OUT.write("\x1b[?25l")  # hide cursor
    try:
        saver.run(once=args.once)
    except KeyboardInterrupt:
        pass
    finally:
        OUT.write("\x1b[0m" if tty else "")
        if saver.mid_line:
            OUT.write("\n")
        if tty:
            OUT.write("\x1b[?25h")  # show cursor
        OUT.flush()


if __name__ == "__main__":
    main()
