// TrailMix engine: everything runs in the browser.
//
//   Ghostscript (WASM) reads EPS/PS/AI/PDF, finds the artwork's bounding box,
//   converts color spaces (CMYK / Gray) and writes EPS.
//   MuPDF (WASM) analyses the artwork (every shape + its exact color), renders
//   PNG/JPG, writes SVG, and re-writes PDFs through a color-mapping proxy.
//   Paper.js does the boolean path maths for one-color logos, so white details
//   become real cut-outs instead of white shapes.

import * as mupdf from './vendor/mupdf/mupdf.js';
import createGhostscript from './vendor/ghostscript/gs.mjs';

const paperLib = () => {
  if (!globalThis.paper) throw new Error('Paper.js did not load');
  return globalThis.paper;
};

/* ------------------------------------------------------------------ */
/* Ghostscript                                                          */
/* ------------------------------------------------------------------ */

let gsWasm;
function loadGhostscriptWasm() {
  if (!gsWasm) {
    gsWasm = (async () => {
      const res = await fetch(new URL('./vendor/ghostscript/gs.wasm', import.meta.url));
      if (!res.ok) throw new Error(`Could not download the converter (HTTP ${res.status})`);
      try {
        return await WebAssembly.compileStreaming(res.clone());
      } catch {
        return WebAssembly.compile(await res.arrayBuffer());
      }
    })();
    gsWasm.catch(() => { gsWasm = undefined; });
  }
  return gsWasm;
}

export async function warmUp() {
  await loadGhostscriptWasm();
  // Touch MuPDF so its wasm is compiled too.
  mupdf.ColorSpace.DeviceRGB.getName();
}

/** Run one Ghostscript command. Each call gets a fresh instance (main() can only run once). */
async function ghostscript(args, inputs, outputName) {
  const wasm = await loadGhostscriptWasm();
  const log = [];
  // This Ghostscript build binds its stdout/stderr to console.log/warn when the
  // instance is created, so capture them by swapping the console temporarily.
  const { log: origLog, warn: origWarn } = console;
  console.log = (...a) => log.push(a.join(' '));
  console.warn = (...a) => log.push(a.join(' '));
  let gs, rc;
  try {
    gs = await createGhostscript({
      instantiateWasm(imports, done) {
        WebAssembly.instantiate(wasm, imports).then((inst) => done(inst));
        return {};
      },
    });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  for (const [name, bytes] of Object.entries(inputs)) gs.FS.writeFile('/' + name, bytes);
  try {
    rc = gs.callMain(['-dSAFER', '-dBATCH', '-dNOPAUSE', ...args]);
  } catch (e) {
    if (e && typeof e.status === 'number') rc = e.status;
    else throw e;
  }
  if (rc !== 0) {
    const tail = log.filter((l) => /error|unable|fail/i.test(l)).slice(-3).join(' ');
    throw new Error('Ghostscript could not process this file' + (tail ? ': ' + tail : ''));
  }
  if (!outputName) return log.join('\n');
  return gs.FS.readFile('/' + outputName);
}

/* ------------------------------------------------------------------ */
/* Loading & normalising the source file                                */
/* ------------------------------------------------------------------ */

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function sniff(bytes) {
  if (bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6) return 'eps';
  const head = latin1(bytes.subarray(0, 2048));
  if (head.startsWith('%!')) return /EPSF/.test(head.split(/[\r\n]/)[0]) ? 'eps' : 'ps';
  if (head.includes('%PDF-')) return 'pdf';
  if (/<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

/** The PostScript part of an EPS (skips a DOS binary header with TIFF/WMF preview). */
function postscriptText(bytes) {
  if (bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const off = dv.getUint32(4, true), len = dv.getUint32(8, true);
    return latin1(bytes.subarray(off, off + len));
  }
  return latin1(bytes);
}

/**
 * Turn an EPS / PS / AI / PDF into a cropped, single-page PDF with text as
 * outlines. Colours are restored to the exact values written in the source
 * file (Ghostscript rounds them to a 1/1024 grid otherwise).
 * Returns { pdf, width, height, kind, sourceColors } (points).
 */
export async function loadLogo(bytes) {
  const kind = sniff(bytes);
  if (kind === 'svg') throw new Error('SVG input is not supported yet. Please upload the EPS, AI or PDF.');
  if (!kind) throw new Error('This does not look like an EPS, AI or PDF file.');
  const inName = 'in.' + (kind === 'pdf' ? 'pdf' : 'eps');

  const normalized = await ghostscript(
    ['-sDEVICE=pdfwrite', '-dNoOutputFonts', '-dCompatibilityLevel=1.6', '-dAutoRotatePages=/None',
      '-dEPSCrop', '-dFirstPage=1', '-dLastPage=1', '-o', '/out.pdf', '/' + inName],
    { [inName]: bytes }, 'out.pdf');

  let pdf, width, height;
  if (kind === 'eps') {
    // Keep the designer's own bounding box (Ghostscript crops the page to it).
    const doc = new mupdf.PDFDocument(normalized);
    const mb = doc.loadPage(0).getObject().getInheritable('MediaBox');
    const b = [0, 1, 2, 3].map((i) => mb.get(i).asNumber());
    width = b[2] - b[0]; height = b[3] - b[1];
    pdf = normalized;
  } else {
    const bboxLog = await ghostscript(['-sDEVICE=bbox', '/in.pdf'], { 'in.pdf': normalized });
    const m = bboxLog.match(/%%HiResBoundingBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/);
    if (!m) throw new Error('Could not measure the artwork.');
    const [bx0, by0, bx1, by1] = m.slice(1).map(Number);
    if (!(bx1 - bx0 > 0.01 && by1 - by0 > 0.01)) throw new Error('No artwork found in this file.');
    const base = pdfMediaOrigin(normalized);
    pdf = setPdfBox(normalized, [base[0] + bx0, base[1] + by0, base[0] + bx1, base[1] + by1]);
    width = bx1 - bx0; height = by1 - by0;
  }
  const sourceColors = kind === 'pdf' ? pdfSourceColors(bytes) : psSourceColors(postscriptText(bytes));
  pdf = snapColors(pdf, sourceColors);
  return { pdf, width, height, kind, sourceColors };
}

/* ------------------------------------------------------------------ */
/* Exact source colours                                                 */
/* ------------------------------------------------------------------ */

const PS_CMYK_OPS = new Set(['k', 'K', 'setcmykcolor', 'cmyk', 'CMYK']);
const PS_RGB_OPS = new Set(['rg', 'RG', 'setrgbcolor', 'Xa', 'XA', 'rgb', 'RGB']);
const PS_GRAY_OPS = new Set(['g', 'G', 'setgray']);

/** Every colour literally written in a PostScript / EPS program. */
function psSourceColors(ps) {
  const found = new Map();
  const nums = [];
  const re = /[-+]?(?:\d+\.?\d*|\.\d+)(?![\w.])|[A-Za-z_][\w]*/g;
  let m;
  while ((m = re.exec(ps))) {
    const t = m[0];
    const c = t.charCodeAt(0);
    if ((c >= 48 && c <= 57) || t[0] === '.' || t[0] === '-' || t[0] === '+') {
      nums.push(t);
      if (nums.length > 4) nums.shift();
      continue;
    }
    let space = null, n = 0;
    if (PS_CMYK_OPS.has(t)) { space = 'CMYK'; n = 4; }
    else if (PS_RGB_OPS.has(t)) { space = 'RGB'; n = 3; }
    else if (PS_GRAY_OPS.has(t)) { space = 'Gray'; n = 1; }
    if (space && nums.length >= n) {
      const vals = nums.slice(-n).map(Number);
      if (vals.every((v) => v >= 0 && v <= 1)) {
        const key = space + ':' + nums.slice(-n).join(' ');
        if (!found.has(key)) found.set(key, { space, values: vals });
      }
    }
    nums.length = 0;
  }
  return [...found.values()];
}

/** Every device colour set in a PDF's page / form content. */
function pdfSourceColors(bytes) {
  const out = new Map();
  try {
    const doc = new mupdf.PDFDocument(bytes);
    walkContent(doc, 0, (src) => {
      rewriteStream(src.text, src.resources, (space, values) => {
        const key = space + ':' + values.join(' ');
        if (!out.has(key)) out.set(key, { space, values });
        return null;
      });
      return null;
    });
  } catch (e) { /* fall back to Ghostscript's values */ }
  return [...out.values()];
}

/** Put exact source values back where Ghostscript rounded them. */
export function snapColors(pdf, sources, tolerance = 0.0025) {
  if (!sources.length) return pdf;
  return rewriteColors(pdf, (space, values) => {
    let best = null, bestErr = Infinity;
    for (const s of sources) {
      if (s.space !== space || s.values.length !== values.length) continue;
      let err = 0;
      for (let i = 0; i < values.length; i++) err = Math.max(err, Math.abs(s.values[i] - values[i]));
      if (err < bestErr) { bestErr = err; best = s; }
    }
    if (!best || bestErr > tolerance || bestErr === 0) return null;
    return { space, values: best.values };
  });
}

/**
 * Digital (RGB) version: every colour that matches a brand colour (same space,
 * same values) is replaced by that brand colour's official RGB value.
 * brand: [{space:'CMYK'|'RGB'|'Gray', values:[0..1], rgb:[0..1]x3}]
 */
export function brandRgbPdf(pdf, brand, tolerance = 0.0005) {
  return rewriteColors(pdf, (space, values) => {
    for (const b of brand) {
      if (b.space !== space || b.values.length !== values.length) continue;
      // (n + 0.25) / 255 survives both rounding (SVG) and truncation (rasteriser) as exactly n.
      if (b.values.every((v, i) => Math.abs(v - values[i]) <= tolerance)) {
        return { space: 'RGB', values: b.rgb.map((v) => (Math.round(v * 255) + 0.25) / 255) };
      }
    }
    return null;
  });
}

/** Swap colours by a rule: map(space, values) -> {space, values} | null. */
export function recolorPdf(pdf, map) { return rewriteColors(pdf, map); }

function pdfMediaOrigin(pdf) {
  const doc = new mupdf.PDFDocument(pdf);
  const mb = doc.loadPage(0).getObject().getInheritable('MediaBox');
  const r = [0, 0];
  if (mb && mb.isArray()) { r[0] = mb.get(0).asNumber(); r[1] = mb.get(1).asNumber(); }
  doc.destroy?.();
  return r;
}

/** Set MediaBox/CropBox (PDF user space) on page 1. */
function setPdfBox(pdf, box) {
  const doc = new mupdf.PDFDocument(pdf);
  const page = doc.loadPage(0);
  const obj = page.getObject();
  const arr = doc.newArray();
  box.forEach((v) => arr.push(doc.newReal(v)));
  obj.put('MediaBox', arr);
  obj.put('CropBox', arr);
  for (const k of ['TrimBox', 'BleedBox', 'ArtBox']) obj.delete(k);
  const out = doc.saveToBuffer('compress,garbage').asUint8Array().slice();
  return out;
}

/** Grow the page by `pad` points on every side. */
export function padPdf(pdf, pad) {
  if (!pad) return pdf;
  const doc = new mupdf.PDFDocument(pdf);
  const mb = doc.loadPage(0).getObject().getInheritable('MediaBox');
  const b = [0, 1, 2, 3].map((i) => mb.get(i).asNumber());
  return setPdfBox(pdf, [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]);
}

/* ------------------------------------------------------------------ */
/* Analysis: capture every shape and color                             */
/* ------------------------------------------------------------------ */

const fmt = (n) => {
  const s = (Math.round(n * 1000) / 1000).toString();
  return s === '-0' ? '0' : s;
};

function transformPath(path, ctm) {
  const [a, b, c, d, e, f] = ctm;
  const X = (x, y) => a * x + c * y + e;
  const Y = (x, y) => b * x + d * y + f;
  const cmds = [];
  path.walk({
    moveTo: (x, y) => cmds.push(['M', X(x, y), Y(x, y)]),
    lineTo: (x, y) => cmds.push(['L', X(x, y), Y(x, y)]),
    curveTo: (x1, y1, x2, y2, x3, y3) => cmds.push(['C', X(x1, y1), Y(x1, y1), X(x2, y2), Y(x2, y2), X(x3, y3), Y(x3, y3)]),
    closePath: () => cmds.push(['Z']),
  });
  return cmds;
}

function rectCmds(ctm) {
  // Unit square (image space) transformed by ctm.
  const [a, b, c, d, e, f] = ctm;
  const p = (x, y) => [a * x + c * y + e, b * x + d * y + f];
  const [p0, p1, p2, p3] = [p(0, 0), p(1, 0), p(1, 1), p(0, 1)];
  return [['M', ...p0], ['L', ...p1], ['L', ...p2], ['L', ...p3], ['Z']];
}

function cmdsToSvg(cmds) {
  return cmds.map((c) => c[0] + (c.length > 1 ? c.slice(1).map(fmt).join(' ') : '')).join('');
}

function cmdsBounds(cmds) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cmds) for (let i = 1; i < c.length; i += 2) {
    x0 = Math.min(x0, c[i]); x1 = Math.max(x1, c[i]);
    y0 = Math.min(y0, c[i + 1]); y1 = Math.max(y1, c[i + 1]);
  }
  return [x0, y0, x1, y1];
}

const matScale = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

const colorCache = new Map();
/** Exact screen RGB of any color (incl. spot colors) by letting MuPDF draw it. */
function colorToRGB(cs, color) {
  const key = cs.getName() + ':' + color.join(',');
  if (colorCache.has(key)) return colorCache.get(key);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 1, 1], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const p = new mupdf.Path();
  p.moveTo(-1, -1); p.lineTo(2, -1); p.lineTo(2, 2); p.lineTo(-1, 2); p.closePath();
  dev.fillPath(p, false, mupdf.Matrix.identity, cs, color, 1);
  dev.close();
  const px = pix.getPixels();
  const rgb = [px[0] / 255, px[1] / 255, px[2] / 255];
  colorCache.set(key, rgb);
  return rgb;
}

export const toHex = (rgb) => '#' + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
export const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};
export function rgbToCmyk([r, g, b]) {
  const k = 1 - Math.max(r, g, b);
  if (k >= 0.9999) return [0, 0, 0, 1];
  return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
}
export const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const saturation = (rgb) => Math.max(...rgb) - Math.min(...rgb);

function describeColor(cs, color) {
  const name = cs.getName();
  const type = cs.getType ? cs.getType() : name;
  const values = Array.from(color);
  const key = name + '|' + values.map((v) => v.toFixed(3)).join(',');
  const rgb = colorToRGB(cs, values);
  let cmyk = null, cmykExact = false, spot = null;
  if (cs.isCMYK()) { cmyk = values.slice(0, 4); cmykExact = true; }
  else if (cs.isGray()) { cmyk = [0, 0, 0, 1 - values[0]]; cmykExact = true; }
  if (/Separation|DeviceN/i.test(type) || /Separation|DeviceN/i.test(name)) {
    const m = name.match(/\((.+)\)/);
    spot = m ? m[1] : name;
  }
  if (!cmyk) cmyk = rgbToCmyk(rgb);
  return { key, space: cs.isCMYK() ? 'CMYK' : cs.isGray() ? 'Gray' : cs.isRGB() ? 'RGB' : type, values, rgb, hex: toHex(rgb), cmyk, cmykExact, spot };
}

/**
 * Walk the page once and record what is drawn, in paint order, with clipping.
 * Coordinates are MuPDF page space: points, origin top-left, y down.
 */
export function analyze(pdf) {
  const doc = mupdf.Document.openDocument(pdf, 'application/pdf');
  const page = doc.loadPage(0);
  const [px0, py0, px1, py1] = page.getBounds();
  const elements = [];
  const clips = [];
  const colors = new Map();
  const notes = new Set();
  let maskDepth = 0;

  const addColor = (c, cmds) => {
    const [x0, y0, x1, y1] = cmds ? cmdsBounds(cmds) : [0, 0, 0, 0];
    const area = Math.max(0, (x1 - x0) * (y1 - y0));
    const e = colors.get(c.key);
    if (e) { e.count++; e.area += area; } else colors.set(c.key, { ...c, count: 1, area });
  };

  const dev = new mupdf.Device({
    fillPath(path, evenOdd, ctm, cs, color, alpha) {
      if (maskDepth) return;
      const cmds = transformPath(path, ctm);
      if (!cmds.length) return;
      const c = describeColor(cs, color);
      addColor(c, cmds);
      elements.push({ type: 'fill', cmds, evenOdd, color: c, alpha, clips: clips.slice() });
    },
    strokePath(path, stroke, ctm, cs, color, alpha) {
      if (maskDepth) return;
      const cmds = transformPath(path, ctm);
      if (!cmds.length) return;
      const c = describeColor(cs, color);
      addColor(c, cmds);
      const s = matScale(ctm);
      elements.push({
        type: 'stroke', cmds, color: c, alpha, clips: clips.slice(),
        width: stroke.getLineWidth() * s, cap: stroke.getLineCap(), join: stroke.getLineJoin(),
        miter: stroke.getMiterLimit(), dash: (stroke.getDashes() || []).map((v) => v * s),
      });
    },
    fillText(text, ctm, cs, color, alpha) {
      if (maskDepth) return;
      notes.add('Some live text could not be outlined and is left out of the one-color versions.');
      addColor(describeColor(cs, color));
    },
    strokeText() { notes.add('Some live text could not be outlined and is left out of the one-color versions.'); },
    fillShade(shade, ctm, alpha) {
      if (maskDepth) return;
      notes.add('Contains gradients. One-color versions fill gradient areas solid.');
      elements.push({ type: 'shade', clips: clips.slice() });
    },
    fillImage(image, ctm, alpha) {
      if (maskDepth) return;
      notes.add('Contains an embedded bitmap image. One-color versions fill it as a solid block.');
      elements.push({ type: 'image', cmds: rectCmds(ctm), clips: clips.slice() });
    },
    fillImageMask(image, ctm, cs, color, alpha) {
      if (maskDepth) return;
      const cmds = rectCmds(ctm);
      const c = describeColor(cs, color);
      addColor(c, cmds);
      elements.push({ type: 'fill', cmds, evenOdd: false, color: c, alpha, clips: clips.slice() });
    },
    clipPath(path, evenOdd, ctm) { clips.push({ cmds: transformPath(path, ctm), evenOdd }); },
    clipStrokePath() { clips.push(null); },
    clipText() { clips.push(null); },
    clipStrokeText() { clips.push(null); },
    clipImageMask(image, ctm) { clips.push({ cmds: rectCmds(ctm), evenOdd: false }); },
    popClip() { clips.pop(); },
    beginMask() { maskDepth++; },
    endMask() { maskDepth--; clips.push(null); notes.add('Contains transparency masks; one-color versions ignore them.'); },
  });
  page.run(dev, mupdf.Matrix.identity);
  dev.close();

  const palette = [...colors.values()].sort((a, b) => b.area - a.area);
  return { width: px1 - px0, height: py1 - py0, elements, palette, notes: [...notes] };
}

/** Sensible per-color defaults. */
export function defaultColorRoles(palette) {
  const roles = {};
  for (const c of palette) {
    const L = luminance(c.rgb);
    roles[c.key] = {
      knockout: L > 0.93 && saturation(c.rgb) < 0.08, // white details become cut-outs
      onDark: L < 0.22 && saturation(c.rgb) < 0.35 ? 'white' : 'keep', // near-black text turns white
    };
  }
  // A logo that is entirely white must not knock everything out.
  if (palette.length && palette.every((c) => roles[c.key].knockout)) palette.forEach((c) => { roles[c.key].knockout = false; });
  return roles;
}

/* ------------------------------------------------------------------ */
/* One-color artwork (boolean knock-outs)                              */
/* ------------------------------------------------------------------ */

let paperScope;
function scope() {
  if (!paperScope) {
    const paper = paperLib();
    paperScope = new paper.PaperScope();
    paperScope.setup(new paperScope.Size(1, 1));
    paperScope.settings.insertItems = false;
  }
  paperScope.activate();
  return paperScope;
}

/** Fills close every subpath implicitly; make that explicit for boolean maths. */
function closeSubpaths(cmds) {
  const out = [];
  let open = false;
  for (const c of cmds) {
    if (c[0] === 'M' && open) out.push(['Z']);
    out.push(c);
    open = c[0] !== 'Z';
  }
  if (open) out.push(['Z']);
  return out;
}

function toPaper(cmds, evenOdd) {
  const ps = scope();
  const item = new ps.CompoundPath({ pathData: cmdsToSvg(closeSubpaths(cmds)), insert: false });
  item.fillRule = evenOdd ? 'evenodd' : 'nonzero';
  return item;
}

function isEmpty(item) {
  if (!item) return true;
  const b = item.bounds;
  return !(b.width > 1e-3 && b.height > 1e-3) || Math.abs(item.area) < 1e-4;
}

/**
 * Build the geometry of a one-color logo: a list of fill shapes (Paper items)
 * plus strokes. Knock-out colors are subtracted from what is underneath.
 */
export function buildOneColorGeometry(analysis, roles) {
  const fills = [];
  const strokes = [];
  const problems = new Set();
  const clipCache = new Map();
  const fullRect = [['M', -1e4, -1e4], ['L', 1e4, -1e4], ['L', 1e4, 1e4], ['L', -1e4, 1e4], ['Z']];

  const clipShape = (clipList) => {
    const real = clipList.filter(Boolean);
    if (!real.length) return null;
    const key = real;
    let acc = null;
    for (const c of real) {
      let shape = clipCache.get(c);
      if (!shape) { shape = toPaper(c.cmds, c.evenOdd); clipCache.set(c, shape); }
      acc = acc ? acc.intersect(shape, { insert: false }) : shape;
    }
    return acc;
  };

  for (const el of analysis.elements) {
    try {
      if (el.type === 'stroke') {
        if (!roles[el.color.key]?.knockout) strokes.push(el);
        continue;
      }
      const knock = el.type === 'fill' && roles[el.color.key]?.knockout;
      let shape = toPaper(el.cmds || fullRect, el.evenOdd);
      const clip = clipShape(el.clips);
      if (clip) shape = shape.intersect(clip, { insert: false });
      else if (!el.cmds) continue; // unclipped gradient: nothing sensible to fill
      if (isEmpty(shape)) continue;
      if (knock) {
        const sb = shape.bounds;
        for (let i = 0; i < fills.length; i++) {
          if (!fills[i].bounds.intersects(sb)) continue;
          fills[i] = fills[i].subtract(shape, { insert: false });
        }
      } else {
        fills.push(shape);
      }
    } catch (e) {
      problems.add('A complex shape could not be cut out cleanly.');
    }
  }
  return { fills: fills.filter((f) => !isEmpty(f)), strokes, problems: [...problems] };
}

/* ------------------------------------------------------------------ */
/* A tiny PDF writer                                                    */
/* ------------------------------------------------------------------ */

function buildPdf(width, height, content, { font = false } = {}) {
  const enc = new TextEncoder();
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  const res = font ? '<< /Font << /F1 5 0 R /F2 6 0 R >> >>' : '<< >>';
  objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(width)} ${fmt(height)}] /Resources ${res} /Contents 4 0 R >>`);
  const stream = enc.encode(content);
  objs.push({ dict: `<< /Length ${stream.length} >>`, stream });
  if (font) {
    objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  }
  const parts = [enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  let offset = parts[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(offset);
    let chunk;
    if (typeof o === 'string') chunk = [enc.encode(`${i + 1} 0 obj\n${o}\nendobj\n`)];
    else chunk = [enc.encode(`${i + 1} 0 obj\n${o.dict}\nstream\n`), o.stream, enc.encode('\nendstream\nendobj\n')];
    chunk.forEach((c) => { parts.push(c); offset += c.length; });
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { xref += String(o).padStart(10, '0') + ' 00000 n \n'; });
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(enc.encode(xref));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

function paperToPdfOps(item) {
  const ops = [];
  const paths = item.children && item.children.length ? item.children : [item];
  const P = (pt) => `${fmt(pt.x)} ${fmt(pt.y)}`;
  for (const p of paths) {
    const segs = p.segments;
    if (!segs || !segs.length) continue;
    ops.push(P(segs[0].point) + ' m');
    const n = segs.length;
    const last = p.closed ? n : n - 1;
    for (let i = 1; i <= last; i++) {
      const s1 = segs[i - 1], s2 = segs[i % n];
      if (s1.handleOut.isZero() && s2.handleIn.isZero()) ops.push(P(s2.point) + ' l');
      else ops.push(`${P(s1.point.add(s1.handleOut))} ${P(s2.point.add(s2.handleIn))} ${P(s2.point)} c`);
    }
    if (p.closed) ops.push('h');
  }
  return ops.join('\n');
}

function cmdsToPdfOps(cmds) {
  return cmds.map((c) => {
    switch (c[0]) {
      case 'M': return `${fmt(c[1])} ${fmt(c[2])} m`;
      case 'L': return `${fmt(c[1])} ${fmt(c[2])} l`;
      case 'C': return `${c.slice(1).map(fmt).join(' ')} c`;
      default: return 'h';
    }
  }).join('\n');
}

/**
 * Write a one-color logo as PDF. `ink` is { rgb:[0..1], cmyk:[0..1] };
 * mode 'cmyk' for print, 'rgb' for screen. `pad` adds margin in points.
 */
export function oneColorPdf(analysis, geometry, ink, mode, pad = 0) {
  const W = analysis.width + 2 * pad, H = analysis.height + 2 * pad;
  const fill = mode === 'cmyk' ? `${ink.cmyk.map(fmt).join(' ')} k` : `${ink.rgb.map(fmt).join(' ')} rg`;
  const stroke = mode === 'cmyk' ? `${ink.cmyk.map(fmt).join(' ')} K` : `${ink.rgb.map(fmt).join(' ')} RG`;
  const out = [`1 0 0 -1 ${fmt(pad)} ${fmt(H - pad)} cm`, fill, stroke];
  for (const f of geometry.fills) {
    out.push(paperToPdfOps(f));
    out.push(f.fillRule === 'evenodd' ? 'f*' : 'f');
  }
  for (const s of geometry.strokes) {
    out.push('q');
    out.push(`${fmt(s.width)} w ${s.cap} J ${s.join} j ${fmt(s.miter)} M`);
    if (s.dash.length) out.push(`[${s.dash.map(fmt).join(' ')}] 0 d`);
    out.push(cmdsToPdfOps(s.cmds));
    out.push('S Q');
  }
  return buildPdf(W, H, out.join('\n'));
}

/* ------------------------------------------------------------------ */
/* Color rewriting in PDF content streams (keeps gradients, clips, etc.) */
/* ------------------------------------------------------------------ */

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));

/** Tokenise a content stream. Yields {type, start, end, text}. */
function* tokens(str) {
  let i = 0;
  const n = str.length;
  while (i < n) {
    const c = str.charCodeAt(i);
    if (WS.has(c)) { i++; continue; }
    const start = i;
    if (c === 37) { while (i < n && str[i] !== '\n' && str[i] !== '\r') i++; continue; } // % comment
    if (c === 40) { // ( string )
      let depth = 0;
      for (; i < n; i++) {
        const ch = str[i];
        if (ch === '\\') { i++; continue; }
        if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) { i++; break; }
      }
      yield { type: 'operand', start, end: i };
      continue;
    }
    if (c === 60 && str[i + 1] === '<') { yield { type: 'open', start, end: (i += 2) }; continue; }
    if (c === 62 && str[i + 1] === '>') { yield { type: 'close', start, end: (i += 2) }; continue; }
    if (c === 60) { i = str.indexOf('>', i) + 1 || n; yield { type: 'operand', start, end: i }; continue; }
    if (c === 91) { yield { type: 'open', start, end: ++i }; continue; }
    if (c === 93) { yield { type: 'close', start, end: ++i }; continue; }
    if (c === 47) { // /Name
      i++;
      while (i < n && !WS.has(str.charCodeAt(i)) && !DELIM.has(str.charCodeAt(i))) i++;
      yield { type: 'operand', start, end: i, text: str.slice(start, i) };
      continue;
    }
    while (i < n && !WS.has(str.charCodeAt(i)) && !DELIM.has(str.charCodeAt(i))) i++;
    if (i === start) { i++; continue; }
    const text = str.slice(start, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) { yield { type: 'operand', start, end: i, text, num: +text }; continue; }
    if (text === 'true' || text === 'false' || text === 'null') { yield { type: 'operand', start, end: i, text }; continue; }
    if (text === 'ID') { // inline image data: skip to EI
      const m = /\sEI(?=[\s]|$)/g;
      m.lastIndex = i;
      const r = m.exec(str);
      i = r ? r.index + r[0].length : n;
      yield { type: 'operator', start, end: i, text: 'ID' };
      continue;
    }
    yield { type: 'operator', start, end: i, text };
  }
}

function resolveColorSpace(resources, name) {
  if (name === 'DeviceRGB' || name === 'RGB') return { space: 'RGB', n: 3 };
  if (name === 'DeviceCMYK' || name === 'CMYK') return { space: 'CMYK', n: 4 };
  if (name === 'DeviceGray' || name === 'G') return { space: 'Gray', n: 1 };
  const obj = resources?.get('ColorSpace')?.get(name);
  if (!obj || obj.isNull()) return null;
  const o = obj.resolve();
  if (o.isName()) return resolveColorSpace(null, o.asName());
  if (o.isArray() && o.get(0).asName() === 'ICCBased') {
    const N = o.get(1).get('N').asNumber();
    return N === 4 ? { space: 'CMYK', n: 4 } : N === 3 ? { space: 'RGB', n: 3 } : N === 1 ? { space: 'Gray', n: 1 } : null;
  }
  return null; // Separation, Pattern, Lab… left as they are
}

export const csFor = (space) => space === 'CMYK' ? mupdf.ColorSpace.DeviceCMYK : space === 'RGB' ? mupdf.ColorSpace.DeviceRGB : mupdf.ColorSpace.DeviceGray;
const colorNum = (v) => {
  const s = (Math.round(v * 1e6) / 1e6).toString();
  return s.startsWith('0.') ? s.slice(1) : s === '-0' ? '0' : s;
};
const DEVICE_OP = { CMYK: ['k', 'K'], RGB: ['rg', 'RG'], Gray: ['g', 'G'] };

/**
 * Rewrite colour operators in one content stream.
 * map(space, values) returns {space, values} to replace, or null to keep.
 */
function rewriteStream(str, resources, map) {
  const out = [];
  let last = 0;
  let operands = [];
  let depth = 0;
  const cur = { fill: null, stroke: null };
  const restore = { fill: null, stroke: null }; // named space to re-select after a device-colour swap
  for (const t of tokens(str)) {
    if (t.type === 'open') { if (!depth) operands.push(t); depth++; continue; }
    if (t.type === 'close') { depth = Math.max(0, depth - 1); continue; }
    if (depth) continue;
    if (t.type === 'operand') { operands.push(t); continue; }
    const op = t.text;
    let space = null, n = 0, side = null, named = null;
    if (op === 'k' || op === 'K') { space = 'CMYK'; n = 4; }
    else if (op === 'rg' || op === 'RG') { space = 'RGB'; n = 3; }
    else if (op === 'g' || op === 'G') { space = 'Gray'; n = 1; }
    else if (op === 'cs' || op === 'CS') {
      const sd = op === 'cs' ? 'fill' : 'stroke';
      const name = operands[operands.length - 1]?.text?.slice(1);
      cur[sd] = name ? { ...resolveColorSpace(resources, name), name } : null;
      restore[sd] = null;
    } else if (op === 'sc' || op === 'scn' || op === 'SC' || op === 'SCN') {
      side = op[0] === 's' ? 'fill' : 'stroke';
      const c = cur[side];
      if (c && c.space && !operands.some((o) => o.text?.startsWith('/'))) { space = c.space; n = c.n; named = c.name; }
    }
    if (space) {
      side = side || (op === op.toLowerCase() ? 'fill' : 'stroke');
      const isFill = side === 'fill';
      if (named && restore[side]) { // our earlier swap changed the current space: select it again
        out.push(str.slice(last, operands[0]?.start ?? t.start), `/${restore[side]} ${isFill ? 'cs' : 'CS'} `);
        last = operands[0]?.start ?? t.start;
        restore[side] = null;
      }
      if (operands.length === n && operands.every((o) => typeof o.num === 'number')) {
        const r = map(space, operands.map((o) => o.num));
        if (r) {
          const vals = r.values.map(colorNum).join(' ');
          let rep;
          if (named && r.space === space) rep = `${vals} ${op}`;
          else {
            rep = `${vals} ${DEVICE_OP[r.space][isFill ? 0 : 1]}`;
            if (named) restore[side] = named;
          }
          out.push(str.slice(last, operands[0].start), rep);
          last = t.end;
        }
      }
    }
    operands = [];
  }
  out.push(str.slice(last));
  return out.join('');
}

/** Visit page `index`'s content streams and nested form XObjects. fn({text, resources}) -> new text | null */
function walkContent(doc, index, fn) {
  const seen = new Set();
  const visit = (stream, resources) => {
    if (!stream || stream.isNull() || !stream.isStream()) return;
    const id = stream.isIndirect() ? stream.asIndirect() : null;
    if (id !== null) { if (seen.has(id)) return; seen.add(id); }
    const text = latin1(stream.readStream().asUint8Array());
    const res = fn({ text, resources });
    if (res != null && res !== text) stream.writeStream(Uint8Array.from(res, (ch) => ch.charCodeAt(0)));
    const xobjs = resources && !resources.isNull() ? resources.get('XObject') : null;
    if (xobjs && xobjs.isDictionary()) {
      xobjs.forEach((x) => {
        const xo = x.resolve();
        if (xo.isStream() && xo.get('Subtype').asName() === 'Form') {
          const xres = xo.get('Resources');
          visit(x, xres.isNull() ? resources : xres);
        }
      });
    }
  };
  const pageObj = doc.loadPage(index).getObject();
  const resources = pageObj.getInheritable('Resources');
  const contents = pageObj.get('Contents');
  if (contents.isArray()) contents.forEach((c) => visit(c, resources));
  else visit(contents, resources);
}

/** Rewrite every colour operator in page 1 (and its forms) through map(). */
function rewriteColors(pdf, map) {
  const doc = new mupdf.PDFDocument(pdf);
  let changed = false;
  walkContent(doc, 0, ({ text, resources }) => {
    const res = rewriteStream(text, resources, map);
    if (res !== text) changed = true;
    return res;
  });
  return changed ? doc.saveToBuffer('compress').asUint8Array().slice() : pdf;
}

/** Full-colour logo for dark backgrounds: colours marked "white on dark" become white. */
export function reversedPdf(pdf, roles, palette) {
  const whiteHex = new Set(palette.filter((c) => roles[c.key]?.onDark === 'white').map((c) => c.hex));
  if (!whiteHex.size) return pdf;
  return rewriteColors(pdf, (space, values) =>
    whiteHex.has(toHex(colorToRGB(csFor(space), values))) ? { space, values: space === 'CMYK' ? [0, 0, 0, 0] : space === 'RGB' ? [1, 1, 1] : [1] } : null);
}

/* ------------------------------------------------------------------ */
/* Output formats                                                       */
/* ------------------------------------------------------------------ */

export const toCmykPdf = (pdf) => ghostscript(
  ['-sDEVICE=pdfwrite', '-sColorConversionStrategy=CMYK', '-sProcessColorModel=DeviceCMYK', '-dCompatibilityLevel=1.6', '-o', '/o.pdf', '/i.pdf'],
  { 'i.pdf': pdf }, 'o.pdf');

export const toGrayPdf = (pdf) => ghostscript(
  ['-sDEVICE=pdfwrite', '-sColorConversionStrategy=Gray', '-sProcessColorModel=DeviceGray', '-dCompatibilityLevel=1.6', '-o', '/o.pdf', '/i.pdf'],
  { 'i.pdf': pdf }, 'o.pdf');

export const toEps = (pdf) => ghostscript(['-sDEVICE=eps2write', '-o', '/o.eps', '/i.pdf'], { 'i.pdf': pdf }, 'o.eps');

export function toSvg(pdf) {
  const doc = mupdf.Document.openDocument(pdf, 'application/pdf');
  const page = doc.loadPage(0);
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, 'svg', 'text=path,no-reuse-images');
  const dev = w.beginPage(page.getBounds());
  page.run(dev, mupdf.Matrix.identity);
  w.endPage();
  w.close();
  return buf.asString()
    .replace(/\s+xmlns:inkscape="[^"]*"/, '')
    .replace(/^<\?xml[^>]*>\s*/, '');
}

function fillBackground(pix, rgb) {
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const p = new mupdf.Path();
  const [, , w, h] = [0, 0, pix.getWidth(), pix.getHeight()];
  p.moveTo(-1, -1); p.lineTo(w + 1, -1); p.lineTo(w + 1, h + 1); p.lineTo(-1, h + 1); p.closePath();
  dev.fillPath(p, false, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, rgb, 1);
  dev.close();
}

/**
 * Render a PDF to a bitmap.
 *   width: output width in px (height follows the logo), or
 *   box: [w, h] canvas with the logo centered inside an `inset` margin (fraction of the short side).
 *   background: null for transparent, or [r,g,b] 0..1.
 */
export function render(pdf, { width, box, inset = 0.12, background = null, format = 'png', quality = 92 }) {
  const doc = mupdf.Document.openDocument(pdf, 'application/pdf');
  const page = doc.loadPage(0);
  const [x0, y0, x1, y1] = page.getBounds();
  const w = x1 - x0, h = y1 - y0;
  let pw, ph, matrix;
  if (box) {
    [pw, ph] = box;
    const m = Math.min(pw, ph) * inset;
    const s = Math.min((pw - 2 * m) / w, (ph - 2 * m) / h);
    matrix = mupdf.Matrix.concat(mupdf.Matrix.scale(s, s), mupdf.Matrix.translate((pw - w * s) / 2, (ph - h * s) / 2));
  } else {
    const s = width / w;
    pw = Math.round(width);
    ph = Math.max(1, Math.round(h * s));
    matrix = mupdf.Matrix.scale(s, s);
  }
  const alpha = (format === 'png' || format === 'rgba') && !background;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, pw, ph], alpha);
  if (alpha) pix.clear(); else pix.clear(255);
  if (background) fillBackground(pix, background);
  const dev = new mupdf.DrawDevice(matrix, pix);
  page.run(dev, mupdf.Matrix.identity);
  dev.close();
  if (format === 'rgba') return pixmapToRGBA(pix);
  return format === 'jpg' ? pix.asJPEG(quality, false).slice() : pix.asPNG().slice();
}

/** Straight (un-premultiplied) RGBA pixels from a MuPDF pixmap. */
function pixmapToRGBA(pix) {
  const w = pix.getWidth(), h = pix.getHeight();
  const stride = pix.getStride();
  const n = Math.round(stride / w); // bytes per pixel: 4 with alpha, 3 without
  const src = pix.getPixels();
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * stride + x * n, o = (y * w + x) * 4;
      const a = n === 4 ? src[i + 3] : 255;
      if (a === 255) { out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2]; }
      else if (a > 0) { out[o] = Math.round((src[i] * 255) / a); out[o + 1] = Math.round((src[i + 1] * 255) / a); out[o + 2] = Math.round((src[i + 2] * 255) / a); }
      out[o + 3] = a;
    }
  }
  return { data: out, width: w, height: h };
}

/* ------------------------------------------------------------------ */
/* WebP (lossless, libwebp in WebAssembly: same output in every browser) */
/* ------------------------------------------------------------------ */

const WEBP_OPTIONS = {
  quality: 100, target_size: 0, target_PSNR: 0, method: 4, sns_strength: 50, filter_strength: 60, filter_sharpness: 0,
  filter_type: 1, partitions: 0, segments: 4, pass: 1, show_compressed: 0, preprocessing: 0, autofilter: 0,
  partition_limit: 0, alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100, lossless: 1, exact: 0,
  image_hint: 0, emulate_jpeg_size: 0, thread_level: 0, low_memory: 0, near_lossless: 100, use_delta_palette: 0, use_sharp_yuv: 0,
};
let webpModule;
function webpEncoder() {
  if (!webpModule) {
    webpModule = (async () => {
      const simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
      const { default: factory } = await import(simd ? './vendor/webp/webp_enc_simd.js' : './vendor/webp/webp_enc.js');
      return factory({ noInitialRun: true });
    })();
    webpModule.catch(() => { webpModule = undefined; });
  }
  return webpModule;
}

/** Render a PDF straight to lossless WebP (same options as render()). */
export async function renderWebp(pdf, opts) {
  const { data, width, height } = render(pdf, { ...opts, format: 'rgba' });
  const enc = await webpEncoder();
  const result = enc.encode(data, width, height, WEBP_OPTIONS);
  if (!result) throw new Error('WebP encoding failed');
  return new Uint8Array(result).slice();
}

/* ------------------------------------------------------------------ */
/* Extras: ICO and Adobe Swatch Exchange                                */
/* ------------------------------------------------------------------ */

export function buildIco(pngs) {
  // pngs: [{size, bytes}]
  const header = 6 + 16 * pngs.length;
  const total = header + pngs.reduce((n, p) => n + p.bytes.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0, true); dv.setUint16(2, 1, true); dv.setUint16(4, pngs.length, true);
  let offset = header;
  pngs.forEach((p, i) => {
    const e = 6 + i * 16;
    out[e] = p.size >= 256 ? 0 : p.size;
    out[e + 1] = p.size >= 256 ? 0 : p.size;
    dv.setUint16(e + 4, 1, true);
    dv.setUint16(e + 6, 32, true);
    dv.setUint32(e + 8, p.bytes.length, true);
    dv.setUint32(e + 12, offset, true);
    out.set(p.bytes, offset);
    offset += p.bytes.length;
  });
  return out;
}

export function buildAse(colors) {
  // colors: [{name, model:'RGB'|'CMYK', values:[0..1], spot:boolean}]
  const blocks = colors.map((c) => {
    const name = c.name + '\0';
    const nameBytes = name.length * 2;
    const model = c.model === 'CMYK' ? 'CMYK' : 'RGB ';
    const len = 2 + nameBytes + 4 + 4 * c.values.length + 2;
    const b = new DataView(new ArrayBuffer(6 + len));
    let o = 0;
    b.setUint16(o, 0x0001); o += 2;
    b.setUint32(o, len); o += 4;
    b.setUint16(o, name.length); o += 2;
    for (let i = 0; i < name.length; i++) { b.setUint16(o, name.charCodeAt(i)); o += 2; }
    for (let i = 0; i < 4; i++) { b.setUint8(o, model.charCodeAt(i)); o += 1; }
    c.values.forEach((v) => { b.setFloat32(o, v); o += 4; });
    b.setUint16(o, c.spot ? 1 : 2);
    return new Uint8Array(b.buffer);
  });
  const head = new DataView(new ArrayBuffer(12));
  'ASEF'.split('').forEach((ch, i) => head.setUint8(i, ch.charCodeAt(0)));
  head.setUint16(4, 1); head.setUint16(6, 0); head.setUint32(8, blocks.length);
  const total = 12 + blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  out.set(new Uint8Array(head.buffer), 0);
  let pos = 12;
  for (const b of blocks) { out.set(b, pos); pos += b.length; }
  return out;
}

const pdfText = (s) => '(' + String(s).replace(/[\\()]/g, (m) => '\\' + m).replace(/[^\x20-\x7e]/g, '?') + ')';

/** A one-page brand color sheet (PDF). */
export function colorSheetPdf(brand, colors) {
  const W = 612, rowH = 92, top = 110;
  const H = Math.max(792, top + colors.length * rowH + 60);
  const ops = [];
  ops.push(`BT /F2 22 Tf 48 ${H - 64} Td ${pdfText(brand + ' brand colors')} Tj ET`);
  colors.forEach((c, i) => {
    const y = H - top - (i + 1) * rowH + 16;
    if (c.cmykExact) ops.push(`${c.cmyk.map(fmt).join(' ')} k`);
    else ops.push(`${c.rgb.map(fmt).join(' ')} rg`);
    ops.push(`48 ${y} 120 ${rowH - 24} re f`);
    ops.push('0.75 G 0.5 w 48 ' + y + ' 120 ' + (rowH - 24) + ' re S');
    ops.push('0 g');
    const lines = [
      [c.spot || c.name, 'F2', 13],
      [`HEX ${c.hex}`, 'F1', 10],
      [`RGB ${c.rgb.map((v) => Math.round(v * 255)).join(' / ')}`, 'F1', 10],
      [`CMYK ${c.cmyk.map((v) => Math.round(v * 100)).join(' / ')}${c.cmykExact ? '' : '  (converted)'}`, 'F1', 10],
    ];
    lines.forEach(([t, f, s], j) => ops.push(`BT /${f} ${s} Tf 190 ${y + rowH - 40 - j * 16} Td ${pdfText(t)} Tj ET`));
  });
  return buildPdf(W, H, ops.join('\n'), { font: true });
}

export { mupdf };
