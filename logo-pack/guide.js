// Brand guidelines PDF, built with MuPDF. Logos are embedded as vector
// Form XObjects in their official RGB colours; nothing is rasterised.

import * as E from './engine.js';
import * as P from './pack.js';

const { mupdf } = E;
const W = 1920, H = 1080, M = 120;

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

const num = (n) => { const s = (Math.round(n * 1000) / 1000).toString(); return s === '-0' ? '0' : s; };
const rgbOf = (hex) => E.hexToRgb(hex);
const mix = (hex, toHex, t) => { const a = rgbOf(hex), b = rgbOf(toHex); return E.toHex(a.map((v, i) => v + (b[i] - v) * t)); };
const WINANSI = { 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2026: 0x85, 0xd7: 0xd7, 0x2192: 0x3e };
function pdfString(str) {
  let out = '(';
  for (const ch of str) {
    let c = ch.codePointAt(0);
    if (WINANSI[c] !== undefined) c = WINANSI[c];
    else if (c > 255) c = 0x3f;
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out + ')';
}
const mat = {
  mul: (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]],
  t: (x, y) => [1, 0, 0, 1, x, y],
  s: (x, y = x) => [x, 0, 0, y, 0, 0],
  r: (deg) => { const r = (deg * Math.PI) / 180; return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]; },
};

/** Parse an SVG path (absolute & relative M L H V C S Q T Z) into absolute segments. */
function parsePath(d) {
  const toks = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g) || [];
  const segs = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, lc = null;
  const n = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === 'M') { x = ox + n(); y = oy + n(); sx = x; sy = y; segs.push(['M', x, y]); cmd = rel ? 'l' : 'L'; lc = null; }
    else if (C === 'L') { x = ox + n(); y = oy + n(); segs.push(['L', x, y]); lc = null; }
    else if (C === 'H') { x = ox + n(); segs.push(['L', x, y]); lc = null; }
    else if (C === 'V') { y = oy + n(); segs.push(['L', x, y]); lc = null; }
    else if (C === 'C') { const a = [ox + n(), oy + n(), ox + n(), oy + n(), ox + n(), oy + n()]; segs.push(['C', ...a]); lc = [a[2], a[3]]; x = a[4]; y = a[5]; }
    else if (C === 'S') { const c1 = lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y]; const a = [ox + n(), oy + n(), ox + n(), oy + n()]; segs.push(['C', ...c1, ...a]); lc = [a[0], a[1]]; x = a[2]; y = a[3]; }
    else if (C === 'Q' || C === 'T') {
      let qx, qy;
      if (C === 'Q') { qx = ox + n(); qy = oy + n(); } else { qx = lc ? 2 * x - lc[0] : x; qy = lc ? 2 * y - lc[1] : y; }
      const ex = ox + n(), ey = oy + n();
      segs.push(['C', x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey]);
      lc = [qx, qy]; x = ex; y = ey;
    } else if (C === 'Z') { segs.push(['Z']); x = sx; y = sy; lc = null; }
    else i++;
  }
  return segs;
}

/* ------------------------------------------------------------------ */
/* Document & page builders                                             */
/* ------------------------------------------------------------------ */

class Guide {
  constructor() {
    this.doc = new mupdf.PDFDocument();
    this.font = { r: new mupdf.Font('Helvetica'), b: new mupdf.Font('Helvetica-Bold') };
    this.fontRef = { r: this.doc.addSimpleFont(this.font.r, 'Latin'), b: this.doc.addSimpleFont(this.font.b, 'Latin') };
    this.forms = new Map();
    this.gstates = new Map();
  }
  measure(str, size, f = 'r') {
    let w = 0;
    for (const ch of str) w += this.font[f].advanceGlyph(this.font[f].encodeCharacter(ch.codePointAt(0)));
    return w * size;
  }
  /** Embed page 1 of a PDF as a vector Form XObject. */
  form(key, pdf) {
    if (this.forms.has(key)) return this.forms.get(key);
    const src = new mupdf.PDFDocument(pdf);
    const pg = src.loadPage(0).getObject();
    const mb = pg.getInheritable('MediaBox');
    const box = [0, 1, 2, 3].map((i) => mb.get(i).asNumber());
    const parts = [];
    const c = pg.get('Contents');
    const add = (s) => parts.push(s.readStream().asUint8Array().slice());
    if (c.isArray()) c.forEach(add); else add(c);
    const len = parts.reduce((n, p) => n + p.length + 1, 0);
    const buf = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; buf[o++] = 10; }
    const d = this.doc.newDictionary();
    d.put('Type', this.doc.newName('XObject'));
    d.put('Subtype', this.doc.newName('Form'));
    const bb = this.doc.newArray();
    box.forEach((v) => bb.push(this.doc.newReal(v)));
    d.put('BBox', bb);
    const res = pg.getInheritable('Resources');
    if (res && !res.isNull()) d.put('Resources', this.doc.graftObject(res));
    const ref = this.doc.addStream(buf, d);
    const f = { name: 'X' + this.forms.size, ref, box, w: box[2] - box[0], h: box[3] - box[1] };
    this.forms.set(key, f);
    return f;
  }
  page(bg = '#FFFFFF') { return new Page(this, bg); }
  save() { return this.doc.saveToBuffer('compress,garbage').asUint8Array().slice(); }
}

class Page {
  constructor(g, bg) {
    this.g = g;
    this.ops = [];
    this.xobjs = new Map();
    this.gs = new Map();
    if (bg && bg.toUpperCase() !== '#FFFFFF') this.rect(0, 0, W, H, { fill: bg });
  }
  color(hex, stroke = false) { return `${rgbOf(hex).map(num).join(' ')} ${stroke ? 'RG' : 'rg'}`; }
  alpha(a) {
    const k = 'G' + Math.round(a * 100);
    if (!this.gs.has(k)) this.gs.set(k, a);
    return `/${k} gs`;
  }
  rect(x, y, w, h, { fill, stroke, lw = 1, r = 0, dash, opacity } = {}) {
    this.ops.push('q');
    if (opacity !== undefined) this.ops.push(this.alpha(opacity));
    if (fill) this.ops.push(this.color(fill));
    if (stroke) this.ops.push(this.color(stroke, true), `${num(lw)} w`);
    if (dash) this.ops.push(`[${dash.join(' ')}] 0 d`);
    if (r > 0) this.ops.push(this.pathOps(parsePath(roundRect(x, y, w, h, r))));
    else this.ops.push(`${num(x)} ${num(H - y - h)} ${num(w)} ${num(h)} re`);
    this.ops.push(fill && stroke ? 'B' : fill ? 'f' : 'S', 'Q');
  }
  line(x1, y1, x2, y2, { color = '#D4D4D8', lw = 1, dash } = {}) {
    this.ops.push('q', this.color(color, true), `${num(lw)} w`, dash ? `[${dash.join(' ')}] 0 d` : '', `${num(x1)} ${num(H - y1)} m ${num(x2)} ${num(H - y2)} l S`, 'Q');
  }
  pathOps(segs, m = null) {
    const T = (x, y) => (m ? [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] : [x, y]);
    return segs.map((s) => {
      if (s[0] === 'Z') return 'h';
      const pts = [];
      for (let i = 1; i < s.length; i += 2) { const [px, py] = T(s[i], s[i + 1]); pts.push(num(px), num(H - py)); }
      return pts.join(' ') + (s[0] === 'M' ? ' m' : s[0] === 'L' ? ' l' : ' c');
    }).join('\n');
  }
  /** Draw an SVG path given in local units, placed with matrix m (top-left page space). */
  path(d, { fill, stroke, lw = 1, m = null, opacity, evenodd = false, cap = 1, join = 1 } = {}) {
    this.ops.push('q');
    if (opacity !== undefined) this.ops.push(this.alpha(opacity));
    if (fill) this.ops.push(this.color(fill));
    if (stroke) this.ops.push(this.color(stroke, true), `${num(lw)} w ${cap} J ${join} j`);
    this.ops.push(this.pathOps(parsePath(d), m));
    this.ops.push(fill && stroke ? (evenodd ? 'B*' : 'B') : fill ? (evenodd ? 'f*' : 'f') : 'S', 'Q');
  }
  text(str, x, y, { size = 20, font = 'r', color = '#18181B', align = 'left', maxWidth = 0, lh = 1.4, tracking = 0, opacity } = {}) {
    const words = String(str).split(/\s+/);
    const lines = [];
    if (maxWidth) {
      let cur = '';
      for (const w of words) {
        const t = cur ? cur + ' ' + w : w;
        if (cur && this.g.measure(t, size, font) > maxWidth) { lines.push(cur); cur = w; } else cur = t;
      }
      if (cur) lines.push(cur);
    } else lines.push(String(str));
    this.ops.push('q');
    if (opacity !== undefined) this.ops.push(this.alpha(opacity));
    this.ops.push(this.color(color));
    lines.forEach((ln, i) => {
      const w = this.g.measure(ln, size, font) + tracking * size * Math.max(0, [...ln].length - 1);
      const lx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
      const ly = H - (y + size * 0.8 + i * size * lh);
      this.ops.push(`BT /F${font === 'b' ? 2 : 1} ${num(size)} Tf ${tracking ? num(tracking * size) + ' Tc ' : ''}${num(lx)} ${num(ly)} Td ${pdfString(ln)} Tj ET`);
    });
    this.ops.push('Q');
    return lines.length * size * lh;
  }
  /** Place a form inside box (x,y,w,h), keeping proportions. extra: {align, rotate, sx, sy, valign} */
  logo(f, x, y, w, h, { align = 'center', valign = 'middle', rotate = 0, sx = 1, sy = 1, opacity } = {}) {
    if (!f) return null;
    const rw = Math.abs(rotate) % 180 === 90 ? f.h : f.w, rh = Math.abs(rotate) % 180 === 90 ? f.w : f.h;
    const s = Math.min(w / (rw * sx), h / (rh * sy));
    const dw = rw * s * sx, dh = rh * s * sy;
    const cx = align === 'left' ? x + dw / 2 : align === 'right' ? x + w - dw / 2 : x + w / 2;
    const cy = valign === 'top' ? y + dh / 2 : valign === 'bottom' ? y + h - dh / 2 : y + h / 2;
    this.place(f, cx, cy, s, { rotate, sx, sy, opacity });
    return { x: cx - dw / 2, y: cy - dh / 2, w: dw, h: dh, s };
  }
  /** Place form centred at (cx, cy) (top-left page space) with scale s. */
  place(f, cx, cy, s, { rotate = 0, sx = 1, sy = 1, opacity } = {}) {
    this.xobjs.set(f.name, f.ref);
    let m = mat.t(-(f.box[0] + f.w / 2), -(f.box[1] + f.h / 2));
    m = mat.mul(m, mat.s(s * sx, s * sy));
    if (rotate) m = mat.mul(m, mat.r(rotate));
    m = mat.mul(m, mat.t(cx, H - cy));
    this.ops.push('q', opacity !== undefined ? this.alpha(opacity) : '', `${m.map(num).join(' ')} cm /${f.name} Do Q`);
  }
  finish() {
    const doc = this.g.doc;
    const res = doc.newDictionary();
    const fonts = doc.newDictionary();
    fonts.put('F1', this.g.fontRef.r);
    fonts.put('F2', this.g.fontRef.b);
    res.put('Font', fonts);
    if (this.xobjs.size) {
      const xd = doc.newDictionary();
      for (const [n, ref] of this.xobjs) xd.put(n, ref);
      res.put('XObject', xd);
    }
    if (this.gs.size) {
      const gd = doc.newDictionary();
      for (const [n, a] of this.gs) {
        const e = doc.newDictionary();
        e.put('ca', doc.newReal(a));
        e.put('CA', doc.newReal(a));
        gd.put(n, e);
      }
      res.put('ExtGState', gd);
    }
    const page = doc.addPage([0, 0, W, H], 0, res, this.ops.filter(Boolean).join('\n'));
    doc.insertPage(-1, page);
  }
}

function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const k = 0.5523 * r;
  return `M${x + r} ${y}H${x + w - r}C${x + w - r + k} ${y} ${x + w} ${y + r - k} ${x + w} ${y + r}V${y + h - r}C${x + w} ${y + h - r + k} ${x + w - r + k} ${y + h} ${x + w - r} ${y + h}H${x + r}C${x + r - k} ${y + h} ${x} ${y + h - r + k} ${x} ${y + h - r}V${y + r}C${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y}Z`;
}
function ellipse(cx, cy, rx, ry) {
  const kx = 0.5523 * rx, ky = 0.5523 * ry;
  return `M${cx + rx} ${cy}C${cx + rx} ${cy + ky} ${cx + kx} ${cy + ry} ${cx} ${cy + ry}C${cx - kx} ${cy + ry} ${cx - rx} ${cy + ky} ${cx - rx} ${cy}C${cx - rx} ${cy - ky} ${cx - kx} ${cy - ry} ${cx} ${cy - ry}C${cx + kx} ${cy - ry} ${cx + rx} ${cy - ky} ${cx + rx} ${cy}Z`;
}

/* ------------------------------------------------------------------ */
/* Guide content                                                        */
/* ------------------------------------------------------------------ */

const INK = '#18181B', MUTED = '#6B6B76', RULE = '#E4E4E7', TILE = '#F4F4F5';

/**
 * Build the guidelines PDF for a brand (see pack.js for the brand model).
 */
export function buildGuide(brand) {
  const g = new Guide();
  P.assignNames(brand);
  const colors = brand.colors;
  const byKey = new Map(colors.map((c) => [c.key, c]));
  const neutrals = colors.filter((c) => P.isNeutral(rgbOf(c.hex)));
  const light = P.lightBackground(brand);
  const mainF = P.mainFamily(brand);
  const prim = P.pick(brand, ['logo', 'logo-no-tag', 'mark'], 'primary');
  const sec = P.pick(brand, ['logo', 'logo-no-tag', 'mark'], 'secondary');
  const dark = P.darkBackground(brand);
  void neutrals;
  const formOf = (a) => (a ? g.form('a' + a.id, P.rgbPdf(brand, a)) : null);
  const markP = P.pick(brand, ['mark', 'logo-no-tag', 'logo'], 'primary');
  const markS = P.pick(brand, ['mark', 'logo-no-tag', 'logo'], 'secondary');
  const noTagP = P.pick(brand, ['logo-no-tag', 'logo'], 'primary');
  const noTagS = P.pick(brand, ['logo-no-tag', 'logo'], 'secondary');
  const title = brand.name.toUpperCase() + ' BRAND GUIDELINES';
  const L = P.layout(brand);
  const famTitle = (f) => P.familyTitle(brand, f);
  const typeLabel = (t) => P.TYPES.find((x) => x.id === t).label;

  const pages = [];
  const sections = [];
  const add = (fn, section) => { if (section) sections.push({ title: section, index: pages.length }); pages.push(fn); };

  // Common chrome.
  const chrome = (pg, n, onDark = false) => {
    const c = onDark ? light : INK;
    pg.text(title, M, 56, { size: 13, color: c, tracking: 0.08, opacity: 0.8 });
    pg.text(`P / ${String(n).padStart(2, '0')}`, W - M, 56, { size: 13, color: c, align: 'right', opacity: 0.8 });
    pg.line(M, 86, W - M, 86, { color: onDark ? mix(dark, '#FFFFFF', 0.25) : RULE });
  };
  const heading = (pg, t, sub) => {
    pg.text(t.toUpperCase(), M, 140, { size: 34, font: 'b', tracking: 0.02 });
    if (sub) pg.text(sub, M, 196, { size: 22, color: MUTED, maxWidth: 1300 });
  };
  const caption = (pg, t, x, y, opts = {}) => pg.text(t, x, y, { size: 18, color: MUTED, ...opts });
  const tile = (pg, x, y, w, h, bg, border = false) => pg.rect(x, y, w, h, { fill: bg, stroke: border ? RULE : undefined, lw: 1.5, r: 10 });

  /* 1. Cover ---------------------------------------------------------- */
  add((pg) => {
    pg.logo(formOf(sec), M, 150, 820, 300, { align: 'left' });
    pg.text('Brand Guidelines', M, 700, { size: 84, font: 'b', color: light });
    const d = new Date();
    pg.text(`Logo assets, colors and usage  •  ${d.toLocaleString('en-US', { month: 'long' })} ${d.getFullYear()}`, M, 820, { size: 26, color: light, opacity: 0.75 });
  });
  pages[0].bg = dark;

  /* 2. Contents (filled after all pages are known) -------------------- */
  add((pg, n) => {
    chrome(pg, n);
    heading(pg, 'Contents');
    const half = Math.ceil(sections.length / 2);
    sections.forEach((s, i) => {
      const col = i < half ? 0 : 1, row = i < half ? i : i - half;
      const x = M + col * 860, y = 280 + row * 74;
      pg.text(String(s.index + 1).padStart(2, '0'), x, y, { size: 24, font: 'b', color: MUTED });
      pg.text(s.title, x + 80, y, { size: 24 });
      pg.line(x, y + 50, x + 760, y + 50, { color: RULE });
    });
  });

  /* 3. Package -------------------------------------------------------- */
  add((pg, n) => {
    chrome(pg, n);
    heading(pg, 'Your logo package', 'Everything you need, organized by logo and by where you will use it.');
    const rows = P.packageOutline(brand);
    const rh = Math.min(36, 760 / rows.length);
    rows.forEach((r, i) => {
      const y = 270 + i * rh;
      const x = M + r.depth * 34;
      // folder / file glyph
      if (r.file) pg.path(`M0 0H11L16 5V20H0Z`, { stroke: MUTED, lw: 1.4, m: [1, 0, 0, 1, x, y + 4] });
      else pg.path('M0 3H7L9 6H20V19H0Z', { stroke: MUTED, lw: 1.4, m: [1, 0, 0, 1, x, y + 4] });
      pg.text(r.name, x + 32, y + 4, { size: Math.min(18, rh * 0.55), font: r.depth <= 1 ? 'b' : 'r' });
      pg.text(r.desc, 1080, y + 4, { size: Math.min(17, rh * 0.52), color: MUTED });
      pg.line(M, y + rh - 4, W - M, y + rh - 4, { color: '#F0F0F2' });
    });
  }, 'Your logo package');

  /* 4. Logo suite ----------------------------------------------------- */
  const fams = L.fams;
  const types = P.TYPES.filter((t) => brand.assets.some((a) => a.type === t.id));
  add((pg, n) => {
    chrome(pg, n);
    heading(pg, 'The logo suite', 'Every version supplied in this package. Dark (primary) versions sit on light backgrounds; light (secondary) versions on dark.');
    const top = 280, left = M + 250, gw = W - M - left, gh = H - top - 90;
    const cw = gw / types.length - 20, ch = gh / fams.length - 20;
    types.forEach((t, j) => pg.text(t.label.toUpperCase(), left + j * (cw + 20), top - 34, { size: 15, font: 'b', color: MUTED, tracking: 0.06 }));
    fams.forEach((f, i) => {
      const y = top + i * (ch + 20);
      pg.text(famTitle(f), M, y + ch / 2 - 14, { size: 22, font: 'b', maxWidth: 230 });
      types.forEach((t, j) => {
        const x = left + j * (cw + 20);
        const p = P.find(brand, f.id, t.id, 'primary'), s = P.find(brand, f.id, t.id, 'secondary');
        tile(pg, x, y, cw / 2 - 4, ch, light);
        tile(pg, x + cw / 2 + 4, y, cw / 2 - 4, ch, dark);
        if (p) pg.logo(formOf(p), x + 18, y + 18, cw / 2 - 40, ch - 36);
        if (s) pg.logo(formOf(s), x + cw / 2 + 22, y + 18, cw / 2 - 40, ch - 36);
      });
    });
  }, 'Logo suite');

  /* 5. Primary & secondary ------------------------------------------- */
  add((pg, n) => {
    chrome(pg, n);
    heading(pg, 'Primary and secondary logo', `The dark logo is the primary logo. The light logo is the secondary logo, for dark backgrounds. Use the supplied files exactly as they are.`);
    const y = 300, w = (W - 2 * M - 40) / 2, h = 520;
    tile(pg, M, y, w, h, '#FFFFFF', true);
    tile(pg, M + w + 40, y, w, h, dark);
    pg.logo(formOf(prim), M + 90, y + 90, w - 180, h - 180);
    pg.logo(formOf(sec), M + w + 130, y + 90, w - 180, h - 180);
    pg.text('Primary', M, y + h + 26, { size: 22, font: 'b' });
    caption(pg, `${prim?.base || ''}  •  for white and light backgrounds`, M, y + h + 60);
    pg.text('Secondary', M + w + 40, y + h + 26, { size: 22, font: 'b' });
    caption(pg, `${sec?.base || ''}  •  for dark backgrounds and photography`, M + w + 40, y + h + 60);
  }, 'Primary and secondary logo');

  /* 6. Versions: logo / no-tag / mark --------------------------------- */
  if (types.length > 1) add((pg, n) => {
    chrome(pg, n);
    heading(pg, 'Choosing a version', 'Each version has a job. Pick the most complete version that stays clear at the size you need.');
    const usage = {
      logo: 'The main logo. Use it whenever there is room for the tagline to be read: websites, documents, signage, presentations.',
      'logo-no-tag': 'For small sizes and tight spaces where the tagline would be too small to read, or when the tagline already appears nearby.',
      mark: 'The symbol on its own. For square and very small spaces: social profile pictures, favicons, app icons, stamps and merchandise details.',
    };
    const cw = (W - 2 * M - 40 * (types.length - 1)) / types.length;
    types.forEach((t, i) => {
      const x = M + i * (cw + 40), y = 300;
      tile(pg, x, y, cw, 400, light);
      pg.logo(formOf(P.find(brand, mainF.id, t.id, 'primary') || P.pick(brand, [t.id], 'primary')), x + 60, y + 70, cw - 120, 260);
      pg.text(t.label, x, y + 430, { size: 24, font: 'b' });
      pg.text(usage[t.id], x, y + 474, { size: 19, color: MUTED, maxWidth: cw - 20 });
    });
  }, 'Choosing a version');

  /* 7. Brand family --------------------------------------------------- */
  if (fams.length > 1) add((pg, n) => {
    chrome(pg, n);
    heading(pg, 'Brand family', 'Each part of the business has its own accent color. Keep each accent with its own logo, and never mix them.');
    const rh = Math.min(200, (H - 300 - 80) / fams.length - 20);
    fams.forEach((f, i) => {
      const y = 290 + i * (rh + 20);
      tile(pg, M, y, 980, rh, light);
      pg.logo(formOf(P.find(brand, f.id, 'logo', 'primary') || P.pick(brand, ['logo', 'logo-no-tag', 'mark'], 'primary', f.id)), M + 50, y + 30, 880, rh - 60, { align: 'left' });
      pg.text(famTitle(f), M + 1030, y + 30, { size: 26, font: 'b' });
      const acc = [...f.accentKeys].map((k) => byKey.get(k)).filter(Boolean);
      acc.forEach((c, j) => {
        pg.rect(M + 1030 + j * 250, y + 84, 56, 56, { fill: c.hex, r: 8 });
        pg.text(c.name, M + 1100 + j * 250, y + 86, { size: 18, font: 'b' });
        pg.text(c.hex.toUpperCase(), M + 1100 + j * 250, y + 112, { size: 16, color: MUTED });
      });
    });
  }, 'Brand family');

  /* 8. Clear space ---------------------------------------------------- */
  const clearPage = (a, label) => (pg, n) => {
    chrome(pg, n);
    heading(pg, `Clear space / ${label}`);
    const f = formOf(a);
    const X = Math.min(f.w, f.h); // X = the logo's shorter side
    const cs = 0.5 * X;
    const maxW = 1100, maxH = 520;
    const s = Math.min(maxW / (f.w + 2 * cs), maxH / (f.h + 2 * cs));
    const ow = (f.w + 2 * cs) * s, oh = (f.h + 2 * cs) * s;
    const ox = (W - ow) / 2, oy = 290 + (maxH + 40 - oh) / 2;
    pg.rect(ox, oy, ow, oh, { fill: '#EEF0F3' });
    pg.rect(ox + cs * s, oy + cs * s, f.w * s, f.h * s, { fill: '#FFFFFF' });
    pg.rect(ox, oy, ow, oh, { stroke: '#9CA3AF', lw: 1.5, dash: [8, 6] });
    pg.rect(ox + cs * s, oy + cs * s, f.w * s, f.h * s, { stroke: '#9CA3AF', lw: 1 });
    pg.place(f, ox + ow / 2, oy + oh / 2, s);
    // dimension markers
    const dim = (x1, y1, x2, y2, t, vertical) => {
      pg.line(x1, y1, x2, y2, { color: '#71717A', lw: 1.5 });
      if (vertical) { pg.line(x1 - 8, y1, x1 + 8, y1, { color: '#71717A' }); pg.line(x2 - 8, y2, x2 + 8, y2, { color: '#71717A' }); pg.text(t, x1 + 18, (y1 + y2) / 2 - 13, { size: 26, font: 'b', color: '#52525B' }); }
      else { pg.line(x1, y1 - 8, x1, y1 + 8, { color: '#71717A' }); pg.line(x2, y2 - 8, x2, y2 + 8, { color: '#71717A' }); pg.text(t, (x1 + x2) / 2, y1 - 44, { size: 26, font: 'b', align: 'center', color: '#52525B' }); }
    };
    dim(ox, oy - 24, ox + cs * s, oy - 24, '½X');
    dim(ox + ow + 28, oy + cs * s, ox + ow + 28, oy + cs * s + X * s, 'X', true);
    pg.text(`Keep a clear space of at least ½X on every side, where X is the ${f.w >= f.h ? 'height' : 'width'} of the logo.`, M, 890, { size: 24 });
    caption(pg, 'Keep text, graphics and the edges of the page or screen out of this area. The space grows and shrinks with the logo.', M, 934);
  };
  add(clearPage(prim, typeLabel(prim.type)), 'Clear space');
  if (markP && markP !== prim && markP.type === 'mark') add(clearPage(markP, 'Mark'));

  /* 9. Minimum size --------------------------------------------------- */
  add((pg, n) => {
    chrome(pg, n);
    heading(pg, 'Minimum size', 'Below these sizes details fill in and text becomes unreadable. Never reproduce the logo smaller.');
    const spec = { logo: [38, 1.5, 160], 'logo-no-tag': [25, 1, 100], mark: [8, 0.3, 24] };
    const cw = (W - 2 * M - 40 * (types.length - 1)) / types.length;
    types.forEach((t, i) => {
      const a = P.find(brand, mainF.id, t.id, 'primary') || P.pick(brand, [t.id], 'primary');
      const f = formOf(a);
      const [mm, inch, px] = spec[t.id];
      const x = M + i * (cw + 40), y = 300;
      tile(pg, x, y, cw, 330, light);
      const wpt = (mm / 25.4) * 72 * 1.6; // shown 1.6x so it reads on screen
      const s = Math.min(wpt / f.w, 200 / f.h);
      pg.place(f, x + cw / 2, y + 165, s);
      pg.text(t.label, x, y + 360, { size: 24, font: 'b' });
      pg.text(`Print: ${mm} mm / ${inch} in wide`, x, y + 404, { size: 20, color: MUTED });
      pg.text(`Screen: ${px} px wide`, x, y + 436, { size: 20, color: MUTED });
    });
    caption(pg, 'Sizes refer to the width of the artwork. For anything smaller than the mark minimum, such as browser tabs, use the supplied favicon files.', M, 920);
  }, 'Minimum size');

  /* 10. Colors -------------------------------------------------------- */
  add((pg, n) => {
    chrome(pg, n);
    heading(pg, 'Brand colors', 'Use HEX and RGB for screens. Use CMYK for print. These are the exact values used in the supplied files.');
    const per = Math.min(colors.length, 4);
    const rows = Math.ceil(colors.length / per);
    const cw = (W - 2 * M - 30 * (per - 1)) / per;
    const ch = Math.min(300, (H - 290 - 70) / rows - 24);
    colors.forEach((c, i) => {
      const x = M + (i % per) * (cw + 30), y = 270 + Math.floor(i / per) * (ch + 24);
      const sh = ch * 0.48;
      pg.rect(x, y, cw, sh, { fill: c.hex, stroke: E.luminance(rgbOf(c.hex)) > 0.9 ? RULE : undefined, r: 8 });
      pg.text(c.name, x, y + sh + 12, { size: 21, font: 'b' });
      let ty = y + sh + 44;
      if (c.note) { pg.text(c.note, x, ty, { size: 16 }); ty += 26; }
      const lines = [`HEX  ${c.hex.toUpperCase()}`, `RGB  ${rgbOf(c.hex).map((v) => Math.round(v * 255)).join(', ')}`];
      if (c.cmyk) lines.push(`CMYK  ${P.cmykText(c.cmyk)}`);
      if (c.pantone) lines.push(`PANTONE  ${c.pantone}`);
      lines.forEach((t, j) => pg.text(t, x, ty + j * 24, { size: 16, color: MUTED }));
    });
    if (brand.pantoneSuggested && colors.some((c) => c.pantone)) caption(pg, 'Pantone values are the closest PANTONE+ Solid Coated matches to the artwork colors. Confirm them against a printed Pantone guide before press.', M, 1000);
  }, 'Brand colors');

  /* 11. Backgrounds --------------------------------------------------- */
  add((pg, n) => {
    chrome(pg, n);
    heading(pg, 'Background usage', 'Approved combinations. Every color in the logo keeps enough contrast against these backgrounds.');
    const combos = [];
    for (const f of fams) {
      for (const role of ['primary', 'secondary']) {
        const a = P.find(brand, f.id, 'logo', role) || P.pick(brand, ['logo', 'logo-no-tag', 'mark'], role, f.id);
        if (a && a.familyId === f.id) for (const bg of P.backgroundsFor(brand, a)) combos.push({ a, bg, f });
      }
    }
    const list = combos.slice(0, 6);
    const per = 3, cw = (W - 2 * M - 60) / per, ch = 250;
    list.forEach(({ a, bg, f }, i) => {
      const x = M + (i % per) * (cw + 30), y = 290 + Math.floor(i / per) * (ch + 90);
      tile(pg, x, y, cw, ch, bg.hex, E.luminance(rgbOf(bg.hex)) > 0.9);
      pg.logo(formOf(a), x + 60, y + 50, cw - 120, ch - 100);
      caption(pg, `${famTitle(f)} ${a.role} on ${bg.name}  \u2022  ${bg.hex}`, x, y + ch + 14);
    });
    caption(pg, `Use the dark (primary) logos on ${colors.find((c) => c.bg === 'light')?.name || 'light backgrounds'} and the light (secondary) logos on ${colors.find((c) => c.bg === 'dark')?.name || 'dark backgrounds'}. Avoid busy photos and other colors.`, M, 1000);
  }, 'Background usage');

  /* 12. Incorrect usage ---------------------------------------------- */
  add((pg, n) => {
    chrome(pg, n);
    heading(pg, 'Incorrect usage', 'Always use the supplied files. Never redraw, distort, recolor or add effects to the logo.');
    const f = formOf(prim);
    const fs = formOf(sec);
    const off = g.form('misuse-recolor', E.recolorPdf(P.rgbPdf(brand, prim), (space, v) => {
      const L0 = space === 'RGB' ? E.luminance(v) : 0.5;
      return { space: 'RGB', values: L0 < 0.4 ? [0.42, 0.25, 0.85] : [0.1, 0.75, 0.55] };
    }));
    const shadow = g.form('misuse-shadow', E.recolorPdf(P.rgbPdf(brand, prim), () => ({ space: 'RGB', values: [0.72, 0.72, 0.74] })));
    const per = 3, cw = (W - 2 * M - 60) / per, ch = 250;
    const cells = [
      ['Do not stretch or squash', (x, y) => pg.logo(f, x + 40, y + 40, cw - 80, ch - 80, { sx: 1.35, sy: 0.7 })],
      ['Do not rotate', (x, y) => pg.logo(f, x + 60, y + 30, cw - 120, ch - 60, { rotate: 12 })],
      ['Do not change the colors', (x, y) => pg.logo(off, x + 60, y + 50, cw - 120, ch - 100)],
      ['Do not add shadows or effects', (x, y) => { const b = pg.logo(shadow, x + 66, y + 58, cw - 120, ch - 100); pg.logo(f, x + 60, y + 50, cw - 120, ch - 100); return b; }],
      ['Do not use on low-contrast colors', (x, y) => { pg.rect(x, y, cw, ch, { fill: dark, r: 10 }); pg.logo(f, x + 60, y + 50, cw - 120, ch - 100); }],
      ['Do not crowd the logo', (x, y) => {
        const b = pg.logo(f, x + 60, y + 70, cw - 120, ch - 140);
        pg.text('OTHER CONTENT', b.x, b.y + b.h + 4, { size: 14, color: '#52525B', font: 'b' });
        pg.rect(b.x + b.w + 6, b.y - 10, 40, b.h + 30, { fill: '#D4D4D8' });
      }],
    ];
    cells.forEach(([label, draw], i) => {
      const x = M + (i % per) * (cw + 30), y = 270 + Math.floor(i / per) * (ch + 90);
      tile(pg, x, y, cw, ch, light);
      draw(x, y);
      pg.path('M0 0L16 16M16 0L0 16', { stroke: '#DC2626', lw: 3, m: [1, 0, 0, 1, x, y + ch + 18] });
      pg.text(label, x + 30, y + ch + 14, { size: 19 });
    });
    void fs;
  }, 'Incorrect usage');

  /* 13. Applications divider ----------------------------------------- */
  add((pg, n) => {
    chrome(pg, n);
    pg.text('BRAND', M + 60, 420, { size: 110, font: 'b' });
    pg.text('APPLICATIONS', M + 60, 540, { size: 110, font: 'b' });
    pg.text('Examples of the identity in use.', M + 66, 690, { size: 28, color: MUTED });
  }, 'Brand applications');
  pages[pages.length - 1].bg = light;

  // Mockups use only the brand's background colours: main logo on light and dark,
  // plus a third item that cycles through the other brand families (or the mark).
  const bgName = (hex) => colors.find((c) => c.hex.toUpperCase() === hex.toUpperCase())?.name || (E.luminance(rgbOf(hex)) > 0.5 ? 'Light' : 'Dark');
  const others = fams.filter((f) => f !== mainF);
  let mockIndex = 0;
  const waysFor = (k) => {
    const third = k % 2 === 0 ? { bg: dark, role: 'secondary' } : { bg: light, role: 'primary' };
    const f = others.length ? others[Math.floor(k / 2) % others.length] : mainF;
    return [
      { bg: light, role: 'primary', family: mainF },
      { bg: dark, role: 'secondary', family: mainF },
      { ...third, family: f, preferMark: !others.length },
    ].map((w) => ({ ...w, name: bgName(w.bg) }));
  };
  const wayAsset = (w, prefer = ['logo', 'logo-no-tag', 'mark']) => {
    const order = w.preferMark ? ['mark', ...prefer] : prefer;
    for (const t of order) { const a = P.find(brand, w.family.id, t, w.role); if (a) return a; }
    return P.pick(brand, order, w.role);
  };
  const shade = (hex) => mix(hex, E.luminance(rgbOf(hex)) > 0.5 ? '#000000' : '#FFFFFF', 0.12);

  const mockPage = (titleText, sub, draw) => { const k = mockIndex++; return (pg, n) => {
    chrome(pg, n);
    heading(pg, titleText, sub);
    const cw = (W - 2 * M) / 3;
    waysFor(k).forEach((w, i) => {
      const cx = M + cw * i + cw / 2;
      draw(pg, cx, w, i);
      pg.text(w.name, cx, 930, { size: 20, align: 'center', font: 'b' });
      caption(pg, `${famTitle(w.family)} \u2022 ${w.role === 'secondary' ? 'Secondary' : 'Primary'} logo`, cx, 962, { align: 'center' });
    });
  }; };
  const shadowUnder = (pg, cx, y, w) => pg.path(ellipse(cx, y, w / 2, 14), { fill: '#000000', opacity: 0.08 });

  add(mockPage('Business cards', 'A simple introduction in the brand palette.', (pg, cx, w) => {
    const cwid = 420, chei = 240;
    shadowUnder(pg, cx, 830, 460);
    for (const [dx, dy, rot] of [[-30, -110, -5], [10, 20, 4]]) {
      const m = mat.mul(mat.mul(mat.t(-cwid / 2, -chei / 2), mat.r(-rot)), mat.t(cx + dx, 600 + dy));
      pg.path(roundRect(0, 0, cwid, chei, 6), { fill: w.bg, stroke: w.bg === '#FFFFFF' || E.luminance(rgbOf(w.bg)) > 0.85 ? '#D4D4D8' : undefined, lw: 1, m });
      const f = formOf(wayAsset(w));
      const s = Math.min((cwid * 0.62) / f.w, (chei * 0.36) / f.h);
      pg.place(f, cx + dx, 600 + dy, s, { rotate: rot });
    }
  }), 'Business cards');

  add(mockPage('Tote bags', 'Everyday essentials in the brand palette.', (pg, cx, w) => {
    const m = mat.mul(mat.t(-200, -250), mat.t(cx, 600));
    shadowUnder(pg, cx, 862, 380);
    pg.path('M110 130V70C110 30 140 8 175 8H225C260 8 290 30 290 70V130', { stroke: shade(w.bg), lw: 26, m, cap: 0 });
    pg.path('M24 128H376L356 470C355 482 348 488 336 488H64C52 488 45 482 44 470Z', { fill: w.bg, stroke: E.luminance(rgbOf(w.bg)) > 0.85 ? '#D4D4D8' : undefined, lw: 1.5, m });
    pg.path('M24 128H376L374 150H26Z', { fill: shade(w.bg), m });
    pg.logo(formOf(wayAsset(w)), cx - 120, 600 - 40, 240, 150);
  }), 'Tote bags');

  add(mockPage('Drinkware', 'A consistent identity on light and dark surfaces.', (pg, cx, w) => {
    const m = mat.mul(mat.t(-75, -250), mat.t(cx, 590));
    shadowUnder(pg, cx, 852, 190);
    pg.path(roundRect(20, 0, 110, 70, 14), { fill: shade(w.bg), m });
    pg.path('M10 60H140V470C140 486 128 500 112 500H38C22 500 10 486 10 470Z', { fill: w.bg, stroke: E.luminance(rgbOf(w.bg)) > 0.85 ? '#D4D4D8' : undefined, lw: 1.5, m });
    pg.path('M10 60H140V80H10Z', { fill: shade(w.bg), m });
    const a = wayAsset(w, ['logo-no-tag', 'logo', 'mark']);
    pg.logo(formOf(a), cx - 46, 590 - 150, 92, 330, { rotate: a.logo.width > a.logo.height ? 90 : 0 });
  }), 'Drinkware');

  add(mockPage('Apparel', 'Relaxed shapes. Understated branding.', (pg, cx, w) => {
    const m = mat.mul(mat.t(-200, -250), mat.t(cx, 590));
    shadowUnder(pg, cx, 852, 300);
    pg.path('M140 20C160 48 240 48 260 20L350 58L398 170L334 196L312 150V488H88V150L66 196L2 170L50 58Z', { fill: w.bg, stroke: E.luminance(rgbOf(w.bg)) > 0.85 ? '#D4D4D8' : shade(w.bg), lw: 2, m });
    pg.path('M140 20C160 48 240 48 260 20', { stroke: shade(w.bg), lw: 10, m });
    const a = wayAsset(w, ['logo-no-tag', 'logo', 'mark']);
    pg.logo(formOf(a), cx - 80, 590 - 150, 160, 60, { align: 'center' });
  }), 'Apparel');

  add((pg, n) => {
    chrome(pg, n);
    heading(pg, 'Stationery', 'Letterhead and envelope with the primary logo.');
    // letterhead
    shadowUnder(pg, 640, 990, 600);
    pg.rect(400, 260, 480, 680, { fill: '#FFFFFF', stroke: '#D4D4D8' });
    pg.logo(formOf(prim), 440, 300, 220, 60, { align: 'left' });
    for (let i = 0; i < 9; i++) pg.rect(440, 440 + i * 28, i === 8 ? 220 : 400, 8, { fill: '#E4E4E7' });
    pg.rect(440, 880, 160, 6, { fill: byKey.get(prim.colorKeys[1])?.hex || '#D4D4D8' });
    // envelope
    shadowUnder(pg, 1320, 760, 700);
    pg.rect(970, 470, 700, 350, { fill: light, stroke: '#D4D4D8' });
    pg.logo(formOf(prim), 1010, 510, 240, 70, { align: 'left' });
    for (let i = 0; i < 3; i++) pg.rect(1330, 660 + i * 26, 240, 8, { fill: '#D4D4D8' });
  }, 'Stationery');

  add((pg, n) => {
    chrome(pg, n);
    heading(pg, 'Digital', 'Website header and social profile.');
    // browser
    shadowUnder(pg, 760, 900, 1100);
    pg.rect(M, 270, 1240, 640, { fill: '#FFFFFF', stroke: '#D4D4D8', r: 16 });
    pg.rect(M, 270, 1240, 56, { fill: '#F4F4F5', r: 16 });
    pg.rect(M, 300, 1240, 26, { fill: '#F4F4F5' });
    [0, 1, 2].forEach((i) => pg.path(ellipse(M + 30 + i * 26, 298, 7, 7), { fill: ['#F87171', '#FBBF24', '#34D399'][i] }));
    pg.rect(M + 140, 286, 600, 26, { fill: '#FFFFFF', r: 13 });
    pg.logo(formOf(noTagP), M + 50, 356, 300, 60, { align: 'left' });
    [0, 1, 2, 3].forEach((i) => pg.rect(M + 820 + i * 100, 382, 70, 10, { fill: '#D4D4D8' }));
    pg.rect(M, 450, 1240, 460, { fill: dark });
    pg.rect(M, 880, 1240, 30, { fill: dark, r: 16 });
    pg.logo(formOf(sec), M + 80, 560, 640, 180, { align: 'left' });
    pg.rect(M + 80, 790, 220, 50, { fill: byKey.get(sec.colorKeys[1])?.hex || light, r: 25 });
    // phone
    const px = 1430, py = 240;
    shadowUnder(pg, px + 170, 930, 300);
    pg.rect(px, py, 340, 680, { fill: '#111111', r: 46 });
    pg.rect(px + 14, py + 14, 312, 652, { fill: '#FFFFFF', r: 36 });
    pg.rect(px + 14, py + 14, 312, 170, { fill: light, r: 36 });
    pg.rect(px + 14, py + 120, 312, 64, { fill: light });
    pg.path(ellipse(px + 170, py + 190, 64, 64), { fill: dark, stroke: '#FFFFFF', lw: 6 });
    pg.logo(formOf(markS), px + 130, py + 150, 80, 80);
    pg.text(brand.name, px + 170, py + 274, { size: 22, font: 'b', align: 'center' });
    for (let i = 0; i < 3; i++) pg.rect(px + 60, py + 330 + i * 26, 220 - i * 40, 8, { fill: '#E4E4E7' });
    for (let i = 0; i < 6; i++) pg.rect(px + 30 + (i % 3) * 96, py + 440 + Math.floor(i / 3) * 96, 88, 88, { fill: i % 2 ? light : '#E4E4E7' });
  }, 'Digital');

  /* File guide -------------------------------------------------------- */
  add((pg, n) => {
    chrome(pg, n);
    heading(pg, 'Which file do I use?', 'A quick reference for you, your printer, your web developer and anyone else working with the brand.');
    const rows = [
      ['Printing: business cards, brochures, merchandise', 'EPS or PDF (CMYK)', '01_Print_CMYK'],
      ['Signs, vinyl, embroidery, engraving', 'EPS (vector)', '01_Print_CMYK / 01_EPS'],
      ['Websites and apps', 'SVG, or WEBP for speed', '02_Digital_RGB / 01_SVG, 04_WEBP'],
      ['Presentations and documents', 'PNG (transparent), 1024 or 2048 px', '02_Digital_RGB / 02_PNG'],
      ['Places that do not support transparency', brand.jpgOnWhite === false ? 'JPG on a brand background' : `JPG on white or ${colors.find((c) => c.bg === 'dark')?.name || 'the dark color'}`, '02_Digital_RGB / 03_JPG'],
      ['Social media profiles and covers', 'Ready-made PNGs per platform', L.extras.social.split('/').pop()],
      ['Email signatures', 'PNG, 600 px file shown at 300 px', L.extras.email.split('/').pop()],
      ['Website tab and home screen icons', 'Favicon set (open setup.html)', L.extras.icons.split('/').pop()],
      ['Colors for designers and developers', '.ase for Adobe, .css / .json for code', L.extras.colors.split('/').pop()],
    ];
    pg.text('I NEED TO…', M, 268, { size: 15, font: 'b', color: MUTED, tracking: 0.06 });
    pg.text('USE', 900, 268, { size: 15, font: 'b', color: MUTED, tracking: 0.06 });
    pg.text('FOLDER', 1360, 268, { size: 15, font: 'b', color: MUTED, tracking: 0.06 });
    rows.forEach((r, i) => {
      const y = 310 + i * 70;
      pg.line(M, y - 14, W - M, y - 14, { color: RULE });
      pg.text(r[0], M, y, { size: 21 });
      pg.text(r[1], 900, y, { size: 21, font: 'b' });
      pg.text(r[2], 1360, y, { size: 17, color: MUTED });
    });
  }, 'Which file do I use?');

  /* File names -------------------------------------------------------- */
  add((pg, n) => {
    chrome(pg, n);
    heading(pg, 'How files are named', 'Every file name says what it is, so the right file is easy to find.');
    const sampleA = brand.assets.find((a) => a.type === 'logo-no-tag' && a.role === 'primary' && !familyIsMain(a)) || noTagP || prim;
    function familyIsMain(a) { return P.familyOf(brand, a)?.isMain; }
    const fam = P.familyOf(brand, sampleA);
    const parts = [
      [P.slug(brand.name), 'Company'],
      fam?.name ? [P.slug(fam.name), 'Brand family'] : null,
      sampleA.type === 'mark' ? ['mark', 'Version: mark'] : sampleA.type === 'logo-no-tag' ? ['no-tag', 'Version: no tagline'] : null,
      [sampleA.role, sampleA.role === 'primary' ? 'Primary (dark)' : 'Secondary (light)'],
      ['rgb', 'Color mode'],
      ['1024px', 'Size'],
    ].filter(Boolean);
    let x = M;
    const y = 360;
    parts.forEach(([t, label], i) => {
      const tw = g.measure(t, 44, 'b');
      pg.text(t, x, y, { size: 44, font: 'b', color: i % 2 ? '#3F3F46' : INK });
      pg.line(x, y + 70, x + tw, y + 70, { color: '#A1A1AA', lw: 2 });
      pg.text(label, x, y + 86, { size: 17, color: MUTED });
      x += tw;
      if (i < parts.length - 1) { pg.text('-', x + 4, y, { size: 44, color: '#A1A1AA' }); x += g.measure('-', 44) + 12; }
    });
    pg.text('.png', x + 4, y, { size: 44, color: '#A1A1AA' });
    const notes = [
      ['Company first', `Every file starts with ${P.slug(brand.name)}.`],
      ['The main logo has no extra label', 'The logo with its tagline is the main logo. Versions without the tagline add "no-tag"; the symbol on its own adds "mark".'],
      ['Primary and secondary', 'Primary is the dark logo for light backgrounds. Secondary is the light logo for dark backgrounds.'],
      ['Color mode', '"cmyk" files are for print. "rgb" files are for screens. JPGs add the background color, for example "on-white".'],
    ];
    notes.forEach(([h, t], i) => {
      const nx = M + (i % 2) * 860, ny = 580 + Math.floor(i / 2) * 170;
      pg.text(h, nx, ny, { size: 22, font: 'b' });
      pg.text(t, nx, ny + 38, { size: 19, color: MUTED, maxWidth: 780 });
    });
  }, 'How files are named');

  /* Back cover -------------------------------------------------------- */
  add((pg) => {
    const b = pg.logo(formOf(prim), W / 2 - 330, H / 2 - 140, 660, 220);
    pg.text('Logo assets & usage guidelines', W / 2, b.y + b.h + 70, { size: 22, color: MUTED, align: 'center' });
  });

  // Render.
  pages.forEach((fn, i) => {
    const pg = g.page(fn.bg || '#FFFFFF');
    fn(pg, i + 1);
    pg.finish();
  });
  return g.save();
}

export { W as GUIDE_W, H as GUIDE_H };
