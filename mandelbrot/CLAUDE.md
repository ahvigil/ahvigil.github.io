# mandelbrot/

Browser Mandelbrot viewer (published at https://arthurvigil.com/mandelbrot/).
Read `docs/README.md` first: layout, tests, deploy, adding tour stops, pitfalls.

- No build step, no dependencies. Classic scripts, one global each; contracts
  and URL parameters are documented at the top of `index.html`'s script.
- Test: `cd mandelbrot && npm test`. It includes headless-Chrome GPU-vs-CPU
  checks; run it after touching `core.js`, `gpu.js`, `cpu.js` or the tour.
- Not published (excluded in the root `_config.yml`): `docs/`, `tests/`,
  `tools/`, `package.json`, this file. New dev-only files here need adding
  there too.
- The GPU color shader (`FS_COLOR` in `gpu.js`) and `renderBand` (`core.js`)
  must implement the same color mappings, and the same goes for both
  renderers' `colorRange`.
- Functions shipped to workers via `toString()` must stay self-contained.
- After pushing: GitHub Pages deploys in about a minute, but Cloudflare can
  serve stale `.js` for up to 4 hours; purge it or check with a
  `?nocache=` query.
