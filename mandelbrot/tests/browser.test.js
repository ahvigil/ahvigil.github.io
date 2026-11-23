"use strict";
// End-to-end checks of mandelbrot/index.html in headless Chrome:
// - no script errors or console.error (gpu.js logs invariant violations),
// - the GPU renderer agrees with the CPU renderer (hi-res, double precision)
//   on which pixels are inside the set at deep views. A float32 precision
//   glitch on the GPU shows up as missing or extra chunks of a minibrot.
//
// Run from mandelbrot/: npm test   (skips if Chrome isn't found; set CHROME to
// its path). SITE=<dir> serves another copy of the site, a directory holding
// mandelbrot/ (e.g. an older commit: git archive <rev> mandelbrot | tar -x -C <dir>).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");

// The site root: the directory holding mandelbrot/ (served at /mandelbrot/).
const SITE = path.resolve(process.env.SITE || path.join(__dirname, "..", ".."));
const CHROME = process.env.CHROME || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find((p) => fs.existsSync(p));
const WIDTH = 800, HEIGHT = 500;

// --- static server ---------------------------------------------------------------------

function serve(root) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// --- Chrome over the DevTools protocol -------------------------------------------------------

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mb-chrome-"));
  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`, "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "about:blank",
  ], { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
  return { proc, port, profile };
}

async function openPage(port) {
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waits = new Map(), errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); }
    if (d.method === "Runtime.exceptionThrown") {
      const x = d.params.exceptionDetails;
      errors.push("exception: " + ((x.exception && x.exception.description) || x.text));
    }
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") {
      errors.push("console.error: " + d.params.args.map((a) => a.value ?? a.description).join(" "));
    }
  };
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    waits.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => {
    const r = (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result;
    if (r.exceptionDetails) throw new Error("evaluate: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  return { send, evaluate, errors, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Loads url and waits until the page reports its view rendered.
async function render(page, url, timeoutMs = 90000) {
  await page.send("Page.navigate", { url });
  await sleep(500);
  const t0 = Date.now();
  while (!(await page.evaluate("typeof rendered !== 'undefined' && rendered"))) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out rendering ${url}`);
    await sleep(250);
  }
  await sleep(600);  // color fade
  await page.evaluate(`hud.style.display = "none";
    for (const el of document.querySelectorAll("#mb-bar")) el.style.display = "none"; true`);
  await sleep(100);
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  return decodePng(Buffer.from(shot.result.data, "base64"));
}

// --- PNG decoding (8-bit RGB/RGBA, non-interlaced: what Chrome produces) ---------------------

function decodePng(buf) {
  let p = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("unsupported PNG");
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error("unsupported PNG color type " + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0, b = y ? px[up + x] : 0, c = x >= bpp && y ? px[up + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v & 255;
    }
  }
  return { width, height, bpp, px };
}

// Pixels drawn black: inside the set (no palette starts this dark).
function insideMask(img) {
  const n = img.width * img.height, mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * img.bpp;
    mask[i] = img.px[o] + img.px[o + 1] + img.px[o + 2] < 24 ? 1 : 0;
  }
  return mask;
}

// --- tests ---------------------------------------------------------------------------------

const VIEWS = [
  // Deep minibrots, centered and off-center; the last is where a GPU
  // precision glitch was first reported.
  { name: "neck stop", query: "location=4&once" },
  { name: "seahorse stop", query: "location=2&once" },
  { name: "off-center neck view", query: "at=-1.25065946995669,0.02012025532361,4.392e-10,3" },
];

test("mandelbrot page in headless Chrome", { skip: !CHROME && "Chrome not found (set CHROME)", timeout: 600000 }, async (t) => {
  const server = await serve(SITE);
  const base = `http://127.0.0.1:${server.address().port}/mandelbrot/`;
  const chrome = await launchChrome();
  const page = await openPage(chrome.port);
  try {
    await t.test("tour loads and dives without errors", async () => {
      await render(page, base);
      await page.evaluate("setAnim({ speed: 8 }); go(1); true");
      await sleep(300);
      const t0 = Date.now();
      while (await page.evaluate("camera.animating() || !rendered")) {
        if (Date.now() - t0 > 120000) throw new Error("dive never finished");
        await sleep(250);
      }
      assert.deepEqual(page.errors, []);
    });

    await t.test("pause freezes a dive and resume continues it", async () => {
      await render(page, base);
      await page.evaluate("setAnim({ speed: 2 }); go(1); true");
      await sleep(1500);
      await page.evaluate("togglePause(); true");
      const a = await page.evaluate("camera.cam.distance");
      await sleep(800);
      assert.equal(await page.evaluate("camera.cam.distance"), a, "camera moved while paused");
      assert.equal(await page.evaluate("camera.animating() && paused"), true);
      await page.evaluate("togglePause(); true");
      await sleep(800);
      assert.notEqual(await page.evaluate("camera.cam.distance"), a, "camera didn't resume");
    });

    await t.test("tour order: each round visits every stop once, neighbors apart", async () => {
      const bad = await page.evaluate(`(() => {
        const problems = [];
        const near = (a, b) => Math.hypot(locations[a][0] - locations[b][0], locations[a][1] - locations[b][1]) < 0.05;
        for (let k = 0; k < 200; k++) {
          const first = k % n, o = shuffled(first);
          if (o[0] !== first || o.length !== n || new Set(o).size !== n) problems.push("not a permutation: " + o);
          for (let i = 1; i < o.length; i++) if (near(o[i - 1], o[i])) problems.push("neighbors adjacent: " + o);
        }
        return problems.slice(0, 3);
      })()`);
      assert.deepEqual(bad, []);
    });

    await t.test("URL parameters set the settings; bad values fall back", async () => {
      const state = "JSON.stringify({ r: rendererPref, scale: iterationScale, speed: anim.speed, dive: anim.dive, map: colorMap, color: colorMode, palette, auto: autoRange, hd: hiRes })";
      await page.send("Page.navigate", { url: `${base}?renderer=cpu&scale=4&speed=fast&dive=0&map=bands&color=escape&palette=ice&auto=0&hd=1&once` });
      await sleep(800);
      assert.deepEqual(JSON.parse(await page.evaluate(state)),
        { r: "cpu", scale: 4, speed: 6, dive: false, map: "bands", color: "escape", palette: "ice", auto: false, hd: true });
      await page.send("Page.navigate", { url: `${base}?renderer=nope&scale=-2&speed=bogus&map=nope&color=nope&palette=nope&once` });
      await sleep(800);
      const d = JSON.parse(await page.evaluate(state));
      assert.equal(d.scale, 1);
      assert.ok(d.speed > 0 && d.speed !== 6);
      assert.ok(["auto", "gpu", "cpu"].includes(d.r));
      assert.ok(["equal", "blend", "bands", "cycles"].includes(d.map));
      assert.equal(d.color, "auto");
      assert.ok(d.palette !== "nope");
    });

    await t.test("HUD and buttons stay on screen and apart at common sizes", async () => {
      const sizes = [[390, 844, true], [844, 390, true], [360, 640, true], [820, 1180, true], [660, 500, false], [1280, 800, false]];
      try {
        for (const [w, h, touch] of sizes) {
          await page.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
          await page.send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 0 });
          await page.send("Page.navigate", { url: `${base}?location=1&once` });
          await sleep(800);
          for (const m of ["tour", "explore"]) {
            const r = JSON.parse(await page.evaluate(`mode = "${m}"; updateHud("", 60000);
              JSON.stringify((() => { const h = hud.getBoundingClientRect(), b = document.getElementById("mb-bar").getBoundingClientRect();
                return { overlap: !(h.right <= b.left || b.right <= h.left || h.bottom <= b.top || b.bottom <= h.top),
                         offscreen: h.left < 0 || h.right > innerWidth || h.top < 0 || h.bottom > innerHeight ||
                                    b.left < 0 || b.right > innerWidth || b.top < 0 || b.bottom > innerHeight }; })())`));
            assert.deepEqual(r, { overlap: false, offscreen: false }, `${w}x${h} ${touch ? "touch" : "mouse"} ${m}`);
          }
        }
      } finally {
        await page.send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 0 });
        await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
      }
    });

    const gpu = await page.evaluate("gpuRenderer.available");
    for (const view of VIEWS) {
      await t.test(`GPU matches CPU inside the set: ${view.name}`, { skip: !gpu && "no WebGL2 here" }, async () => {
        page.errors.length = 0;
        const g = await render(page, `${base}?${view.query}&color=trap`);
        assert.equal(await page.evaluate("renderer.name"), "gpu");
        const gi = await page.evaluate("renderer.status().effectiveIterations");
        // Same iteration count on the CPU (?iterations is the floor both
        // renderers grow from), so only precision differs.
        const c = await render(page, `${base}?${view.query}&color=trap&gpu=0&hd=1&iterations=${gi}`);
        assert.equal(await page.evaluate("renderer.name"), "cpu");
        const ci = await page.evaluate("renderer.status().effectiveIterations");
        if (process.env.DUMP) {
          for (const [k, img] of [["gpu", g], ["cpu", c]]) {
            fs.writeFileSync(path.join(process.env.DUMP, `${view.name.replace(/\W+/g, "-")}-${k}.ppm`),
              Buffer.concat([Buffer.from(`P6 ${img.width} ${img.height} 255\n`),
                Buffer.from(Array.from({ length: img.width * img.height * 3 }, (_, i) => img.px[Math.floor(i / 3) * img.bpp + i % 3]))]));
          }
        }
        assert.deepEqual(page.errors, []);
        const a = insideMask(g), b = insideMask(c);
        let either = 0, differ = 0;
        for (let i = 0; i < a.length; i++) { either += a[i] | b[i]; differ += a[i] ^ b[i]; }
        assert.ok(either > 50, `${view.name}: expected a visible minibrot (${either} inside pixels)`);
        // The renderers pick different iteration counts and the GPU's
        // float32 rounds differently, so the edges differ a little.
        const share = differ / either;
        assert.ok(share < 0.15, `${view.name}: GPU (${gi} iterations) and CPU (${ci}) disagree on ${(100 * share).toFixed(1)}% of inside pixels`);
      });
    }
  } finally {
    page.close();
    chrome.proc.kill();
    server.close();
    await sleep(200);
    fs.rmSync(chrome.profile, { recursive: true, force: true });
  }
});
