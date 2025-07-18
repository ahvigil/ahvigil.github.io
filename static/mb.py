from __future__ import print_function
import sys, os, unicodedata, colorsys

def h2a(h, s, v):
    if s < 0.1:
        return int(v * 23) + 232
    r, g, b = map(lambda x: int(x * 5), colorsys.hsv_to_rgb(h, s, v))
    return 16 + (r * 36) + (g * 6) + b

ansi_ramp80 = [
    h2a(0.57 + float(i) / 80, 1 - pow(float(i) / 80, 3), 1)
    for i in range(80)
]

if os.environ.get('TERM', 'dumb').find('256') > 0:
    palette = list(map(lambda x: "38;5;%d" % x, ansi_ramp80))
else:
    palette = [39, 34, 35, 36, 31, 33, 32, 37]

DEBUG = False

def _getdimensions():
    import termios, fcntl, struct
    call = fcntl.ioctl(1, termios.TIOCGWINSZ, "\000" * 8)
    h, w = struct.unpack("hhhh", call)[:2]
    return h, w

def get_terminal_width():
    width = 0
    try:
        _, width = _getdimensions()
    except:
        pass

    if width == 0:
        width = int(os.environ.get('COLUMNS', 80))

    if width < 40:
        width = 80
    return width

terminal_width = get_terminal_width()

char_width = {
    'A': 1,   # "Ambiguous"
    'F': 2,   # Fullwidth
    'H': 1,   # Halfwidth
    'N': 1,   # Neutral
    'Na': 1,  # Narrow
    'W': 2,   # Wide
}

def get_line_width(text):
    text = unicodedata.normalize('NFC', text)
    return sum(char_width.get(unicodedata.east_asian_width(c), 1) for c in text)

def ansi_print(text, esc, file=None, newline=True, flush=False):
    if file is None:
        file = sys.stderr
    text = text.rstrip()
    if esc and not isinstance(esc, tuple):
        esc = (esc,)
    if esc and file.isatty():
        text = (''.join(['\x1b[%sm' % cod for cod in esc])  +
                text +
                '\x1b[0m')     # ANSI color code "reset"
    if newline:
        text += '\n'

    file.write(text)
    
    if flush:
        file.flush()

class M:
    def __init__ (self, width=100, height=100, x_pos=-0.5, y_pos=0, distance=6.75):
        self.xpos = x_pos
        self.ypos = y_pos
        aspect_ratio = 1/3.
        factor = float(distance) / width # lowering the distance will zoom in
        self.xscale = factor * aspect_ratio
        self.yscale = factor
        self.x = width
        self.y = height

        self.iterations = 170

    def init(self):
        self.reset_lines = False
        xmin = self.xpos - self.xscale * self.x / 2
        ymin = self.ypos - self.yscale * self.y / 2
        self.x_range = [xmin + self.xscale * ix for ix in range(self.x)]
        self.y_range = [ymin + self.yscale * iy for iy in range(self.y)]

    def reset(self, cnt):
        self.reset_lines = cnt

    def generate(self):
        self.reset_lines = False
        iy = 0
        while iy < self.y:
            ix = 0
            while ix < self.x:
                c = complex(self.x_range[ix], self.y_range[iy])
                z = complex(0, 0)
                color = 0
                mind = 2

                for i in range(self.iterations):
                    z = z * z + c
                    d = abs(z)
                    if d >= 2:
                        color = min(int(mind / 0.007), 254) + 1
                        break
                    else:
                        mind = min(d, mind)

                yield ix, iy, color
                if self.reset_lines is not False: # jump to the beginning of the line
                    iy += self.reset_lines
                    self.reset_lines = False
                    break
                else:
                    ix += 1
            iy += 1


class D(object):
    locations = [
        (0.37865401, 0.669227668, 0.04, 111),
        (-1.2693, -0.4145, 0.2, 105),
        (-1.2693, -0.4145, 0.05, 97),
        (-1.2642, -0.4185, 0.01, 95),
        (-1.15, -0.28, 0.9, 94),
        (-1.15, -0.28, 0.3, 58),
        (-1.15, -0.28, 0.05, 26),
            ]
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.location = -1
        self.max_color = 256
        self.color_range = None
        self.invert = True
        self.init()

    def init(self):
        self.width = get_terminal_width() or 80
        self.mb = M(width=(self.width or 1), **self.kwargs)
        self.mb.init()
        self.gen = self.mb.generate()

    def reset(self, cnt=0):
        self.mb.reset(cnt)

    def restart(self):
        print(file=sys.stderr)
        self.init()

    def dot(self):
        x = c = 0
        try:
            x, y, c = next(self.gen)
            if x == 0:
                width = get_terminal_width()
                if width != self.width:
                    print(file=sys.stderr)
                    self.init()
        except StopIteration:
            kwargs = self.kwargs
            self.location += 1
            self.location %= len(self.locations)
            loc = self.locations[self.location]
            kwargs.update({"x_pos": loc[0], "y_pos": loc[1], "distance": loc[2]})
            self.max_color = loc[3]
            self.color_range = None
            self.restart()
            return
        self.pixel(c, self.invert)

        if x == self.width - 1:
            sleep(random.random() / 10)


    def pixel(self, color, invert=1):
        chars = [".", ".", "+", "*", "%", "#"]
        idx = lambda chars: (color+1) * (len(chars) - 1) // self.max_color
        if invert:
            idx = lambda chars, idx=idx:len(chars) - 1 - idx(chars)
        char = chars[idx(chars)]
        ansi_color = palette[idx(palette)]
        ansi_print(char, ansi_color, newline=False, flush=True)

if __name__ == '__main__':
    import random
    from time import sleep

    d = D()
    while True:
        try:
            d.dot()
        except KeyboardInterrupt:
            sys.exit(0)
