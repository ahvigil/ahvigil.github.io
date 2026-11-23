"use strict";
/*
 * Settings dialog and the on-screen button bar (previous / play-pause / next
 * for the tour, and the settings gear). Every control calls the page's setter
 * immediately; control values are re-read from the page globals whenever the
 * dialog opens and after each change. All DOM is created in init().
 *
 * The bar fades in on activity and out after 3 s idle; on touch screens
 * (coarse pointer), where there are no keys, it stays visible.
 */
const settings = (() => {
  const CSS = `
  #mb-bar {
    position: fixed; left: 12px; bottom: 10px; display: flex; gap: 4px;
    opacity: 0; transition: opacity 0.6s;
  }
  #mb-bar button {
    width: 30px; height: 28px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.85); color: #bbb; border: 0; border-radius: 3px;
    font: 14px/1 ui-monospace, Menlo, Consolas, monospace; cursor: pointer;
    touch-action: manipulation;
    pointer-events: none;  /* invisible: clicks go to the stage */
  }
  #mb-bar.show, #mb-bar:focus-within { opacity: 1; transition: none; }
  #mb-bar.show button, #mb-bar:focus-within button { pointer-events: auto; }
  #mb-bar button:hover { color: #fff; }
  #mb-bar button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 1px; }
  @media (pointer: coarse) {
    #mb-bar { opacity: 1; }
    #mb-bar button { pointer-events: auto; width: 40px; height: 36px; font-size: 16px; }
  }
  @media (prefers-reduced-motion: reduce) { #mb-bar { transition: none; } }
  #mb-settings {
    box-sizing: border-box; width: 26rem; max-width: 92vw; max-height: 88vh; overflow: auto;
    padding: 12px 16px 14px; margin: auto; border: 1px solid #333; border-radius: 4px;
    background: rgba(8, 8, 8, 0.96); color: #bbb;
    font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace;
  }
  #mb-settings::backdrop { background: rgba(0, 0, 0, 0.55); }
  #mb-settings header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  #mb-settings h2 { margin: 0; font-size: 13px; font-weight: normal; color: #eee; }
  #mb-settings fieldset { border: 0; border-top: 1px solid #2a2a2a; margin: 8px 0 0; padding: 6px 0 0; min-width: 0; }
  #mb-settings legend { color: #888; padding: 0 6px 0 0; }
  #mb-settings .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 5px 0; min-height: 24px; }
  #mb-settings .row > label { flex: 1 1 auto; }
  #mb-settings .note { color: #888; font-size: 11px; margin: -2px 0 4px; }
  #mb-settings select, #mb-settings input[type=number], #mb-settings button {
    font: inherit; color: #ddd; background: #1a1a1a; border: 1px solid #444; border-radius: 3px; padding: 3px 6px;
  }
  #mb-settings select { max-width: 11rem; }
  #mb-settings input[type=number] { width: 6rem; }
  #mb-settings input[type=checkbox] { width: 16px; height: 16px; margin: 0; }
  #mb-settings button { cursor: pointer; }
  #mb-settings :disabled { opacity: 0.45; }
  #mb-settings :focus-visible { outline: 2px solid #8ab4f8; outline-offset: 1px; }
  `;

  const SCALES = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16];
  const scaleLabel = (s) => (s < 1 ? `×1/${1 / s}` : `×${s}`);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const SPEEDS = [["1.25", "slow"], ["2", "relaxed"], ["3.5", "brisk"], ["6", "fast"]];

  let bar, gear, playBtn, dlg, hideTimer = 0;
  const els = {};

  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    e.append(...kids);
    return e;
  }

  function row(id, label, control, note) {
    control.id = "mb-s-" + id;
    els[id] = control;
    const r = el("div", { className: "row" }, el("label", { htmlFor: control.id, textContent: label }), control);
    return r;
  }
  const select = (opts) => el("select", {}, ...opts.map(([v, t]) => el("option", { value: v, textContent: t })));
  const checkbox = () => el("input", { type: "checkbox" });
  const number = (min, max, step) => el("input", { type: "number", min, max, step, inputMode: "decimal" });
  const group = (title, ...kids) => el("fieldset", {}, el("legend", { textContent: title }), ...kids);

  // Reads a number input; null if empty/NaN. With writeBack (on change, not
  // while typing), puts the clamped value back into the input.
  function readNum(input, lo, hi, writeBack) {
    const raw = input.value.trim();
    const v = raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(v)) return null;
    const c = clamp(v, lo, hi);
    if (writeBack && c !== v) input.value = c;
    return c;
  }

  function sync() {
    const gpuOk = !!gpuRenderer.available;
    els.renderer.value = rendererPref;
    els.renderer.querySelector("[value=gpu]").disabled = !gpuOk;
    if (!gpuOk && els.renderer.value === "gpu") els.renderer.value = "auto";
    els.rendererNote.textContent = (gpuOk ? "" : "GPU unavailable. ") + "Active: " + renderer.name;
    const gpuActive = renderer.name === "gpu";
    els.hires.value = hiRes ? "1" : "0";
    els.hires.disabled = gpuActive;
    els.hiresNote.textContent = gpuActive ? "GPU always uses perturbation" : "";
    els.hiresNote.hidden = !gpuActive;
    els.color.value = colorMode;
    els.map.value = colorMap;
    els.auto.checked = !!autoRange;
    els.palette.value = palette;
    els.iter.value = String(iterationScale);
    els.speed.value = String(anim.speed || 2);
    els.dive.checked = !!anim.dive;
    els.hold.value = +(hold / 1000).toFixed(2);
  }

  // The play button shows what pressing it does.
  function update() {
    if (!playBtn) return;
    const [glyph, label] = mode === "explore" ? ["▶", "Back to the tour"]
      : paused ? ["▶", "Resume the tour"] : ["❚❚", "Pause the tour"];
    playBtn.textContent = glyph;
    playBtn.title = label + " (space)";
    playBtn.setAttribute("aria-label", label);
  }

  function build() {
    document.head.append(el("style", { textContent: CSS }));

    const button = (glyph, label, title) => {
      const b = el("button", { type: "button", title, textContent: glyph });
      b.setAttribute("aria-label", label);
      return b;
    };
    const prevBtn = button("‹", "Previous stop", "Previous stop (←)");
    playBtn = button("❚❚", "Pause the tour", "Pause the tour (space)");
    const nextBtn = button("›", "Next stop", "Next stop (→)");
    gear = button("⚙", "Settings", "Settings (s)");
    gear.id = "mb-gear";
    gear.setAttribute("aria-haspopup", "dialog");
    bar = el("div", { id: "mb-bar" }, prevBtn, playBtn, nextBtn, gear);
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Tour");

    els.rendererNote = el("div", { className: "note" });
    els.hiresNote = el("div", { className: "note" });

    const closeBtn = el("button", { type: "button", textContent: "Close" });
    closeBtn.setAttribute("aria-label", "Close settings");
    const title = el("h2", { id: "mb-s-title", textContent: "Settings" });

    const iterOpts = SCALES.map((s) => [String(s), scaleLabel(s)]);
    const palOpts = PALETTE_NAMES.map((n) => [n, n]);

    dlg = el("dialog", { id: "mb-settings" },
      el("header", {}, title, closeBtn),
      group("Rendering",
        row("renderer", "Renderer", select([["auto", "auto"], ["gpu", "GPU"], ["cpu", "CPU"]])),
        els.rendererNote,
        row("hires", "Precision (CPU)", select([["0", "lo-res"], ["1", "hi-res"]])),
        els.hiresNote,
        row("iter", "Iterations", select(iterOpts))),
      group("Color",
        row("color", "Coloring", select([["auto", "auto"], ["trap", "orbit trap"], ["escape", "escape time"]])),
        row("map", "Escape-time mapping", select([["equal", "equal area"], ["blend", "blend"], ["bands", "bands"], ["cycles", "log cycles"]])),
        row("auto", "Auto color range", checkbox()),
        row("palette", "Palette", select(palOpts))),
      group("Animation",
        row("speed", "Camera speed", select(SPEEDS)),
        row("dive", "Tour dive", checkbox()),
        row("hold", "Hold at stop (s)", number(0, 60, 1))));
    dlg.setAttribute("aria-labelledby", "mb-s-title");
    document.body.append(bar, dlg);

    // Fade-in on activity, fade out after 3 s idle.
    const wake = () => {
      bar.classList.add("show");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => bar.classList.remove("show"), 3000);
    };
    for (const ev of ["mousemove", "pointerdown", "touchstart", "keydown"]) {
      document.addEventListener(ev, wake, { passive: true });
    }
    wake();

    // Keep the bar's events away from the stage.
    for (const ev of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "dblclick", "wheel"]) {
      bar.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }
    const onClick = (b, fn) => b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    onClick(prevBtn, () => go(-1));
    onClick(playBtn, togglePause);
    onClick(nextBtn, () => go(1));
    onClick(gear, open);
    update();

    closeBtn.addEventListener("click", close);
    dlg.addEventListener("click", (e) => {
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
    });
    for (const ev of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "wheel", "dblclick"]) {
      dlg.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }
    dlg.addEventListener("keydown", (e) => {
      // Esc is handled natively by the dialog (cancel); nothing reaches the page.
      e.stopPropagation();
      const t = e.target;
      const typing = t instanceof HTMLInputElement && t.type !== "checkbox";
      if (e.key === "s" && !typing && !(t instanceof HTMLSelectElement) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        close();
      }
    });
    dlg.addEventListener("keyup", (e) => e.stopPropagation());
    dlg.addEventListener("close", () => { try { gear.focus({ preventScroll: true }); } catch (err) { /* ignore */ } });

    const changed = (fn) => (e) => { fn(e); sync(); };
    els.renderer.addEventListener("change", changed(() => setRenderer(els.renderer.value)));
    els.hires.addEventListener("change", changed(() => setHiRes(els.hires.value === "1")));
    els.color.addEventListener("change", changed(() => setColorMode(els.color.value)));
    els.map.addEventListener("change", changed(() => setColorMap(els.map.value)));
    els.auto.addEventListener("change", changed(() => setAutoRange(els.auto.checked)));
    els.palette.addEventListener("change", changed(() => setPalette(els.palette.value)));
    els.iter.addEventListener("change", changed(() => setIterationScale(Number(els.iter.value))));
    els.dive.addEventListener("change", changed(() => setAnim({ dive: els.dive.checked })));
    els.speed.addEventListener("change", changed(() => setAnim({ speed: Number(els.speed.value) })));

    // Number inputs apply on input (when valid) and re-sync on change (blur/enter).
    const num = (input, lo, hi, apply) => {
      const go = (writeBack) => { const v = readNum(input, lo, hi, writeBack); if (v !== null) apply(v); };
      input.addEventListener("input", () => go(false));
      input.addEventListener("change", () => { go(true); sync(); });
    };
    num(els.hold, 0, 60, (v) => setAnim({ hold: Math.round(v * 1000) }));
  }

  function open() {
    if (!dlg || dlg.open) return;
    sync();
    dlg.showModal();
  }
  function close() { if (dlg && dlg.open) dlg.close(); }

  return {
    init() { build(); },
    open,
    close,
    update,
    isOpen() { return !!dlg && dlg.open; },
  };
})();
