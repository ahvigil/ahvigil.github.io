"""Find a minibrot (a small copy of the Mandelbrot set) near a seed point.

usage: python3 mandelbrot/tools/minibrot.py X Y R [MAXPERIOD]
  X, Y   seed point (decimal text; may carry more digits than a double)
  R      half-width of the box searched around it (e.g. 1e-8 .. 1e-14)
prints: PERIOD NUCLEUS_X NUCLEUS_Y SIZE   (timings on stderr)

Method: the box period (the first n where a disk bounding the orbit of the
box contains 0) gives the period of a minibrot inside the box; Newton's
method on z_p(c) = 0 then finds its nucleus (center), and the size estimate
is 1 / |beta lambda^2|. A good tour stop is the nucleus at distance
SIZE * 60 (tight, minibrot with its halo) to SIZE * 3000 (wide, context);
preview with mandelbrot/tools/preview.js before adding it to LOCATIONS in core.js.

Gotchas:
 - Newton sometimes lands on a multiple of the true period (e.g. 232 = 2 x
   116); the size estimate is then wildly off (larger than R). Preview it.
 - "no period": the seed is inside a component, or the orbit escapes before
   the box contains 0; try a different seed or box size.
 - The box can't be smaller than the seed's digits resolve: chain searches
   (use a found nucleus as the next seed) to go deeper.
Fixed-point integers throughout: precision follows depth, Newton doubles
its precision as it converges, and an escape guard stops runaway steps.
"""
import sys, math, time
from decimal import Decimal, getcontext

def parse(s, F):
    getcontext().prec = F // 3 + 30
    return int(Decimal(s) * (1 << F))

def box_period(cx, cy, F, r, maxp):
    zx = zy = 0; rho = 0.0
    sh = max(F - 52, 0); scale = 2.0 ** -(F - sh)
    for n in range(1, maxp + 1):
        x2, y2 = (zx * zx) >> F, (zy * zy) >> F
        zy = ((zx * zy) >> (F - 1)) + cy
        zx = x2 - y2 + cx
        az = math.hypot((zx >> sh) * scale, (zy >> sh) * scale)
        rho = 2 * az * rho + rho * rho + r
        if az > 4 or rho > 4: return None
        if az <= rho: return n
    return None

def newton_step(cx, cy, p, F):
    ONE = 1 << F
    zx = zy = dx = dy = 0
    for _ in range(p):
        dx, dy = ((zx * dx - zy * dy) >> (F - 1)) + ONE, (zx * dy + zy * dx) >> (F - 1)
        x2, y2 = (zx * zx) >> F, (zy * zy) >> F
        zy = ((zx * zy) >> (F - 1)) + cy
        zx = x2 - y2 + cx
        if x2 + y2 > LIMIT << F:      # escaped: numbers would grow without bound
            return None
    den = (dx * dx + dy * dy) >> F
    if den == 0: return None
    qx = (((zx * dx + zy * dy) >> F) << F) // den
    qy = (((zy * dx - zx * dy) >> F) << F) // den
    return cx - qx, cy - qy, math.hypot(qx, qy) / 2.0 ** F

LIMIT = 1 << 20

def newton(cx, cy, F0, p, Ffinal, tol):
    # Damped Newton: a step that lands where the orbit escapes is halved
    # (up to 40 times) before giving up.
    F = F0
    r = newton_step(cx, cy, p, F)
    if not r: return None
    for _ in range(80):
        nx, ny, step = r
        dxs, dys = nx - cx, ny - cy
        for _ in range(40):
            nr = newton_step(cx + dxs, cy + dys, p, F)
            if nr: break
            dxs, dys = dxs // 2, dys // 2
        else:
            return None
        cx, cy = cx + dxs, cy + dys
        r = nr
        if step < tol and F == Ffinal: return cx, cy
        if step < 2.0 ** (-F // 2) or step < tol:   # converged at this precision: double it
            nF = min(Ffinal, 2 * F)
            cx, cy, F = cx << (nF - F), cy << (nF - F), nF
            r = newton_step(cx, cy, p, F)
            if not r: return None
    return cx, cy

def size(cx, cy, p, F):
    zx = zy = 0; lr, li, le = 1.0, 0.0, 0; br, bi = 1.0, 0.0
    sh = max(F - 52, 0); scale = 2.0 ** -(F - sh)
    for i in range(1, p):
        x2, y2 = (zx * zx) >> F, (zy * zy) >> F
        zy = ((zx * zy) >> (F - 1)) + cy
        zx = x2 - y2 + cx
        x, y = 2 * (zx >> sh) * scale, 2 * (zy >> sh) * scale
        lr, li = lr * x - li * y, lr * y + li * x
        m, e = math.frexp(math.hypot(lr, li)); lr, li, le = lr / 2**e, li / 2**e, le + e
        if le < 1000:
            d = (lr * lr + li * li) * 2.0 ** le
            br += lr / d; bi -= li / d
    return 1 / (math.hypot(br, bi) * math.hypot(lr, li) ** 2) * 2.0 ** (-2 * le)

def dec(v, F, digits):
    getcontext().prec = digits + 30
    return format((Decimal(v) / (1 << F)).quantize(Decimal(1).scaleb(-digits)), 'f')

x, y, r = sys.argv[1], sys.argv[2], float(sys.argv[3])
maxp = int(sys.argv[4]) if len(sys.argv) > 4 else 20000
t0 = time.time()
Fb = int(-math.log2(r)) + 48
p = box_period(parse(x, Fb), parse(y, Fb), Fb, r, maxp)
t1 = time.time()
if not p: print("no period"); sys.exit(1)
# Minibrot sizes run around r^2 or smaller; aim the final precision past that.
Ff = 2 * Fb + 64
n = newton(parse(x, Ff) >> (Ff - Fb), parse(y, Ff) >> (Ff - Fb), Fb, p, Ff, r * r * 1e-8)
t2 = time.time()
s = size(*n, p, Ff)
t3 = time.time()
digits = int(-math.log10(s)) + 6
print(p, dec(n[0], Ff, digits), dec(n[1], Ff, digits), "%.3g" % s)
print("box %.2fs  newton %.2fs  size %.2fs" % (t1 - t0, t2 - t1, t3 - t2), file=sys.stderr)
