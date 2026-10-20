"use strict";
// ---------- constants ----------
const INK_THRESHOLD = 215;          // luminance below this counts as drawn ink
const COL_MATCH = [97, 89, 75];     // brown (#61594b) for matching linework
const COL_DIFF = [237, 65, 51];     // red (#ed4133)
const LEGEND = [[COL_MATCH, "Coincide"], [COL_DIFF, "Diferencia"]];
const NO_MATCH = 20;                // below this % of matching linework, A and B are treated as different plans
const MAX_ZOOM = 32;                // screen px per overview px
const DETAIL_BUDGET = 14e6;         // max pixels of the sharp detail render
const HATCH_MIN_MM = 4;             // PDF: a filled area at least this long (on paper) counts as hatch
const TOL = 1;                      // px a line may shift without counting as a change
const RES = 4500;                   // long side of the comparison image, px
const PDF_RES = 12000;              // long side of the comparison in the downloaded PDF, px (redrawn from the plans in tiles)
const PDF_TILE = 2000;              // tile side for that redraw, px
const $ = (id) => document.getElementById(id);
const DPR = () => Math.min(2, window.devicePixelRatio || 1);

if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const S = {
  A: null, B: null,             // {name, kind:'pdf'|'dxf', pdf, dxf, pages, page, scale | prims,bb,k,pad, text}
  rasterA: null, rasterB: null, // overview canvases (unaligned)
  frame: null,                  // {W,H}
  maskA: null,
  xf: null,                     // {mode:'auto'|'manual', m:[a,b,c,d,e,f]} maps B raster px -> frame px
  autoXf: null,
  bWarp: null,                  // aligned B canvas (overview)
  excl: [],                     // excluded rectangles, frame px
  neutral: [],                  // boxes of matching texts, frame px
  view: "diff",
  mixed: false,
  result: null,
  hatch: true,                  // on by default; off: hatch (and dark filled areas in PDFs) with lines along their edge are left out; lone fills are compared
  annot: true,                  // annotation (axes, dimensions, texts, levels, section marks) is compared; off: not drawn nor compared
};

// ---------- small affine helpers ----------
const mul = (m, n) => [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
const apply = (m, x, y) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
const scaleOf = (m) => Math.hypot(m[0], m[1]);
const I = [1, 0, 0, 1, 0, 0];
const inv = (m) => { const d = m[0] * m[3] - m[1] * m[2]; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]; };

// ---------- file handling ----------
async function loadFile(k, file) {
  const msg = $("msg" + k); msg.hidden = true;
  showName(k, file.name);
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const buf = await file.arrayBuffer();
  try {
    if (ext === "dwg") throw new Error("El formato DWG no se puede leer en el navegador. Exporta el plano a PDF (Trazar → PDF) o a DXF desde tu programa CAD.");
    if (ext === "pdf" || isPdf(buf)) {
      if (!window.pdfjsLib) throw new Error("No se pudo cargar el lector de PDF. Revisa tu conexión y recarga la página.");
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise; // CVE-2024-4367 mitigation
      S[k] = { name: file.name, kind: "pdf", pdf, pages: pdf.numPages, page: 1, ocAnnot: [] };
      try {
        const g = (await pdf.getOptionalContentConfig()).getGroups() || {};
        for (const [id, grp] of Object.entries(g)) if (annotLayer(grp.name)) S[k].ocAnnot.push(id);
      } catch (e) { console.warn(e); }
    } else if (ext === "dxf") {
      const head = new TextDecoder("latin1").decode(buf.slice(0, 22));
      if (head.startsWith("AutoCAD Binary DXF")) throw new Error("Este DXF es binario. Expórtalo como DXF de texto (ASCII).");
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { text = new TextDecoder("windows-1252").decode(buf); }
      const P = window.DxfParser && (window.DxfParser.default || window.DxfParser.DxfParser || window.DxfParser);
      if (!P) throw new Error("No se pudo cargar el lector de DXF. Revisa tu conexión y recarga la página.");
      const parser = new P();
      try { parser.registerEntityHandler(HatchHandler); } catch (e) { console.warn(e); }
      const dxf = parser.parseSync(text);
      if (!dxf || !dxf.entities) throw new Error("No se pudo leer el DXF.");
      S[k] = { name: file.name, kind: "dxf", dxf, pages: 1, page: 1 };
    } else {
      throw new Error("Formato no reconocido. Usa PDF o DXF.");
    }
  } catch (e) {
    S[k] = null; resetView(); showName(k, file.name); // the previous result no longer applies
    msg.textContent = e.message || String(e); msg.hidden = false;
    showError(`${file.name}: ${e.message || e}`);
    return false;
  }
  refreshSlot(k);
  return true;
}
function refreshSlot(k) {
  const D = S[k], sel = $("page" + k);
  showName(k, D ? D.name : "");
  $("msg" + k).hidden = true;
  sel.innerHTML = "";
  if (D && D.pages > 1) {
    for (let i = 1; i <= D.pages; i++) sel.add(new Option("Página " + i, i));
    sel.value = D.page; sel.hidden = false;
  } else sel.hidden = true;
}
function showName(k, name) {
  const n = $("name" + k); n.textContent = name; n.hidden = !name; $("slot" + k).classList.toggle("has", !!name);
  $("pick" + k).textContent = S[k] ? "Cambiar archivo" : "Elegir archivo";
}
function isPdf(buf) { const b = new Uint8Array(buf.slice(0, 5)); return String.fromCharCode(...b) === "%PDF-"; }

for (const k of ["A", "B"]) {
  $("pick" + k).onclick = () => $("file" + k).click();
  $("file" + k).onchange = async (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) await userLoad(k, f); };
  $("page" + k).onchange = (e) => { S[k].page = +e.target.value; S.excl = []; run({ rerender: true }); };
}

// ---------- drag and drop from a folder, anywhere on the page ----------
const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
let dropTimer = 0;
function hideDrop() { $("drop").hidden = true; document.querySelectorAll(".dz").forEach((d) => d.classList.remove("over")); }
window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); $("drop").hidden = false; });
window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); e.dataTransfer.dropEffect = "copy";
  $("drop").hidden = false;
  const dz = e.target.closest ? e.target.closest(".dz") : null;
  document.querySelectorAll(".dz").forEach((d) => d.classList.toggle("over", d === dz));
  // dragover repeats while the pointer is over the page; when it stops, the drag left
  clearTimeout(dropTimer); dropTimer = setTimeout(hideDrop, 400);
});
window.addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); clearTimeout(dropTimer);
  const dz = e.target.closest ? e.target.closest(".dz") : null;
  hideDrop();
  await takeFiles([...e.dataTransfer.files], dz ? dz.dataset.k : null);
});

// Two files: the first by name is A. One file: the slot it was dropped on, else the first free one.
async function takeFiles(files, k) {
  if (exporting) return;
  files = files.filter((f) => /\.(pdf|dxf|dwg)$/i.test(f.name));
  if (!files.length) { showError("Solo se pueden comparar archivos PDF o DXF."); return; }
  clearError();
  if (files.length >= 2) {
    files.sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true, sensitivity: "base" }));
    setBusy("Leyendo " + files[0].name + " y " + files[1].name + "…");
    await new Promise((r) => setTimeout(r, 30));
    const okA = await loadFile("A", files[0]), okB = await loadFile("B", files[1]);
    setBusy(null);
    if (okA && okB) newFiles(); else if (okA) waitFor("B"); else if (okB) waitFor("A");
    return;
  }
  if (!k) k = !S.A ? "A" : "B";
  await userLoad(k, files[0]);
}
$("fileBoth").onchange = async (e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length) await takeFiles(f, null); };
$("swap").onclick = () => {
  if (exporting || (!S.A && !S.B)) return;
  [S.A, S.B] = [S.B, S.A]; refreshSlot("A"); refreshSlot("B");
  if (S.A && S.B) newFiles(); else waitFor(S.A ? "B" : "A");
};
function newFiles() { S.excl = []; S.xf = null; S.forceShow = false; syncLoaded(); run({ rerender: true }); }
// on a phone the viewer and the Cambios card appear once both plans are loaded (or to show an error)
function syncLoaded() { document.querySelector(".app").classList.toggle("loaded", !!(S.A && S.B) || !!errKind); }

// Nothing is compared until both plans are loaded.
async function userLoad(k, file) {
  clearError();
  setBusy("Leyendo " + file.name + "…");
  await new Promise((r) => setTimeout(r, 30));
  const ok = await loadFile(k, file);
  setBusy(null);
  const o = k === "A" ? "B" : "A";
  if (ok && S.A && S.B) newFiles();
  else if (ok) waitFor(o);
}
function clearSlot(k) { S[k] = null; showName(k, ""); $("page" + k).hidden = true; $("msg" + k).hidden = true; }
function resetView() {
  runId++; cancelRenders(); detailId++; clearDetail(); setBusy(null);
  Object.assign(S, { result: null, rasterA: null, rasterB: null, xf: null, excl: [], running: false });
  main.content.hidden = true;
  $("dlPdf").disabled = $("dlDxf").disabled = true; $("dlHint").textContent = ""; $("alignBtn").disabled = false;
  $("pct").textContent = "–"; $("pctLbl").textContent = "Los cambios aparecerán en color rojo"; $("pctLbl").classList.add("pre"); $("alignBtn").hidden = true; $("resultSec").hidden = true;
  setStatus(""); syncLoaded();
}
function waitFor(k) { resetView(); showHome(`Plano ${k === "A" ? "B" : "A"} listo. Ahora carga el plano ${k}.`); }

// ---------- loica: welcome and error ----------
// The welcome loica sits in the viewer while a plan is missing. Errors (a file that cannot be read,
// a comparison that fails, or A and B that do not match) show the error loica for 10 s, then go back.
let errTimer = 0, errTick = 0, errKind = null;
function showHome(msg) {
  $("emptyMsg").textContent = msg || ""; $("emptyMsg").hidden = !msg;
  if (!errKind) $("empty").hidden = false;
}
function showError(msg, kind = "error") {
  clearTimeout(errTimer); clearInterval(errTick);
  errKind = kind;
  $("errMsg").textContent = msg; $("errBtns").hidden = kind !== "nomatch";
  $("empty").hidden = true; $("errorView").hidden = false; document.querySelector(".credit").style.visibility = "hidden"; syncLoaded(); // on a phone it would sit on the countdown
  let left = 10;
  const tick = () => { $("errCount").textContent = `Volviendo al inicio en ${left} s.`; };
  tick(); errTick = setInterval(() => { left = Math.max(1, left - 1); tick(); }, 1000);
  errTimer = setTimeout(backHome, 10000);
}
function clearError() { clearTimeout(errTimer); clearInterval(errTick); errKind = null; $("errorView").hidden = true; document.querySelector(".credit").style.visibility = ""; syncLoaded(); }
// after an error: keep a plan that loaded fine and wait for the other; otherwise start over
function backHome() {
  clearError();
  for (const k of ["A", "B"]) if (!S[k]) clearSlot(k);
  if (S.A && S.B) { clearSlot("A"); clearSlot("B"); }
  if (S.A) waitFor("B"); else if (S.B) waitFor("A"); else { resetView(); showHome(""); }
}
$("loicaBtn").onclick = () => $("fileBoth").click();
// The sign shows one message at a time: BIENVENIDO for 4 s, then ARRASTRA AQUÍ 10 s / TE ESTOY ESPERANDO 5 s.
// Each time the welcome screen comes back, a fresh copy of the drawing starts the head movement from zero.
const loicaTpl = $("loicaBtn").querySelector("svg").cloneNode(true);
let loicaT0 = 0, loicaTick = 0, loicaOn = false;
function loicaMsg() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return "drag";
  const t = (performance.now() - loicaT0) / 1000;
  return t < 4 ? "welcome" : (t - 4) % 15 < 10 ? "drag" : "wait";
}
function loicaSync() {
  const on = !$("empty").hidden;
  if (on === loicaOn) return;
  loicaOn = on; clearInterval(loicaTick);
  if (!on) return;
  const svg = loicaTpl.cloneNode(true);
  $("loicaBtn").querySelector("svg").replaceWith(svg);
  loicaT0 = performance.now();
  const set = () => { const m = loicaMsg(); if (svg.getAttribute("data-msg") !== m) svg.setAttribute("data-msg", m); };
  set(); loicaTick = setInterval(set, 200);
}
new MutationObserver(loicaSync).observe($("empty"), { attributes: true, attributeFilter: ["hidden"] });

// Hidden detail: a click right on the bird, its body or head (not the A and B letters nor the sign) plays a loica's song once, about 4 s, with the beak
// moving (class is-singing). Clicks while it sings are ignored. The sign and the rest keep opening the file picker.
const SONG = "audio/loica-canto.mp3";
let song = null, singing = false;
function stopSong() {
  singing = false;
  const svg = $("loicaBtn").querySelector("svg"); if (svg) svg.classList.remove("is-singing");
  if (song) { song.pause(); song.currentTime = 0; }
}
$("loicaBtn").addEventListener("click", (e) => {
  if (!(e.target.closest && e.target.closest(".loica-bird, .loica-head-hit")) || e.target.closest(".letter-a, .letter-b")) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (singing) return;
  singing = true;
  if (!song) { song = new Audio(SONG); song.preload = "auto"; song.volume = 0.5; song.onended = song.onerror = stopSong; }
  song.currentTime = 0;
  song.play().then(() => { if (singing) $("loicaBtn").querySelector("svg").classList.add("is-singing"); }).catch(stopSong);
}, true);
new MutationObserver(() => { if ($("empty").hidden && singing) stopSong(); }).observe($("empty"), { attributes: true, attributeFilter: ["hidden"] });

// ---------- HATCH entities (dxf-parser 1.1.2 skips them) ----------
// Boundary loops and pattern lines, in the entity's own coordinates (OCS).
class HatchHandler {
  constructor() { this.ForEntityName = "HATCH"; }
  parseEntity(sc, g) {
    const t = [];
    for (g = sc.next(); !sc.isEOF() && g.code !== 0; g = sc.next()) t.push([g.code, g.value]);
    return parseHatch(t);
  }
}
function parseHatch(t) {
  const e = { type: "HATCH", loops: [], lines: [], solid: false };
  let i = 0;
  const at = (c) => i < t.length && t[i][0] === c;
  const val = () => t[i++][1];
  while (i < t.length && !at(91)) {
    const [c, v] = t[i++];
    if (c === 8) e.layer = v; else if (c === 60) e.visible = v === 0; else if (c === 67) e.inPaperSpace = v !== 0;
    else if (c === 2) e.pattern = v; else if (c === 70) e.solid = v === 1; else if (c === 230) e.extrusionDirectionZ = v;
  }
  if (i >= t.length) return e;
  const nLoops = val();
  for (let L = 0; L < nLoops && i < t.length; L++) {
    while (i < t.length && !at(92)) i++;
    if (i >= t.length) break;
    const flag = val();
    if (flag & 2) { // polyline loop: 72 has bulge, 73 closed, 93 count, then 10/20/[42]
      while (i < t.length && !at(93)) i++;
      const nv = i < t.length ? val() : 0, vs = [];
      for (let k = 0; k < nv && at(10); k++) { const x = val(), y = at(20) ? val() : 0, b = at(42) ? val() : 0; vs.push({ x, y, bulge: b }); }
      e.loops.push({ poly: vs });
    } else { // edge loop: lines, arcs, elliptic arcs and splines
      const ne = at(93) ? val() : 0, edges = [];
      for (let k = 0; k < ne && at(72); k++) {
        const type = val();
        if (type === 4) {
          const ed = { type, deg: 3, knots: [], cp: [] };
          while (i < t.length && [94, 73, 74, 95, 96].includes(t[i][0])) { const [c, v] = t[i++]; if (c === 94) ed.deg = v; }
          while (at(40)) ed.knots.push(val());
          while (at(10)) { const x = val(), y = at(20) ? val() : 0; if (at(42)) i++; ed.cp.push({ x, y }); }
          if (at(97)) { // fit data, unless this 97 already counts the loop's source objects
            const save = i, n = val();
            if (at(11) || at(12) || (n === 0 && at(97))) { while (at(11) || at(21) || at(12) || at(22) || at(13) || at(23)) i++; } else i = save;
          }
          edges.push(ed);
        } else {
          const m = {};
          while (i < t.length && ![72, 97, 92, 75].includes(t[i][0])) { const [c, v] = t[i++]; m[c] = v; }
          edges.push({ type, m });
        }
      }
      e.loops.push({ edges });
    }
    if (at(97)) { const n = val(); for (let k = 0; k < n && at(330); k++) i++; }
  }
  while (i < t.length) {
    const [c, v] = t[i];
    if (c === 78) { // pattern lines: angle, base point, offset, dashes (already scaled and rotated)
      i++;
      for (let q = 0; q < v && at(53); q++) {
        const ln = { a: val() };
        ln.bx = at(43) ? val() : 0; ln.by = at(44) ? val() : 0; ln.ox = at(45) ? val() : 0; ln.oy = at(46) ? val() : 0;
        const nd = at(79) ? val() : 0; ln.d = [];
        for (let r = 0; r < nd && at(49); r++) ln.d.push(val());
        e.lines.push(ln);
      }
      continue;
    }
    if (c === 450 && v === 1) e.solid = true; // gradient fills are drawn as solid
    i++;
  }
  return e;
}

// ---------- annotation elements ("Elementos de anotación" switch) ----------
// What is not part of the drawn building: axes and their bubbles, dimensions, texts, level marks,
// section and elevation marks, tags. Switched off, they are neither drawn nor compared.
// By name: DXF layers, DXF blocks and PDF layers (the layer's own name, also inside a bound xref "XREF$0$COTAS").
const ANNOT_WORDS = new Set(("eje ejes axis axes grid grids grilla grillas iden cota cotas acotacion acotaciones dim dims dimension dimensions dimensiones " +
  "texto textos text texts anno anot anota anotacion anotaciones annotation annotations nota notas note notes nplt " +
  "levl npt symb simb simbolo simbolos simbologia symbol symbols tag tags etiqueta etiquetas").split(" "));
const LEVEL_WORDS = new Set("nivel niveles level levels".split(" ")); // only in names without numbers ("NIVEL 1" holds a floor's walls)
const CUT_WORDS = new Set("corte cortes seccion secciones section sections sect elev elevacion elevaciones elevation elevations".split(" "));
const MARK_WORDS = new Set("linea lineas line lines marca marcas mark marks simb symb simbolo head cabeza tail flecha".split(" "));
const BLOCK_WORDS = new Set("level levels grid grids nivel niveles npt eje ejes burbuja burbujas cota cotas tag tags etiqueta etiquetas callout spot".split(" "));
const AXIS_LT = /grid|eje/i; // DXF linetypes of axes
const nameWords = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
function annotLayer(name) {
  const s = String(name || "").split("$0$").pop(), w = nameWords(s);
  if (!w.length) return false;
  if (w.some((x) => ANNOT_WORDS.has(x))) return true;
  if (!/\d/.test(s) && w.some((x) => LEVEL_WORDS.has(x))) return true;
  // "CORTES" alone holds the section lines and heads; "MURO CORTE" holds the cut walls
  if (w.every((x) => CUT_WORDS.has(x))) return true;
  return w.some((x) => CUT_WORDS.has(x)) && w.some((x) => MARK_WORDS.has(x));
}
// Revit names blocks "Family - Type-<id>-<view>"; the view ("NIVEL PISO 3") says nothing of the block
function annotBlock(name) {
  const s = String(name || "").replace(/-V?\d+-(?!.*-V?\d+-).*$/, ""), w = nameWords(s);
  if (w.some((x) => BLOCK_WORDS.has(x))) return true;
  return w.some((x) => CUT_WORDS.has(x)) && w.some((x) => MARK_WORDS.has(x));
}

// PDFs without layers: annotation is told apart by its shape around the texts.
// pdf.js builds each path between two beginPath() calls and then strokes or fills it. Paths are numbered
// in that order and their subpaths (each moveTo or rect) by place: the same numbers on every render of a
// page with the same layers hidden, at any zoom.
const TAP = ["beginPath", "moveTo", "lineTo", "bezierCurveTo", "quadraticCurveTo", "rect", "closePath", "stroke", "fill"];
function untap(ctx) { if (ctx.__tap) { for (const [k, f] of ctx.__tap) { if (f) ctx[k] = f; else delete ctx[k]; } ctx.__tap = null; } }
function tap(ctx, hooks) {
  untap(ctx);
  const saved = [];
  for (const k of TAP) {
    if (!hooks[k]) continue;
    const own = Object.prototype.hasOwnProperty.call(ctx, k) ? ctx[k] : null, inner = ctx[k], h = hooks[k];
    saved.push([k, own]);
    ctx[k] = function (...a) { return h.call(this, inner, a); };
  }
  ctx.__tap = saved;
}
// Record every painted path of a render: [{pid, subs:[{pts, closed}], s, f, lw, col, dash}], canvas px.
function tapRecord(ctx, out) {
  let pid = 0, subs = [], cur = null, t = null, last = null;
  const dev = (x, y) => [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
  const start = (c, x, y) => { t = c.getTransform(); cur = { pts: [dev(x, y)], closed: false }; subs.push(cur); };
  const paint = (c, kind) => {
    if (!subs.length) return;
    if (last && last.pid === pid) { last[kind] = true; if (kind === "s") { last.col = c.strokeStyle; last.lw = lwOf(c); last.dash = c.getLineDash().length > 0; } return; }
    last = { pid, subs, s: kind === "s", f: kind === "f", lw: kind === "s" ? lwOf(c) : 0, col: kind === "s" ? c.strokeStyle : c.fillStyle, dash: kind === "s" && c.getLineDash().length > 0, prim: c.__prim };
    out.push(last);
  };
  const lwOf = (c) => { const m = c.getTransform(); return c.lineWidth * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)); };
  tap(ctx, {
    beginPath(inner, a) { pid++; subs = []; cur = null; return inner.apply(this, a); },
    moveTo(inner, a) { start(this, a[0], a[1]); return inner.apply(this, a); },
    lineTo(inner, a) { if (cur) cur.pts.push(dev(a[0], a[1])); else start(this, a[0], a[1]); return inner.apply(this, a); },
    bezierCurveTo(inner, a) {
      if (cur) {
        const [px, py] = cur.pts[cur.pts.length - 1], c1 = dev(a[0], a[1]), c2 = dev(a[2], a[3]), e = dev(a[4], a[5]);
        for (let i = 1; i <= 8; i++) { const u = i / 8, v = 1 - u; cur.pts.push([v * v * v * px + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * e[0], v * v * v * py + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * e[1]]); }
        cur.curve = true;
      }
      return inner.apply(this, a);
    },
    quadraticCurveTo(inner, a) { if (cur) { cur.pts.push(dev(a[2], a[3])); cur.curve = true; } return inner.apply(this, a); },
    rect(inner, a) {
      const [x, y, w, h] = a; t = this.getTransform();
      subs.push({ pts: [dev(x, y), dev(x + w, y), dev(x + w, y + h), dev(x, y + h), dev(x, y)], closed: true }); cur = null;
      return inner.apply(this, a);
    },
    closePath(inner, a) { if (cur) cur.closed = true; return inner.apply(this, a); },
    stroke(inner, a) { if (!(a[0] instanceof Path2D)) paint(this, "s"); return inner.apply(this, a); },
    fill(inner, a) { if (!(a[0] instanceof Path2D)) paint(this, "f"); return inner.apply(this, a); },
  });
}
// Leave out the marked subpaths (marks: pid -> Set of subpath numbers) of a render.
// A path with some marked subpaths is built again, at paint time, with the others only.
function tapFilter(ctx, marks) {
  const P = CanvasRenderingContext2D.prototype;
  let pid = 0, set = null, buf = null, cur = null, t = null;
  const dev = (x, y) => [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
  const start = (c, x, y) => { t = c.getTransform(); cur = [["M", ...dev(x, y)]]; buf.push(cur); };
  // false: nothing of the path is left to paint
  const rebuild = (c) => {
    const keep = buf.filter((s, i) => !set.has(i)); if (!keep.length) return false;
    if (keep.length === buf.length) return true;
    const m = c.getTransform().invertSelf(), L = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
    P.beginPath.call(c);
    for (const s of keep) for (const o of s) {
      if (o[0] === "M") P.moveTo.call(c, ...L(o[1], o[2]));
      else if (o[0] === "L") P.lineTo.call(c, ...L(o[1], o[2]));
      else if (o[0] === "C") P.bezierCurveTo.call(c, ...L(o[1], o[2]), ...L(o[3], o[4]), ...L(o[5], o[6]));
      else if (o[0] === "Q") P.quadraticCurveTo.call(c, ...L(o[1], o[2]), ...L(o[3], o[4]));
      else P.closePath.call(c);
    }
    return true;
  };
  tap(ctx, {
    beginPath(inner, a) { pid++; set = marks.get(pid) || null; buf = set ? [] : null; cur = null; return inner.apply(this, a); },
    moveTo(inner, a) { if (buf) start(this, a[0], a[1]); return inner.apply(this, a); },
    lineTo(inner, a) { if (buf) { if (cur) cur.push(["L", ...dev(a[0], a[1])]); else start(this, a[0], a[1]); } return inner.apply(this, a); },
    bezierCurveTo(inner, a) { if (buf && cur) cur.push(["C", ...dev(a[0], a[1]), ...dev(a[2], a[3]), ...dev(a[4], a[5])]); return inner.apply(this, a); },
    quadraticCurveTo(inner, a) { if (buf && cur) cur.push(["Q", ...dev(a[0], a[1]), ...dev(a[2], a[3])]); return inner.apply(this, a); },
    rect(inner, a) {
      if (buf) { const [x, y, w, h] = a; t = this.getTransform(); buf.push([["M", ...dev(x, y)], ["L", ...dev(x + w, y)], ["L", ...dev(x + w, y + h)], ["L", ...dev(x, y + h)], ["Z"]]); cur = null; }
      return inner.apply(this, a);
    },
    closePath(inner, a) { if (buf && cur) cur.push(["Z"]); return inner.apply(this, a); },
    stroke(inner, a) { if (buf && !(a[0] instanceof Path2D) && !rebuild(this)) return; return inner.apply(this, a); },
    fill(inner, a) { if (buf && !(a[0] instanceof Path2D) && !rebuild(this)) return; return inner.apply(this, a); },
  });
}

// Annotation of a PDF page without layers for it, found once per page and scale (overview px).
// oc: the layers hidden in the render, so paths are numbered as in the render.
// A canvas of 8 x 8 px that tells pdf.js it has the page's size: pdf.js leaves out fills it believes
// fall outside the canvas, and the paths are only recorded, not drawn.
function tinyCanvas(vp) {
  const c = document.createElement("canvas"); c.width = c.height = 8;
  const W = Math.ceil(vp.width), H = Math.ceil(vp.height);
  Object.defineProperty(c, "width", { get: () => W, set: () => {} }); Object.defineProperty(c, "height", { get: () => H, set: () => {} });
  return c;
}
// DXF lines on drawing layers that still are annotation (a level mark drawn with lines beside its text):
// found by the same shapes as in a PDF, on the overview. Marked primitives get "as".
function dxfAnnots(D) {
  const key = D.prims.length + "|" + D.k + "|" + D.pad + "|" + D.bb.join(",");
  if (D.annot && D.annot.key === key && D.annot.prims === D.prims) return D.annot; // a redraw builds new primitives
  const c = tinyCanvas({ width: D.W, height: D.H }), ctx = c.getContext("2d"), paths = [], texts = [];
  ctx.fillText = ctx.strokeText = () => {};
  for (const p of D.prims) p.as = false;
  tapRecord(ctx, paths);
  try { drawPrims(ctx, D, I, texts, false, true, true); } finally { untap(ctx); }
  // the layers already give the dimensions, axes, tags and their bubbles: look only for level marks drawn on
  // other layers (height marks, level triangles) and the lines that start at them
  const r = annotFind(paths, texts, false, { pre: (s) => !!(s.p.prim && s.p.prim.an), noDims: true, levelsOnly: true });
  for (const P of paths) {
    const set = r.marks.get(P.pid), q = P.prim;
    if (set && q && !q.an && (q.t === "p" || (q.t === "h" && q.solid)) && set.size >= P.subs.length) q.as = true;
  }
  D.annot = { key, prims: D.prims, n: r.n, kinds: r.kinds };
  return D.annot;
}
// A DXF hatch exploded into lines (LINE entities, no HATCH): the same families of parallel lines as in a PDF.
// A DXF has no paper scale: the overview (about 4500 px across) is read as a sheet about a meter wide.
const DXF_PX_PER_MM = 4.5;
function dxfHatch(D) {
  const key = D.prims.length + "|" + D.k + "|" + D.pad + "|" + D.bb.join(",");
  if (D.hl && D.hl.key === key && D.hl.prims === D.prims) return D.hl;
  const c = tinyCanvas({ width: D.W, height: D.H }), ctx = c.getContext("2d"), paths = [];
  ctx.fillText = ctx.strokeText = () => {};
  for (const p of D.prims) p.hl = false;
  tapRecord(ctx, paths);
  try { drawPrims(ctx, D, I, null, false, true, true); } finally { untap(ctx); }
  const r = lineHatch(paths, DXF_PX_PER_MM);
  let n = 0;
  for (const P of paths) { const set = r.marks.get(P.pid), q = P.prim; if (set && q && q.t === "p" && !q.fill && set.size >= P.subs.length) { q.hl = true; n++; } }
  D.hl = { key, prims: D.prims, n };
  return D.hl;
}
// The page's paths as pdf.js draws them, recorded once per set of hidden layers (the path numbers
// depend on it): what pdfAnnots and pdfHatch read.
async function pdfRecord(D, oc, hidden) {
  const key = D.page + "|" + D.scale + "|" + hidden;
  if (D.rec && D.rec.key === key) return D.rec;
  const page = await D.pdf.getPage(D.page), vp = page.getViewport({ scale: D.scale });
  const c = tinyCanvas(vp), ctx = c.getContext("2d"), paths = [];
  ctx.fillText = ctx.strokeText = () => {};
  tapRecord(ctx, paths);
  const task = page.render({ canvasContext: ctx, viewport: vp, optionalContentConfigPromise: oc });
  liveTasks.push(task);
  try { await task.promise; } finally { liveTasks = liveTasks.filter((t) => t !== task); untap(ctx); }
  D.rec = { key, paths, annot: null, hatch: null };
  return D.rec;
}
async function pdfAnnots(D, oc, hidden = "annot") {
  const R = await pdfRecord(D, oc, hidden);
  if (!R.annot) {
    let texts = [];
    try { texts = await pdfTexts(D); } catch {}
    const r = annotFind(R.paths, texts);
    R.annot = { marks: r.marks, n: r.n, kinds: r.kinds };
  }
  D.annot = R.annot;
  return R.annot;
}
async function pdfHatch(D, oc, hidden) {
  const R = await pdfRecord(D, oc, hidden);
  if (!R.hatch) R.hatch = lineHatch(R.paths, D.scale * 72 / 25.4);
  return R.hatch;
}

// Hatch drawn as lines. CAD programs print a hatch pattern as one stroke per line, already cut at the
// hatch's boundary, all drawn one after another. A family of them: at least HL_MIN lines of the same
// style and angle drawn in a row, at a regular spacing (HL_MIN_MM to HL_MAX_MM on paper, most of them
// one spacing from the next) and in step (two
// hatches drawn one after the other may be out of step with each other: each is a family of its own),
// whose ends meet the boundary at a slant. That last test leaves out stair treads, railing bars, louvres
// and the like: their ends meet the stringer or the rail square, all at the same place along the lines.
// A family of under 2 × HL_MIN lines must be spaced at most HL_TIGHT_MM (the steps of a stand are spaced wider).
// Returns marks (pid -> Set of subpaths) like annotFind, and the number of families.
const HL_MIN = 10, HL_MIN_MM = 0.4, HL_MAX_MM = 6, HL_TIGHT_MM = 2.2;
function lineHatch(paths, pxPerMm, dbg = null) {
  const marks = new Map(), open = [], runs = [];
  let n = 0;
  for (const P of paths) {
    if (!P.s || P.f) continue;
    P.subs.forEach((sb, i) => {
      if (sb.pts.length !== 2) return;
      const [a, b] = sb.pts, dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 0.5) return;
      let th = Math.atan2(dy, dx); if (th < 0) th += Math.PI; if (th >= Math.PI) th -= Math.PI;
      const tol = Math.max(0.005, 0.3 / len); // a short line's angle is less sure (coordinates are rounded)
      let run = null;
      for (let k = open.length - 1; k >= 0; k--) {
        const r = open[k];
        if (P.pid - r.last > 6) { open.splice(k, 1); continue; }
        const d = Math.abs(r.th - th);
        if (r.col === P.col && r.dash === P.dash && Math.abs(r.lw - P.lw) < 0.05 && Math.min(d, Math.PI - d) < tol) { run = r; break; }
      }
      if (!run) { run = { col: P.col, dash: P.dash, lw: P.lw, th, ls: [] }; open.push(run); runs.push(run); }
      if (len >= 20 && !run.sure) { run.th = th; run.sure = true; } // the angle of a long line stands for the run
      run.ls.push({ P, i, a, b }); run.last = P.pid;
    });
  }
  // a run whose first long line was a little off splits one hatch in two (a 50 px line may be 0.3° off):
  // a run of the same style that goes on right after the previous one at nearly its angle joins it,
  // at the median angle of their long lines
  const median = (r) => {
    const long = r.ls.map((o) => { const dx = o.b[0] - o.a[0], dy = o.b[1] - o.a[1]; let t = Math.atan2(dy, dx); t -= Math.PI * Math.round((t - r.th) / Math.PI); return { t, len: Math.hypot(dx, dy) }; }).filter((o) => o.len >= 20).map((o) => o.t).sort((x, y) => x - y);
    return long.length ? long[long.length >> 1] : r.th;
  };
  for (let k = runs.length - 1; k > 0; k--) {
    const r = runs[k], q = runs[k - 1], first = r.ls[0].P.pid;
    if (r.col !== q.col || r.dash !== q.dash || Math.abs(r.lw - q.lw) >= 0.05 || first > q.last + 6 || first < q.ls[0].P.pid) continue;
    const d = Math.abs(median(r) - median(q)); if (Math.min(d, Math.PI - d) > 0.012) continue;
    q.ls.push(...r.ls); q.last = Math.max(q.last, r.last); q.joined = true; runs.splice(k, 1);
  }
  for (const r of runs) {
    if (r.ls.length < HL_MIN) continue;
    if (r.joined) r.th = median(r);
    const why = (w, x = {}) => { if (dbg) { const xs = r.ls.flatMap((o) => [o.a[0], o.b[0]]), ys = r.ls.flatMap((o) => [o.a[1], o.b[1]]); dbg.push({ why: w, n: r.ls.length, deg: +(r.th * 180 / Math.PI).toFixed(1), pids: r.ls[0].P.pid + "-" + r.ls[r.ls.length - 1].P.pid, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round), lw: r.lw, ...x }); } };
    // offset across the lines and the two ends along them, all at the run's angle
    const ux = Math.cos(r.th), uy = Math.sin(r.th);
    const ls = r.ls.map((o) => { const sa = o.a[0] * ux + o.a[1] * uy, sb = o.b[0] * ux + o.b[1] * uy; return { o, off: (-(o.a[0] + o.b[0]) * uy + (o.a[1] + o.b[1]) * ux) / 2, s0: Math.min(sa, sb), s1: Math.max(sa, sb) }; }).sort((x, y) => x.off - y.off);
    // one row per distinct offset (a line may be cut in pieces by an island): its two ends along the lines
    const rows = [];
    for (const l of ls) {
      const w = rows[rows.length - 1];
      if (w && l.off - w.off <= 0.3) { w.s0 = Math.min(w.s0, l.s0); w.s1 = Math.max(w.s1, l.s1); w.ls.push(l.o); }
      else rows.push({ off: l.off, s0: l.s0, s1: l.s1, ls: [l.o] });
    }
    if (rows.length < HL_MIN) { why("rows", { rows: rows.length }); continue; }
    // spacing: the most common gap between neighbouring rows
    const gaps = []; for (let k = 1; k < rows.length; k++) gaps.push(rows[k].off - rows[k - 1].off);
    let sp = 0, best = 0;
    const spMin = Math.max(1.5, HL_MIN_MM * pxPerMm); // closer lines are a grey fill, or details that only look regular
    for (const g of gaps) { if (g < spMin || g > HL_MAX_MM * pxPerMm) continue; const c = gaps.filter((h) => Math.abs(h - g) <= Math.max(0.3, 0.08 * g)).length; if (c > best) { best = c; sp = g; } }
    if (!sp) { why("spacing"); continue; }
    const near = gaps.filter((h) => Math.abs(h - sp) <= Math.max(0.3, 0.08 * sp)).sort((x, y) => x - y); sp = near[near.length >> 1];
    // families in step: rows grouped by their place within the spacing (two hatches may be out of step)
    const tol = Math.max(0.35, 0.12 * sp), phase = (x) => ((x % sp) + sp) % sp;
    const byPh = rows.map((w) => ({ w, ph: phase(w.off) })).sort((x, y) => x.ph - y.ph), groups = [];
    for (const e of byPh) { const g = groups[groups.length - 1]; if (g && e.ph - g.last <= tol) { g.rows.push(e.w); g.last = e.ph; } else groups.push({ rows: [e.w], first: e.ph, last: e.ph }); }
    if (groups.length > 1) { const g0 = groups[0], gz = groups[groups.length - 1]; if (g0.first + sp - gz.last <= tol) { g0.rows.push(...gz.rows); groups.pop(); } } // wraps around
    for (const g of groups) {
      const rw = g.rows.sort((x, y) => x.off - y.off);
      if (rw.length < HL_MIN) continue;
      // regular: neighbours one to four spacings apart (a missing line is a hole in the hatch)
      let regular = 0, next = 0, slant = 0;
      for (let k = 1; k < rw.length; k++) {
        const d = rw[k].off - rw[k - 1].off, m = Math.round(d / sp);
        if (m >= 1 && m <= 4 && Math.abs(d - m * sp) <= tol * Math.max(1, m / 2)) { regular++; if (m === 1) next++; }
        // ends meeting the boundary at a slant move along the lines from one line to the next
        if (Math.abs(rw[k].s0 - rw[k - 1].s0) > 0.3 * d + 0.3 || Math.abs(rw[k].s1 - rw[k - 1].s1) > 0.3 * d + 0.3) slant++;
      }
      if (regular < 0.75 * (rw.length - 1) || next < 0.6 * (rw.length - 1)) { why("irregular", { sp, rows: rw.length, reg: regular / (rw.length - 1) }); continue; }
      if (slant < 0.5 * (rw.length - 1)) { why("square", { sp, rows: rw.length, slant: slant / (rw.length - 1) }); continue; }
      // a short family spaced wide may be the steps of a stand: a hatch that small is spaced tight
      if (rw.length < 2 * HL_MIN && sp > HL_TIGHT_MM * pxPerMm) { why("few", { sp, rows: rw.length }); continue; }
      why("hatch", { sp, rows: rw.length });
      n++;
      for (const w of rw) for (const o of w.ls) { let set = marks.get(o.P.pid); if (!set) marks.set(o.P.pid, set = new Set()); set.add(o.i); }
    }
  }
  return { marks, n };
}

// A number as dimensions write it ("130", "2,40", "d=150", "Ø50", "R=25 cm")
const DIM_RE = /^\s*(?:[a-zA-ZøØ∅]{1,3}\s*[=:]?\s*)?[±+]?\s*\d{1,6}(?:[.,]\d{1,3})?\s*(?:mm|cm|m)?\s*$/;
// Level texts: "NPT ±0.00", "NIVEL 5310", "H9 ALTURA 39.40M", "+2,50"
const LEVEL_RE = /^\s*(?:(?:n\.?\s?p\.?\s?[tsn]|n\.?\s?s\.?\s?l|nivel|level|niv)\.?(?:[^a-z].{0,22})?|(?:\S{1,4}\s+)?(?:altura|cota)\b.{0,24}|[±+-]\s*\d+(?:[.,]\d+)?\s*m?)\s*$/i;

// Shapes around texts that are annotation: bubbles and tags with a text inside (axes, section and
// elevation heads, door and window tags), the marks of level texts and the line under them, the lines
// that start at those symbols (axes, section lines, level lines) with their dashes, and dimension lines
// under a number with their ticks, dots and extension lines. A circle may come as one path or as dozens
// of one-segment paths (AutoCAD). Returns marks (pid -> Set of subpaths).
// a light color (a white mask behind a view, a pale fill): no ink
const lightCol = (c) => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c || ""); return !!m && 0.3 * parseInt(m[1], 16) + 0.59 * parseInt(m[2], 16) + 0.11 * parseInt(m[3], 16) > 215; };
// the letter of a section cut: A, B', A1, CC'
const CUT_RE = /^[A-Z]{1,2}\d{0,2}['’´`]{0,2}$/;
const MIN_TEXT = 3; // px: smaller texts (a key plan at 1:500) are too small to tell their symbols from the drawing
function annotFind(paths, texts, debug = false, opt = {}) {
  const subs = [];
  for (const p of paths) p.subs.forEach((s, i) => {
    const pts = s.pts; if (!pts.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pts) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
    if (!isFinite(x0)) return;
    const a = pts[0], b = pts[pts.length - 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const closed = s.closed || (pts.length > 2 && len < 0.75);
    let straight = !closed && len > 0.5;
    const ux = len ? (b[0] - a[0]) / len : 1, uy = len ? (b[1] - a[1]) / len : 0;
    if (straight && pts.length > 2) for (const q of pts) if (Math.abs((q[0] - a[0]) * uy - (q[1] - a[1]) * ux) > 0.6) { straight = false; break; }
    subs.push({ p, i, pts, closed, straight, curve: !!s.curve, bb: [x0, y0, x1, y1], size: Math.max(x1 - x0, y1 - y0), a, b, len, ux, uy, an: false });
  });
  if (opt.pre) for (const s of subs) if (opt.pre(s)) s.an = true; // already known (a DXF annotation layer)
  // grid of the subpaths along their segments
  const G = 32, grid = new Map();
  subs.forEach((s, n) => {
    const cells = new Set(), pts = s.pts;
    const add = (x, y) => cells.add(Math.floor(x / G) * 65536 + Math.floor(y / G));
    add(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], m = Math.ceil(Math.hypot(bx - ax, by - ay) / (G / 2));
      for (let j = 1; j <= m; j++) add(ax + (bx - ax) * j / m, ay + (by - ay) * j / m);
    }
    for (const k of cells) { let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(n); }
  });
  let stamp = 0; const seen = new Uint32Array(subs.length);
  const near = (x0, y0, x1, y1) => {
    stamp++; const out = [];
    for (let i = Math.floor(x0 / G); i <= Math.floor(x1 / G); i++) for (let j = Math.floor(y0 / G); j <= Math.floor(y1 / G); j++) {
      const l = grid.get(i * 65536 + j); if (!l) continue;
      for (const n of l) if (seen[n] !== stamp) { seen[n] = stamp; out.push(subs[n]); }
    }
    return out;
  };
  const kinds = { bubble: 0, level: 0, line: 0, dim: 0 };
  const marks = new Map(); let nMarked = 0, why = "";
  let src = null;
  const mark = (s) => { if (s.an) return; s.an = true; nMarked++; if (debug) { s.why = why; s.src = src; } let set = marks.get(s.p.pid); if (!set) marks.set(s.p.pid, set = new Set()); set.add(s.i); };
  const segDist = (px, py, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
    return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
  };
  const polyDist = (px, py, pts) => { let d = Infinity; for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(px, py, pts[i - 1], pts[i])); return pts.length > 1 ? d : Math.hypot(px - pts[0][0], py - pts[0][1]); };
  const boxGap = (b, c) => Math.max(0, b[0] - c[2], c[0] - b[2], b[1] - c[3], c[1] - b[3]);
  // a segment crossing a box (not only its bounding box: a long diagonal passing by a corner)
  const segInBox = (a, b, box) => {
    let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - box[0]], [dx, box[2] - a[0]], [-dy, a[1] - box[1]], [dy, box[3] - a[1]]]) {
      if (p === 0) { if (q < 0) return false; continue; }
      const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return true;
  };
  const within = (b, box) => b[0] >= box[0] && b[1] >= box[1] && b[2] <= box[2] && b[3] <= box[3];
  // a shape (one closed subpath, or a loop of pieces): its points, box, corners and roundness
  const shape = (members, own = null) => {
    const pts = own || (members.length === 1 ? members[0].pts : members.flatMap((m) => m.pts));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pts) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rs = pts.map((q) => Math.hypot(q[0] - cx, q[1] - cy)), rm = rs.reduce((a, b) => a + b, 0) / rs.length;
    const v = [];
    if (members.length === 1 || own) { for (const q of pts) if (!v.some((w) => Math.abs(w[0] - q[0]) < 0.6 && Math.abs(w[1] - q[1]) < 0.6)) v.push(q); }
    else if (members.every((m) => m.straight)) for (const m of members) for (const q of [m.a, m.b]) if (!v.some((w) => Math.abs(w[0] - q[0]) < 0.6 && Math.abs(w[1] - q[1]) < 0.6)) v.push(q);
    const round = rm > 0 && (Math.max(...rs) - Math.min(...rs)) / rm < 0.12 && (members.length > 6 || pts.length > 12 || members.some((m) => m.curve));
    return { members, pts, bb: [x0, y0, x1, y1], size: Math.max(x1 - x0, y1 - y0), cx, cy, round, nv: round ? 0 : v.length, v, col: members[0].p.col };
  };
  // closed loops among open pieces: the 2-core of the graph of their segments joined end to end, so that a
  // circle can close on the middle of a polyline (a bubble drawn in one stroke with the start of its axis)
  const loops = (pieces) => {
    const segs = [];
    for (const s of pieces) for (let i = 1; i < s.pts.length; i++) { const a = s.pts[i - 1], b = s.pts[i]; if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) > 0.05) segs.push({ s, a, b }); }
    if (segs.length < 3) return [];
    const node = new Map(), par = [], find = (i) => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
    const key = (q) => { const x = Math.round(q[0] * 2), y = Math.round(q[1] * 2); let id = node.get(x + "," + y); if (id !== undefined) return id; id = par.length; par.push(id); node.set(x + "," + y, id);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const o = node.get((x + dx) + "," + (y + dy)); if (o !== undefined && o !== id) { const r1 = find(o), r2 = find(id); if (r1 !== r2) par[r2] = r1; } }
      return id; };
    const ends = segs.map((g) => [key(g.a), key(g.b)]);
    const E = ends.map(([a, b]) => [find(a), find(b)]), deg = new Map(), alive = segs.map(() => true);
    E.forEach(([a, b], i) => { if (a === b) { alive[i] = false; return; } deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1); });
    for (let changed = true; changed;) {
      changed = false;
      E.forEach(([a, b], i) => { if (alive[i] && (deg.get(a) < 2 || deg.get(b) < 2)) { alive[i] = false; deg.set(a, deg.get(a) - 1); deg.set(b, deg.get(b) - 1); changed = true; } });
    }
    const comp = new Map(), cp = [], cf = (i) => { while (cp[i] !== i) i = cp[i] = cp[cp[i]]; return i; };
    E.forEach(([a, b], i) => { if (!alive[i]) return; for (const n of [a, b]) if (!comp.has(n)) { comp.set(n, cp.length); cp.push(cp.length); } const r1 = cf(comp.get(a)), r2 = cf(comp.get(b)); if (r1 !== r2) cp[r2] = r1; });
    const groups = new Map();
    E.forEach(([a], i) => { if (!alive[i]) return; const r = cf(comp.get(a)); let g = groups.get(r); if (!g) groups.set(r, g = []); g.push(segs[i]); });
    const out = [];
    for (const g of groups.values()) {
      if (g.length < 3) continue; // a line drawn twice
      const members = [...new Set(g.map((x) => x.s))], pts = [];
      for (const x of g) pts.push(x.a, x.b);
      const y = shape(members, pts);
      if (Math.min(y.bb[2] - y.bb[0], y.bb[3] - y.bb[1]) > 1) out.push(y);
    }
    return out;
  };
  // shapes around a box: closed subpaths and loops of open pieces, all of them inside lim
  const shapesIn = (lim, maxSize) => {
    const cand = near(lim[0], lim[1], lim[2], lim[3]).filter((s) => !s.an && s.size <= maxSize && within(s.bb, lim));
    const open = cand.filter((s) => !s.closed), curvy = open.filter((s) => s.curve || s.pts.length > 12);
    // a circle drawn in arcs: its own loop too, apart from the lines touching it
    return cand.filter((s) => s.closed || (s.p.f && !s.straight)).map((s) => shape([s])).concat(loops(open), curvy.length < open.length ? loops(curvy) : []);
  };
  // a point surrounded by a shape: its points go all the way round
  const around = (y, x, yy) => {
    if (slantTag(y)) { // a slanted tag: the point is inside it (its corners alone leave wide gaps)
      const v = ring(y.v); let inside = false;
      for (let i = 0, j = v.length - 1; i < v.length; j = i++) if ((v[i][1] > yy) !== (v[j][1] > yy) && x < (v[j][0] - v[i][0]) * (yy - v[i][1]) / (v[j][1] - v[i][1]) + v[i][0]) inside = !inside;
      return inside;
    }
    const ang = y.pts.map((q) => Math.atan2(q[1] - yy, q[0] - x)).sort((a, b) => a - b);
    let gap = ang[0] + 2 * Math.PI - ang[ang.length - 1];
    for (let i = 1; i < ang.length; i++) gap = Math.max(gap, ang[i] - ang[i - 1]);
    return gap < 1.75;
  };
  // texts with their own frame: origin at the bottom-left of the box, u along the baseline, v up
  const T = [], raw = new Set(texts.map((q) => q.s));
  for (const t of texts.concat(textLines(texts).filter((l) => !raw.has(l.s)))) {
    const s = (t.s || "").trim(); if (!s || !t.h) continue;
    const [p0, p1, p2, p3] = t.c, W = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1, Hh = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) || 1;
    const xs = t.c.map((q) => q[0]), ys = t.c.map((q) => q[1]);
    T.push({ s, h: t.h, p0, u: [(p1[0] - p0[0]) / W, (p1[1] - p0[1]) / W], v: [(p3[0] - p0[0]) / Hh, (p3[1] - p0[1]) / Hh], W, Hh,
      cx: (p0[0] + p1[0] + p2[0] + p3[0]) / 4, cy: (p0[1] + p1[1] + p2[1] + p3[1]) / 4, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
  }
  const fx = (t, q) => (q[0] - t.p0[0]) * t.u[0] + (q[1] - t.p0[1]) * t.u[1], fy = (t, q) => (q[0] - t.p0[0]) * t.v[0] + (q[1] - t.p0[1]) * t.v[1];
  // a bubble holds its texts and little else: lines of its own color inside it (the dividers of a tag or a
  // section head), up to two other lines, or a pattern of one other color passing under it (floor tiles);
  // a room of a small key plan holds more
  const empty = (y) => {
    const m = 0.15 * y.size, box = [y.bb[0] + m, y.bb[1] + m, y.bb[2] - m, y.bb[3] - m], own = new Set(y.members), tol = Math.max(1, 0.05 * y.size);
    const lim = [y.bb[0] - tol, y.bb[1] - tol, y.bb[2] + tol, y.bb[3] + tol];
    const others = near(box[0], box[1], box[2], box[3]).filter((s) => !own.has(s) && boxGap(s.bb, box) === 0 && (!s.straight || segInBox(s.a, s.b, box)) && s.size >= 0.15 * y.size && !(s.p.col === y.col && within(s.bb, lim)));
    return others.length <= 2 || others.every((s) => s.p.col === others[0].p.col && s.p.col !== y.col);
  };
  // a circle split by a line through its middle: a section or elevation head, drawn over anything
  const divided = (y) => {
    if (!y.round) return false;
    const tol = Math.max(1, 0.05 * y.size), lim = [y.bb[0] - tol, y.bb[1] - tol, y.bb[2] + tol, y.bb[3] + tol];
    return near(lim[0], lim[1], lim[2], lim[3]).some((s) => s.straight && s.len >= 0.85 * y.size && within(s.bb, lim) && segDist(y.cx, y.cy, s.a, s.b) <= 0.1 * y.size);
  };
  const sameStyle = (a, b) => a.p.col === b.p.col && a.p.dash === b.p.dash && b.p.lw <= 1.45 * a.p.lw + 0.05 && a.p.lw <= 1.45 * b.p.lw + 0.05;
  // the end of a leader or arrow: a small dot or arrowhead (filled or closed, maybe cut in half by a wall)
  // on the line's end, of the line's color
  const termAt = (q, h, line) => {
    const r = Math.max(1.2, 0.12 * h), out = [];
    for (const d of near(q[0] - r, q[1] - r, q[0] + r, q[1] + r)) {
      if (d.an || d.straight || !(d.closed || d.p.f) || d.size > 1.6 * h || d.size < Math.min(1.5, 0.12 * h) || (line && d.p.col !== line.p.col)) continue;
      if (boxGap(d.bb, [q[0], q[1], q[0], q[1]]) <= r) out.push(d);
    }
    return out;
  };
  // a line drawn twice, and the end of a line that touches nothing else (a line of the drawing meets others)
  const dupOf = (n, l) => n.straight && ((Math.hypot(n.a[0] - l.a[0], n.a[1] - l.a[1]) <= 1 && Math.hypot(n.b[0] - l.b[0], n.b[1] - l.b[1]) <= 1) || (Math.hypot(n.a[0] - l.b[0], n.a[1] - l.b[1]) <= 1 && Math.hypot(n.b[0] - l.a[0], n.b[1] - l.a[1]) <= 1));
  const free = (q, chain) => near(q[0] - 1, q[1] - 1, q[0] + 1, q[1] + 1).every((n) => n.size < 1 || chain.includes(n) || chain.some((l) => dupOf(n, l)) || polyDist(q[0], q[1], n.pts) > 1);
  // corners in order around their middle (a loop of pieces lists them in any order)
  const ring = (v) => { const cx = v.reduce((a, q) => a + q[0], 0) / v.length, cy = v.reduce((a, q) => a + q[1], 0) / v.length; return v.slice().sort((p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx)); };
  // a tag drawn as a slanted parallelogram (a level or finish tag): four corners, none square
  const slantTag = (y) => !y.round && y.nv === 4 && ring(y.v).every((q, i, v) => {
    const a = v[(i + 3) % 4], b = v[(i + 1) % 4], ax = a[0] - q[0], ay = a[1] - q[1], bx = b[0] - q[0], by = b[1] - q[1];
    const c = Math.abs(ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    return c > 0.15 && c < 0.95;
  });
  const syms = [];
  const symbol = (y, kind) => { if (y.members.some((m) => m.an)) return; y.kind = kind; for (const m of y.members) mark(m); syms.push(y); kinds[kind]++; };
  // 1. bubbles and tags: a closed shape a little bigger than a text, around the text's middle
  why = "bubble";
  for (const t of T) {
    if (t.h < MIN_TEXT) continue;
    const r = 5 * t.h;
    for (const y of shapesIn([t.cx - r, t.cy - r, t.cx + r, t.cy + r], 6.5 * t.h)) {
      const w = y.bb[2] - y.bb[0], h = y.bb[3] - y.bb[1], g = 0.2 * t.h, slant = slantTag(y);
      if (opt.levelsOnly && !slant) continue; // in a DXF the layers give the bubbles
      if (y.size < 1.0 * t.h || y.size > (y.round ? 6.5 : slant ? 7 : 4.5) * t.h || Math.min(w, h) < 0.25 * y.size) continue; // a section head is a big circle
      if (t.bb[0] < y.bb[0] - g || t.bb[1] < y.bb[1] - g || t.bb[2] > y.bb[2] + g || t.bb[3] > y.bb[3] + g) continue;
      if (Math.abs(t.cx - y.cx) > 0.3 * w || Math.abs(t.cy - y.cy) > 0.3 * h || !around(y, t.cx, t.cy) || !(empty(y) || divided(y))) continue;
      symbol(y, "bubble"); t.held = true;
    }
  }
  // 2. level texts: the triangle, diamond or circle beside them, and the line under them
  const anchors = [];
  why = "level";
  // a triangle, a circle, or a diamond (sides of about the same length, none level): a rotated plan's small
  // rectangles are not level marks
  // in the text's frame: a triangle has a side along the text and the other two alike; a diamond's corners
  // point along the text and across it
  const levelMark = (y, t) => {
    if (y.round) return true;
    if (y.nv !== 3 && y.nv !== 4) return false;
    const v = ring(y.v), n = v.length, e = v.map((q, i) => Math.hypot(v[(i + 1) % n][0] - q[0], v[(i + 1) % n][1] - q[1]));
    const along = (p, q) => Math.abs((q[0] - p[0]) * t.u[0] + (q[1] - p[1]) * t.u[1]) / (Math.hypot(q[0] - p[0], q[1] - p[1]) || 1);
    if (n === 3) {
      const k = [0, 1, 2].find((i) => along(v[i], v[(i + 1) % 3]) > 0.98); if (k === undefined) return false;
      const e1 = e[(k + 1) % 3], e2 = e[(k + 2) % 3]; if (Math.max(e1, e2) > 1.3 * Math.min(e1, e2)) return false;
    } else {
      if (Math.max(...e) > 1.6 * Math.min(...e)) return false;
      const d1 = along(v[0], v[2]), d2 = along(v[1], v[3]);
      if (Math.max(d1, d2) < 0.97 || Math.min(d1, d2) > 0.25) return false;
    }
    // long lines ending at its corners: at most the level line (one or two pieces in line); more is a corner of the drawing
    const att = [];
    for (const q of v) for (const s of near(q[0] - 1.5, q[1] - 1.5, q[0] + 1.5, q[1] + 1.5)) {
      if (!s.straight || s.len <= 1.5 * y.size || y.members.includes(s) || att.includes(s)) continue;
      if (Math.min(Math.hypot(s.a[0] - q[0], s.a[1] - q[1]), Math.hypot(s.b[0] - q[0], s.b[1] - q[1])) <= 1.5) att.push(s);
    }
    return att.length <= 2 && att.every((s) => Math.abs(s.ux * att[0].ux + s.uy * att[0].uy) > 0.998);
  };
  for (const t of T) {
    if (t.h < MIN_TEXT || !LEVEL_RE.test(t.s)) continue;
    const h = t.h, r = 6.5 * h;

    for (const y of shapesIn([t.bb[0] - r, t.bb[1] - r, t.bb[2] + r, t.bb[3] + r], 4.2 * h)) if (y.size >= 0.3 * h && boxGap(y.bb, t.bb) <= 2.5 * h && levelMark(y, t)) { y.h = h; y.holds = t.cx > y.bb[0] && t.cx < y.bb[2] && t.cy > y.bb[1] && t.cy < y.bb[3]; y.tiny = y.size < 0.75 * h; symbol(y, "level"); }
    // the line under the text: from its mark, or with a free end; a floor or slab line under the text touches neither
    const near2 = syms.filter((y) => y.kind === "level" && boxGap(y.bb, t.bb) <= 2.5 * h); // its marks, also those another text found first
    const byMark = (s) => near2.some((y) => segDist(y.cx, y.cy, s.a, s.b) <= 0.5 * y.size || y.members.some((m) => Math.min(polyDist(s.a[0], s.a[1], m.pts), polyDist(s.b[0], s.b[1], m.pts)) <= 1.5));
    for (const s of near(t.bb[0] - h, t.bb[1] - h, t.bb[2] + h, t.bb[3] + h)) {
      if (!s.straight || s.an || Math.abs(s.ux * t.u[0] + s.uy * t.u[1]) < 0.999) continue;
      const ya = fy(t, s.a), yb = fy(t, s.b), xa = fx(t, s.a), xb = fx(t, s.b);
      if (!free(s.a, [s]) && !free(s.b, [s]) && !byMark(s)) continue;
      if (Math.max(ya, yb) <= 0.35 * h && Math.min(ya, yb) >= -1.0 * h && Math.max(xa, xb) >= -0.5 * h && Math.min(xa, xb) <= t.W + 0.5 * h) { mark(s); anchors.push(s); s.level = true; s.hh = h; s.home = [t.bb[0] - 3 * h, t.bb[1] - 3 * h, t.bb[2] + 3 * h, t.bb[3] + 3 * h]; kinds.level++; }
    }
  }
  // 3. small shapes of the symbol's color touching it (the arrow of a section head), and short lines inside a bubble
  why = "part";
  for (const y of syms.slice()) {
    const tol = Math.max(1, 0.1 * y.size), lim = [y.bb[0] - tol, y.bb[1] - tol, y.bb[2] + tol, y.bb[3] + tol];
    for (const s of near(lim[0] - y.size, lim[1] - y.size, lim[2] + y.size, lim[3] + y.size)) {
      if (s.an || boxGap(s.bb, y.bb) > tol) continue;
      if (!s.straight && (s.closed || s.p.f) && s.size <= 1.2 * y.size && s.size >= 0.2 * y.size && s.p.col === y.col && (y.round || y.kind === "level")) mark(s);
      else if (s.straight && y.round && y.kind === "level" && s.len <= 1.8 * y.size && Math.hypot((s.a[0] + s.b[0]) / 2 - y.cx, (s.a[1] + s.b[1]) / 2 - y.cy) <= 0.3 * y.size && segDist(y.cx, y.cy, s.a, s.b) <= 0.15 * y.size) mark(s); // the cross of a height mark, past its circle
      else if (s.straight && (y.kind === "bubble" || y.round) && s.len <= 1.05 * y.size && within(s.bb, lim) && (!y.round || [s.a, s.b].every((e) => Math.hypot(e[0] - y.cx, e[1] - y.cy) <= 0.5 * y.size + tol))) mark(s);
    }
    // the arrow of a section or elevation head: pieces joined to the circle, close around it
    if (y.kind !== "bubble" || !y.round) continue;
    const S0 = y.size, ext = [y.bb[0] - 0.5 * S0, y.bb[1] - 0.5 * S0, y.bb[2] + 0.5 * S0, y.bb[3] + 0.5 * S0], got = y.members.slice();
    const pool = near(ext[0], ext[1], ext[2], ext[3]).filter((s) => !s.an && !s.closed && s.len >= 0.1 * S0 && within(s.bb, ext)), add = [];
    for (let more = true; more && add.length <= 12;) {
      more = false;
      for (const s of pool) if (!got.includes(s) && [s.a, s.b].some((e) => got.some((g) => polyDist(e[0], e[1], g.pts) <= tol))) { got.push(s); add.push(s); more = true; }
    }
    if (add.length <= 12) for (const s of add) mark(s); // more is a drawing (a fixture) touching the circle
  }
  // 4. lines starting at a symbol: axes (pointing at a bubble's center), section lines, level lines (through a corner of the mark)
  why = "anchor";
  for (const y of syms) {
    if (y.kind === "level" && (y.round || y.tiny || y.holds)) continue; // a height mark (circle with a cross) has no line of its own, the dot of a leader neither
    if (y.kind === "bubble" && !y.round) continue; // a tag in a box has none either: axes and section lines start at circles
    const S0 = y.size, tol = Math.max(1.5, 0.12 * S0);
    const dist = (q) => Math.min(...y.members.map((m) => polyDist(q[0], q[1], m.pts)));
    const far = y.round ? 0.6 * S0 : tol; // an axis may start a little away from its bubble, in line with its center
    for (const s of near(y.bb[0] - far, y.bb[1] - far, y.bb[2] + far, y.bb[3] + far)) {
      if (!s.straight || s.an) continue;
      let hit = false;
      const d0 = Math.min(dist(s.a), dist(s.b)), off = Math.abs((y.cx - s.a[0]) * s.uy - (y.cy - s.a[1]) * s.ux);
      if (d0 <= tol) hit = !y.round || off <= 0.3 * S0;
      else if (y.round && d0 <= far && off <= 0.08 * S0) { const r = (q) => Math.hypot(q[0] - y.cx, q[1] - y.cy); hit = Math.max(r(s.a), r(s.b)) > 0.5 * S0 + s.len * 0.9; }
      if (!hit && y.kind === "level" && !y.round && s.len >= S0) hit = y.v.some((q) => segDist(q[0], q[1], s.a, s.b) <= tol);
      if (hit) { src = y.members[0]; mark(s); src = null; anchors.push(s); if (y.kind === "level") { s.level = true; s.hh = y.h; } s.home = [y.bb[0] - 2 * S0, y.bb[1] - 2 * S0, y.bb[2] + 2 * S0, y.bb[3] + 2 * S0]; kinds.line++; }
    }
  }
  // 4b. section cuts: a short thick bar by the section's letter (A, B', A1...) and the thin line leaving its end.
  // The bar is a narrow four-sided shape (a fill or its outline; some PDFs fill its box through a clip) or a thick stroke.
  why = "cut";
  const cutLines = [];
  const axis = (v) => { let best = null, bl = 0; for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) { const dx = v[j][0] - v[i][0], dy = v[j][1] - v[i][1], l = Math.hypot(dx, dy); if (!best || Math.abs(l - sides(v)[1]) < Math.abs(bl - sides(v)[1])) { best = [dx / l, dy / l]; bl = l; } } return best; }; // direction of the long sides
  const sides = (v) => { const d = []; for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) d.push(Math.hypot(v[i][0] - v[j][0], v[i][1] - v[j][1])); d.sort((a, b) => a - b); return [d[0], d[2]]; }; // a rectangle's width and length
  for (const t of T) {
    if (t.h < MIN_TEXT || t.held || !CUT_RE.test(t.s)) continue; // a tag's letters (T1 in a bubble) name no cut
    const h = t.h, r = 1.2 * h, bars = [];
    const cand = near(t.bb[0] - r, t.bb[1] - r, t.bb[2] + r, t.bb[3] + r).filter((b) => !b.an && boxGap(b.bb, t.bb) <= r);
    const narrow = (v) => { const [W, L] = sides(v); return L >= 0.4 * h && L <= 4 * h && W <= 0.45 * L && W >= 0.06 * h ? L : 0; };
    for (const b of cand) {
      if (!b.straight && b.p.f && b.pts.length >= 4 && b.pts.length <= 6) { const y = shape([b]), L = y.nv === 4 && narrow(y.v); if (L) bars.push({ members: [b], v: y.v, bb: y.bb, L, ax: axis(y.v) }); }
      else if (b.straight && b.p.s && b.p.lw >= Math.max(2.5, 0.12 * h) && b.len >= 0.4 * h && b.len <= 4 * h) bars.push({ members: [b], v: [b.a, b.b], bb: b.bb, L: b.len, ax: [b.ux, b.uy] });
    }
    for (const y of loops(cand.filter((b) => b.straight && b.len <= 4 * h))) { const L = y.nv === 4 && narrow(y.v); if (L) bars.push({ members: y.members, v: y.v, bb: y.bb, L, ax: axis(y.v) }); }
    for (const bar of bars) {
      if (bar.members.some((m) => m.an)) continue;
      const L = bar.L, tol = Math.max(1.5, 0.08 * L), box = [bar.bb[0] - tol, bar.bb[1] - tol, bar.bb[2] + tol, bar.bb[3] + tol];
      const lines = near(box[0], box[1], box[2], box[3]).filter((s) => !bar.members.includes(s) && !s.an);
      const thin = lines.filter((s) => s.straight && s.len >= L && !within(s.bb, box) && bar.v.some((q) => Math.min(Math.hypot(s.a[0] - q[0], s.a[1] - q[1]), Math.hypot(s.b[0] - q[0], s.b[1] - q[1])) <= tol));
      // one line (maybe drawn twice), across the bar; nothing else touches the bar (a wall drawn thick meets other walls)
      if (!thin.length || !thin.every((s) => dupOf(s, thin[0])) || Math.abs(thin[0].ux * bar.ax[0] + thin[0].uy * bar.ax[1]) > 0.35) continue;
      const poly = bar.v.length === 4 ? ring(bar.v) : bar.v;
      const edge = (q) => poly.some((c, i) => segDist(q[0], q[1], c, poly[(i + 1) % poly.length]) <= tol);
      const touch = lines.filter((s) => s.straight && !thin.includes(s) && !within(s.bb, box) && (edge(s.a) || edge(s.b))); // lines ending at it (lines passing by are drawing under it)
      if (touch.length) continue;
      for (const m of bar.members) mark(m);
      kinds.line++;
      const col = bar.members[0].p.col;
      for (const s of lines) if (within(s.bb, box) && s.size <= L + 2 * tol && (s.p.col === col || s.p.f)) mark(s); // its outline, its fill
      for (const s of thin) { mark(s); anchors.push(s); cutLines.push(s); s.home = [bar.bb[0] - 2 * L, bar.bb[1] - 2 * L, bar.bb[2] + 2 * L, bar.bb[3] + 2 * L]; }
    }
  }
  // a stepped cut bends by a letter of its own (A1 ... A2): the piece joined to the cut line there
  const cutTexts = T.filter((t) => t.h >= MIN_TEXT && CUT_RE.test(t.s));
  for (const c of cutLines.slice()) for (const e of [c.a, c.b]) {
    if (!cutTexts.some((t) => boxGap([e[0], e[1], e[0], e[1]], t.bb) <= 1.5 * t.h)) continue;
    for (const n of near(e[0] - 1, e[1] - 1, e[0] + 1, e[1] + 1)) {
      if (n.an || !n.straight || !sameStyle(c, n) || Math.min(Math.hypot(n.a[0] - e[0], n.a[1] - e[1]), Math.hypot(n.b[0] - e[0], n.b[1] - e[1])) > 1) continue;
      mark(n); anchors.push(n); cutLines.push(n); n.home = c.home;
    }
  }
  // a level line may bend near its mark (an elbow): the lines joined end to end with it, same style, two joints at
  // most; a line across it only if it ends in a dot or arrowhead (a leader to the floor it measures)
  why = "elbow";
  const chainEnd = [];
  for (const a of anchors.filter((s) => s.level)) {
    const h = a.hh || 8;
    let front = [a];
    chainEnd.push([a, h]);
    for (let depth = 0; depth < 2 && front.length; depth++) {
      const next = [];
      for (const f of front) for (const e of [f.a, f.b]) for (const s of near(e[0] - 2, e[1] - 2, e[0] + 2, e[1] + 2)) {
        if (s.an || !s.straight || !sameStyle(f, s)) continue;
        const da = Math.hypot(s.a[0] - e[0], s.a[1] - e[1]), db = Math.hypot(s.b[0] - e[0], s.b[1] - e[1]);
        if (Math.min(da, db) > 1) continue;
        const tm = termAt(da < db ? s.b : s.a, h, s);
        if (!tm.length && (Math.abs(s.ux * f.ux + s.uy * f.uy) < 0.3 || (depth && s.len > 8 * h))) continue; // a line across it, or a long one past a bend: the drawing
        src = f; mark(s); src = null; anchors.push(s); next.push(s); s.home = f.home; s.hh = h; kinds.line++;
        chainEnd.push([s, h]);
      }
      front = next;
    }
  }
  why = "term";
  for (const [s, h] of chainEnd) for (const e of [s.a, s.b]) for (const d of termAt(e, h, s)) mark(d);
  // 4c. leaders and slope arrows: a line leaving a text (from its end, or running under it) that ends, maybe after
  // one or two bends, in a dot or an arrowhead. Its start and its bends touch nothing else: a line of the drawing
  // meets other lines at its ends.
  why = "leader";
  if (!opt.levelsOnly) for (const t of T) {
    if (t.h < MIN_TEXT) continue;
    const h = t.h, g = 0.6 * h, pt = (q) => [q[0], q[1], q[0], q[1]];
    for (const s of near(t.bb[0] - g, t.bb[1] - g, t.bb[2] + g, t.bb[3] + g)) {
      if (!s.straight || s.an || s.len > 25 * h || s.len < 0.8 * h) continue;
      const ga = boxGap(pt(s.a), t.bb), gb = boxGap(pt(s.b), t.bb), starts = []; // [far end, near end]
      if (ga <= g && gb > ga + h) starts.push([s.b, s.a]);
      else if (gb <= g && ga > gb + h) starts.push([s.a, s.b]);
      else if (Math.abs(s.ux * t.u[0] + s.uy * t.u[1]) > 0.999) { // under the text, along it
        const ya = fy(t, s.a), yb = fy(t, s.b), xa = fx(t, s.a), xb = fx(t, s.b);
        if (Math.max(ya, yb) <= 0.2 * h && Math.min(ya, yb) >= -0.8 * h && Math.min(xa, xb) <= 0.5 * t.W && Math.max(xa, xb) >= 0.5 * t.W) starts.push([s.a, s.b], [s.b, s.a]);
      }
      for (const [e0, e1] of starts) {
        if (!free(e1, [s])) continue;
        // depth-first along the bends: [lines, far end], three lines at most
        const stack = [[[s], e0]];
        let got = null;
        while (stack.length) {
          const [chain, e] = stack.pop(), last = chain[chain.length - 1], tm = termAt(e, h, last);
          if (tm.length) { got = [chain, tm]; break; }
          if (chain.length >= 3) continue;
          for (const n of near(e[0] - 1, e[1] - 1, e[0] + 1, e[1] + 1)) {
            if (n.an || !n.straight || chain.includes(n) || chain.some((l) => dupOf(n, l)) || !sameStyle(last, n) || n.len > 25 * h) continue;
            const da = Math.hypot(n.a[0] - e[0], n.a[1] - e[1]), db = Math.hypot(n.b[0] - e[0], n.b[1] - e[1]);
            if (Math.min(da, db) <= 1 && free(e, [last, n])) stack.push([chain.concat([n]), da < db ? n.b : n.a]);
          }
        }
        if (!got) continue;
        for (const x of got[0]) { mark(x); for (const n of near(x.bb[0] - 1, x.bb[1] - 1, x.bb[2] + 1, x.bb[3] + 1)) if (dupOf(n, x)) mark(n); }
        why = "term"; for (const d of got[1]) mark(d); why = "leader";
        kinds.line++;
        break;
      }
    }
  }
  // 5. the rest of those lines: same line, same style (dashes drawn one by one), up to a gap
  why = "collinear";
  const lines = new Map(), DEG = Math.PI / 180, NB = Math.round(180 / 0.25);
  const lineKey = (s) => { let th = Math.atan2(s.uy, s.ux); if (th < 0) th += Math.PI; if (th >= Math.PI - 0.125 * DEG) th -= Math.PI; return [th, -s.a[0] * Math.sin(th) + s.a[1] * Math.cos(th)]; };
  for (const s of subs) if (s.straight && s.p.s) { const [th, rho] = lineKey(s); s.th = th; s.rho = rho; const k = Math.round(th / (0.25 * DEG)) * 1e6 + Math.round(rho / 1.5); let l = lines.get(k); if (!l) lines.set(k, l = []); l.push(s); }
  let ext = 100; for (const s of subs) ext = Math.max(ext, s.bb[2], s.bb[3]);
  const maxGap = 0.025 * ext;
  for (const a of anchors) {
    if (a.th === undefined) continue;
    src = a;
    const ka = Math.round(a.th / (0.25 * DEG)), ko = Math.round(a.rho / 1.5), cand = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      let kk = ka + i, flip = 1; if (kk < 0) { kk += NB; flip = -1; } else if (kk >= NB) { kk -= NB; flip = -1; }
      for (const s of lines.get(kk * 1e6 + flip * ko + j) || []) if (s !== a && sameStyle(a, s) && Math.abs(Math.sin(s.th - a.th)) < 0.45 * DEG && Math.abs(Math.abs(s.rho) - Math.abs(a.rho)) <= Math.max(1, a.p.lw)) cand.push(s);
    }
    if (!cand.length) continue;
    const pos = (q) => q[0] * a.ux + q[1] * a.uy, span = (s) => { const p = pos(s.a), q = pos(s.b); return [Math.min(p, q), Math.max(p, q)]; };
    const all = cand.map((s) => ({ s, r: span(s) })).sort((x, y) => x.r[0] - y.r[0]);
    let [lo, hi] = span(a);
    // a level line goes on only through loose pieces (its dashes): a piece of a floor or slab meets walls at its ends
    const own = new Set(cand.concat([a])), loose = (o) => !a.level || [o.s.a, o.s.b].every((q) => near(q[0] - 1, q[1] - 1, q[0] + 1, q[1] + 1).every((n) => n.size < 1 || own.has(n) || n.an || polyDist(q[0], q[1], n.pts) > 1));
    // pieces that go on past the ends: a line lying on top of an axis is drawing, not the axis, unless it
    // is by the symbol (the bar of a level head drawn over the level line)
    for (const o of all) if (!o.s.an && a.home && o.r[0] >= lo && o.r[1] <= hi && within(o.s.bb, a.home)) { mark(o.s); kinds.line++; }
    for (const o of all) if (o.r[0] >= lo - 1 && o.r[1] > hi + 0.5 && o.r[0] - hi <= maxGap && loose(o)) { hi = o.r[1]; if (!o.s.an) { mark(o.s); kinds.line++; } }
    for (const o of all.slice().sort((x, y) => y.r[1] - x.r[1])) if (o.r[1] <= hi + 1 && o.r[0] < lo - 0.5 && lo - o.r[1] <= maxGap && loose(o)) { lo = o.r[0]; if (!o.s.an) { mark(o.s); kinds.line++; } }
  }
  if (opt.noDims) return debug ? { marks, n: nMarked, kinds, subs, T, dbg: [] } : { marks, n: nMarked, kinds };
  // 6. dimensions: a line parallel to a number, just under it, with ticks, dots or arrows centered on its
  // ends or extension lines crossing them. Its length must agree with the number at the scale that most
  // dimensions of the sheet agree on (a viewport's scale), which leaves out furniture and walls near a number.
  const val = (s) => { const m = s.replace(",", ".").match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
  // ends of a dimension line: ticks, dots or arrows centered on the line near its end, or extension lines
  // crossing it there and stopping just past it. The line itself may run a little past them, so the length
  // the number measures is the distance between the two terminators.
  // an extension line stands free: no other line meets its ends at an angle (a wall's ends meet other walls)
  const loose = (d, c, h) => {
    for (const q of [d.a, d.b]) for (const s of near(q[0] - 1, q[1] - 1, q[0] + 1, q[1] + 1)) {
      if (s === d || s === c || !s.straight || Math.abs(s.ux * d.ux + s.uy * d.uy) > 0.9) continue;
      const k = Math.abs(s.ux * c.ux + s.uy * c.uy); if (s.len <= 2.5 * h && k > 0.55 && k < 0.85) continue; // a tick
      if (Math.min(Math.hypot(s.a[0] - q[0], s.a[1] - q[1]), Math.hypot(s.b[0] - q[0], s.b[1] - q[1])) <= 1) return false;
    }
    return true;
  };
  const terminators = (c, h) => {
    const tol = Math.max(1.5, 0.3 * h), Z = Math.min(1.2 * h, 0.3 * c.len), nx = -c.uy, ny = c.ux, found = [], pos = [];
    const along = (q) => (q[0] - c.a[0]) * c.ux + (q[1] - c.a[1]) * c.uy, perp = (q) => (q[0] - c.a[0]) * nx + (q[1] - c.a[1]) * ny;
    let strong = 0, cross = 0;
    for (const [e, sgn] of [[c.a, 1], [c.b, -1]]) {
      let st = false, ex = false; const at = [];
      const inward = (u) => (sgn > 0 ? u : c.len - u);
      for (const d of near(e[0] - 3 * h, e[1] - 3 * h, e[0] + 3 * h, e[1] + 3 * h)) {
        if (d === c) continue; // a line already taken (an axis) can still end a dimension
        if (d.straight) {
          const cos = Math.abs(d.ux * c.ux + d.uy * c.uy), mid = [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2];
          if (d.len <= 2.5 * h && cos > 0.55 && cos < 0.85) {
            const u = along(mid), w = inward(u);
            if (Math.abs(perp(mid)) <= 0.25 * d.len + tol && w >= -tol - 0.25 * d.len && w <= Z) { found.push(d); st = true; at.push(u); }
          } else if (cos < 0.035 && d.p.col === c.p.col && d.len <= 8 * h) { // a long line there is a wall the dimension measures to
            const sa = perp(d.a), sb = perp(d.b);
            if (sa * sb >= 0) continue;
            const q = [d.a[0] + (d.b[0] - d.a[0]) * sa / (sa - sb), d.a[1] + (d.b[1] - d.a[1]) * sa / (sa - sb)], u = along(q), w = inward(u);
            const over = Math.min(Math.abs(sa), Math.abs(sb));
            if (w >= -tol && w <= Z && over >= 0.1 * h && over <= 2.5 * h && loose(d, c, h)) { found.push(d); ex = true; at.push(u); }
          }
        } else if ((d.closed || d.p.f) && d.size <= 1.5 * h) {
          const m = [(d.bb[0] + d.bb[2]) / 2, (d.bb[1] + d.bb[3]) / 2], u = along(m), w = inward(u);
          if (Math.abs(perp(m)) <= Math.max(tol, 0.6 * d.size) && w >= -tol - 0.5 * d.size && w <= Z) { found.push(d); st = true; at.push(d.curve || d.pts.length > 6 ? u : sgn > 0 ? Math.max(0, u - 0.5 * d.size) : Math.min(c.len, u + 0.5 * d.size)); } // a dot sits on the extension line, an arrow's tip touches it
        }
      }
      strong += st; cross += ex;
      if (at.length) { at.sort((x, y) => x - y); pos.push(at[at.length >> 1]); }
    }
    if (!(strong || cross === 2)) return null;
    return { f: found, len: pos.length === 2 && pos[1] - pos[0] > 0.5 * c.len ? pos[1] - pos[0] : c.len };
  };
  const dims = [], dbg = [];
  for (const t of T) {
    if (t.h < MIN_TEXT || !DIM_RE.test(t.s)) continue;
    const v = val(t.s); if (!(v > 0)) continue;
    const h = t.h, r = 2 * h, cs = [];
    for (const c of near(t.bb[0] - r, t.bb[1] - r, t.bb[2] + r, t.bb[3] + r)) {
      if (!c.straight || Math.abs(c.ux * t.u[0] + c.uy * t.u[1]) < 0.9994) continue;
      const ya = fy(t, c.a), yb = fy(t, c.b), xa = fx(t, c.a), xb = fx(t, c.b);
      if (Math.max(ya, yb) > 0.8 * t.Hh || Math.min(ya, yb) < -1.8 * h || Math.max(xa, xb) < -0.5 * h || Math.min(xa, xb) > t.W + 0.5 * h) continue;
      cs.push({ c, gap: Math.abs((ya + yb) / 2 + 0.25 * h) });
    }
    cs.sort((a, b) => a.gap - b.gap);
    let nf = 0;
    for (const { c } of cs.slice(0, 4)) { const r = terminators(c, h); if (r) { nf++; dims.push({ t, c, v, len: r.len, k: v / r.len, f: r.f }); } }
    if (debug) dbg.push({ s: t.s, h: +t.h.toFixed(1), at: t.bb.map(Math.round), u: t.u.map((q) => +q.toFixed(3)), cand: cs.length, withTerm: nf, lens: cs.slice(0, 4).map((o) => +o.c.len.toFixed(1)), ks: dims.filter((d) => d.t === t).map((d) => +d.k.toFixed(3)) });
  }
  // scales: ratios (number per pixel) shared by at least three numbers; a number with a decimal part or
  // under 20 says little about the scale on its own
  const ref = dims.filter((d) => d.v >= 20).map((d) => d.k).sort((a, b) => a - b);
  const count = (lo, hi) => { let a = 0, b = ref.length; while (a < b) { const m = (a + b) >> 1; if (ref[m] < lo) a = m + 1; else b = m; } let n = 0; for (let i = a; i < ref.length && ref[i] <= hi; i++) n++; return n; };
  const taken = new Set();
  why = "dim";
  for (const d of dims) {
    if (taken.has(d.t)) continue;
    const e = Math.max(0.55, 0.012 * d.v), lo = (d.v - e) / d.len, hi = (d.v + e) / d.len;
    if (count(lo, hi) - (d.v >= 20 ? 1 : 0) < 2) continue;
    taken.add(d.t); mark(d.c); kinds.dim++;
    why = "term"; for (const x of d.f) mark(x); why = "dim";
  }
  return debug ? { marks, n: nMarked, kinds, subs, T, dbg } : { marks, n: nMarked, kinds };
}

// ---------- sources: draw a plan with any transform (raster px -> canvas px) ----------
let liveTasks = [];
function cancelRenders() { for (const t of liveTasks) { try { t.cancel(); } catch {} } liveTasks = []; }

// fixed: draw the overview with the fill decisions already in D.keepFills (after reconcileFills)
// noHatch: leave hatch out even when the switch is on (the Plano A / Plano B views)
// all: annotation drawn whatever the switch says (the automatic alignment needs the axes)
async function renderSource(D, T, w, h, withText = false, fixed = false, noHatch = false, all = false) {
  const hatch = S.hatch && !noHatch, showAnnot = S.annot || all;
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  // annotation off: letters are neither drawn nor copied (PDF text drawn as lines, as some CAD programs export it, stays)
  const prepText = () => { if (withText) c.text = captureText(ctx); if (!showAnnot) ctx.fillText = ctx.strokeText = () => {}; };
  prepText();
  if (D.kind === "pdf") {
    const page = await D.pdf.getPage(D.page);
    const vp = page.getViewport({ scale: D.scale }), overview = T === I;
    const minPx = HATCH_MIN_MM * 72 / 25.4 * D.scale * scaleOf(T);
    const hide = showAnnot ? [] : D.ocAnnot || [];
    const oc = hide.length ? D.pdf.getOptionalContentConfig().then((cfg) => { for (const id of hide) cfg.setVisibility(id, false); return cfg; }) : undefined;
    // annotation off: also the bubbles, dimensions and level marks found by their shape;
    // hatch off: also the hatch printed as lines
    const hidden = hide.join(",");
    const am = showAnnot ? null : (await pdfAnnots(D, oc, hidden)).marks, hm = hatch ? null : (await pdfHatch(D, oc, hidden)).marks;
    let marks = am || hm;
    if (am && hm && hm.size) { marks = new Map(am); for (const [k, v] of hm) marks.set(k, new Set([...(am.get(k) || []), ...v])); }
    const draw = async (keep) => {
      const fills = watchFills(ctx, minPx, !hatch, keep, inv(T));
      if (marks && marks.size) tapFilter(ctx, marks);
      const task = page.render({ canvasContext: ctx, viewport: vp, transform: T, optionalContentConfigPromise: oc });
      liveTasks.push(task);
      try { await task.promise; } finally { liveTasks = liveTasks.filter((t) => t !== task); untap(ctx); }
      return fills;
    };
    if (overview && !hatch && !fixed) {
      // First pass without the large dark fills, to see which of them have no line along their edge.
      // Those are shapes on their own (a pillar drawn only as a black fill): the page is drawn again with
      // them, by pdf.js itself, so each keeps its place, clip and painting order.
      const fills = await draw(null);
      D.fills = loneFills(ctx, fills.skipped, D.scale * 72 / 25.4); D.keepFills = keepMap(D.fills);
      if (D.keepFills.size) {
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        prepText();
        await draw(D.keepFills);
      }
      for (const f of D.fills) f.drawn = f.lone;
    } else await draw(D.keepFills || new Map());
  } else {
    if (!showAnnot) dxfAnnots(D);
    if (!hatch) dxfHatch(D);
    drawPrims(ctx, D, T, null, false, hatch, all);
  }
  return c;
}

// Copy every letter drawn into a separate canvas, so that inside the box of a text that only
// changed typeface the changes are ignored where letters are drawn and nowhere else
// (a line or symbol under the label still counts).
function captureText(ctx) {
  const P = CanvasRenderingContext2D.prototype, t = document.createElement("canvas");
  t.width = ctx.canvas.width; t.height = ctx.canvas.height;
  const x = t.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, t.width, t.height);
  const copy = (src, how, a) => {
    x.setTransform(src.getTransform()); x.font = src.font; x.textAlign = src.textAlign; x.textBaseline = src.textBaseline; x.direction = src.direction;
    x.fillStyle = x.strokeStyle = "#000"; x.lineWidth = src.lineWidth; x[how](...a);
  };
  ctx.fillText = function (...a) { copy(this, "fillText", a); return P.fillText.apply(this, a); };
  ctx.strokeText = function (...a) { copy(this, "strokeText", a); return P.strokeText.apply(this, a); };
  return t;
}

// A PDF has no hatch entity: hatch, wall poché and filled regions arrive as filled paths.
// Count the dark ones at least minPx long and, when skip is set, leave them out (except the keys in keep).
// Light fills never count as ink, and lines and text are not fills, so they are kept.
// Without keep, each left-out fill is returned with its outline in canvas pixels and the clip that
// was active, so loneFills() can check whether a line runs along its edge.
// A fill is identified by its box in the path's own units plus its box in overview pixels (Ti maps
// this canvas back to the overview), so the same shape placed twice with another transform is
// still two fills, at every zoom.
function watchFills(ctx, minPx, skip, keep, Ti = I) {
  const P = CanvasRenderingContext2D.prototype, st = { n: 0, skipped: [] }, record = skip && !keep;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, polys = [], cur = null, m = null, clip = null;
  const clips = [];
  const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  const dev = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  const dark = (c) => {
    if (typeof c !== "string") return true; // pattern or gradient fill
    let r, g, b;
    if (c[0] === "#") { r = parseInt(c.slice(1, 3), 16); g = parseInt(c.slice(3, 5), 16); b = parseInt(c.slice(5, 7), 16); }
    else { const m = c.match(/[\d.]+/g); if (!m) return true; [r, g, b] = m.map(Number); if (m.length > 3 && +m[3] < 0.3) return false; }
    return 0.299 * r + 0.587 * g + 0.114 * b < INK_THRESHOLD;
  };
  // box of the current path in canvas pixels (or, with pre, in the pixels pre maps them to)
  const box = (c, pre = null) => {
    let t = c.getTransform(); let a = Infinity, b = Infinity, cc = -Infinity, d = -Infinity;
    if (pre) { const q = mul(pre, [t.a, t.b, t.c, t.d, t.e, t.f]); t = { a: q[0], b: q[1], c: q[2], d: q[3], e: q[4], f: q[5] }; }
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
      const X = t.a * x + t.c * y + t.e, Y = t.b * x + t.d * y + t.f;
      a = Math.min(a, X); cc = Math.max(cc, X); b = Math.min(b, Y); d = Math.max(d, Y);
    }
    return [a, b, cc, d];
  };
  ctx.beginPath = function () { x0 = y0 = Infinity; x1 = y1 = -Infinity; polys = []; cur = null; return P.beginPath.call(this); };
  ctx.moveTo = function (x, y) { add(x, y); if (record) { m = this.getTransform(); cur = [dev(x, y)]; polys.push(cur); } return P.moveTo.call(this, x, y); };
  ctx.lineTo = function (x, y) { add(x, y); if (cur) cur.push(dev(x, y)); return P.lineTo.call(this, x, y); };
  ctx.bezierCurveTo = function (a, b, c, d, x, y) {
    add(a, b); add(c, d); add(x, y);
    if (cur) {
      const [px, py] = cur[cur.length - 1], c1 = dev(a, b), c2 = dev(c, d), e = dev(x, y);
      for (let t = 1; t <= 8; t++) { const u = t / 8, v = 1 - u; cur.push([v * v * v * px + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * e[0], v * v * v * py + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * e[1]]); }
    }
    return P.bezierCurveTo.call(this, a, b, c, d, x, y);
  };
  ctx.rect = function (x, y, w, h) {
    add(x, y); add(x + w, y + h);
    if (record) { m = this.getTransform(); polys.push([dev(x, y), dev(x + w, y), dev(x + w, y + h), dev(x, y + h), dev(x, y)]); cur = null; }
    return P.rect.call(this, x, y, w, h);
  };
  ctx.closePath = function () { if (cur && cur.length) cur.push(cur[0]); return P.closePath.call(this); };
  if (record) {
    // follow the clip (as a box) so that only the visible part of an edge is checked
    ctx.save = function () { clips.push(clip); return P.save.call(this); };
    ctx.restore = function () { if (clips.length) clip = clips.pop(); return P.restore.call(this); };
    ctx.clip = function (...a) {
      if (!(a[0] instanceof Path2D) && x0 !== Infinity) { const r = box(this); clip = clip ? [Math.max(clip[0], r[0]), Math.max(clip[1], r[1]), Math.min(clip[2], r[2]), Math.min(clip[3], r[3])] : r; }
      return P.clip.apply(this, a);
    };
  } else { delete ctx.save; delete ctx.restore; delete ctx.clip; }
  ctx.fill = function (...args) {
    if (!(args[0] instanceof Path2D) && x0 !== Infinity && dark(this.fillStyle)) {
      const r = box(this);
      if (Math.max(r[2] - r[0], r[3] - r[1]) >= minPx) {
        st.n++;
        if (skip) {
          const key = [x0, y0, x1, y1].map((v) => v.toFixed(2)).join(",");
          // a fill closes its open subpaths, so their closing edge is checked too
          if (record) { st.skipped.push({ key, ob: r, polys: polys.map((p) => p.length > 1 && (p[0][0] !== p[p.length - 1][0] || p[0][1] !== p[p.length - 1][1]) ? [...p, p[0]] : p), clip }); return; }
          const list = keep.get(key); if (!list) return;
          const o = box(this, Ti);
          if (!list.some((q) => Math.abs(q[0] - o[0]) < 1.5 && Math.abs(q[1] - o[1]) < 1.5 && Math.abs(q[2] - o[2]) < 1.5 && Math.abs(q[3] - o[3]) < 1.5)) return;
        }
      }
    }
    return P.fill.apply(this, args);
  };
  return st;
}
// A left-out fill with no line drawn along its edge is a shape on its own (for example a pillar
// drawn only as a black fill), not hatch or poché inside outlined walls: it is compared.
const LONE_EDGE = 0.75; // a fill with less than this share of its edge over other ink counts as lone
function inkNear(ctx) {
  const W = ctx.canvas.width, H = ctx.canvas.height, d = ctx.getImageData(0, 0, W, H).data;
  return (x, y) => {
    x = Math.round(x); y = Math.round(y);
    for (let yy = Math.max(0, y - 2); yy <= Math.min(H - 1, y + 2); yy++) for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) {
      const j = (yy * W + xx) * 4; if (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2] < INK_THRESHOLD) return true;
    }
    return false;
  };
}
// share of an outline (list of closed or open point lists, canvas px) that runs over ink, counting
// only what lies on the canvas and inside clip. The clip gets 1 px of slack: PDF writers often clip
// a fill to its own outline, which then lies on the clip border give or take rounding.
// An edge that is all clipped away counts as lone.
function edgeInk(near, polys, W, H, clip = null) {
  let len = 0; for (const P of polys) for (let i = 1; i < P.length; i++) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
  const step = Math.max(2, len / 400); let n = 0, hit = 0;
  for (const P of polys) for (let i = 1; i < P.length; i++) {
    const [ax, ay] = P[i - 1], [bx, by] = P[i], m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let j = 0; j < m; j++) {
      const x = ax + (bx - ax) * j / m, y = ay + (by - ay) * j / m;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (clip && (x < clip[0] - 1 || y < clip[1] - 1 || x > clip[2] + 1 || y > clip[3] + 1)) continue;
      n++; if (near(x, y)) hit++;
    }
  }
  return n ? hit / n : clip ? 0 : 1;
}
// A small compact solid fill (a column or pillar in plan) is an element, not hatch: it stays when
// hatch is off even with a line along its edge. DXF columns usually come outlined and PDF ones often
// not, so without this the same pillar was kept in one format and dropped in the other.
// Each outline (canvas px) must be compact (4πA/P² ≥ PILLAR_ROUND: square 0.79, 1:2 rectangle 0.70)
// and between PILLAR_MM[0] (side of an equal-area square) and PILLAR_MM[1] (longest side) on paper.
const PILLAR_ROUND = 0.62, PILLAR_MM = [1.2, 15];
function pillar(polys, pxPerMm) {
  const P = polys.filter((p) => p.length > 3);
  if (!P.length || P.length > 64) return false;
  return P.every((p) => {
    let a = 0, per = 0;
    for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; per += Math.hypot(r[0] - q[0], r[1] - q[1]); }
    a = Math.abs(a) / 2;
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]), big = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    return per > 0 && 4 * Math.PI * a / (per * per) >= PILLAR_ROUND && Math.sqrt(a) >= PILLAR_MM[0] * pxPerMm && big <= PILLAR_MM[1] * pxPerMm;
  });
}
// Left-out fills with their edge share e; lone (no line along the edge) ones and pillars are compared.
// lone0 is the plan's own decision; reconcileFills() may change lone to match the other plan.
function loneFills(ctx, list, pxPerMm) {
  if (!list.length) return [];
  const near = inkNear(ctx), W = ctx.canvas.width, H = ctx.canvas.height;
  return list.map((f) => { const e = edgeInk(near, f.polys, W, H, f.clip), pil = pillar(f.polys, pxPerMm), l = pil || e < LONE_EDGE; return { key: f.key, ob: f.ob, e, pil, lone0: l, lone: l }; });
}
// key -> overview boxes of the fills to draw
function keepMap(fills) {
  const keep = new Map();
  for (const f of fills) if (f.lone) { if (!keep.has(f.key)) keep.set(f.key, []); keep.get(f.key).push(f.ob); }
  return keep;
}
// The same wall can land just under the lone threshold in one delivery and just over it in the
// other, and would then be drawn in one plan only. Left-out fills at the same place in A and B
// (once aligned) get one decision, from their mean edge share. Plans whose decisions changed are
// drawn again. Returns false when a newer run took over.
async function reconcileFills(id) {
  const A = S.A, B = S.B;
  if (S.hatch || A.kind !== "pdf" || B.kind !== "pdf" || !A.fills || !B.fills) return true;
  for (const f of A.fills) f.lone = f.lone0;
  for (const f of B.fills) f.lone = f.lone0;
  const m = S.xf.m, cell = 16, grid = new Map(), at = (x, y) => Math.round(x / cell) + "," + Math.round(y / cell);
  for (const f of B.fills) {
    const c = [[f.ob[0], f.ob[1]], [f.ob[2], f.ob[1]], [f.ob[2], f.ob[3]], [f.ob[0], f.ob[3]]].map(([x, y]) => apply(m, x, y));
    const b = [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))];
    const k = at(b[0], b[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push({ f, b });
  }
  for (const a of A.fills) {
    const gx = Math.round(a.ob[0] / cell), gy = Math.round(a.ob[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const { f, b } of grid.get(gx + dx + "," + (gy + dy)) || []) {
      if (f.lone0 === a.lone0 || Math.abs(b[0] - a.ob[0]) > 3 || Math.abs(b[1] - a.ob[1]) > 3 || Math.abs(b[2] - a.ob[2]) > 3 || Math.abs(b[3] - a.ob[3]) > 3) continue;
      a.lone = f.lone = a.pil || f.pil || (a.e + f.e) / 2 < LONE_EDGE;
    }
  }
  const { W, H } = S.frame;
  for (const D of [A, B]) {
    if (!D.fills.some((f) => f.lone !== f.drawn)) continue;
    D.keepFills = keepMap(D.fills);
    const c = await renderSource(D, I, D.W, D.H, true, true);
    if (id !== runId) return false;
    for (const f of D.fills) f.drawn = f.lone;
    if (D === A) { S.rasterA = c; S.maskA = inkMask(padTo(c, W, H), W, H); S.glyphA = glyphs(padTo(c.text, W, H), A); c.text = null; }
    else S.rasterB = c;
  }
  return true;
}

// Drawing units from the DXF header ($INSUNITS), as millimetres per unit; null when not set.
function mmPerUnit(dxf) {
  const u = dxf.header && dxf.header["$INSUNITS"];
  return { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 7: 1e6, 9: 0.0254, 10: 914.4, 14: 100 }[u] || null;
}

// DXF -> list of primitives in world coordinates (times f)
function dxfPrims(dxf, f = 1) {
  const out = [];
  const layers = (dxf.tables && dxf.tables.layer && dxf.tables.layer.layers) || {};
  const hidden = (l) => { const L = layers[l]; return L && (L.visible === false || L.frozen === true); };
  const ap = (m, p) => apply(m, p.x, p.y);
  const arcPts = (cx, cy, r, a0, sweep) => { const n = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI * 2) * 96)); const pts = []; for (let i = 0; i <= n; i++) { const a = a0 + sweep * i / n; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); } return pts; };
  function polyWithBulge(vs, closed) {
    const pts = []; const n = vs.length;
    for (let i = 0; i < n; i++) {
      const p = vs[i], q = vs[(i + 1) % n];
      pts.push({ x: p.x, y: p.y });
      if (i === n - 1 && !closed) break;
      const b = p.bulge || 0;
      if (b && q) {
        const dx = q.x - p.x, dy = q.y - p.y, c = Math.hypot(dx, dy); if (!c) continue;
        const th = 4 * Math.atan(b), r = c / (2 * Math.sin(th / 2)), h = r * Math.cos(th / 2);
        const cx = (p.x + q.x) / 2 - dy / c * h, cy = (p.y + q.y) / 2 + dx / c * h;
        const a0 = Math.atan2(p.y - cy, p.x - cx);
        const arc = arcPts(cx, cy, Math.abs(r), a0, th); arc.shift(); arc.pop(); pts.push(...arc);
      }
    }
    if (closed && pts.length) pts.push({ ...pts[0] });
    return pts;
  }
  function bspline(e) {
    const cp = e.controlPoints || [], k = e.knotValues || [], d = e.degreeOfSplineCurve || 3;
    if (e.fitPoints && e.fitPoints.length > 1 && (!cp.length || !k.length)) return e.fitPoints;
    if (cp.length < 2 || k.length !== cp.length + d + 1) return cp;
    const lo = k[d], hi = k[cp.length], n = cp.length * 10, pts = [];
    for (let s = 0; s <= n; s++) {
      const t = Math.min(lo + (hi - lo) * s / n, hi - 1e-9);
      let i = d; while (i < cp.length - 1 && t >= k[i + 1]) i++;
      const v = []; for (let j = 0; j <= d; j++) v.push({ x: cp[i - d + j].x, y: cp[i - d + j].y });
      for (let r = 1; r <= d; r++) for (let j = d; j >= r; j--) {
        const den = k[i + 1 + j - r] - k[i - d + j]; const a = den ? (t - k[i - d + j]) / den : 0;
        v[j] = { x: (1 - a) * v[j - 1].x + a * v[j].x, y: (1 - a) * v[j - 1].y + a * v[j].y };
      }
      pts.push(v[d]);
    }
    return pts;
  }
  // \U+XXXX is how AutoCAD (and our own export) writes characters outside the drawing's code page
  const uni = (s) => (s || "").replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const cleanMtext = (s) => uni(s).replace(/\\P/g, "\n").replace(/\\[ACFHQTWfhcqtwpL][^;\\]*;?/g, "").replace(/\\[LlOoKk]/g, "").replace(/[{}]/g, "").replace(/%%[cC]/g, "Ø").replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±");
  const cleanText = (s) => uni(s).replace(/%%[cC]/g, "Ø").replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±").replace(/%%[uUoO]/g, "");

  // hatch boundary edges -> points, following ezdxf: clockwise arcs store 360° minus their angles
  function edgePts(ed) {
    const m = ed.m || {};
    if (ed.type === 1) return [{ x: m[10], y: m[20] }, { x: m[11], y: m[21] }];
    if (ed.type === 2 || ed.type === 3) {
      const ccw = m[73] !== 0, s = (m[50] || 0) * Math.PI / 180, en = (m[51] ?? 360) * Math.PI / 180;
      let a0, sw;
      if (ccw) { a0 = s; sw = en - s; if (sw <= 0) sw += Math.PI * 2; } else { a0 = -s; sw = s - en; if (sw >= 0) sw -= Math.PI * 2; }
      if (ed.type === 2) return arcPts(m[10], m[20], m[40], a0, sw);
      const mx = m[11], my = m[21], r = m[40] || 1, n = 64, pts = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + sw * i / n, p = Math.atan2(Math.sin(a) / r, Math.cos(a)), c = Math.cos(p), sn = Math.sin(p) * r;
        pts.push({ x: m[10] + c * mx - sn * my, y: m[20] + c * my + sn * mx });
      }
      return pts;
    }
    if (ed.type === 4) return bspline({ controlPoints: ed.cp, knotValues: ed.knots, degreeOfSplineCurve: ed.deg });
    return [];
  }

  const OCS = new Set(["INSERT", "ARC", "CIRCLE", "LWPOLYLINE", "POLYLINE", "SOLID", "TEXT", "HATCH"]);
  // lay: layer that entities on layer "0" take (the block's); pan: inside an annotation block or dimension
  const annL = new Map(), annotL = (l) => { let v = annL.get(l); if (v === undefined) annL.set(l, v = annotLayer(l)); return v; };
  function walk(ents, mp, depth, lay = null, pan = false) {
    if (depth > 12) return;
    for (const e of ents || []) {
      if (e.inPaperSpace || hidden(e.layer)) continue;
      const L = !e.layer || e.layer === "0" ? lay ?? e.layer : e.layer;
      const an = pan || annotL(L) || AXIS_LT.test(e.lineType || "") || (e.type === "INSERT" && annotBlock(e.name));
      const n0 = out.length;
      // entities with extrusion (0,0,-1) are drawn mirrored (common for mirrored blocks)
      const ez = e.extrusionDirection ? e.extrusionDirection.z : e.extrusionDirectionZ;
      const m = ez < 0 && OCS.has(e.type) ? mul(mp, [-1, 0, 0, 1, 0, 0]) : mp;
      const line = (pts, closed, fill) => { if (pts && pts.length > 1) out.push({ t: "p", pts: pts.map((p) => ap(m, p)), closed, fill }); };
      switch (e.type) {
        case "LINE": line(e.vertices); break;
        case "LWPOLYLINE": case "POLYLINE": if (e.vertices) line(polyWithBulge(e.vertices, !!e.shape), false); break;
        case "CIRCLE": line(arcPts(e.center.x, e.center.y, e.radius, 0, Math.PI * 2)); break;
        case "ARC": { const s = e.startAngle; let sw = e.endAngle - s; if (sw <= 0) sw += Math.PI * 2; line(arcPts(e.center.x, e.center.y, e.radius, s, sw)); break; }
        case "ELLIPSE": {
          const mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y, ra = Math.hypot(mx, my), rb = ra * e.axisRatio, rot = Math.atan2(my, mx);
          const s = e.startAngle || 0, en = e.endAngle == null ? Math.PI * 2 : e.endAngle; let sw = en - s; if (sw <= 0) sw += Math.PI * 2;
          const n = 96, pts = []; for (let i = 0; i <= n; i++) { const a = s + sw * i / n, x = ra * Math.cos(a), y = rb * Math.sin(a); pts.push({ x: e.center.x + x * Math.cos(rot) - y * Math.sin(rot), y: e.center.y + x * Math.sin(rot) + y * Math.cos(rot) }); }
          line(pts); break;
        }
        case "SPLINE": line(bspline(e)); break;
        case "SOLID": case "3DFACE": if (e.points && e.points.length >= 3) { const p = e.points; const q = p.length === 4 && e.type === "SOLID" ? [p[0], p[1], p[3], p[2]] : p; line([...q, q[0]], true, true); } break;
        case "TEXT": case "ATTRIB": {
          if (!e.text) break;
          const useEnd = (e.halign || e.valign) && e.endPoint;
          const p = useEnd ? e.endPoint : e.startPoint; if (!p) break;
          out.push({ t: "x", p: ap(m, p), h: (e.textHeight || 2.5) * scaleOf(m), rot: (e.rotation || 0) * Math.PI / 180 + Math.atan2(m[1], m[0]), s: cleanText(e.text), ha: [0, 1, 2, 0, 1, 0][e.halign || 0] ?? 0, va: e.valign || 0 });
          break;
        }
        case "MTEXT": {
          if (!e.text || !e.position) break;
          const a1 = e.attachmentPoint || 1;
          const rot = e.directionVector ? Math.atan2(e.directionVector.y, e.directionVector.x) : (e.rotation || 0) * Math.PI / 180;
          out.push({ t: "x", p: ap(m, e.position), h: (e.height || 2.5) * scaleOf(m), rot: rot + Math.atan2(m[1], m[0]), s: cleanMtext(e.text), ha: (a1 - 1) % 3, va: [3, 2, 1][Math.floor((a1 - 1) / 3)], multi: true });
          break;
        }
        case "INSERT": {
          const b = dxf.blocks && dxf.blocks[e.name]; if (!b || !e.position) break;
          const sx = e.xScale ?? 1, sy = e.yScale ?? 1, r = (e.rotation || 0) * Math.PI / 180, bp = b.position || { x: 0, y: 0 };
          const T = [Math.cos(r) * sx, Math.sin(r) * sx, -Math.sin(r) * sy, Math.cos(r) * sy, e.position.x, e.position.y];
          walk(b.entities, mul(m, mul(T, [1, 0, 0, 1, -bp.x, -bp.y])), depth + 1, L, an);
          break;
        }
        case "DIMENSION": { const b = dxf.blocks && dxf.blocks[e.block]; if (b) walk(b.entities, m, depth + 1, L, true); break; }
        case "HATCH": {
          const loops = [];
          for (const L of e.loops) {
            const pts = L.poly ? polyWithBulge(L.poly, true) : L.edges.flatMap(edgePts);
            if (pts.length > 2 && pts.every((p) => isFinite(p.x) && isFinite(p.y))) loops.push(pts.map((p) => ap(m, p)));
          }
          if (!loops.length) break;
          const o = ap(m, { x: 0, y: 0 }), vec = (x, y) => { const q = ap(m, { x, y }); return [q[0] - o[0], q[1] - o[1]]; };
          const lines = e.solid ? [] : e.lines.map((l) => { const a = l.a * Math.PI / 180; return { b: ap(m, { x: l.bx, y: l.by }), u: vec(Math.cos(a), Math.sin(a)), o: vec(l.ox, l.oy), d: l.d }; });
          const xs = loops.flat().map((p) => p[0]), ys = loops.flat().map((p) => p[1]);
          out.push({ t: "h", loops, solid: !lines.length, lines, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
          break;
        }
      }
      if (an && e.type !== "INSERT" && e.type !== "DIMENSION") for (let i = n0; i < out.length; i++) out[i].an = true;
    }
  }
  walk(dxf.entities, [f, 0, 0, f, 0, 0], 0);
  return out;
}

function primBounds(prims) {
  const xs = [], ys = [];
  for (const p of prims) {
    if (p.t === "h") continue; // the frame does not depend on whether hatch is drawn
    if (p.t === "p") for (const q of p.pts) { xs.push(q[0]); ys.push(q[1]); }
    else { xs.push(p.p[0]); ys.push(p.p[1]); }
  }
  if (!xs.length) return null;
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
  // trim far outliers (stray objects far from the sheet) without cutting a normal drawing
  let x0 = q(xs, 0.002), x1 = q(xs, 0.998), y0 = q(ys, 0.002), y1 = q(ys, 0.998);
  const w = x1 - x0 || 1, h = y1 - y0 || 1;
  x0 = Math.max(xs[0], x0 - w * 0.25); x1 = Math.min(xs[xs.length - 1], x1 + w * 0.25);
  y0 = Math.max(ys[0], y0 - h * 0.25); y1 = Math.min(ys[ys.length - 1], y1 + h * 0.25);
  return [x0, y0, x1, y1];
}

// Draw DXF primitives. World -> raster px uses D.bb/D.k/D.pad; T maps raster px -> canvas px.
// When `texts` is an array, each drawn text line's box (raster px corners) is pushed to it.
function drawPrims(ctx, D, T, texts, overview = false, hatch = S.hatch, all = false) {
  const { prims, bb, k, pad } = D, st = scaleOf(T), skip = (p) => !all && !shown(p);
  ctx.save();
  ctx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  ctx.strokeStyle = "#000"; ctx.fillStyle = "#000"; ctx.lineWidth = 1.25 / st; ctx.lineJoin = "round"; ctx.lineCap = "round";
  const X = (x) => (x - bb[0]) * k + pad, Y = (y) => (bb[3] - y) * k + pad;
  let vis = null;
  if (overview && !hatch) for (const p of prims) if (p.t === "h") p.keep = false; // decided again below
  for (const p of prims) {
    if (skip(p) || (!hatch && p.hl)) continue; // hatch off: also the hatch exploded into lines
    ctx.__prim = p;
    if (p.t === "h") {
      if (!hatch && !p.keep) continue;
      if (!vis) { const iv = inv(T), w = ctx.canvas.width, h = ctx.canvas.height, c = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => apply(iv, x, y)); vis = [Math.min(...c.map((q) => q[0])), Math.min(...c.map((q) => q[1])), Math.max(...c.map((q) => q[0])), Math.max(...c.map((q) => q[1]))]; }
      drawHatch(ctx, p, X, Y, k, st, vis);
      continue;
    }
    if (p.t === "p") {
      ctx.beginPath(); ctx.moveTo(X(p.pts[0][0]), Y(p.pts[0][1]));
      for (let i = 1; i < p.pts.length; i++) ctx.lineTo(X(p.pts[i][0]), Y(p.pts[i][1]));
      if (p.fill) ctx.fill(); else ctx.stroke();
    } else {
      const px = p.h * k; if (px * st < 1.5 && !texts) continue;
      const ox = X(p.p[0]), oy = Y(p.p[1]), cs = Math.cos(-p.rot), sn = Math.sin(-p.rot);
      ctx.save(); ctx.translate(ox, oy); ctx.rotate(-p.rot);
      ctx.font = px.toFixed(2) + "px Arial, Helvetica, sans-serif";
      ctx.textAlign = ["left", "center", "right"][p.ha] || "left";
      const lines = p.s.split("\n"), lh = px * 1.4;
      let y0 = 0;
      if (p.multi) { ctx.textBaseline = "top"; const tot = lh * lines.length; y0 = p.va === 3 ? 0 : p.va === 2 ? -tot / 2 : -tot; }
      else ctx.textBaseline = ["alphabetic", "bottom", "middle", "top"][p.va] || "alphabetic";
      lines.forEach((s, i) => {
        const ly = y0 + i * lh;
        if (px * st >= 1.5) ctx.fillText(s, 0, ly);
        if (texts && s.trim()) {
          const m = ctx.measureText(s);
          const l = -m.actualBoundingBoxLeft, r = m.actualBoundingBoxRight, t = ly - m.actualBoundingBoxAscent, b = ly + m.actualBoundingBoxDescent;
          const loc = [[l, b], [r, b], [r, t], [l, t]];
          texts.push({ s, h: px, c: loc.map(([x, y]) => [ox + x * cs - y * sn, oy + x * sn + y * cs]), p });
        }
      });
      ctx.restore();
    }
  }
  // left-out solid hatch with no line along its boundary is a shape on its own, and so is a small compact
  // one (a pillar): compare it. A pattern hatch never is: soil or concrete under a section has no outline
  // either, and goes with the switch.
  if (overview && !hatch) {
    const near = inkNear(ctx), W = ctx.canvas.width, H = ctx.canvas.height, vis = [0, 0, W, H], lone = [];
    for (const p of prims) {
      if (p.t !== "h" || !p.solid || skip(p)) continue;
      const polys = p.loops.map((L) => [...L, L[0]].map((q) => [X(q[0]), Y(q[1])]));
      if (pillar(polys, DXF_PX_PER_MM) || edgeInk(near, polys, W, H) < LONE_EDGE) lone.push(p);
    }
    for (const p of lone) { p.keep = true; drawHatch(ctx, p, X, Y, k, st, vis); }
  }
  ctx.restore();
}

// A DXF primitive the "Elementos de anotación" switch lets through (texts are always annotation)
const shown = (p) => S.annot || !(p.an || p.as || p.t === "x");

// One hatch: solid ones are filled; pattern ones draw their line families inside the boundary
// (only over the visible part). Families too dense to tell apart at this zoom are filled.
function drawHatch(ctx, p, X, Y, k, st, vis) {
  const r = [Math.max(vis[0], X(p.bb[0])), Math.max(vis[1], Y(p.bb[3])), Math.min(vis[2], X(p.bb[2])), Math.min(vis[3], Y(p.bb[1]))];
  if (r[0] >= r[2] || r[1] >= r[3]) return;
  ctx.beginPath();
  for (const L of p.loops) { ctx.moveTo(X(L[0][0]), Y(L[0][1])); for (let i = 1; i < L.length; i++) ctx.lineTo(X(L[i][0]), Y(L[i][1])); ctx.closePath(); }
  if (p.solid) { ctx.fill("evenodd"); return; }
  ctx.save(); ctx.clip("evenodd");
  const corners = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]], diag = Math.hypot(r[2] - r[0], r[3] - r[1]);
  for (const l of p.lines) {
    const B = [X(l.b[0]), Y(l.b[1])], U = [l.u[0] * k, -l.u[1] * k], O = [l.o[0] * k, -l.o[1] * k];
    const ul = Math.hypot(U[0], U[1]); if (!ul) continue;
    const ux = U[0] / ul, uy = U[1] / ul, sp = O[0] * -uy + O[1] * ux; // spacing between lines, raster px
    if (Math.abs(sp) * st < 1.5) { ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]); break; }
    const q = corners.map(([x, y]) => ((x - B[0]) * -uy + (y - B[1]) * ux) / sp), j0 = Math.ceil(Math.min(...q)), j1 = Math.floor(Math.max(...q));
    const dash = l.d.map((d) => d * ul), per = dash.reduce((a, d) => a + Math.abs(d), 0);
    const plain = !dash.some((d) => d < 0) || per * st < 4 || (j1 - j0 + 1) * (diag / per) * dash.length > 4e5;
    ctx.beginPath();
    for (let j = j0; j <= j1; j++) {
      const ox = B[0] + j * O[0], oy = B[1] + j * O[1];
      const ss = corners.map(([x, y]) => (x - ox) * ux + (y - oy) * uy), s0 = Math.min(...ss), s1 = Math.max(...ss);
      if (plain) { ctx.moveTo(ox + s0 * ux, oy + s0 * uy); ctx.lineTo(ox + s1 * ux, oy + s1 * uy); continue; }
      let s = Math.floor(s0 / per) * per;
      while (s < s1) for (const d of dash) {
        if (d >= 0) { const e = s + Math.max(d, 0.01); ctx.moveTo(ox + s * ux, oy + s * uy); ctx.lineTo(ox + e * ux, oy + e * uy); }
        s += Math.abs(d);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

// PDF text items -> boxes in raster px (corners: baseline-start, baseline-end, top-end, top-start)
async function pdfTexts(D) {
  const page = await D.pdf.getPage(D.page);
  const vp = page.getViewport({ scale: D.scale });
  const tc = await page.getTextContent();
  const out = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    const fs = Math.hypot(c, d) || Math.hypot(a, b); if (!fs) continue;
    const ux = a / Math.hypot(a, b), uy = b / Math.hypot(a, b), vx = c / fs, vy = d / fs;
    const w = it.width || fs * it.str.length * 0.5, desc = fs * 0.22, asc = fs * 0.9;
    const pts = [[e - vx * desc, f - vy * desc], [e + ux * w - vx * desc, f + uy * w - vy * desc], [e + ux * w + vx * asc, f + uy * w + vy * asc], [e + vx * asc, f + vy * asc]];
    out.push({ s: it.str, h: fs * D.scale, c: pts.map(([x, y]) => vp.convertToViewportPoint(x, y)) });
  }
  return out;
}

// Merge text fragments that sit on the same baseline into whole lines,
// so "DORMITORIO 1" matches even if one file splits it in two pieces.
function textLines(items) {
  const rows = items.map((t) => {
    const [p0, p1, , p3] = t.c;
    let ux = p1[0] - p0[0], uy = p1[1] - p0[1]; const L = Math.hypot(ux, uy) || 1; ux /= L; uy /= L;
    const ang = Math.round(Math.atan2(uy, ux) * 180 / Math.PI / 2) * 2;
    const nx = -uy, ny = ux;
    return { ...t, ux, uy, ang, perp: p0[0] * nx + p0[1] * ny, a0: p0[0] * ux + p0[1] * uy, a1: p1[0] * ux + p1[1] * uy };
  });
  rows.sort((p, q) => p.ang - q.ang || p.perp - q.perp);
  const lines = [];
  let i = 0;
  while (i < rows.length) {
    const band = [rows[i]]; let j = i + 1;
    while (j < rows.length && rows[j].ang === rows[i].ang && rows[j].perp - band[band.length - 1].perp < 0.3 * Math.max(rows[j].h, rows[i].h)) band.push(rows[j++]);
    band.sort((p, q) => p.a0 - q.a0);
    let cur = null;
    for (const r of band) {
      if (cur && r.a0 - cur.a1 < 0.9 * Math.max(r.h, cur.h) && r.h / cur.h < 1.6 && cur.h / r.h < 1.6) {
        cur.s += (r.a0 - cur.a1 > 0.15 * r.h ? " " : "") + r.s; cur.c[1] = r.c[1]; cur.c[2] = r.c[2]; cur.a1 = Math.max(cur.a1, r.a1); cur.h = Math.max(cur.h, r.h);
      } else { cur = { s: r.s, h: r.h, c: r.c.map((p) => p.slice()), a1: r.a1 }; lines.push(cur); }
    }
    i = j;
  }
  return lines;
}

// Find texts that say the same thing in the same place in A and B. Returns boxes (frame px)
// where differences only come from the typeface and should be shown as matching.
function matchTexts(tA, tB, M) {
  if (!tA || !tB || !tA.length || !tB.length) return [];
  const norm = (s) => s.toLowerCase().replace(/\s+/g, "");
  const box = (c) => { const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  const sB = scaleOf(M);
  const byKey = new Map();
  for (const t of tB) {
    const c = t.c.map((p) => apply(M, p[0], p[1])), bx = box(c);
    const item = { key: norm(t.s), h: t.h * sB, bx, cx: (bx[0] + bx[2]) / 2, cy: (bx[1] + bx[3]) / 2, used: false };
    if (!byKey.has(item.key)) byKey.set(item.key, []);
    byKey.get(item.key).push(item);
  }
  const out = [];
  for (const t of tA) {
    const cand = byKey.get(norm(t.s)); if (!cand) continue;
    const bx = box(t.c), cx = (bx[0] + bx[2]) / 2, cy = (bx[1] + bx[3]) / 2;
    let best = null, bd = Infinity;
    for (const c of cand) {
      if (c.used) continue;
      // compare both the centers and the start points, since a new font changes the width
      const d = Math.min(Math.hypot(c.cx - cx, c.cy - cy), Math.hypot(c.bx[0] - bx[0], c.bx[1] - bx[1]), Math.hypot(c.bx[2] - bx[2], c.bx[3] - bx[3]));
      if (d < bd) { bd = d; best = c; }
    }
    const h = Math.max(t.h, best ? best.h : 0);
    if (best && bd < 1.2 * h + 3 && best.h / t.h < 1.8 && t.h / best.h < 1.8) {
      best.used = true;
      const p = 0.15 * h;
      out.push([Math.min(bx[0], best.bx[0]) - p, Math.min(bx[1], best.bx[1]) - p, Math.max(bx[2], best.bx[2]) + p, Math.max(bx[3], best.bx[3]) + p]);
    }
  }
  return out;
}

async function rasterize(all = false) {
  const target = RES;
  const A = S.A, B = S.B;
  S.mixed = A.kind !== B.kind;
  const prepDxf = (D, prims, bb) => {
    const pad = Math.round(target * 0.02), k = (target - 2 * pad) / Math.max(bb[2] - bb[0], bb[3] - bb[1]);
    Object.assign(D, { prims, bb, k, pad, W: Math.ceil((bb[2] - bb[0]) * k + 2 * pad), H: Math.ceil((bb[3] - bb[1]) * k + 2 * pad) });
  };
  if (A.kind === "dxf" && B.kind === "dxf") {
    // DXF pairs usually share model coordinates. Bring both to millimetres first,
    // since one file may be drawn in mm and the other in cm or m.
    const ua = mmPerUnit(A.dxf), ub = mmPerUnit(B.dxf);
    const fa = ua && ub ? ua : 1, fb = ua && ub ? ub : 1;
    const pa = dxfPrims(A.dxf, fa), pb = dxfPrims(B.dxf, fb); A.f = fa; B.f = fb;
    const ba = primBounds(pa), bbB = primBounds(pb);
    if (!ba || !bbB) throw new Error("Uno de los DXF no tiene entidades visibles en el espacio modelo.");
    const size = (b) => Math.max(b[2] - b[0], b[3] - b[1]), r = size(ba) / size(bbB);
    const overlap = Math.min(ba[2], bbB[2]) > Math.max(ba[0], bbB[0]) && Math.min(ba[3], bbB[3]) > Math.max(ba[1], bbB[1]);
    if (r > 0.5 && r < 2 && overlap) { const bb = primBounds(pa.concat(pb)); prepDxf(A, pa, bb); prepDxf(B, pb, bb); }
    // otherwise each is drawn on its own and the automatic alignment finds scale and offset
    else { prepDxf(A, pa, ba); prepDxf(B, pb, bbB); }
  }
  else {
    for (const D of [A, B]) if (D.kind === "dxf") { D.f = 1; const p = dxfPrims(D.dxf), bb = primBounds(p); if (!bb) throw new Error("El DXF no tiene entidades visibles."); prepDxf(D, p, bb); }
  }
  // PDFs share one points-to-pixels scale so equal drawing scales stay equal
  const sizes = [];
  for (const D of [A, B]) if (D.kind === "pdf") { const p = await D.pdf.getPage(D.page), v = p.getViewport({ scale: 1 }); D.pw = v.width; D.ph = v.height; sizes.push(v.width, v.height); }
  const scale = sizes.length ? target / Math.max(...sizes) : 1;
  const out = [];
  for (const D of [A, B]) {
    if (D.kind === "pdf") {
      D.scale = scale; D.W = Math.floor(D.pw * scale); D.H = Math.floor(D.ph * scale);
      out.push(await renderSource(D, I, D.W, D.H, true, false, false, all));
      try { D.text = S.annot || all ? await pdfTexts(D) : []; } catch { D.text = []; }
    } else {
      const c = document.createElement("canvas"); c.width = D.W; c.height = D.H;
      const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, D.W, D.H);
      c.text = captureText(ctx);
      if (!S.annot && !all) dxfAnnots(D);
      if (!S.hatch) dxfHatch(D);
      const texts = []; drawPrims(ctx, D, I, texts, true, S.hatch, all); D.text = texts; out.push(c);
    }
    D.lines = textLines(D.text);
  }
  return out;
}

// ---------- masks ----------
function inkMask(canvas, W, H, thr = INK_THRESHOLD) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, W, H).data, m = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < m.length; i++, j += 4) {
    const a = d[j + 3] / 255;
    const lum = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) * a + 255 * (1 - a);
    if (lum < thr) m[i] = 1;
  }
  return m;
}
function dilate(m, W, H, r) {
  if (r <= 0) return m.slice();
  const t = new Uint8Array(W * H), o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W; let cnt = 0;
    for (let x = 0; x < Math.min(r, W); x++) cnt += m[row + x];
    for (let x = 0; x < W; x++) {
      if (x + r < W) cnt += m[row + x + r];
      if (x - r - 1 >= 0) cnt -= m[row + x - r - 1];
      t[row + x] = cnt > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < W; x++) {
    let cnt = 0;
    for (let y = 0; y < Math.min(r, H); y++) cnt += t[y * W + x];
    for (let y = 0; y < H; y++) {
      if (y + r < H) cnt += t[(y + r) * W + x];
      if (y - r - 1 >= 0) cnt -= t[(y - r - 1) * W + x];
      o[y * W + x] = cnt > 0 ? 1 : 0;
    }
  }
  return o;
}
const clipRect = (r, W, H) => [Math.max(0, Math.floor(r[0])), Math.max(0, Math.floor(r[1])), Math.min(W, Math.ceil(r[2])), Math.min(H, Math.ceil(r[3]))];

// Classify every inked pixel: in both (gray), only in A, only in B.
// excl and neutral are rectangles in this canvas' pixels; gA and gB mark the letters drawn in A and B
// (null when the letters could not be told apart from the rest of the drawing).
function classify(mA, mB, W, H, tol, excl, neutral, gA = null, gB = null) {
  for (const r of excl) {
    const [x0, y0, x1, y1] = clipRect(r, W, H); if (x1 <= x0) continue;
    for (let y = y0; y < y1; y++) { mA.fill(0, y * W + x0, y * W + x1); mB.fill(0, y * W + x0, y * W + x1); }
  }
  const dA = dilate(mA, W, H, tol), dB = dilate(mB, W, H, tol);
  // Inside a solid area (a filled hatch, a thick wall) the tolerance would match every pixel near the other
  // plan's lines, so a thin line over a fill came out as a thick gray band. There a pixel matches only where
  // the other plan has ink at that very pixel; the tolerance still applies near the edges.
  const edge = (m) => { const o = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) o[i] = m[i] ? 0 : 1; return dilate(o, W, H, tol + 1); };
  const eA = tol > 0 ? edge(mA) : null, eB = tol > 0 ? edge(mB) : null;
  const rem = new Uint8Array(W * H), add = new Uint8Array(W * H), com = new Uint8Array(W * H);
  let nA = 0, nB = 0, nRem = 0, nAdd = 0;
  for (let i = 0; i < W * H; i++) {
    if (mA[i]) { nA++; if (!eA || eA[i] ? dB[i] : mB[i]) com[i] = 1; else { rem[i] = 1; nRem++; } }
    if (mB[i]) { nB++; if (!eB || eB[i] ? dA[i] : mA[i]) com[i] = 1; else { add[i] = 1; nAdd++; } }
  }
  // Same text in another typeface: inside the text's box, a change is ignored only on the letters
  // (A's letters for what A lost, B's for what B gained). Lines and symbols there stay a change.
  // Without the letters of both plans nothing is ignored: a typeface change in red is better than a hidden change.
  let fontFixed = 0;
  if (neutral.length && gA && gB) {
    const GA = dilate(gA, W, H, Math.max(1, tol)), GB = dilate(gB, W, H, Math.max(1, tol));
    for (const r of neutral) {
      const [x0, y0, x1, y1] = clipRect(r, W, H); let n = 0;
      for (let y = y0; y < y1; y++) for (let i = y * W + x0, e = y * W + x1; i < e; i++) {
        if (rem[i] && GA[i]) { rem[i] = 0; nRem--; n++; }
        if (add[i] && GB[i]) { add[i] = 0; nAdd--; n++; }
        // show B's lettering only, so two overlapping typefaces don't read as a smudge
        com[i] = (mB[i] && !add[i]) || (com[i] && !GA[i]) ? 1 : 0; // B's ink still red stays red (a fill over the text)
      }
      if (n > 2) fontFixed++;
    }
  }
  return { rem, add, com, nA, nB, nRem, nAdd, fontFixed };
}

// ---------- alignment ----------
function profiles(m, W, H) {
  const col = new Float64Array(W), row = new Float64Array(H);
  for (let y = 0; y < H; y++) { const r = y * W; let s = 0; for (let x = 0; x < W; x++) { const v = m[r + x]; s += v; col[x] += v; } row[y] = s; }
  return [col, row];
}
function bestShift(a, b, maxShift) {
  // shift s so that b[i - s] lines up with a[i]
  const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
  const A = a.map((v) => v - ma), B = b.map((v) => v - mb);
  let best = -Infinity, bestS = 0, zero = 0;
  for (let s = -maxShift; s <= maxShift; s++) {
    let acc = 0;
    const i0 = Math.max(0, s), i1 = Math.min(A.length, B.length + s);
    for (let i = i0; i < i1; i++) acc += A[i] * B[i - s];
    if (s === 0) zero = acc;
    if (acc > best) { best = acc; bestS = s; }
  }
  if (zero >= best * 0.985) return 0;
  return bestS;
}
// Positions of long straight lines (grid axes, walls, frames): strong local maxima of an ink profile.
function axisPeaks(prof, n) {
  let mx = 0; for (const v of prof) mx = Math.max(mx, v);
  const thr = mx * 0.2, out = [];
  for (let i = 0; i < prof.length; i++) {
    const v = prof[i]; if (v < thr || v === 0) continue;
    let top = true;
    for (let j = Math.max(0, i - 4); j <= Math.min(prof.length - 1, i + 4); j++) if (prof[j] > v || (prof[j] === v && j < i)) { top = false; break; }
    if (top) out.push({ p: i, v });
  }
  out.sort((a, b) => b.v - a.v);
  return out.slice(0, n).map((o) => o.p).sort((a, b) => a - b);
}
function nearestDist(sorted, x) {
  let lo = 0, hi = sorted.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m; else hi = m; }
  return Math.min(Math.abs(sorted[lo] - x), Math.abs(sorted[hi] - x));
}
const countHits = (pa, pb, s, t, tol) => { let n = 0; for (const b of pb) if (nearestDist(pa, s * b + t) < tol) n++; return n; };
// usual ratios between drawing scales (1:50 vs 1:100, 1:75 vs 1:100, ...)
const NICE = (() => { const sc = [10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 1000], r = []; for (const a of sc) for (const b of sc) r.push(b / a); return r; })();
const isNice = (s) => NICE.some((r) => Math.abs(s / r - 1) < 0.006);

// For one axis: every pair of lines in A against every pair in B proposes a scale and offset;
// keep the proposals under which most lines of B land on lines of A.
function axisProposals(pa, pb, len) {
  const tol = Math.max(2, len * 0.0015), out = [];
  for (let i = 0; i < pa.length; i++) for (let j = i + 1; j < pa.length; j++) {
    const da = pa[j] - pa[i]; if (da < len * 0.04) continue;
    for (let k = 0; k < pb.length; k++) for (let l = k + 1; l < pb.length; l++) {
      const db = pb[l] - pb[k]; if (db < len * 0.04) continue;
      const s = da / db; if (s < 0.2 || s > 5) continue;
      const t = pa[i] - s * pb[k];
      out.push({ s, t, n: countHits(pa, pb, s, t, tol) });
    }
  }
  out.sort((a, b) => b.n - a.n);
  return out;
}
function bestOffset(pa, pb, s, len) {
  const tol = Math.max(2, len * 0.0015); let best = { t: 0, n: -1 };
  for (const a of pa) for (const b of pb) { const t = a - s * b, n = countHits(pa, pb, s, t, tol); if (n > best.n) best = { t, n }; }
  return best;
}
// How well B (placed with m) lies on A: F-score of ink near ink, on masks 1/div of the size.
function overlapScorer(rA, rB, W, H, div = 2) {
  const w = Math.max(1, Math.round(W / div)), h = Math.max(1, Math.round(H / div));
  const half = (c, m) => { const o = document.createElement("canvas"); o.width = w; o.height = h; const x = o.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.setTransform(m[0] / div, m[1] / div, m[2] / div, m[3] / div, m[4] / div, m[5] / div); x.drawImage(c, 0, 0); return inkMask(o, w, h, 245); };
  const mA = half(rA, I), dA = dilate(mA, w, h, 2); let nA = 0; for (const v of mA) nA += v;
  return (m) => {
    const mB = half(rB, m), dB = dilate(mB, w, h, 2);
    let nB = 0, hitB = 0, hitA = 0;
    for (let i = 0; i < w * h; i++) { if (mB[i]) { nB++; if (dA[i]) hitB++; } if (mA[i] && dB[i]) hitA++; }
    const P = nB ? hitB / nB : 0, R = nA ? hitA / nA : 0;
    return P + R ? 2 * P * R / (P + R) : 0;
  };
}
// The same score, quick: ink points of each plan (on masks a quarter of the size, at most ~40000 of
// them) checked against the other's dilated mask. For sorting many proposals.
function quickScorer(rA, rB) {
  const div = 4;
  const prep = (c) => {
    const w = Math.max(1, Math.ceil(c.width / div)), h = Math.max(1, Math.ceil(c.height / div));
    const o = document.createElement("canvas"); o.width = w; o.height = h;
    const x = o.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.setTransform(1 / div, 0, 0, 1 / div, 0, 0); x.drawImage(c, 0, 0);
    const m = inkMask(o, w, h, 245), pts = [];
    let n = 0; for (const v of m) n += v;
    const step = Math.max(1, Math.round(n / 40000));
    for (let i = 0, k = 0; i < m.length; i++) if (m[i] && (k++ % step === 0)) pts.push((i % w) * div + div / 2, Math.floor(i / w) * div + div / 2);
    return { w, h, d: dilate(m, w, h, 2), pts };
  };
  const A = prep(rA), B = prep(rB);
  const hits = (src, dst, m) => {
    let n = 0; const P = src.pts;
    for (let i = 0; i < P.length; i += 2) {
      const x = Math.floor((m[0] * P[i] + m[2] * P[i + 1] + m[4]) / div), y = Math.floor((m[1] * P[i] + m[3] * P[i + 1] + m[5]) / div);
      if (x >= 0 && y >= 0 && x < dst.w && y < dst.h && dst.d[y * dst.w + x]) n++;
    }
    return P.length ? n / (P.length / 2) : 0;
  };
  return (m) => {
    const det = m[0] * m[3] - m[1] * m[2], inv = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
    const P = hits(B, A, m), R = hits(A, B, inv);
    return P + R ? 2 * P * R / (P + R) : 0;
  };
}
function autoAlign(rA, rB, W, H) {
  const mA = inkMask(padTo(rA, W, H), W, H), mB = inkMask(padTo(rB, W, H), W, H);
  const [cA, rwA] = profiles(mA, W, H), [cB, rwB] = profiles(mB, W, H);
  const shift = [1, 0, 0, 1, bestShift(cA, cB, Math.round(W * 0.3)), bestShift(rwA, rwB, Math.round(H * 0.3))];
  // Same drawing at another scale: match the grid axes of A and B to find scale and offset.
  const N = 24, xa = axisPeaks(cA, N), xb = axisPeaks(cB, N), ya = axisPeaks(rwA, N), yb = axisPeaks(rwB, N);
  const cands = [];
  if (xa.length >= 2 && xb.length >= 2 && ya.length && yb.length) {
    for (const c of axisProposals(xa, xb, W).slice(0, 40)) { const o = bestOffset(ya, yb, c.s, H); cands.push({ s: c.s, tx: c.t, ty: o.t, n: c.n + o.n }); }
  }
  if (ya.length >= 2 && yb.length >= 2 && xa.length && xb.length) {
    for (const c of axisProposals(ya, yb, H).slice(0, 40)) { const o = bestOffset(xa, xb, c.s, W); cands.push({ s: c.s, tx: o.t, ty: c.t, n: c.n + o.n }); }
  }
  // The sheet's frame: the outermost lines on each side (a PDF and a DXF of one sheet are drawn at
  // unrelated sizes, and lines bunched in the middle of the sheet can outvote the frame above)
  const outer = (pa, pb, len, pa2, pb2, len2, vertical) => {
    const ends = (p) => [p.slice(0, 3), p.slice(-3)];
    const [la, ra] = ends(pa), [lb, rb] = ends(pb);
    for (const l of la) for (const r of ra) for (const l2 of lb) for (const r2 of rb) {
      if (r - l < len * 0.5 || r2 - l2 < len * 0.5) continue;
      const s = (r - l) / (r2 - l2); if (s < 0.2 || s > 5) continue;
      const t = l - s * l2, o = bestOffset(pa2, pb2, s, len2), n = countHits(pa, pb, s, t, Math.max(2, len * 0.0015)) + o.n;
      cands.push(vertical ? { s, tx: o.t, ty: t, n } : { s, tx: t, ty: o.t, n });
    }
  };
  if (xa.length >= 2 && xb.length >= 2 && ya.length && yb.length) outer(xa, xb, W, ya, yb, H, false);
  if (ya.length >= 2 && yb.length >= 2 && xa.length && xb.length) outer(ya, yb, H, xa, xb, W, true);
  for (const c of cands) c.score = c.n + (isNice(c.s) ? 1.5 : 0) + (Math.abs(c.s - 1) < 0.004 ? 0.5 : 0);
  cands.sort((a, b) => b.score - a.score);
  // a quick look at the best different proposals keeps five of them
  const distinct = [];
  for (const c of cands) {
    if (distinct.some((p) => Math.abs(p.s / c.s - 1) < 0.01 && Math.abs(p.tx - c.tx) < 4 && Math.abs(p.ty - c.ty) < 4)) continue;
    distinct.push(c); if (distinct.length >= 40) break;
  }
  const quick = quickScorer(rA, rB);
  for (const c of distinct) c.f = quick([c.s, 0, 0, c.s, c.tx, c.ty]);
  const picked = distinct.sort((a, b) => b.f - a.f).slice(0, 5);
  // Least-squares fit over all lines that matched, then snap to a usual scale ratio if close.
  const refine = (c) => {
    const pairs = (pa, pb, t, len) => { const tol = Math.max(3, len * 0.003), r = []; for (const q of pb) { const x = c.s * q + t; let a = pa[0]; for (const v of pa) if (Math.abs(v - x) < Math.abs(a - x)) a = v; if (Math.abs(a - x) < tol) r.push([q, a]); } return r; };
    const px = pairs(xa, xb, c.tx, W), py = pairs(ya, yb, c.ty, H);
    if (px.length + py.length < 3) return [c.s, 0, 0, c.s, c.tx, c.ty];
    const mean = (r, i) => r.reduce((x, p) => x + p[i], 0) / (r.length || 1);
    const mbx = mean(px, 0), max = mean(px, 1), mby = mean(py, 0), may = mean(py, 1);
    let num = 0, den = 0;
    for (const [q, a] of px) { num += (q - mbx) * (a - max); den += (q - mbx) ** 2; }
    for (const [q, a] of py) { num += (q - mby) * (a - may); den += (q - mby) ** 2; }
    let s = den ? num / den : c.s;
    const nice = NICE.find((r) => Math.abs(s / r - 1) < 0.006); if (nice) s = nice;
    return [s, 0, 0, s, px.length ? max - s * mbx : c.tx, py.length ? may - s * mby : c.ty];
  };
  const score = overlapScorer(rA, rB, W, H);
  let best = shift, bestF = score(shift);
  for (const c of picked) {
    const m = refine(c), f = score(m);
    if (f > bestF + 0.02) { best = m; bestF = f; }
  }
  if (best !== shift && Math.abs(best[0] - 1) < 0.002) best = [1, 0, 0, 1, Math.round(best[4]), Math.round(best[5])];
  return best;
}
function padTo(c, W, H) {
  if (c.width === W && c.height === H) return c;
  const o = document.createElement("canvas"); o.width = W; o.height = H;
  const x = o.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, W, H); x.drawImage(c, 0, 0); return o;
}
function warp(c, m, W, H) {
  const o = document.createElement("canvas"); o.width = W; o.height = H;
  const x = o.getContext("2d", { willReadFrequently: true });
  x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
  const pure = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1;
  if (pure) x.drawImage(c, Math.round(m[4]), Math.round(m[5]));
  else { x.imageSmoothingEnabled = true; x.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]); x.drawImage(c, 0, 0); }
  return o;
}

// ---------- comparison (overview) ----------
function compare() {
  const { W, H } = S.frame;
  S.neutral = matchTexts(S.A.lines, S.B.lines, S.xf.m); // same text in another font is not a change
  const R = classify(S.maskA.slice(), inkMask(S.bWarp, W, H), W, H, TOL, S.excl, S.neutral, S.glyphA, S.glyphB);
  R.pct = R.nA + R.nB ? (R.nRem + R.nAdd) / (R.nA + R.nB) * 100 : 0;
  S.result = R;
  paint();
  showResult();
}

// ---------- painting ----------
// Paint a classification R into ctx.
function paintDiff(ctx, R, W, H, thick) {
  const img = ctx.createImageData(W, H), d = img.data;
  // strokes are thickened for display only, so thin CAD lines stay visible
  const remV = dilate(R.rem, W, H, thick), addV = dilate(R.add, W, H, thick), comV = dilate(R.com, W, H, thick);
  for (let i = 0, j = 0; i < W * H; i++, j += 4) {
    let c = null;
    // A is the reference, drawn whole in gray; B on top: what matches A is gray, what A does not have is red.
    // What only A has stays gray. Swapping A and B makes the other plan the reference.
    // a matching pixel stays gray even next to red (the red is thickened for display, the gray line must not vanish in it)
    if (R.com[i]) c = COL_MATCH; else if (addV[i]) c = COL_DIFF; else if (remV[i] || comV[i]) c = COL_MATCH;
    if (c) { d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2]; } else { d[j] = d[j + 1] = d[j + 2] = 255; }
    d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function paint() {
  const { W, H } = S.frame;
  if (!S.out || S.out.width !== W || S.out.height !== H) { S.out = document.createElement("canvas"); S.out.width = W; S.out.height = H; }
  const ctx = S.out.getContext("2d");
  if (S.view === "diff") paintDiff(ctx, S.result, W, H, 1);
  else {
    const v = plainView(S.view);
    if (v) ctx.drawImage(v, 0, 0);
    else { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H); makePlain().then((ok) => { if (ok) paint(); }); }
  }
  main.setCanvas(S.out);
  scheduleDetail();
}

// Plano A and Plano B views: one plan alone, without hatch, A in #28251f and B in #7e705b.
// Made from the comparison rasters when the hatch switch is off, else drawn again without hatch.
const COL_PLAIN = { A: [135, 122, 103], B: [199, 189, 168] }; // #877a67 and #c7bda8
function tint(c, rgb) {
  const o = document.createElement("canvas"); o.width = c.width; o.height = c.height;
  const x = o.getContext("2d"); x.drawImage(c, 0, 0);
  const img = x.getImageData(0, 0, o.width, o.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = 1 - Math.min(d[i], d[i + 1], d[i + 2]) / 255; // how much ink, keeping the line's soft edges
    d[i] = 255 - (255 - rgb[0]) * a; d[i + 1] = 255 - (255 - rgb[1]) * a; d[i + 2] = 255 - (255 - rgb[2]) * a; d[i + 3] = 255;
  }
  x.putImageData(img, 0, 0); return o;
}
const plainKey = () => [S.rasterA, S.bWarp, S.hatch];
function plainView(v) { const p = S.plain; return p && p.key.every((k, i) => k === plainKey()[i]) ? p[v] : null; }
let plainBusy = null;
function makePlain() {
  if (plainBusy) return plainBusy;
  const key = plainKey(), { W, H } = S.frame;
  plainBusy = (async () => {
    let a = S.rasterA, b = S.rasterB;
    if (S.hatch) {
      setBusy("Preparando vista…");
      [a, b] = await Promise.all([renderSource(S.A, I, S.rasterA.width, S.rasterA.height, false, true, true), renderSource(S.B, I, S.rasterB.width, S.rasterB.height, false, true, true)]);
      setBusy(null);
    }
    if (!plainKey().every((k, i) => k === key[i])) return false; // a new comparison came meanwhile
    S.plain = { key, A: tint(padTo(a, W, H), COL_PLAIN.A), B: tint(warp(b, S.xf.m, W, H), COL_PLAIN.B) };
    return true;
  })().catch((e) => { setBusy(null); if (!(e && e.name === "RenderingCancelledException")) console.error(e); return false; }).finally(() => { plainBusy = null; });
  return plainBusy;
}

function showResult() {
  const R = S.result, pct = R.pct;
  $("pct").innerHTML = (pct < 10 ? pct.toFixed(1) : Math.round(pct)).toString().replace(".", ",") + "<small>%</small>";
  $("pctLbl").textContent = "Cambios aproximados"; $("pctLbl").classList.remove("pre"); $("alignBtn").hidden = false; $("resultSec").hidden = false;
  const match = 100 - pct, noMatch = match < NO_MATCH;
  if (noMatch && !S.forceShow) { if (errKind !== "nomatch") showError(`No match: A y B coinciden solo en un ${Math.round(match)} %. Puede que no sean versiones del mismo plano, o que no se hayan podido alinear.`, "nomatch"); }
  else if (errKind === "nomatch") clearError();
  showResultStatus();
  exportButtons();
}

function alignText() {
  const m = S.xf.m;
  const isT = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1;
  return (S.xf.mode === "manual" ? "Manual" : "Automática") + " · B movido " +
    (isT ? `${Math.round(m[4])}, ${Math.round(m[5])} px` : `${Math.round(m[4])}, ${Math.round(m[5])} px · escala ×${scaleOf(m).toFixed(3).replace(".", ",")}` + (Math.abs(Math.atan2(m[1], m[0])) > 1e-4 ? ` · giro ${(Math.atan2(m[1], m[0]) * 180 / Math.PI).toFixed(2).replace(".", ",")}°` : ""));
}

function legend() {
  $("legend").innerHTML = LEGEND.map(([c, t]) => `<span><i class="sw" style="background:rgb(${c})"></i>${t}</span>`).join("");
}

// ---------- sharp detail when zoomed in ----------
// The overview is a fixed-size image. When zoomed in, the visible area is drawn again
// from the original PDF/DXF at screen resolution and compared again, so lines stay crisp.
let detailTimer = 0, detailId = 0, detailEl = null;
function clearDetail() { if (detailEl) { detailEl.remove(); detailEl = null; } }
function scheduleDetail() {
  clearTimeout(detailTimer);
  if (!S.result || exporting || S.running) return;
  const z = main.s * DPR();
  if (z <= 1.1) { cancelRenders(); detailId++; clearDetail(); return; }
  // keep the current detail while it still covers the view at about the right resolution
  if (detailEl && Math.abs(detailEl._z / z - 1) < 0.05 && covers(detailEl._r)) return;
  detailTimer = setTimeout(renderDetail, 220);
}
function covers(r) {
  const a = main.toFrame(main.el.getBoundingClientRect().left, main.el.getBoundingClientRect().top);
  const b = main.toFrame(main.el.getBoundingClientRect().right, main.el.getBoundingClientRect().bottom);
  const { W, H } = S.frame;
  return r[0] <= Math.max(0, a[0]) + 0.5 && r[1] <= Math.max(0, a[1]) + 0.5 && r[2] >= Math.min(W, b[0]) - 0.5 && r[3] >= Math.min(H, b[1]) - 0.5;
}
async function renderDetail() {
  const id = ++detailId;
  cancelRenders();
  const { W, H } = S.frame, er = main.el.getBoundingClientRect();
  const a = main.toFrame(er.left, er.top), b = main.toFrame(er.right, er.bottom);
  let z = Math.min(main.s * DPR(), MAX_ZOOM * 2);
  const mx = (b[0] - a[0]) * 0.15, my = (b[1] - a[1]) * 0.15;
  let r = [Math.max(0, a[0] - mx), Math.max(0, a[1] - my), Math.min(W, b[0] + mx), Math.min(H, b[1] + my)];
  if ((r[2] - r[0]) * (r[3] - r[1]) * z * z > DETAIL_BUDGET) r = [Math.max(0, a[0]), Math.max(0, a[1]), Math.min(W, b[0]), Math.min(H, b[1])];
  const area = (r[2] - r[0]) * (r[3] - r[1]); if (area <= 1) return;
  if (area * z * z > DETAIL_BUDGET) z = Math.sqrt(DETAIL_BUDGET / area);
  setStatus("Afinando detalle…");
  try {
    const out = await renderRegion(r, z, S.view, Math.max(1, Math.round(DPR())), () => id !== detailId);
    if (!out || id !== detailId) return;
    out.className = "detail";
    Object.assign(out.style, { left: r[0] + "px", top: r[1] + "px", width: (r[2] - r[0]) + "px", height: (r[3] - r[1]) + "px" });
    out._z = z; out._r = r;
    clearDetail(); detailEl = out; main.content.appendChild(out);
    showResultStatus();
  } catch (e) {
    if (e && e.name === "RenderingCancelledException") return;
    console.error(e); if (id === detailId) showResultStatus();
  }
}
// Draw frame rectangle r at z canvas px per frame px: plan A, plan B, or the comparison.
async function renderRegion(r, z, view, thick, stale = () => false) {
  const w = Math.max(1, Math.round((r[2] - r[0]) * z)), h = Math.max(1, Math.round((r[3] - r[1]) * z));
  const TA = [z, 0, 0, z, -r[0] * z, -r[1] * z];
  const m = S.xf.m, TB = [z * m[0], z * m[1], z * m[2], z * m[3], z * (m[4] - r[0]), z * (m[5] - r[1])];
  let out;
  if (view === "A") out = tint(await renderSource(S.A, TA, w, h, false, false, true), COL_PLAIN.A);
  else if (view === "B") out = tint(await renderSource(S.B, TB, w, h, false, false, true), COL_PLAIN.B);
  else {
    const [cA, cB] = await Promise.all([renderSource(S.A, TA, w, h, true), renderSource(S.B, TB, w, h, true)]);
    if (stale()) return null;
    const tol = Math.round(TOL * z);
    const sc = (q) => [(q[0] - r[0]) * z, (q[1] - r[1]) * z, (q[2] - r[0]) * z, (q[3] - r[1]) * z];
    const g = S.glyphA && S.glyphB && S.neutral.length;
    const R = classify(inkMask(cA, w, h), inkMask(cB, w, h), w, h, tol, S.excl.map(sc), S.neutral.map(sc), g && inkMask(cA.text, w, h), g && inkMask(cB.text, w, h));
    out = document.createElement("canvas"); out.width = w; out.height = h;
    paintDiff(out.getContext("2d"), R, w, h, thick);
  }
  return out;
}
function showResultStatus() {
  if (!S.A || !S.B) return;
  if (S.mixed) { setStatus("A y B tienen formatos distintos (PDF y DXF): revisa que calcen bien."); return; }
  const el = $("status"), vs = document.createElement("b"); vs.className = "vs"; vs.textContent = "VS";
  el.textContent = ""; el.append(S.A.name, vs, S.B.name); el.title = S.A.name + " vs " + S.B.name;
}

// ---------- export (PDF and DXF) ----------
let exporting = false, dlNs;
// the hatch switch, the swap and new files wait while a download is prepared, so the file describes one comparison
function setExporting(on) { exporting = on; for (const id of ["hatchBtn", "annotBtn", "swap", "pickA", "pickB"]) $(id).disabled = on; }
// fallback: () => [filename, blob] in a format the Claude page accepts, when it refuses this one
async function offerFile(filename, blob, fallback = null) {
  if (dlNs === undefined) dlNs = window.claude && window.claude.use ? await window.claude.use("downloads") : null;
  if (dlNs) {
    try { await dlNs.save({ filename, data: blob }); setStatus("Descargado: " + filename); }
    catch (e) {
      const c = e && e.code;
      if (fallback && (c === "rejected_extension" || c === "extension_not_enabled")) { const [f, b] = await fallback(); return offerFile(f, b); }
      setStatus(c === "declined" ? "Descarga cancelada." : c === "rate_limited" ? "Ya hay una descarga esperando tu confirmación." : c === "too_large" ? "El archivo es demasiado grande para descargarlo aquí." : "La descarga no está disponible en esta vista.");
    }
    return;
  }
  // the page opened outside the Claude viewer (for example on your own website)
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
const stem = (n) => n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\.[^.]+$/, "").replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "") || "plano";
const exportName = () => `comparacion_${stem(S.A.name)}_vs_${stem(S.B.name)}`;
const fmtPct = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v))).replace(".", ",") + " %";
function exportButtons() {
  const ready = !!S.result;
  $("dlPdf").disabled = !ready;
  $("dlDxf").disabled = !(ready && S.A.kind === "dxf" && S.B.kind === "dxf");
  $("dlHint").textContent = ready && $("dlDxf").disabled ? "El DXF solo se puede generar cuando A y B son DXF." : "";
}

// VialAG logo, from the header drawing VialAG supplied ("VIÑETA 4.dxf", units: cm, origin at the
// bar's lower-left corner). r: outlines (outer ring, then holes); t: the same area as triangles.
const LOGO = {
  bar: [45.12, 1.976], band: 0.222, bb: [1.598,0.572,9.611,1.621],
  box: { r: [[[7.737,0.572,1.598,0.572,1.598,1.621,7.737,1.621,7.737,0.572]]],
    t: [1.598,0.572,7.737,0.572,7.737,1.621,7.737,1.621,1.598,1.621,1.598,0.572] },
  vial: { r: [[[2.033,1.437,2.118,1.437,2.379,0.83,2.643,1.437,2.729,1.437,2.387,0.651,2.37,0.651,2.033,1.437]],[[3.841,1.437,3.92,1.437,3.92,0.651,3.841,0.651,3.841,1.437]],[[5.392,1.437,5.759,0.651,5.674,0.651,5.55,0.91,5.212,0.91,5.09,0.651,5.002,0.651,5.373,1.437,5.392,1.437],[5.382,1.27,5.248,0.986,5.516,0.986,5.382,1.27]],[[6.88,1.428,6.958,1.428,6.958,0.718,7.26,0.718,7.26,0.642,6.88,0.642,6.88,1.428]]],
    t: [2.118,1.437,2.033,1.437,2.37,0.651,2.37,0.651,2.387,0.651,2.729,1.437,2.729,1.437,2.643,1.437,2.379,0.83,2.379,0.83,2.118,1.437,2.37,0.651,2.37,0.651,2.729,1.437,2.379,0.83,3.92,1.437,3.841,1.437,3.841,0.651,3.841,0.651,3.92,0.651,3.92,1.437,5.002,0.651,5.248,0.986,5.382,1.27,5.002,0.651,5.09,0.651,5.212,0.91,5.55,0.91,5.674,0.651,5.759,0.651,5.759,0.651,5.392,1.437,5.373,1.437,5.373,1.437,5.002,0.651,5.382,1.27,5.248,0.986,5.002,0.651,5.212,0.91,5.55,0.91,5.759,0.651,5.373,1.437,5.373,1.437,5.382,1.27,5.516,0.986,5.516,0.986,5.248,0.986,5.212,0.91,5.55,0.91,5.373,1.437,5.516,0.986,5.516,0.986,5.212,0.91,5.55,0.91,6.958,1.428,6.88,1.428,6.88,0.642,6.88,0.642,7.26,0.642,7.26,0.718,6.958,0.718,6.958,1.428,6.88,0.642,6.88,0.642,7.26,0.718,6.958,0.718] },
  ag: { r: [[[8.319,1.409,8.685,0.624,8.6,0.624,8.477,0.882,8.138,0.882,8.016,0.624,7.928,0.624,8.3,1.409,8.319,1.409],[8.309,1.242,8.174,0.958,8.443,0.958,8.309,1.242]],[[9.565,1.277,9.522,1.314,9.48,1.346,9.436,1.372,9.393,1.393,9.348,1.409,9.302,1.42,9.254,1.427,9.205,1.429,9.145,1.426,9.088,1.415,9.034,1.399,8.983,1.375,8.937,1.345,8.896,1.31,8.86,1.27,8.83,1.224,8.805,1.175,8.788,1.125,8.777,1.072,8.774,1.017,8.78,0.944,8.798,0.876,8.829,0.812,8.871,0.752,8.905,0.718,8.941,0.688,8.979,0.662,9.021,0.641,9.066,0.625,9.113,0.613,9.163,0.606,9.216,0.604,9.26,0.606,9.302,0.611,9.341,0.619,9.378,0.631,9.412,0.646,9.445,0.664,9.475,0.686,9.503,0.711,9.528,0.739,9.55,0.769,9.568,0.802,9.583,0.837,9.595,0.874,9.604,0.914,9.609,0.956,9.611,1,9.272,1,9.272,0.924,9.523,0.924,9.511,0.872,9.49,0.826,9.461,0.784,9.424,0.747,9.379,0.717,9.33,0.696,9.277,0.683,9.219,0.679,9.17,0.681,9.123,0.69,9.078,0.704,9.035,0.724,8.995,0.749,8.96,0.778,8.93,0.812,8.903,0.85,8.883,0.89,8.868,0.932,8.859,0.975,8.856,1.018,8.859,1.061,8.867,1.103,8.882,1.143,8.902,1.183,8.927,1.219,8.957,1.252,8.992,1.281,9.031,1.306,9.074,1.325,9.117,1.34,9.162,1.348,9.207,1.351,9.245,1.349,9.283,1.343,9.321,1.332,9.36,1.318,9.398,1.299,9.435,1.276,9.47,1.25,9.504,1.22,9.565,1.277]]],
    t: [7.928,0.624,8.174,0.958,8.309,1.242,8.174,0.958,7.928,0.624,8.016,0.624,8.477,0.882,8.6,0.624,8.685,0.624,8.685,0.624,8.319,1.409,8.3,1.409,8.3,1.409,7.928,0.624,8.309,1.242,8.174,0.958,8.016,0.624,8.138,0.882,8.477,0.882,8.685,0.624,8.3,1.409,8.3,1.409,8.309,1.242,8.443,0.958,8.443,0.958,8.174,0.958,8.138,0.882,8.477,0.882,8.3,1.409,8.443,0.958,8.443,0.958,8.138,0.882,8.477,0.882,9.504,1.22,9.565,1.277,9.522,1.314,9.522,1.314,9.48,1.346,9.436,1.372,9.436,1.372,9.393,1.393,9.348,1.409,9.348,1.409,9.302,1.42,9.254,1.427,9.254,1.427,9.205,1.429,9.145,1.426,9.145,1.426,9.088,1.415,9.034,1.399,9.034,1.399,8.983,1.375,8.937,1.345,8.937,1.345,8.896,1.31,8.86,1.27,8.86,1.27,8.83,1.224,8.805,1.175,8.805,1.175,8.788,1.125,8.777,1.072,8.777,1.072,8.774,1.017,8.78,0.944,8.78,0.944,8.798,0.876,8.829,0.812,8.829,0.812,8.871,0.752,8.905,0.718,8.905,0.718,8.941,0.688,8.979,0.662,8.979,0.662,9.021,0.641,9.066,0.625,9.066,0.625,9.113,0.613,9.163,0.606,9.163,0.606,9.216,0.604,9.26,0.606,9.26,0.606,9.302,0.611,9.341,0.619,9.341,0.619,9.378,0.631,9.412,0.646,9.412,0.646,9.445,0.664,9.475,0.686,9.475,0.686,9.503,0.711,9.528,0.739,9.528,0.739,9.55,0.769,9.568,0.802,9.568,0.802,9.583,0.837,9.595,0.874,9.595,0.874,9.604,0.914,9.609,0.956,9.609,0.956,9.611,1,9.272,1,9.272,1,9.272,0.924,9.523,0.924,9.47,1.25,9.504,1.22,9.522,1.314,9.522,1.314,9.436,1.372,9.348,1.409,9.348,1.409,9.254,1.427,9.145,1.426,9.145,1.426,9.034,1.399,8.937,1.345,8.937,1.345,8.86,1.27,8.805,1.175,8.805,1.175,8.777,1.072,8.78,0.944,8.78,0.944,8.829,0.812,8.905,0.718,8.905,0.718,8.979,0.662,9.066,0.625,9.066,0.625,9.163,0.606,9.26,0.606,9.26,0.606,9.341,0.619,9.412,0.646,9.412,0.646,9.475,0.686,9.528,0.739,9.528,0.739,9.568,0.802,9.595,0.874,9.609,0.956,9.272,1,9.523,0.924,9.435,1.276,9.47,1.25,9.522,1.314,9.522,1.314,9.348,1.409,9.145,1.426,9.145,1.426,8.937,1.345,8.805,1.175,8.805,1.175,8.78,0.944,8.905,0.718,8.905,0.718,9.066,0.625,9.26,0.606,9.26,0.606,9.412,0.646,9.528,0.739,9.528,0.739,9.595,0.874,9.609,0.956,9.609,0.956,9.523,0.924,9.511,0.872,9.398,1.299,9.435,1.276,9.522,1.314,9.528,0.739,9.609,0.956,9.511,0.872,9.36,1.318,9.398,1.299,9.522,1.314,9.528,0.739,9.511,0.872,9.49,0.826,9.321,1.332,9.36,1.318,9.522,1.314,9.528,0.739,9.49,0.826,9.461,0.784,9.283,1.343,9.321,1.332,9.522,1.314,9.528,0.739,9.461,0.784,9.424,0.747,9.245,1.349,9.283,1.343,9.522,1.314,9.26,0.606,9.528,0.739,9.424,0.747,9.245,1.349,9.522,1.314,9.145,1.426,9.26,0.606,9.424,0.747,9.379,0.717,9.207,1.351,9.245,1.349,9.145,1.426,9.26,0.606,9.379,0.717,9.33,0.696,9.162,1.348,9.207,1.351,9.145,1.426,9.26,0.606,9.33,0.696,9.277,0.683,9.117,1.34,9.162,1.348,9.145,1.426,9.26,0.606,9.277,0.683,9.219,0.679,9.074,1.325,9.117,1.34,9.145,1.426,9.26,0.606,9.219,0.679,9.17,0.681,9.031,1.306,9.074,1.325,9.145,1.426,8.905,0.718,9.26,0.606,9.17,0.681,8.992,1.281,9.031,1.306,9.145,1.426,8.905,0.718,9.17,0.681,9.123,0.69,8.957,1.252,8.992,1.281,9.145,1.426,8.905,0.718,9.123,0.69,9.078,0.704,8.957,1.252,9.145,1.426,8.805,1.175,8.905,0.718,9.078,0.704,9.035,0.724,8.927,1.219,8.957,1.252,8.805,1.175,8.905,0.718,9.035,0.724,8.995,0.749,8.902,1.183,8.927,1.219,8.805,1.175,8.905,0.718,8.995,0.749,8.96,0.778,8.882,1.143,8.902,1.183,8.805,1.175,8.905,0.718,8.96,0.778,8.93,0.812,8.867,1.103,8.882,1.143,8.805,1.175,8.905,0.718,8.93,0.812,8.903,0.85,8.859,1.061,8.867,1.103,8.805,1.175,8.905,0.718,8.903,0.85,8.883,0.89,8.856,1.018,8.859,1.061,8.805,1.175,8.905,0.718,8.883,0.89,8.868,0.932,8.859,0.975,8.856,1.018,8.805,1.175,8.805,1.175,8.905,0.718,8.868,0.932,8.868,0.932,8.859,0.975,8.805,1.175] },
};
// date and time for the downloads, with plain spaces (the PDF fonts have no narrow spaces)
const stamp = () => new Date().toLocaleString("es-CL").replace(/[\u00a0\u202f]/g, " ");
const CREDIT = "Desarrollado por VialAG para la comparación y revisión preliminar de planos";
const SECRETO = "Si encontraste esto eres un genio y me debes un almuerzo. Atte. Felipe Borquez";
const PRIVACY = "Los archivos se procesan en tu navegador y no se suben a ningún servidor.";
// The PDF fonts only have the Windows Latin characters: others become a near equivalent or "?".
const WIN_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const pdfSafe = (s) => s.normalize("NFC").replace(/[^\x20-\x7e\xa0-\xff]/gu, (c) => WIN_EXTRA.includes(c) ? c : ({ "≥": ">=", "≤": "<=", "№": "No", "\u2009": " ", "\u202f": " " }[c] ?? "?"));
// shorten a line in the middle until it fits w (mm), so the start and the end of a file name stay
function fitWidth(doc, s, w) {
  if (doc.getTextWidth(s) <= w) return s;
  let lo = 1, hi = s.length;
  while (lo < hi) { const n = (lo + hi + 1) >> 1, k = Math.ceil(n / 2); if (doc.getTextWidth(s.slice(0, k) + "…" + s.slice(s.length - (n - k))) <= w) lo = n; else hi = n - 1; }
  const k = Math.ceil(lo / 2); return s.slice(0, k) + "…" + s.slice(s.length - (lo - k));
}
// hatch and fills a plan left out of the comparison (lone ones are compared, so they do not count)
const leftOut = (D) => D.kind === "pdf" ? (D.fills || []).filter((f) => !f.lone).length : (D.prims || []).filter((p) => p.t === "h" && !p.keep).length;
// what was left out of the comparison, for the downloads
function exportNotes() {
  const R = S.result, out = [], n = R.fontFixed;
  if (n) out.push(n === 1 ? "1 texto igual con otra fuente ignorado" : `${n} textos iguales con otra fuente ignorados`);
  if (!S.hatch && leftOut(S.A) + leftOut(S.B) > 0) out.push("hatch con contorno excluidos (los rellenos sin contorno sí se comparan)");
  if (!S.annot) out.push("elementos de anotación excluidos (ejes, cotas, textos, niveles y marcas de corte)");
  return out;
}

// The PDF's header repeats the page's: brand bar with logo, title, legend and privacy note.
function pdfHeader(doc, pw) {
  const bh = 16, brown = [97, 89, 75], light = [239, 233, 223];
  doc.setFillColor(...brown); doc.rect(0, 0, pw, bh, "F");
  doc.setFillColor(199, 189, 168); doc.rect(0, bh, pw, 1.2, "F");
  // logo, drawn as vector shapes
  const bb = LOGO.bb, lh = 7.6, k = lh / (bb[3] - bb[1]), lx = 12, ly = (bh - lh) / 2;
  const X = (u) => lx + (u - bb[0]) * k, Y = (v) => ly + (bb[3] - v) * k;
  for (const [part, col] of [[LOGO.box, [255, 255, 255]], [LOGO.vial, brown], [LOGO.ag, [255, 255, 255]]]) {
    doc.setFillColor(...col);
    for (const poly of part.r) {
      const ops = [];
      for (const r of poly) { for (let i = 0; i < r.length; i += 2) ops.push({ op: i ? "l" : "m", c: [X(r[i]), Y(r[i + 1])] }); ops.push({ op: "h" }); }
      doc.path(ops); doc.fillEvenOdd();
    }
  }
  let x = X(bb[2]) + 8;
  doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(255, 255, 255);
  doc.text("Comparador de Planos", x, bh / 2, { baseline: "middle" });
  x += doc.getTextWidth("Comparador de Planos");
  // legend pill: centered on the page when there is room, else right after the title
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
  const sw = 6, gap = 2.2, tws = LEGEND.map(([, t]) => doc.getTextWidth(t));
  const lw = 10 + tws.reduce((a, t) => a + sw + gap + t, 0) + 6 * (LEGEND.length - 1), lht = 7;
  const px = Math.max(pw / 2 - lw / 2, x + 8), py = bh / 2 - lht / 2;
  doc.setFillColor(255, 255, 255); doc.roundedRect(px, py, lw, lht, lht / 2, lht / 2, "F");
  let cx = px + 5; doc.setLineWidth(1.1); doc.setLineCap("round");
  doc.setTextColor(61, 54, 44);
  LEGEND.forEach(([c, t], i) => {
    doc.setDrawColor(...c); doc.line(cx + 0.5, bh / 2, cx + sw - 0.5, bh / 2); cx += sw + gap;
    doc.text(t, cx, bh / 2, { baseline: "middle" }); cx += tws[i] + 6;
  });
  doc.setLineCap("butt");
  // privacy note on the right, in up to two lines (smaller on a narrow page, three lines at most)
  doc.setTextColor(...light);
  const room = pw - 10 - (px + lw + 8);
  if (room > 30) {
    let fs = 8.5, lines;
    for (fs of [8.5, 7.5, 7]) { doc.setFontSize(fs); lines = doc.getTextWidth(PRIVACY) <= room ? [PRIVACY] : doc.splitTextToSize(PRIVACY, room); if (lines.length <= 2) break; }
    const lh2 = fs * 0.42, y0 = bh / 2 - (lines.length - 1) * lh2 / 2;
    lines.forEach((t, i) => doc.text(t, pw - 10, y0 + i * lh2, { baseline: "middle", align: "right" }));
  }
  return bh + 1.2;
}

async function exportPdf() {
  if (!S.result || exporting || S.running) return;
  if (!window.jspdf) { setStatus("No se pudo cargar el generador de PDF. Revisa tu conexión y recarga la página."); return; }
  setExporting(true); cancelRenders(); detailId++;
  setBusy("Preparando PDF…"); await new Promise((r) => setTimeout(r, 30));
  try {
    const { W, H } = S.frame, R = S.result;
    const doc = new window.jspdf.jsPDF({ orientation: W >= H ? "landscape" : "portrait", unit: "mm", format: "a3", compress: true });
    const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight(), mg = 12;
    const ink = [24, 33, 43], muted = [91, 102, 114];
    let y = pdfHeader(doc, pw) + 13;
    // summary: approximate change, date, files and what was left out
    doc.setFont("helvetica", "bold"); doc.setFontSize(28); doc.setTextColor(...COL_DIFF);
    const pct = fmtPct(R.pct); doc.text(pct, mg, y);
    const x = mg + doc.getTextWidth(pct) + 4;
    doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(...ink); doc.text("Cambios aproximados", x, y - 1);
    doc.setFontSize(9); doc.setTextColor(...muted);
    doc.text(stamp(), pw - mg, y - 1, { align: "right" });
    const aw0 = pw - 2 * mg, a = pdfSafe(`A: ${S.A.name}`), b = pdfSafe(`B: ${S.B.name}`);
    y += 6.5;
    if (doc.getTextWidth(a + "     " + b) <= aw0) doc.text(a + "     " + b, mg, y);
    else { doc.text(fitWidth(doc, a, aw0), mg, y); y += 4.6; doc.text(fitWidth(doc, b, aw0), mg, y); }
    const notes = exportNotes();
    if (notes.length) { y += 4.6; doc.text(fitWidth(doc, notes.join("  ·  "), aw0), mg, y); }
    y += 5;
    // the whole comparison, redrawn from the plans at a higher resolution than the screen, tile by tile
    const aw = pw - 2 * mg, ah = ph - y - 14, s = Math.min(aw / W, ah / H), w = W * s, h = H * s, x0 = (pw - w) / 2;
    await pdfComparison(doc, x0, y, s, W, H);
    doc.setDrawColor(...COL_MATCH); doc.setLineWidth(0.2); doc.rect(x0, y, w, h);
    doc.setFontSize(8); doc.setTextColor(150, 145, 136); doc.text(CREDIT, pw / 2, ph - 6.5, { align: "center" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(4); doc.setTextColor(255, 255, 255); doc.text(pdfSafe(SECRETO), pw - 3, ph - 2.5, { align: "right" }); // hidden signature, white on white
    await offerFile(exportName() + ".pdf", doc.output("blob"));
  } catch (e) { console.error(e); setStatus("No se pudo generar el PDF: " + (e.message || e)); }
  finally { setExporting(false); setBusy(null); scheduleDetail(); } // the export stopped any sharp detail being drawn
}

// Draw the comparison into the PDF at x0,y (mm), s mm per frame px. Each tile is compared with a margin,
// so a line near its edge still finds its match in the neighbouring tile, and the margin is cut off.
async function pdfComparison(doc, x0, y0, s, W, H) {
  const z = Math.max(1, PDF_RES / Math.max(W, H)), step = PDF_TILE / z, pad = TOL + 4;
  const nx = Math.ceil(W / step), ny = Math.ceil(H / step);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    setBusy(`Preparando PDF… ${j * nx + i + 1} / ${nx * ny}`);
    await new Promise((res) => setTimeout(res, 20)); // let the counter show and the page breathe between tiles
    const r = [i * step, j * step, Math.min(W, (i + 1) * step), Math.min(H, (j + 1) * step)];
    const rr = [Math.max(0, r[0] - pad), Math.max(0, r[1] - pad), Math.min(W, r[2] + pad), Math.min(H, r[3] + pad)];
    const big = await renderRegion(rr, z, "diff", 1);
    const tw = Math.round((r[2] - r[0]) * z), th = Math.round((r[3] - r[1]) * z);
    const t = document.createElement("canvas"); t.width = tw; t.height = th;
    t.getContext("2d").drawImage(big, Math.round((r[0] - rr[0]) * z), Math.round((r[1] - rr[1]) * z), tw, th, 0, 0, tw, th);
    doc.addImage(t, "PNG", x0 + r[0] * s, y0 + r[1] * s, (r[2] - r[0]) * s, (r[3] - r[1]) * s, undefined, "FAST");
    big.width = big.height = t.width = t.height = 0; // free the memory before the next tile
  }
}

// Header of the downloaded DXF, like the page's: brand bar with logo, title, legend and privacy note,
// then the result and the files, above the plan; the credit below it. ext: the plan's box in A's units.
// Drawn in the bar's own units (cm in VialAG's header drawing) scaled to the plan's width.
// Colors are AutoCAD color numbers (DXF R12 has no true colors): 251 brand brown as in VialAG's
// drawing, 9 light beige, 255 white, 8 and 1 the gray and red of the comparison layers (what only A has is gray too).
function dxfHeader(ext, { num, enc, cut, pct, notes }) {
  const [ex0, ey0, ex1, ey1] = ext, s = (ex1 - ex0) / LOGO.bar[0], out = [], L = "ENCABEZADO";
  const yNotes = ey1 + 1.0 * s, yFiles = ey1 + (notes.length ? 1.55 : 1.0) * s, yPct = yFiles + 0.85 * s, yb = yPct + 0.95 * s;
  const P = (u, v) => [num(ex0 + u * s), num(yb + v * s)];
  const xyz = (i, [x, y]) => `\n1${i}\n${x}\n2${i}\n${y}\n3${i}\n0`;
  const solid = (c, a, b, d, e = d) => out.push(`0\nSOLID\n8\n${L}\n62\n${c}` + xyz(0, a) + xyz(1, b) + xyz(2, d) + xyz(3, e));
  const rect = (c, [u0, v0, u1, v1]) => solid(c, P(u0, v0), P(u1, v0), P(u0, v1), P(u1, v1));
  const tris = (c, t) => { for (let i = 0; i < t.length; i += 6) solid(c, P(t[i], t[i + 1]), P(t[i + 2], t[i + 3]), P(t[i + 4], t[i + 5])); };
  // text in world units: ha 0 left, 1 center, 2 right; va 0 baseline, 2 middle
  const textW = (c, style, str, [x, y], h, ha = 0, va = 0) => out.push(`0\nTEXT\n8\n${L}\n62\n${c}\n10\n${x}\n20\n${y}\n30\n0\n40\n${num(h)}\n1\n${enc(str)}\n7\n${style}` +
    (ha || va ? `\n72\n${ha}\n73\n${va}\n11\n${x}\n21\n${y}\n31\n0` : ""));
  const text = (c, style, str, u, v, h, ha, va) => textW(c, style, str, P(u, v), h * s, ha, va);
  // bar
  rect(9, [0, 0, LOGO.bar[0], LOGO.band]);
  rect(251, [0, LOGO.band, LOGO.bar[0], LOGO.bar[1]]);
  tris(255, LOGO.box.t); tris(251, LOGO.vial.t); tris(255, LOGO.ag.t);
  const mid = (LOGO.band + LOGO.bar[1]) / 2;
  text(255, "VIALAG_NEGRITA", "Comparador de Planos", 10.8, mid, 0.46, 0, 2);
  // legend pill (white, round ends) with the comparison's own colors
  const pl = [21.551, 0.642, 28.25, 1.538], r = (pl[3] - pl[1]) / 2, ring = [];
  for (let i = 0; i <= 12; i++) { const a = -Math.PI / 2 + Math.PI * i / 12; ring.push([pl[2] - r + r * Math.cos(a), mid + r * Math.sin(a)]); }
  for (let i = 0; i <= 12; i++) { const a = Math.PI / 2 + Math.PI * i / 12; ring.push([pl[0] + r + r * Math.cos(a), mid + r * Math.sin(a)]); }
  const cx = (pl[0] + pl[2]) / 2;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; solid(255, P(cx, mid), P(a[0], a[1]), P(b[0], b[1])); }
  rect(8, [21.983, mid - 0.053, 22.554, mid + 0.053]); text(250, "VIALAG", "Coincide", 22.845, mid, 0.27, 0, 2);
  rect(1, [25.066, mid - 0.053, 25.637, mid + 0.053]); text(250, "VIALAG", "Diferencia", 25.909, mid, 0.27, 0, 2);
  text(9, "VIALAG", PRIVACY, 43.528, mid, 0.25, 2, 2);
  // result, files and notes between the bar and the plan
  pct = fmtPct(pct);
  textW(1, "VIALAG_NEGRITA", pct, [num(ex0), num(yPct)], 0.6 * s);
  textW(8, "VIALAG", "Cambios aproximados", [num(ex0 + (pct.length * 0.48 + 0.4) * s), num(yPct)], 0.34 * s);
  textW(8, "VIALAG", stamp(), [num(ex1), num(yPct)], 0.28 * s, 2, 0);
  textW(8, "VIALAG", `${cut("A: " + S.A.name, 120)}     ${cut("B: " + S.B.name, 120)}`, [num(ex0), num(yFiles)], 0.28 * s); // R12 texts hold 255 characters
  if (notes.length) textW(8, "VIALAG", notes.join("  ·  "), [num(ex0), num(yNotes)], 0.28 * s);
  textW(8, "VIALAG", CREDIT, [num((ex0 + ex1) / 2), num(ey0 - 1.0 * s)], 0.28 * s, 1, 0);
  return out;
}

// DXF in A's coordinates and units. The comparison is made on the image, so every line is
// sampled along its length and cut where it changes between "coincide" and "cambio".
async function exportDxf() {
  if (!S.result || exporting || S.running || S.A.kind !== "dxf" || S.B.kind !== "dxf") return;
  if (!window.JSZip) { setStatus("No se pudo cargar el compresor ZIP. Revisa tu conexión y recarga la página."); return; }
  setExporting(true); setBusy("Preparando DXF…"); await new Promise((r) => setTimeout(r, 30));
  try {
    const { W, H } = S.frame, R = S.result, M = S.xf.m, A = S.A, B = S.B, hatch = S.hatch, notes = exportNotes();
    const toFrameA = (x, y) => [(x - A.bb[0]) * A.k + A.pad, (A.bb[3] - y) * A.k + A.pad];
    const toFrameB = (x, y) => apply(M, (x - B.bb[0]) * B.k + B.pad, (B.bb[3] - y) * B.k + B.pad);
    const toWorldA = (fx, fy) => [((fx - A.pad) / A.k + A.bb[0]) / A.f, (A.bb[3] - (fy - A.pad) / A.k) / A.f];
    const near = (mask, fx, fy) => { let n = 0; const x0 = Math.round(fx), y0 = Math.round(fy); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = x0 + dx, y = y0 + dy; if (x >= 0 && y >= 0 && x < W && y < H) n += mask[y * W + x]; } return n; };
    const ents = [], num = (v) => (Math.round(v * 1e4) / 1e4).toString();
    // non-ASCII as \U+XXXX (characters beyond U+FFFF have no such code: "?")
    const enc = (t) => t.normalize("NFC").replace(/[^\x20-\x7e]/gu, (c) => { const v = c.codePointAt(0); return v > 0xffff ? "?" : "\\U+" + v.toString(16).toUpperCase().padStart(4, "0"); });
    // shorten a text in the middle until it takes at most max characters once encoded
    const cut = (t, max = 250) => {
      if (enc(t).length <= max) return t;
      const c = [...t.normalize("NFC")]; let n = c.length, r = t;
      while (n > 0 && enc(r).length > max) { n--; const h = Math.ceil(n / 2); r = c.slice(0, h).join("") + "..." + c.slice(c.length - (n - h)).join(""); }
      return r;
    };
    const inFrame = (fx, fy) => fx >= 0 && fy >= 0 && fx <= W && fy <= H;
    const pline = (layer, pts) => {
      if (pts.length < 2) return;
      if (pts.length === 2) { ents.push(`0\nLINE\n8\n${layer}\n10\n${num(pts[0][0])}\n20\n${num(pts[0][1])}\n30\n0\n11\n${num(pts[1][0])}\n21\n${num(pts[1][1])}\n31\n0`); return; }
      let t = `0\nPOLYLINE\n8\n${layer}\n66\n1\n70\n0\n10\n0\n20\n0\n30\n0`;
      for (const p of pts) t += `\n0\nVERTEX\n8\n${layer}\n10\n${num(p[0])}\n20\n${num(p[1])}\n30\n0`;
      ents.push(t + `\n0\nSEQEND\n8\n${layer}`);
    };
    // split one primitive into runs of "changed" / "same", in world units of A. Only what lies in the
    // compared area is written, as on the page (a B drawn beyond A's sheet was not compared there).
    const runs = (pts, toFrame, chg, keepSame, layerChg) => {
      let cur = null, curCls = null; const flush = () => { if (cur && cur.length > 1) { if (curCls) pline(layerChg, cur); else if (keepSame) pline("COINCIDE", cur); } };
      for (let i = 0; i < pts.length - 1; i++) {
        const p = toFrame(pts[i][0], pts[i][1]), q = toFrame(pts[i + 1][0], pts[i + 1][1]);
        const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 1.5));
        for (let j = i === 0 ? 0 : 1; j <= n; j++) {
          const fx = p[0] + (q[0] - p[0]) * j / n, fy = p[1] + (q[1] - p[1]) * j / n;
          if (!inFrame(fx, fy)) { flush(); cur = null; curCls = null; continue; }
          const c = near(chg, fx, fy), s = near(R.com, fx, fy);
          const cls = c > s ? true : s > 0 ? false : curCls ?? false;
          // keep the vertices and the points where the class switches; a switch point ends one run and starts the next
          if (!cur) { cur = [toWorldA(fx, fy)]; curCls = cls; }
          else if (cls === curCls) { if (j === n) cur.push(toWorldA(fx, fy)); }
          else { const w = toWorldA(fx, fy); cur.push(w); flush(); cur = [w]; curCls = cls; }
        }
      }
      flush();
    };
    const textEnt = (layer, D, p, toFrame) => {
      const lines = p.s.split("\n");
      const [fx, fy] = toFrame(p.p[0], p.p[1]); const [wx, wy] = toWorldA(fx, fy);
      const hh = p.h * D.k * scaleOf(D === A ? I : M) / A.k / A.f; // height in A's units
      const rot = (p.rot - (D === A ? 0 : Math.atan2(M[1], M[0]))) * 180 / Math.PI;
      // MTEXT lines hang from their attachment point (top, middle or bottom), one line every 1.4 heights,
      // as the page draws them; each line is a TEXT aligned by its top
      const lh = hh * 1.4, y0 = !p.multi ? 0 : p.va === 3 ? 0 : p.va === 2 ? -lh * lines.length / 2 : -lh * lines.length;
      lines.forEach((s, i) => {
        if (!s.trim()) return;
        const oy = -(y0 + i * lh), x = wx - oy * Math.sin(rot * Math.PI / 180), y = wy + oy * Math.cos(rot * Math.PI / 180);
        const ha = p.ha || 0, va = p.multi ? 3 : p.va || 0, al = ha || va;
        ents.push(`0\nTEXT\n8\n${layer}\n10\n${num(x)}\n20\n${num(y)}\n30\n0\n40\n${num(hh)}\n1\n${enc(cut(s))}\n50\n${num(rot)}` + (al ? `\n72\n${ha}\n73\n${va}\n11\n${num(x)}\n21\n${num(y)}\n31\n0` : ""));
      });
    };
    // Texts: one at the same place in A and B (same height and angle) is unchanged when it says the
    // same thing and changed when it does not ("REV 0" -> "REV 1"), however few pixels that moves.
    // The others are judged by how much of their drawn letters is red.
    const txt = (D, toFrame) => D.prims.filter((p) => p.t === "x").map((p) => {
      const [x, y] = toFrame(p.p[0], p.p[1]);
      return { p, x, y, h: p.h * D.k * (D === A ? 1 : scaleOf(M)), r: p.rot - (D === A ? 0 : Math.atan2(M[1], M[0])), key: p.s.toLowerCase().replace(/\s+/g, "") };
    });
    const tA = txt(A, toFrameA), tB = txt(B, toFrameB), verdict = new Map();
    const cell = Math.max(32, ...tA.map((t) => t.h * 0.6 + 2)), grid = new Map(), gk = (x, y) => Math.floor(x / cell) + "," + Math.floor(y / cell);
    for (const t of tB) { const g = gk(t.x, t.y); if (!grid.has(g)) grid.set(g, []); grid.get(g).push(t); }
    for (const same of [true, false]) for (const a of tA) {
      if (verdict.has(a.p)) continue;
      const gx = Math.floor(a.x / cell), gy = Math.floor(a.y / cell);
      let best = null, bd = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const b of grid.get(gx + dx + "," + (gy + dy)) || []) {
        if (verdict.has(b.p) || (b.key === a.key) !== same || b.h / a.h > 1.33 || a.h / b.h > 1.33 || Math.abs(Math.sin(b.r - a.r)) > 0.05 || Math.cos(b.r - a.r) < 0) continue;
        const d = Math.hypot(b.x - a.x, b.y - a.y); if (d < 0.6 * a.h + 2 && d < bd) { bd = d; best = b; }
      }
      if (best) { verdict.set(a.p, !same); verdict.set(best.p, !same); }
    }
    // letter boxes the page drew for each text (plan px), in frame px
    const boxes = new Map();
    for (const [D, m] of [[A, I], [B, M]]) for (const t of D.text || []) if (t.p) {
      const c = t.c.map((q) => apply(m, q[0], q[1])), b = [Math.min(...c.map((q) => q[0])), Math.min(...c.map((q) => q[1])), Math.max(...c.map((q) => q[0])), Math.max(...c.map((q) => q[1]))];
      if (!boxes.has(t.p)) boxes.set(t.p, []); boxes.get(t.p).push(b);
    }
    const textChanged = (p, chg) => {
      if (verdict.has(p)) return verdict.get(p);
      let c = 0, s = 0;
      for (const b of boxes.get(p) || []) {
        for (let y = Math.max(0, Math.floor(b[1])); y < Math.min(H, Math.ceil(b[3])); y++)
          for (let x = Math.max(0, Math.floor(b[0])); x < Math.min(W, Math.ceil(b[2])); x++) { c += chg[y * W + x]; s += R.com[y * W + x]; }
      }
      return c > s * 0.5 && c > 3;
    };
    let k = 0;
    for (const [D, toFrame, chg, layer, keepSame] of [[A, toFrameA, R.rem, "ELIMINADO_A", false], [B, toFrameB, R.add, "AGREGADO_B", true]]) {
      for (const p of D.prims) {
        if (!shown(p) || (!hatch && p.hl)) { /* left out by a switch */ }
        else if (p.t === "h") { if (hatch || p.keep) for (const L of p.loops) runs([...L, L[0]], toFrame, chg, keepSame, layer); }
        else if (p.t === "p") runs(p.pts, toFrame, chg, keepSame, layer);
        else if (!inFrame(...toFrame(p.p[0], p.p[1]))) { /* outside the compared area */ }
        else if (textChanged(p, chg)) textEnt(layer, D, p, toFrame);
        else if (keepSame) textEnt("COINCIDE", D, p, toFrame);
        if (++k % 4000 === 0) { setBusy(`Preparando DXF… ${Math.round(k / (A.prims.length + B.prims.length) * 100)} %`); await new Promise((r) => setTimeout(r, 0)); }
      }
    }
    // the page's header above the plan and the credit below it, as wide as the comparison
    const tl = toWorldA(0, 0), br = toWorldA(W, H);
    ents.push(...dxfHeader([tl[0], br[1], br[0], tl[1]], { num, enc, cut, pct: R.pct, notes }));
    const layers = [["COINCIDE", 8], ["ELIMINADO_A", 8], ["AGREGADO_B", 1], ["ENCABEZADO", 7]];
    const styles = [["STANDARD", "txt"], ["VIALAG", "arial.ttf"], ["VIALAG_NEGRITA", "arialbd.ttf"]];
    // R12 has no units variable: say in a comment which units the coordinates are in (A's)
    const uName = { 1: "pulgadas", 2: "pies", 4: "milimetros", 5: "centimetros", 6: "metros", 7: "kilometros", 9: "micropulgadas", 10: "yardas", 14: "decimetros" }[A.dxf.header && A.dxf.header["$INSUNITS"]] || "las mismas del plano A (sin unidades declaradas)";
    const head = ["999", "Comparacion de planos VialAG. Coordenadas del plano A. Unidades: " + uName,
      "0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "0", "ENDSEC",
      "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LTYPE", "70", "1", "0", "LTYPE", "2", "CONTINUOUS", "70", "0", "3", "Solid line", "72", "65", "73", "0", "40", "0.0", "0", "ENDTAB",
      "0", "TABLE", "2", "LAYER", "70", String(layers.length),
      ...layers.flatMap(([n, c]) => ["0", "LAYER", "2", n, "70", "0", "62", String(c), "6", "CONTINUOUS"]),
      "0", "ENDTAB", "0", "TABLE", "2", "STYLE", "70", String(styles.length),
      ...styles.flatMap(([n, f]) => ["0", "STYLE", "2", n, "70", "0", "40", "0.0", "41", "1.0", "50", "0.0", "71", "0", "42", "2.5", "3", f, "4", ""]),
      "0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"].join("\n");
    const dxfText = head + "\n" + ents.join("\n") + "\n0\nENDSEC\n0\nEOF\n";
    // the .dxf itself; where the viewer does not accept .dxf files (the Claude page), inside a .zip
    await offerFile(exportName() + ".dxf", new Blob([dxfText], { type: "application/dxf" }), async () => {
      setBusy("Comprimiendo DXF…");
      const zip = new window.JSZip();
      zip.file(exportName() + ".dxf", dxfText);
      return [exportName() + "_dxf.zip", await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } })];
    });
  } catch (e) { console.error(e); setStatus("No se pudo generar el DXF: " + (e.message || e)); }
  finally { setExporting(false); setBusy(null); }
}
$("dlPdf").onclick = exportPdf;
$("dlDxf").onclick = exportDxf;

// ---------- pipeline ----------
let runId = 0;
// Letters drawn in a plan, in frame pixels. null when the plan has texts but none were drawn as
// letters (for example text made of lines): then no typeface change is ignored.
function glyphs(c, D) {
  const { W, H } = S.frame, g = inkMask(c, W, H);
  return D.lines.length && !g.includes(1) ? null : g;
}
// While a comparison runs, the downloads and the alignment dialog wait for it.
function setRunning(on) {
  S.running = on;
  if (on) $("dlPdf").disabled = $("dlDxf").disabled = $("alignBtn").disabled = true;
  else { exportButtons(); $("alignBtn").disabled = false; }
}
async function run({ rerender = false, realign = false, keepAlign = false } = {}) {
  if (!S.A || !S.B) { if (S.A || S.B) setStatus("Falta cargar el plano " + (S.A ? "B" : "A") + "."); return; }
  const id = ++runId;
  cancelRenders(); detailId++; clearDetail();
  setBusy("Comparando…"); setRunning(true);
  if (rerender) S.stale = true; // a run that is replaced before drawing leaves the redraw to the next one
  await new Promise((r) => setTimeout(r, 30));
  try {
    let full = null; // whole plans (texts and axes drawn), for the automatic alignment when a switch leaves them out
    if (S.stale || !S.rasterA) {
      if (!S.annot && (realign || !S.xf || (S.xf.mode === "auto" && !keepAlign))) {
        full = await rasterize(true);
        if (id !== runId) return;
      }
      const [a, b] = await rasterize();
      if (id !== runId) return;
      S.rasterA = a; S.rasterB = b; S.stale = false;
      S.frame = { W: Math.max(a.width, b.width), H: Math.max(a.height, b.height) };
      S.maskA = inkMask(padTo(a, S.frame.W, S.frame.H), S.frame.W, S.frame.H);
      S.glyphA = glyphs(padTo(a.text, S.frame.W, S.frame.H), S.A); a.text = null;
      realign = realign || !S.xf || (S.xf.mode === "auto" && !keepAlign) || S.xf.res !== S.frame.W;
    }
    if (realign) { const [ra, rb] = full || [S.rasterA, S.rasterB]; S.autoXf = autoAlign(ra, rb, S.frame.W, S.frame.H); S.xf = { mode: "auto", m: S.autoXf.slice(), res: S.frame.W }; }
    if (!(await reconcileFills(id))) return;
    S.bWarp = warp(S.rasterB, S.xf.m, S.frame.W, S.frame.H);
    S.glyphB = glyphs(warp(S.rasterB.text, S.xf.m, S.frame.W, S.frame.H), S.B);
    compare();
    $("empty").hidden = true;
  } catch (e) {
    // a run replaced by a newer one (a switch, another file) ends quietly
    if (id !== runId || (e && e.name === "RenderingCancelledException")) return;
    console.error(e); setStatus(e.message || String(e));
    showError("No se pudo comparar: " + (e.message || e));
  } finally { if (id === runId) { setBusy(null); setRunning(false); } }
}

// ---------- viewer ----------
class Viewer {
  constructor(el, opts = {}) {
    this.el = el; this.opts = opts; this.s = 1; this.tx = 0; this.ty = 0; this.c = null; this.marks = [];
    this.content = document.createElement("div"); this.content.className = "content"; this.content.hidden = true; el.appendChild(this.content);
    this.mlayer = document.createElement("div"); this.mlayer.className = "markers"; el.appendChild(this.mlayer);
    this.sel = document.createElement("div"); this.sel.className = "selrect"; this.sel.hidden = true; el.appendChild(this.sel);
    this.mode = "pan";
    el.addEventListener("wheel", (e) => { e.preventDefault(); const r = el.getBoundingClientRect(); this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    const pts = new Map(); let down = null, pinch = null;
    el.addEventListener("pointerdown", (e) => {
      if (!this.c || e.target.closest(".errorview, .empty")) return; // buttons on the loica screens get their own clicks
      el.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) { const [p, q] = [...pts.values()]; pinch = { d: Math.hypot(p[0] - q[0], p[1] - q[1]) }; down = null; this.sel.hidden = true; return; }
      down = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false }; if (this.mode === "pan") el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && pts.size === 2) {
        const [p, q] = [...pts.values()], d = Math.hypot(p[0] - q[0], p[1] - q[1]), r = el.getBoundingClientRect();
        this.zoomAt((p[0] + q[0]) / 2 - r.left, (p[1] + q[1]) / 2 - r.top, d / pinch.d); pinch.d = d; return;
      }
      if (!down) return; const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.hypot(dx, dy) > 4) down.moved = true;
      if (this.mode === "rect") {
        const r = el.getBoundingClientRect();
        Object.assign(this.sel.style, { left: Math.min(down.x, e.clientX) - r.left + "px", top: Math.min(down.y, e.clientY) - r.top + "px", width: Math.abs(dx) + "px", height: Math.abs(dy) + "px" });
        this.sel.hidden = false;
      } else { this.tx = down.tx + dx; this.ty = down.ty + dy; if (down.moved) this.touched = true; this.apply(); }
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pinch) { if (pts.size < 2) pinch = null; return; }
      if (!down) return; el.classList.remove("dragging"); this.sel.hidden = true;
      if (this.mode === "rect" && down.moved && this.opts.onRect) {
        const a = this.toFrame(down.x, down.y), b = this.toFrame(e.clientX, e.clientY);
        this.opts.onRect([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
      } else if (!down.moved && this.opts.onClick) this.opts.onClick(this.toFrame(e.clientX, e.clientY));
      down = null;
    };
    el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    new ResizeObserver(() => { if (this.c && !this.touched) this.fit(); else this.apply(); }).observe(el);
  }
  setCanvas(c) {
    const same = this.c && this.c.width === c.width && this.c.height === c.height;
    if (this.c !== c) { if (this.c) this.c.remove(); this.content.prepend(c); this.c = c; }
    this.content.style.width = c.width + "px"; this.content.style.height = c.height + "px";
    this.content.hidden = false;
    if (!same) this.fit(); else this.apply();
  }
  fit() {
    if (!this.c) return; const w = this.el.clientWidth, h = this.el.clientHeight - (this.opts.padBottom || 0); // keep clear of the credit line
    this.s = Math.min(w / this.c.width, h / this.c.height) * 0.94; this.tx = (w - this.c.width * this.s) / 2; this.ty = (h - this.c.height * this.s) / 2; this.touched = false; this.apply();
  }
  zoomAt(x, y, f) { const ns = Math.min(MAX_ZOOM, Math.max(0.03, this.s * f)); f = ns / this.s; this.tx = x - (x - this.tx) * f; this.ty = y - (y - this.ty) * f; this.s = ns; this.touched = true; this.apply(); }
  zoomTo(x, y, w, h) {
    const vw = this.el.clientWidth, vh = this.el.clientHeight, m = Math.max(w, h) * 0.6 + 40;
    this.s = Math.min(MAX_ZOOM, Math.min(vw / (w + 2 * m), vh / (h + 2 * m))); this.tx = vw / 2 - (x + w / 2) * this.s; this.ty = vh / 2 - (y + h / 2) * this.s; this.touched = true; this.apply();
  }
  toFrame(cx, cy) { const r = this.el.getBoundingClientRect(); return [(cx - r.left - this.tx) / this.s, (cy - r.top - this.ty) / this.s]; }
  // Smaller copies for seeing the whole plan (see pyramid()); the coarsest that still has a pixel per
  // screen pixel is shown over the full image.
  setLevels(levels) {
    for (const l of this.levels || []) l.c.remove();
    this.levels = levels; for (const l of levels) { l.c.className = "lvl"; this.content.appendChild(l.c); }
    this.apply();
  }
  apply() {
    this.content.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.s})`;
    if (this.c) this.c.style.imageRendering = this.s > 2 ? "pixelated" : "auto";
    if (this.levels) { const z = this.s * DPR(); let use = null; for (const l of this.levels) if (z * l.f <= 1.2) use = l; for (const l of this.levels) l.c.style.visibility = l === use ? "visible" : "hidden"; }
    this.mlayer.innerHTML = "";
    for (const m of this.marks) { const d = document.createElement("div"); d.className = "mk"; d.textContent = m.label; d.style.left = this.tx + m.x * this.s + "px"; d.style.top = this.ty + m.y * this.s + "px"; this.mlayer.appendChild(d); }
    if (this.opts.onView) this.opts.onView();
  }
}

const main = new Viewer($("vp"), {
  padBottom: 28,
  onView: () => scheduleDetail(),
});

// ---------- controls ----------
function setStatus(t) { $("status").textContent = $("status").title = t || ""; }
let busyEl = null;
// the red notice with the red loica on it stands alone: the welcome or error loica behind it is hidden
function setBusy(t) {
  if (t) { if (!busyEl) { busyEl = document.createElement("div"); busyEl.className = "busy"; busyEl.innerHTML = "<div></div>"; $("vp").appendChild(busyEl); } busyEl.firstChild.textContent = t; }
  else if (busyEl) { busyEl.remove(); busyEl = null; }
  $("vp").classList.toggle("is-busy", !!t);
}
function setView(v) { S.view = v; document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === v)); if (S.result) { detailId++; clearDetail(); paint(); } }
document.querySelectorAll("[data-view]").forEach((b) => b.onclick = () => setView(b.dataset.view));
$("zIn").onclick = () => main.zoomAt(main.el.clientWidth / 2, main.el.clientHeight / 2, 1.6);
$("zOut").onclick = () => main.zoomAt(main.el.clientWidth / 2, main.el.clientHeight / 2, 1 / 1.6);
$("zFit").onclick = () => main.fit();
$("nmShow").onclick = () => { S.forceShow = true; clearError(); };
$("nmAlign").onclick = () => { clearError(); openManual(); };
// on the No match screen, the link stops the countdown like the screen's own button
$("alignBtn").onclick = () => { if (errKind === "nomatch") clearError(); openManual(); };
// Switches: Hatchs and Elementos de anotación, both on by default (Hatchs off leaves out only the hatch and
// fills with lines along their edge). Switching one redraws both plans and keeps the current alignment,
// also while a comparison is still running.
for (const [id, key] of [["hatchBtn", "hatch"], ["annotBtn", "annot"]]) $(id).onclick = () => {
  if (exporting) return;
  S[key] = !S[key]; $(id).setAttribute("aria-checked", S[key]);
  if (S.A && S.B) run({ rerender: true, keepAlign: true });
};

// Half-size copies of a plan, down to a few hundred pixels. Each pixel keeps the darkest pixel of the
// block it stands for, so thin lines (the axes to click) do not vanish when the plan is shown whole.
function pyramid(c) {
  if (c._levels) return c._levels;
  let w = c.width, h = c.height, d = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data, f = 1;
  const out = [], lum = (a, j) => 0.299 * a[j] + 0.587 * a[j + 1] + 0.114 * a[j + 2];
  while (Math.max(w, h) > 400) {
    const w2 = Math.ceil(w / 2), h2 = Math.ceil(h / 2), cv = document.createElement("canvas"); cv.width = w2; cv.height = h2;
    const x2 = cv.getContext("2d", { willReadFrequently: true }), img = x2.createImageData(w2, h2), o = img.data;
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      let best = -1, bl = Infinity;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const xx = 2 * x + dx, yy = 2 * y + dy; if (xx < w && yy < h) { const j = (yy * w + xx) * 4, l = lum(d, j); if (l < bl) { bl = l; best = j; } } }
      const k = (y * w2 + x) * 4; o[k] = d[best]; o[k + 1] = d[best + 1]; o[k + 2] = d[best + 2]; o[k + 3] = 255;
    }
    x2.putImageData(img, 0, 0); f *= 2; out.push({ f, c: cv }); w = w2; h = h2; d = o;
  }
  return (c._levels = out);
}

// ---------- manual alignment dialog ----------
const pick = { A: [], B: [] };
const vA = new Viewer($("vpA"), { onClick: (p) => addPick("A", snapCorner(S.rasterA, p, SNAP_PX / vA.s)) });
const vB = new Viewer($("vpB"), { onClick: (p) => addPick("B", snapCorner(S.rasterB, p, SNAP_PX / vB.s)) });
function addPick(k, p) { if (pick[k].length >= 2) return; pick[k].push(p); refreshPicks(); }
// A click snaps to the nearest corner or crossing of lines within SNAP_PX screen pixels (Harris corner
// response on the plan's raster), so both plans get the very same point even when picked zoomed out.
// With no corner in reach the click stays where it was.
const SNAP_PX = 14;
function snapCorner(c, p, r) {
  if (!c) return p;
  r = Math.max(2, Math.min(80, r));
  const x0 = Math.max(0, Math.floor(p[0] - r) - 3), y0 = Math.max(0, Math.floor(p[1] - r) - 3);
  const x1 = Math.min(c.width, Math.ceil(p[0] + r) + 4), y1 = Math.min(c.height, Math.ceil(p[1] + r) + 4), w = x1 - x0, h = y1 - y0;
  if (w < 9 || h < 9) return p;
  const d = c.getContext("2d", { willReadFrequently: true }).getImageData(x0, y0, w, h).data, g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 1 - (0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]) / 255;
  const xx = new Float32Array(w * h), yy = new Float32Array(w * h), xy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, gx = (g[i + 1] - g[i - 1]) / 2, gy = (g[i + w] - g[i - w]) / 2;
    xx[i] = gx * gx; yy[i] = gy * gy; xy[i] = gx * gy;
  }
  let best = null, bestV = 0;
  const s2 = 2 * (r / 1.5) ** 2;
  for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
    const dx = x0 + x + 0.5 - p[0], dy = y0 + y + 0.5 - p[1], dd = dx * dx + dy * dy;
    if (dd > r * r) continue;
    let a = 0, b = 0, cc = 0;
    for (let v = -2; v <= 2; v++) for (let u = -2; u <= 2; u++) { const j = (y + v) * w + x + u; a += xx[j]; b += yy[j]; cc += xy[j]; }
    const R = a * b - cc * cc - 0.04 * (a + b) ** 2;
    if (R < 0.02) continue; // an ideal crossing of two thin lines gives about 0.1
    const v = R * Math.exp(-dd / s2);
    if (v > bestV) { bestV = v; best = [x0 + x + 0.5, y0 + y + 0.5]; }
  }
  return best || p;
}
function refreshPicks() {
  vA.marks = pick.A.map((p, i) => ({ x: p[0], y: p[1], label: i + 1 })); vB.marks = pick.B.map((p, i) => ({ x: p[0], y: p[1], label: i + 1 }));
  vA.apply(); vB.apply();
  $("cntA").textContent = pick.A.length + " / 2"; $("cntB").textContent = pick.B.length + " / 2";
  const same = $("sameScale").checked;
  $("dlgApply").disabled = !(pick.A.length === pick.B.length && (pick.A.length === 2 || (same && pick.A.length === 1)));
}
function openManual() {
  if (!S.rasterA || !S.xf || S.running) return;
  // a PDF and a DXF are drawn at unrelated sizes: their scale always comes from the two points
  pick.A = []; pick.B = []; $("sameScale").checked = !S.mixed && Math.abs(scaleOf(S.xf.m) - 1) < 0.005; $("dlg").showModal();
  vA.setCanvas(S.rasterA); vB.setCanvas(S.rasterB); vA.setLevels(pyramid(S.rasterA)); vB.setLevels(pyramid(S.rasterB)); vA.fit(); vB.fit(); refreshPicks();
}
$("sameScale").onchange = refreshPicks;
$("dlgReset").onclick = () => { pick.A = []; pick.B = []; refreshPicks(); };
$("dlgCancel").onclick = () => $("dlg").close();
$("dlgApply").onclick = () => {
  const [p1, p2] = pick.A, [q1, q2] = pick.B, same = $("sameScale").checked;
  let s = 1, th = 0;
  if (p2 && q2) {
    th = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) - Math.atan2(q2[1] - q1[1], q2[0] - q1[0]);
    // two points always give the scale; "same scale" only rounds a near 1 to exactly 1
    s = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / Math.hypot(q2[0] - q1[0], q2[1] - q1[1]);
    if (same && Math.abs(s - 1) < 0.02) s = 1;
    if (Math.abs(th) < 0.002) th = 0;
  }
  const a = s * Math.cos(th), b = s * Math.sin(th);
  const e = p1[0] - (a * q1[0] - b * q1[1]), f = p1[1] - (b * q1[0] + a * q1[1]);
  S.xf = { mode: "manual", m: [a, b, -b, a, e, f], res: S.frame.W };
  $("dlg").close(); run();
};

legend();
showHome("");
loicaSync();
