// Brand package model: scan uploaded logos, classify them, name every file,
// and build the folder structure with all formats.

import * as E from './engine.js';

/* ------------------------------------------------------------------ */
/* Colour helpers                                                       */
/* ------------------------------------------------------------------ */

export const slug = (s) => String(s || '').trim().toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const folderName = (s) => String(s || '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const pad2 = (n) => String(n).padStart(2, '0');

const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const relLum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a, b) => {
  const la = relLum(a), lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
export const saturation = (rgb) => Math.max(...rgb) - Math.min(...rgb);
export function hue([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 1e-6) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueDist = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
export const isNeutral = (rgb) => saturation(rgb) < 0.12;

function autoColorName(rgb) {
  const L = E.luminance(rgb);
  if (isNeutral(rgb)) {
    if (L < 0.08) return 'Black';
    if (L < 0.25) return 'Charcoal';
    if (L > 0.97) return 'White';
    if (L > 0.85) return 'Off-White';
    return 'Gray';
  }
  const h = hue(rgb);
  const dark = L < 0.35;
  if (h < 12 || h >= 345) return dark ? 'Maroon' : 'Red';
  if (h < 32) return dark ? 'Rust' : 'Orange';
  if (h < 52) return dark ? 'Bronze' : 'Gold';
  if (h < 70) return 'Yellow';
  if (h < 160) return dark ? 'Forest' : 'Green';
  if (h < 195) return 'Teal';
  if (h < 250) return dark ? 'Navy' : 'Blue';
  if (h < 290) return 'Purple';
  return 'Magenta';
}

/* ------------------------------------------------------------------ */
/* Scan: colours, roles, types, families                                */
/* ------------------------------------------------------------------ */

/** Merge every asset's palette into one brand colour list (exact values). */
export function collectColors(assets, previous = []) {
  const prev = new Map(previous.map((c) => [c.key, c]));
  const map = new Map();
  for (const a of assets) {
    a.colorKeys = [];
    for (const c of a.analysis.palette) {
      const space = c.space === 'CMYK' || c.space === 'RGB' || c.space === 'Gray' ? c.space : null;
      if (!space) continue;
      const values = c.values.map((v) => +v.toFixed(6));
      const key = space + ':' + values.join(',');
      let e = map.get(key);
      if (!e) {
        const old = prev.get(key);
        e = {
          key, space, values,
          cmyk: space === 'CMYK' ? values : space === 'Gray' ? [0, 0, 0, +(1 - values[0]).toFixed(6)] : null,
          sourceRgb: space === 'RGB' ? values : null,
          artHex: c.hex, // how the artwork itself renders (colour-managed CMYK -> sRGB)
          hex: old?.hex || c.hex, name: old?.name || '', pantone: old?.pantone || '', note: old?.note || '', named: !!old?.named,
          bg: old ? old.bg : undefined,
          area: 0,
        };
        map.set(key, e);
      }
      e.area += c.area;
      a.colorKeys.push(key);
    }
    a.dominantKey = a.colorKeys[0];
  }
  const colors = [...map.values()];
  // Keep the user's order for colours seen before; new ones: neutrals first (dark to light), then accents by hue.
  const prevIndex = new Map(previous.map((c, i) => [c.key, i]));
  colors.sort((x, y) => {
    const px = prevIndex.has(x.key), py = prevIndex.has(y.key);
    if (px && py) return prevIndex.get(x.key) - prevIndex.get(y.key);
    if (px !== py) return px ? -1 : 1;
    const rx = E.hexToRgb(x.hex), ry = E.hexToRgb(y.hex);
    const nx = isNeutral(rx), ny = isNeutral(ry);
    if (nx !== ny) return nx ? -1 : 1;
    if (nx) return E.luminance(rx) - E.luminance(ry);
    return hue(rx) - hue(ry) || E.luminance(rx) - E.luminance(ry);
  });
  // Unique, readable default names ("Blue", "Blue Light").
  const used = new Map();
  for (const c of colors) if (!c.named) {
    const base = autoColorName(E.hexToRgb(c.hex));
    const list = used.get(base) || [];
    list.push(c);
    used.set(base, list);
  }
  for (const [base, list] of used) {
    list.sort((x, y) => E.luminance(E.hexToRgb(x.hex)) - E.luminance(E.hexToRgb(y.hex)));
    list.forEach((c, i) => { c.name = list.length === 1 ? base : i === 0 ? base : `${base} ${i === 1 ? 'Light' : 'Light ' + i}`; });
  }
  // Background roles: by default the darkest and lightest neutrals.
  if (!colors.some((c) => c.bg)) {
    const neutral = colors.filter((c) => isNeutral(E.hexToRgb(c.hex)));
    const byL = neutral.slice().sort((x, y) => E.luminance(E.hexToRgb(x.hex)) - E.luminance(E.hexToRgb(y.hex)));
    if (byL[0] && E.luminance(E.hexToRgb(byL[0].hex)) < 0.3) byL[0].bg = 'dark';
    const top = byL[byL.length - 1];
    if (top && E.luminance(E.hexToRgb(top.hex)) > 0.75) top.bg = 'light';
  }
  for (const c of colors) if (c.bg === undefined) c.bg = null;
  return colors;
}

/** The brand's light / dark background colours (fall back to white / near-black). */
export const lightBackground = (brand) => brand.colors.find((c) => c.bg === 'light')?.hex || '#FFFFFF';
export const darkBackground = (brand) => brand.colors.find((c) => c.bg === 'dark')?.hex || '#111111';

/* ------------------------------------------------------------------ */
/* Pantone suggestions (CIEDE2000 against a reference book)             */
/* ------------------------------------------------------------------ */

function hexToLab(hex) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = E.hexToRgb(hex).map(lin);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
export function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) * deg + 360) % 360, h2p = (Math.atan2(b2, a2p) * deg + 360) % 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dh = h2p - h1p;
  if (C1p * C2p === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) hbp = Math.abs(h1p - h2p) <= 180 ? (h1p + h2p) / 2 : h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dth = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2), Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dth * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}
/** Closest Pantone in `book` ({name: hex}); null when nothing is within maxDE. */
export function nearestPantone(hex, book, maxDE = 4) {
  const lab = hexToLab(hex);
  let best = null;
  for (const [name, h] of Object.entries(book)) {
    const d = deltaE2000(lab, hexToLab(h));
    if (!best || d < best.de) best = { name, de: d };
  }
  return best && best.de <= maxDE ? best : null;
}

const ASPECT_MARK = 1.5;

/**
 * Propose role (primary = dark / secondary = light), type (logo / logo-no-tag / mark)
 * and family (grouped by accent colour) for every asset.
 */
export function classify(assets, colors) {
  const byKey = new Map(colors.map((c) => [c.key, c]));
  const rgbOf = (k) => E.hexToRgb(byKey.get(k)?.hex || '#000000');

  for (const a of assets) {
    a.role = E.luminance(rgbOf(a.dominantKey)) < 0.5 ? 'primary' : 'secondary';
    a.aspect = a.logo.width / a.logo.height;
    a.accentKey = a.colorKeys.slice(1).find((k) => saturation(rgbOf(k)) > 0.15) || null;
    a.accentHue = a.accentKey ? hue(rgbOf(a.accentKey)) : null;
  }

  // Types: marks are compact; among same-width logos the simplest is the no-tag version.
  const wide = assets.filter((a) => a.aspect >= ASPECT_MARK);
  for (const a of assets) if (a.aspect < ASPECT_MARK) a.type = 'mark';
  const groups = new Map();
  for (const a of wide) {
    const k = Math.round(a.logo.width);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  for (const g of groups.values()) {
    const counts = g.map((a) => a.analysis.elements.length);
    const min = Math.min(...counts);
    const distinct = new Set(counts).size > 1;
    for (const a of g) a.type = distinct && a.analysis.elements.length === min ? 'logo-no-tag' : 'logo';
  }

  // Families: cluster by accent hue.
  const families = [];
  for (const a of assets) {
    let fam = families.find((f) => (f.hue === null && a.accentHue === null) || (f.hue !== null && a.accentHue !== null && hueDist(f.hue, a.accentHue) < 18));
    if (!fam) {
      fam = { id: 'f' + (families.length + 1), hue: a.accentHue, name: '', isMain: false, accentKeys: new Set(), order: families.length };
      families.push(fam);
    }
    if (a.accentKey) fam.accentKeys.add(a.accentKey);
    a.familyId = fam.id;
  }
  // Main family: the one holding the most detailed tagged logo.
  const score = (f) => Math.max(0, ...assets.filter((a) => a.familyId === f.id && a.type === 'logo').map((a) => a.analysis.elements.length));
  const main = families.slice().sort((x, y) => score(y) - score(x))[0];
  if (main) main.isMain = true;
  for (const f of families) {
    if (f.isMain) continue;
    const k = [...f.accentKeys][0];
    f.name = k ? byKey.get(k).name.replace(/ Light.*$/, '') : 'Alt';
  }
  families.sort((x, y) => (y.isMain - x.isMain) || (x.order - y.order)); // upload order
  return families;
}

/* ------------------------------------------------------------------ */
/* Naming                                                               */
/* ------------------------------------------------------------------ */

export const TYPES = [
  { id: 'logo', label: 'Logo', folder: 'Logo', desc: 'The main logo, with tagline' },
  { id: 'logo-no-tag', label: 'Logo, no tag', folder: 'Logo_No-Tag', desc: 'The logo without its tagline' },
  { id: 'mark', label: 'Mark', folder: 'Mark', desc: 'The standalone symbol' },
];
export const ROLES = [
  { id: 'primary', label: 'Primary', desc: 'Dark logo for light backgrounds' },
  { id: 'secondary', label: 'Secondary', desc: 'Light logo for dark backgrounds' },
];

export const familyOf = (brand, a) => brand.families.find((f) => f.id === a.familyId);
export const familyTitle = (brand, f) => [brand.name, f?.name].filter(Boolean).join(' ');

/** company[-family][-mark|-no-tag]-primary|secondary  (the tagged logo is the main logo: no suffix) */
export function assignNames(brand) {
  const seen = new Map();
  for (const a of brand.assets) {
    const fam = familyOf(brand, a);
    const parts = [slug(brand.name) || 'brand', slug(fam?.name), a.type === 'mark' ? 'mark' : '', a.type === 'logo-no-tag' ? 'no-tag' : '', a.role];
    let base = parts.filter(Boolean).join('-');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    if (n > 1) base += '-' + n;
    a.base = base;
  }
}

/* ------------------------------------------------------------------ */
/* Backgrounds                                                          */
/* ------------------------------------------------------------------ */

export function brandColorEntries(brand) {
  return brand.colors.map((c) => ({ space: c.space, values: c.values, rgb: E.hexToRgb(c.hex) }));
}

/** JPG backgrounds: plain white instead of the light brand colour (default), dark brand colour as is. */
export function jpgBackgroundsFor(brand, a) {
  if (brand.jpgOnWhite === false) return backgroundsFor(brand, a);
  const swapped = { ...brand, colors: brand.colors.map((c) => (c.bg === 'light' ? { ...c, hex: '#FFFFFF', name: 'White' } : c)) };
  return backgroundsFor(swapped, a);
}

/** Backgrounds a logo may sit on: the brand's background colours that keep enough contrast. */
export function backgroundsFor(brand, a) {
  const byKey = new Map(brand.colors.map((c) => [c.key, c]));
  const logoHex = new Set(a.colorKeys.map((k) => byKey.get(k)?.hex.toUpperCase()));
  const dom = E.hexToRgb(byKey.get(a.dominantKey).hex);
  const others = a.colorKeys.slice(1).map((k) => E.hexToRgb(byKey.get(k).hex));
  const brandBgs = brand.colors.filter((c) => c.bg).map((c) => ({ name: c.name, hex: c.hex.toUpperCase(), key: c.key }));
  const cands = brandBgs.length ? brandBgs : [{ name: 'White', hex: '#FFFFFF' }, { name: 'Black', hex: '#000000' }];
  const out = [];
  const seenHex = new Set();
  for (const bg of cands) {
    if (seenHex.has(bg.hex) || logoHex.has(bg.hex)) continue;
    const rgb = E.hexToRgb(bg.hex);
    if (contrast(dom, rgb) < 3 || others.some((o) => contrast(o, rgb) < 2)) continue;
    seenHex.add(bg.hex);
    out.push({ ...bg, rgb, slug: slug(bg.name) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Package                                                              */
/* ------------------------------------------------------------------ */

export const PNG_SIZES = [
  { folder: '01_Small', px: 512 },
  { folder: '02_Medium', px: 1024 },
  { folder: '03_Large', px: 2048 },
  { folder: '04_Extra_Large', px: 4096 },
];

export const SOCIAL = [
  { id: 'profile', label: 'Profile picture', w: 1080, h: 1080, use: 'mark', inset: 0.24 },
  { id: 'linkedin-cover', label: 'LinkedIn cover', w: 1584, h: 396, use: 'logo', inset: 0.3 },
  { id: 'x-header', label: 'X (Twitter) header', w: 1500, h: 500, use: 'logo', inset: 0.32 },
  { id: 'facebook-cover', label: 'Facebook cover', w: 1640, h: 624, use: 'logo', inset: 0.32 },
  { id: 'youtube-banner', label: 'YouTube banner', w: 2560, h: 1440, use: 'logo', inset: 0.44 },
  { id: 'open-graph', label: 'Link preview (Open Graph)', w: 1200, h: 630, use: 'logo', inset: 0.3 },
];

const longestTo = (logo, px) => (logo.width >= logo.height ? px : px * (logo.width / logo.height));

/** Canvas with the logo plus breathing room: returns render() options. */
function paddedBox(logo, longest, padFrac = 0.3) {
  const p = padFrac * Math.min(logo.width, logo.height);
  const s = longest / (Math.max(logo.width, logo.height) + 2 * p);
  const cw = Math.round((logo.width + 2 * p) * s), ch = Math.round((logo.height + 2 * p) * s);
  return { box: [cw, ch], inset: (p * s) / Math.min(cw, ch) };
}

/** The asset of a family/type/role, if uploaded. */
export const find = (brand, familyId, type, role) =>
  brand.assets.find((a) => a.familyId === familyId && a.type === type && a.role === role);

export function mainFamily(brand) { return brand.families.find((f) => f.isMain) || brand.families[0]; }

/** Best asset for a job, with fallbacks (e.g. icon: mark, else no-tag, else logo). */
export function pick(brand, prefer, role, familyId = mainFamily(brand)?.id) {
  for (const t of prefer) {
    const a = find(brand, familyId, t, role) || brand.assets.find((x) => x.type === t && x.role === role);
    if (a) return a;
  }
  return brand.assets.find((x) => x.role === role) || brand.assets[0];
}

/** Digital PDF (official RGB) for an asset, cached. */
export function rgbPdf(brand, a) {
  const sig = brand.colors.map((c) => c.key + c.hex).join('|');
  if (a._rgbSig !== sig) { a._rgb = E.brandRgbPdf(a.logo.pdf, brandColorEntries(brand)); a._rgbSig = sig; }
  return a._rgb;
}

/** Combine light/dark mark SVGs into one favicon that follows the browser theme. */
function faviconSvg(lightSvg, darkSvg, w, h) {
  const inner = (svg, prefix) => {
    const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    return body.replace(/id="([^"]+)"/g, `id="${prefix}$1"`).replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`).replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`);
  };
  const S = 1024, m = 64;
  const sc = (S - 2 * m) / Math.max(w, h);
  const x = (S - w * sc) / 2, y = (S - h * sc) / 2;
  const g = (body, cls) => `<svg class="${cls}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(w * sc).toFixed(2)}" height="${(h * sc).toFixed(2)}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
<style>.dark{display:none}@media (prefers-color-scheme:dark){.light{display:none}.dark{display:inline}}</style>
${g(inner(lightSvg, 'l-'), 'light')}
${darkSvg ? g(inner(darkSvg, 'd-'), 'dark') : ''}
</svg>
`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function setupHtml(brand, light, dark) {
  const name = esc(brand.name);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} website icons</title>
<style>
body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;max-width:760px;margin:48px auto;padding:0 20px;background:#fff}
h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:32px 0 8px}p,li{color:#444}
pre{background:#f4f4f5;border-radius:10px;padding:16px;overflow:auto;font-size:13px}
.row{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin:16px 0}
.tile{width:96px;height:96px;border-radius:22px;display:grid;place-items:center;border:1px solid #e4e4e7}
.tile img{width:64px;height:64px}
table{border-collapse:collapse;width:100%;font-size:14px}td{border-top:1px solid #eee;padding:8px 4px;vertical-align:top}td:first-child{font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
</style></head><body>
<h1>Set up your website icons</h1>
<p>Copy the files in this folder to the root of your website, then paste these tags inside <code>&lt;head&gt;</code>. If you use another folder, update the paths.</p>
<pre>&lt;link rel="icon" href="/favicon.ico" sizes="48x48"&gt;
&lt;link rel="icon" href="/favicon.svg" type="image/svg+xml"&gt;
&lt;link rel="icon" href="/favicon-96.png" type="image/png" sizes="96x96"&gt;
&lt;link rel="apple-touch-icon" href="/apple-touch-icon.png"&gt;
&lt;link rel="manifest" href="/site.webmanifest"&gt;</pre>
<div class="row">
<div class="tile" style="background:${light}"><img src="favicon.svg" alt=""></div>
<div class="tile" style="background:${dark}"><img src="icon-512.png" alt=""></div>
<div class="tile" style="background:#fff"><img src="apple-touch-icon.png" alt="" style="border-radius:14px"></div>
</div>
<h2>What each file is for</h2>
<table>
<tr><td>favicon.ico</td><td>Browser tab icon, 16, 32 and 48 px. Older browsers and Windows.</td></tr>
<tr><td>favicon.svg</td><td>Sharp at any size. Switches to the light version when the browser is in dark mode.</td></tr>
<tr><td>favicon-96.png</td><td>PNG fallback for browsers without SVG icon support.</td></tr>
<tr><td>apple-touch-icon.png</td><td>180 px, solid background. Used when someone adds the site to an iPhone or iPad home screen.</td></tr>
<tr><td>icon-192.png, icon-512.png</td><td>Android home screen and installed web app icons (listed in site.webmanifest).</td></tr>
<tr><td>icon-1024.png</td><td>Large square icon with a solid background, for app stores and anywhere a big square avatar is needed.</td></tr>
<tr><td>site.webmanifest</td><td>Tells Android and Chrome the site name, colours and icons.</td></tr>
</table>
</body></html>
`;
}

function colorsCss(brand) {
  const lines = brand.colors.map((c) => `  --${slug(brand.name)}-${slug(c.name)}: ${c.hex.toUpperCase()};`);
  return `/* ${brand.name} brand colours: official digital (RGB) values */\n:root {\n${lines.join('\n')}\n}\n`;
}
function colorsJson(brand) {
  return JSON.stringify({
    brand: brand.name,
    colors: brand.colors.map((c) => ({
      name: c.name, note: c.note || null, hex: c.hex.toUpperCase(), rgb: E.hexToRgb(c.hex).map((v) => Math.round(v * 255)),
      cmyk: c.cmyk ? c.cmyk.map((v) => +(v * 100).toFixed(4)) : null, pantone: c.pantone || null,
    })),
  }, null, 2) + '\n';
}
export const cmykText = (cmyk) => cmyk ? cmyk.map((v) => +(v * 100).toFixed(2)).join(', ') : '';
function colorsTxt(brand) {
  const out = [`${brand.name} brand colors`, '', 'Use HEX and RGB on screens. Use CMYK (or Pantone) in print.'];
  if (brand.pantoneSuggested) out.push('Pantone values are the closest PANTONE+ Solid Coated matches. Confirm them against a printed Pantone guide.');
  out.push('');
  for (const c of brand.colors) {
    out.push(c.name + (c.note ? `  (${c.note})` : ''));
    out.push(`  HEX      ${c.hex.toUpperCase()}`);
    out.push(`  RGB      ${E.hexToRgb(c.hex).map((v) => Math.round(v * 255)).join(', ')}`);
    if (c.cmyk) out.push(`  CMYK     ${cmykText(c.cmyk)}`);
    if (c.pantone) out.push(`  Pantone  ${c.pantone}`);
    out.push('');
  }
  return out.join('\r\n');
}

/** Folder layout for the whole package. Returns helpers for paths. */
export function layout(brand) {
  const root = `${folderName(brand.name) || 'Brand'}_Brand_Assets`;
  const fams = brand.families.filter((f) => brand.assets.some((a) => a.familyId === f.id));
  const multi = fams.length > 1;
  const famFolder = new Map();
  let n = 1;
  for (const f of fams) famFolder.set(f.id, multi ? `${pad2(n++)}_${folderName(familyTitle(brand, f))}` : '');
  const typeFolder = (f, type) => {
    const present = TYPES.filter((t) => brand.assets.some((a) => a.familyId === f.id && a.type === t.id));
    const i = present.findIndex((t) => t.id === type);
    return `${pad2(i + 1)}_${present[i].folder}`;
  };
  const assetDir = (a) => {
    const f = familyOf(brand, a);
    return [root, famFolder.get(f.id), multi ? typeFolder(f, a.type) : `${pad2(n0(a))}_${TYPES.find((t) => t.id === a.type).folder}`].filter(Boolean).join('/');
  };
  const n0 = (a) => TYPES.filter((t) => brand.assets.some((x) => x.type === t.id)).findIndex((t) => t.id === a.type) + 1;
  const extraStart = multi ? fams.length + 1 : TYPES.filter((t) => brand.assets.some((x) => x.type === t.id)).length + 1;
  const extras = {
    icons: `${root}/${pad2(extraStart)}_Favicon_and_App_Icons`,
    social: `${root}/${pad2(extraStart + 1)}_Social_Media`,
    email: `${root}/${pad2(extraStart + 2)}_Email_Signature`,
    colors: `${root}/${pad2(extraStart + 3)}_Brand_Colors`,
  };
  const guideName = `${folderName(brand.name) || 'Brand'}_Brand_Guidelines.pdf`;
  return { root, multi, fams, famFolder, typeFolder, assetDir, extras, guideName };
}

/** A readable outline of the package for the guide's "Your package" page. */
export function packageOutline(brand) {
  const L = layout(brand);
  const rows = [{ depth: 0, name: `${L.root}.zip`, desc: 'Everything below, organized by logo and file type.', file: true }];
  rows.push({ depth: 1, name: L.guideName, desc: 'This guide: how to use the logo, colors and files.', file: true });
  const fmt = (d) => [
    { depth: d, name: '01_Print_CMYK', desc: 'For printing. Exact CMYK colors.' },
    { depth: d + 1, name: '01_EPS', desc: 'Vector artwork for print production and sign makers.' },
    { depth: d + 1, name: '02_PDF', desc: 'Vector artwork for print, viewing and sharing.' },
    { depth: d, name: '02_Digital_RGB', desc: 'For screens. Official HEX / RGB colors.' },
    { depth: d + 1, name: '01_SVG', desc: 'Scalable artwork for websites and apps.' },
    { depth: d + 1, name: '02_PNG', desc: 'Transparent background. 512 to 4096 px.' },
    { depth: d + 1, name: '03_JPG', desc: brand.jpgOnWhite === false ? 'Solid brand backgrounds.' : 'Solid backgrounds: white, or the dark brand color.' },
    { depth: d + 1, name: '04_WEBP', desc: 'Lightweight transparent images for websites.' },
  ];
  if (L.multi) {
    L.fams.forEach((f, i) => {
      rows.push({ depth: 1, name: L.famFolder.get(f.id), desc: i === 0 ? `${familyTitle(brand, f)} logos.` : `${familyTitle(brand, f)} logos. Same structure.` });
      if (i === 0) {
        TYPES.filter((t) => brand.assets.some((a) => a.familyId === f.id && a.type === t.id)).forEach((t, j) => {
          rows.push({ depth: 2, name: L.typeFolder(f, t.id), desc: t.desc + (j === 0 ? '. Format structure shown once.' : '.') });
          if (j === 0) rows.push(...fmt(3));
        });
      }
    });
  } else {
    TYPES.filter((t) => brand.assets.some((a) => a.type === t.id)).forEach((t, j) => {
      rows.push({ depth: 1, name: L.assetDir(brand.assets.find((a) => a.type === t.id)).split('/').pop(), desc: t.desc + '.' });
      if (j === 0) rows.push(...fmt(2));
    });
  }
  rows.push({ depth: 1, name: L.extras.icons.split('/').pop(), desc: 'Website and app icons, with setup instructions.' });
  rows.push({ depth: 1, name: L.extras.social.split('/').pop(), desc: 'Profile pictures and cover images sized for each platform.' });
  rows.push({ depth: 1, name: L.extras.email.split('/').pop(), desc: 'Small logos for email signatures.' });
  rows.push({ depth: 1, name: L.extras.colors.split('/').pop(), desc: 'Color values and swatch files (Adobe, CSS, JSON).' });
  return rows;
}

/**
 * Build every file. `out(path, bytes|string)` receives each one.
 * opts.webp(pngBytes) -> Promise<bytes>, opts.progress(text, fraction), opts.guide() -> Promise<bytes>
 */
export async function buildPackage(brand, out, opts = {}) {
  const progress = opts.progress || (() => {});
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const L = layout(brand);
  const b = slug(brand.name) || 'brand';
  assignNames(brand);

  const assets = [...brand.assets].sort((x, y) =>
    L.fams.findIndex((f) => f.id === x.familyId) - L.fams.findIndex((f) => f.id === y.familyId)
    || TYPES.findIndex((t) => t.id === x.type) - TYPES.findIndex((t) => t.id === y.type)
    || (x.role === 'primary' ? -1 : 1));
  const total = assets.length + 5;
  let step = 0;

  for (const a of assets) {
    progress(`${a.base}`, step++ / total);
    await tick();
    const dir = L.assetDir(a);
    const print = `${dir}/01_Print_CMYK`, digital = `${dir}/02_Digital_RGB`;
    const allCmyk = a.colorKeys.every((k) => k.startsWith('CMYK:') || k.startsWith('Gray:'));
    const mode = allCmyk ? 'cmyk' : 'print';
    // EPS: the designer's original file, untouched.
    out(`${print}/01_EPS/${a.base}-${mode}.eps`, a.logo.kind === 'eps' ? a.bytes : await E.toEps(a.logo.pdf));
    out(`${print}/02_PDF/${a.base}-${mode}.pdf`, a.logo.pdf);

    const rgb = rgbPdf(brand, a);
    out(`${digital}/01_SVG/${a.base}-rgb.svg`, E.toSvg(rgb));
    for (const s of PNG_SIZES) {
      const png = E.render(rgb, { width: longestTo(a.logo, s.px) });
      out(`${digital}/02_PNG/${s.folder}/${a.base}-rgb-${s.px}px.png`, png);
      if (opts.webp !== false) out(`${digital}/04_WEBP/${s.folder}/${a.base}-rgb-${s.px}px.webp`, await E.renderWebp(rgb, { width: longestTo(a.logo, s.px) }));
      await tick();
    }
    for (const bg of jpgBackgroundsFor(brand, a)) {
      out(`${digital}/03_JPG/${a.base}-rgb-on-${bg.slug}.jpg`,
        E.render(rgb, { ...paddedBox(a.logo, 2400), background: bg.rgb, format: 'jpg', quality: 95 }));
    }
  }

  // Favicon & app icons (from the main family's mark).
  progress('Favicon and app icons', step++ / total);
  await tick();
  const iconP = pick(brand, ['mark', 'logo-no-tag', 'logo'], 'primary');
  const iconS = pick(brand, ['mark', 'logo-no-tag', 'logo'], 'secondary');
  const lightBg = lightBackground(brand);
  const darkBg = darkBackground(brand);
  if (iconP) {
    const p = rgbPdf(brand, iconP);
    const sq = (size, inset, bg) => E.render(p, { box: [size, size], inset, background: bg ? E.hexToRgb(bg) : null });
    const ico = [16, 32, 48].map((size) => ({ size, bytes: sq(size, 0.04) }));
    const dir = L.extras.icons;
    out(`${dir}/favicon.ico`, E.buildIco(ico));
    out(`${dir}/favicon.svg`, faviconSvg(E.toSvg(p), iconS && iconS !== iconP ? E.toSvg(rgbPdf(brand, iconS)) : null, iconP.logo.width, iconP.logo.height));
    out(`${dir}/favicon-96.png`, sq(96, 0.06));
    out(`${dir}/apple-touch-icon.png`, sq(180, 0.16, lightBg));
    out(`${dir}/icon-192.png`, sq(192, 0.16, lightBg));
    out(`${dir}/icon-512.png`, sq(512, 0.16, lightBg));
    out(`${dir}/icon-1024.png`, sq(1024, 0.16, lightBg));
    out(`${dir}/site.webmanifest`, JSON.stringify({
      name: brand.name, short_name: brand.name,
      icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
      theme_color: lightBg, background_color: lightBg, display: 'standalone',
    }, null, 2) + '\n');
    out(`${dir}/setup.html`, setupHtml(brand, lightBg, darkBg));
  }

  // Social media.
  progress('Social media images', step++ / total);
  await tick();
  const socialSets = [
    { tag: 'light', bg: lightBg, role: 'primary' },
    { tag: 'dark', bg: darkBg, role: 'secondary' },
  ];
  for (const s of SOCIAL) {
    for (const set of socialSets) {
      const a = s.use === 'mark' ? pick(brand, ['mark', 'logo-no-tag', 'logo'], set.role) : pick(brand, ['logo', 'logo-no-tag'], set.role);
      if (!a) continue;
      out(`${L.extras.social}/${b}-${s.id}-${set.tag}-${s.w}x${s.h}.png`,
        E.render(rgbPdf(brand, a), { box: [s.w, s.h], inset: s.inset, background: E.hexToRgb(set.bg) }));
    }
    await tick();
  }

  // Email signature.
  progress('Email signature', step++ / total);
  for (const role of ['primary', 'secondary']) {
    const a = pick(brand, ['logo', 'logo-no-tag'], role);
    if (!a) continue;
    out(`${L.extras.email}/${b}-email-signature-${role}-600px.png`, E.render(rgbPdf(brand, a), { width: longestTo(a.logo, 600) }));
    out(`${L.extras.email}/${b}-email-signature-${role}-300px.png`, E.render(rgbPdf(brand, a), { width: longestTo(a.logo, 300) }));
  }

  // Brand colours.
  progress('Brand colors', step++ / total);
  const ase = [];
  for (const c of brand.colors) {
    if (c.cmyk) ase.push({ name: `${c.name} (CMYK)`, model: 'CMYK', values: c.cmyk, spot: false });
    ase.push({ name: `${c.name} (RGB ${c.hex.toUpperCase()})`, model: 'RGB', values: E.hexToRgb(c.hex), spot: false });
  }
  out(`${L.extras.colors}/${b}-colors.ase`, E.buildAse(ase));
  out(`${L.extras.colors}/${b}-colors.css`, colorsCss(brand));
  out(`${L.extras.colors}/${b}-colors.json`, colorsJson(brand));
  out(`${L.extras.colors}/${b}-colors.txt`, colorsTxt(brand));

  // Guide.
  progress('Brand guidelines', step++ / total);
  await tick();
  if (opts.guide) out(`${L.root}/${L.guideName}`, await opts.guide());
  progress('Done', 1);
  return L;
}
