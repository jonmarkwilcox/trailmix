import * as E from './engine.js';
import * as P from './pack.js';
import { buildGuide } from './guide.js';

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */

const brand = { name: '', assets: [], colors: [], families: [], splits: new Set() };
let nextId = 1;
let busy = false;
const pending = [];
const errors = [];

const $ = (s) => document.querySelector(s);
const tick = () => new Promise((r) => setTimeout(r, 0));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const blobUrl = (bytes, type) => URL.createObjectURL(new Blob([bytes], { type }));
const validHex = (h) => /^#?[0-9a-f]{6}$/i.test(h.trim());
const normHex = (h) => '#' + h.trim().replace('#', '').toUpperCase();

/* ------------------------------------------------------------------ */
/* Engine start-up                                                      */
/* ------------------------------------------------------------------ */

const status = $('#engine-status');
const engineReady = E.warmUp().then(
  () => { status.textContent = 'Converter ready'; status.className = 'pill ok'; },
  (e) => { status.textContent = 'Converter failed to load'; status.className = 'pill err'; console.error(e); throw e; },
);

/* ------------------------------------------------------------------ */
/* Upload & scan                                                        */
/* ------------------------------------------------------------------ */

const fileInput = $('#file-input');
const dropzone = $('#dropzone');
fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
$('#add-more').addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
for (const target of [dropzone, document.body]) {
  target.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
  target.addEventListener('dragleave', (e) => { if (e.target === dropzone) dropzone.classList.remove('over'); });
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) addFiles(files);
  });
}

function guessBrand(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  const word = stem.split(/\s+/).find((w) => w && !/^(logo|final|cmyk|rgb|vector|asset|artwork|v?\d+)$/i.test(w));
  return word ? word[0].toUpperCase() + word.slice(1) : '';
}

async function addFiles(files) {
  $('#intro').hidden = true;
  $('#workspace').hidden = false;
  $('#bar').hidden = false;
  if (!brand.name) {
    brand.name = files.map((f) => guessBrand(f.name)).find(Boolean) || '';
    $('#brand').value = brand.name;
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const file of files) pending.push({ id: nextId++, fileName: file.name, file });
  renderAssets();
  await engineReady;
  let done = 0;
  const total = pending.length;
  while (pending.length) {
    const p = pending[0];
    setProgress(`Reading ${p.fileName}…`, done / total);
    await tick();
    try {
      const bytes = new Uint8Array(await p.file.arrayBuffer());
      const logo = await E.loadLogo(bytes);
      brand.assets.push({ id: p.id, fileName: p.fileName, bytes, logo, analysis: E.analyze(logo.pdf) });
    } catch (e) {
      console.error(e);
      errors.push({ fileName: p.fileName, message: e.message || String(e) });
    }
    pending.shift();
    done++;
  }
  rescan();
  setProgress(errors.length ? `${errors.length} file(s) could not be read.` : 'Check the names and colors, then download.', 0);
}

const hueClose = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.min(Math.abs(a - b), 360 - Math.abs(a - b)) < 18);

/** Re-run colour collection and classification, keeping the user's edits. */
function rescan() {
  const prevFams = brand.families.map((f) => ({ hue: f.hue, name: f.name, isMain: f.isMain, touched: f.touched }));
  const overrides = new Map(brand.assets.filter((a) => a.override).map((a) => [a.id, a.override]));
  brand.colors = P.collectColors(brand.assets, brand.colors, brand.splits);
  brand.families = P.classify(brand.assets, brand.colors);
  for (const f of brand.families) {
    const old = prevFams.find((o) => o.touched && hueClose(o.hue, f.hue));
    if (old) { f.name = old.name; f.touched = true; }
  }
  const mainOld = prevFams.find((o) => o.isMain && o.touched);
  if (mainOld) {
    brand.families.forEach((f) => { f.isMain = hueClose(f.hue, mainOld.hue); });
    brand.families.sort((x, y) => (y.isMain - x.isMain) || (x.order - y.order));
  }
  for (const a of brand.assets) {
    const o = overrides.get(a.id);
    if (!o) continue;
    if (o.type) a.type = o.type;
    if (o.role) a.role = o.role;
    if (o.famHue !== undefined) { const f = brand.families.find((x) => hueClose(x.hue, o.famHue)); if (f) a.familyId = f.id; }
    a.override = o;
  }
  renderAll();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

const darkBg = () => P.darkBackground(brand);
const lightBg = () => P.lightBackground(brand);

const pct = (v) => +(v * 100).toFixed(2);
const colorSub = (c) => {
  const rgb = `RGB ${E.hexToRgb(c.hex).map((v) => Math.round(v * 255)).join(' ')}`;
  if (c.cmykSource === 'file') return `CMYK ${P.cmykText(c.cmyk)} <span class="exact">from file</span> · ${rgb}`;
  return `${rgb} <span class="exact">from file</span>${c.cmyk ? ` · CMYK ${P.cmykText(c.cmyk)} <span class="exact">entered</span>` : ''}`;
};
const needsCmyk = (c) => c.cmykSource !== 'file' && (c.members || [c]).some((m) => m.space === 'RGB');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function renderColors() {
  $('#colors').innerHTML = brand.colors.map((c, i) => `
    <div class="color-row" data-key="${esc(c.key)}">
      <label class="color-sw" style="background:${c.hex}" title="Pick the official color">
        <input type="color" value="${c.hex.toLowerCase()}" data-act="picker" aria-label="${esc(c.name)} color">
      </label>
      <div class="color-info">
        <div class="color-fields">
          <input type="text" value="${esc(c.name)}" data-act="name" aria-label="Color name" class="in-name">
          <input type="text" value="${c.hex.toUpperCase()}" data-act="hex" aria-label="${esc(c.name)} HEX" class="in-hex" maxlength="7" spellcheck="false">
        </div>
        <div class="sub">${colorSub(c)}</div>
        ${(c.members || []).length > 1 ? `<div class="variants"><span class="v-title">Slight variations in your files, using this color:</span>${c.members.slice(1).map((m) => `
          <span class="variant"><i style="background:${m.artHex}"></i><code>${m.artHex}</code> <span class="v-files">${plural(m.files, 'file')}</span>
          <button type="button" class="link" data-act="split" data-member="${esc(m.key)}">Keep separate</button></span>`).join('')}</div>` : ''}
        ${brand.splits.has(c.key) ? `<div class="variants"><button type="button" class="link" data-act="unsplit">Group again with similar colors</button></div>` : ''}
        ${needsCmyk(c) ? `<input type="text" inputmode="decimal" value="${c.cmyk ? c.cmyk.map(pct).join(' ') : ''}" data-act="cmyk" placeholder="Official CMYK for print, e.g. 66 65 68 70" aria-label="${esc(c.name)} official CMYK" class="in-cmyk">
        <div class="cmyk-warn" ${c.cmyk ? 'hidden' : ''}>No CMYK in the file. Print files use an automatic conversion until you enter the official values.</div>` : ''}
        <div class="art-warn" ${c.artHex && c.hex.toUpperCase() !== c.artHex.toUpperCase() ? '' : 'hidden'}>The artwork renders as <code>${c.artHex}</code>. <button type="button" class="link" data-act="use-art">Use artwork value</button></div>
        <div class="color-fields">
          <input type="text" value="${esc(c.note)}" data-act="note" placeholder="Usage note (optional)" aria-label="${esc(c.name)} usage note" class="in-name in-note">
          <input type="text" value="${esc(c.pantone)}" data-act="pantone" placeholder="Pantone" aria-label="${esc(c.name)} Pantone" class="in-hex in-pms">
        </div>
        <label class="bg-role">Background
          <select data-act="bg" aria-label="${esc(c.name)} background use">
            <option value="" ${!c.bg ? 'selected' : ''}>No</option>
            <option value="light" ${c.bg === 'light' ? 'selected' : ''}>Light background</option>
            <option value="dark" ${c.bg === 'dark' ? 'selected' : ''}>Dark background</option>
          </select></label>
      </div>
      ${i > 0 ? `<button class="icon-btn move-up" type="button" data-act="up" title="Move up" aria-label="Move ${esc(c.name)} up">\u2191</button>` : '<span></span>'}
    </div>`).join('') || '<p class="hint">Colors appear after your files are read.</p>';
}

let colorTimer;
$('#colors').addEventListener('input', (e) => {
  const row = e.target.closest('.color-row');
  const c = brand.colors.find((x) => x.key === row.dataset.key);
  const act = e.target.dataset.act;
  if (act === 'name') { c.name = e.target.value; c.named = true; clearTimeout(colorTimer); colorTimer = setTimeout(renderFamilies, 300); }
  if (act === 'pantone') c.pantone = e.target.value;
  if (act === 'note') c.note = e.target.value;
  if (act === 'cmyk') {
    const v = e.target.value.trim().split(/[\s,;/]+/).filter(Boolean).map(Number);
    const ok = v.length === 4 && v.every((x) => Number.isFinite(x) && x >= 0 && x <= 100);
    c.cmyk = ok ? v.map((x) => x / 100) : null;
    c.cmykSource = ok ? 'entered' : null;
    e.target.classList.toggle('invalid', !!e.target.value.trim() && !ok);
    row.querySelector('.cmyk-warn').hidden = ok;
    row.querySelector('.sub').innerHTML = colorSub(c);
  }
  if (act === 'hex' && validHex(e.target.value)) { c.hex = normHex(e.target.value); row.querySelector('[data-act=picker]').value = c.hex.toLowerCase(); }
  if (act === 'picker') { c.hex = e.target.value.toUpperCase(); row.querySelector('[data-act=hex]').value = c.hex; }
  if (act === 'hex' || act === 'picker') {
    row.querySelector('.color-sw').style.background = c.hex;
    row.querySelector('.sub').innerHTML = colorSub(c);
    row.querySelector('.art-warn').hidden = !c.artHex || c.hex.toUpperCase() === c.artHex.toUpperCase();
    clearTimeout(colorTimer);
    colorTimer = setTimeout(() => { renderFamilies(); renderAssets(); }, 300);
  }
});

$('#colors').addEventListener('change', (e) => {
  if (e.target.dataset.act !== 'bg') return;
  const c = brand.colors.find((x) => x.key === e.target.closest('.color-row').dataset.key);
  const v = e.target.value || null;
  if (v) brand.colors.forEach((x) => { if (x !== c && x.bg === v) x.bg = null; }); // one light and one dark background
  c.bg = v;
  renderColors();
  renderAssets();
});

$('#suggest-pantone').addEventListener('click', async () => {
  const btn = $('#suggest-pantone');
  btn.disabled = true;
  try {
    const book = await (await fetch('vendor/pantone/pantone-plus-solid-coated.json')).json();
    let n = 0;
    for (const c of brand.colors) {
      if (c.pantone) continue;
      const m = P.nearestPantone(c.artHex || c.hex, book);
      if (m) { c.pantone = m.name; n++; }
    }
    brand.pantoneSuggested = true;
    renderColors();
    setProgress(n ? `Suggested ${n} Pantone match(es). Check them against a printed Pantone guide.` : 'No close Pantone matches for the remaining colors.', 0);
  } catch (e) { setProgress('Could not load Pantone data.', 0); } finally { btn.disabled = false; }
});

$('#colors').addEventListener('click', (e) => {
  if (e.target.dataset.act === 'split') { brand.splits.add(e.target.dataset.member); rescan(); return; }
  if (e.target.dataset.act === 'unsplit') { brand.splits.delete(e.target.closest('.color-row').dataset.key); rescan(); return; }
  if (e.target.dataset.act === 'use-art') {
    const c = brand.colors.find((x) => x.key === e.target.closest('.color-row').dataset.key);
    c.hex = c.artHex;
    renderColors();
    renderAssets();
    return;
  }
  if (e.target.dataset.act !== 'up') return;
  const i = brand.colors.findIndex((x) => x.key === e.target.closest('.color-row').dataset.key);
  if (i > 0) [brand.colors[i - 1], brand.colors[i]] = [brand.colors[i], brand.colors[i - 1]];
  renderColors();
});

function renderFamilies() {
  const byKey = new Map(brand.colors.map((c) => [c.key, c]));
  $('#families-card').hidden = brand.families.length < 2;
  $('#families').innerHTML = brand.families.map((f) => `
    <div class="family-row" data-id="${f.id}">
      <span class="swatches">${[...f.accentKeys].map((k) => `<i style="background:${byKey.get(k)?.hex}" title="${esc(byKey.get(k)?.name)}"></i>`).join('') || '<i style="background:#ccc"></i>'}</span>
      <input type="text" value="${esc(f.name)}" placeholder="${f.isMain ? 'Main brand: leave empty' : 'e.g. Strategy'}" data-act="fname" aria-label="Family name">
      <label class="radio"><input type="radio" name="main-fam" ${f.isMain ? 'checked' : ''} data-act="main"> Main</label>
    </div>`).join('');
}
$('#families').addEventListener('input', (e) => {
  const f = brand.families.find((x) => x.id === e.target.closest('.family-row').dataset.id);
  if (e.target.dataset.act === 'fname') { f.name = e.target.value.trim(); f.touched = true; renderAssetNames(); }
});
$('#families').addEventListener('change', (e) => {
  if (e.target.dataset.act !== 'main') return;
  const f = brand.families.find((x) => x.id === e.target.closest('.family-row').dataset.id);
  brand.families.forEach((x) => { x.isMain = x === f; x.touched = true; });
  brand.families.sort((x, y) => (y.isMain - x.isMain) || (x.order - y.order));
  renderAll();
});

$('#brand').addEventListener('input', (e) => { brand.name = e.target.value; renderAssetNames(); });
$('#jpg-white').addEventListener('change', (e) => { brand.jpgOnWhite = e.target.checked; updateCount(); });

const thumbCache = new Map();
function thumbFor(a) {
  const pdf = P.rgbPdf(brand, a);
  if (thumbCache.get(a.id)?.pdf !== pdf) {
    const w = a.aspect >= 1.5 ? 560 : 240;
    thumbCache.set(a.id, { pdf, url: blobUrl(E.render(pdf, { width: w }), 'image/png') });
  }
  return thumbCache.get(a.id).url;
}

function renderAssets() {
  P.assignNames(brand);
  const groups = brand.families.map((f) => ({ f, list: brand.assets.filter((a) => a.familyId === f.id) })).filter((g) => g.list.length);
  const order = (a) => P.TYPES.findIndex((t) => t.id === a.type) * 2 + (a.role === 'primary' ? 0 : 1);
  const dark = darkBg(), light = lightBg();
  const fOpts = (a) => brand.families.map((f) => `<option value="${f.id}" ${a.familyId === f.id ? 'selected' : ''}>${esc(P.familyTitle(brand, f) || 'Main brand')}</option>`).join('');
  const tOpts = (a) => P.TYPES.map((t) => `<option value="${t.id}" ${a.type === t.id ? 'selected' : ''}>${t.label}</option>`).join('');
  const rOpts = (a) => P.ROLES.map((r) => `<option value="${r.id}" ${a.role === r.id ? 'selected' : ''}>${r.label} (${r.id === 'primary' ? 'dark' : 'light'})</option>`).join('');
  const tile = (a) => `
    <figure class="asset${openCards.has(a.id) ? ' open' : ''}" data-id="${a.id}">
      <div class="stage" style="background:${a.role === 'primary' ? light : dark}"><img src="${thumbFor(a)}" alt="${esc(a.fileName)}"></div>
      <figcaption>
        <code class="fname" title="File name">${esc(a.base)}</code>
        <div class="selects">
          ${brand.families.length > 1 ? `<select data-act="family" aria-label="Family">${fOpts(a)}</select>` : ''}
          <select data-act="type" aria-label="Version">${tOpts(a)}</select>
          <select data-act="role" aria-label="Role">${rOpts(a)}</select>
        </div>
        <span class="summary">${esc(P.TYPES.find((t) => t.id === a.type).label)} \u00b7 ${a.role === 'primary' ? 'Primary' : 'Secondary'}</span>
        ${(a.logo.warnings || []).map((w) => `<span class="asset-warn">${esc(w)}</span>`).join('')}
        <small>${esc(a.fileName)}</small>
        <button type="button" class="edit-btn" data-act="edit" aria-expanded="${openCards.has(a.id)}">${openCards.has(a.id) ? 'Done' : 'Edit'}</button>
      </figcaption>
    </figure>`;
  const loading = pending.map((p) => `<figure class="asset loading"><div class="stage checker"><div class="spinner"></div></div><figcaption><small>${esc(p.fileName)}</small></figcaption></figure>`).join('');
  const errs = errors.map((e) => `<div class="notes err-note"><strong>${esc(e.fileName)}</strong>: ${esc(e.message)}</div>`).join('');
  $('#assets').innerHTML = errs + groups.map((g) => `
      <section class="logo-block">
        ${groups.length > 1 ? `<h3>${esc(P.familyTitle(brand, g.f) || 'Main brand')}</h3>` : ''}
        <div class="asset-grid">${g.list.sort((x, y) => order(x) - order(y)).map(tile).join('')}</div>
      </section>`).join('') + (loading ? `<div class="asset-grid">${loading}</div>` : '');
  $('#asset-count').textContent = brand.assets.length ? `${brand.assets.length}` : '';
  updateCount();
}

function renderAssetNames() {
  P.assignNames(brand);
  for (const el of document.querySelectorAll('.asset[data-id]')) {
    const a = brand.assets.find((x) => x.id === +el.dataset.id);
    el.querySelector('.fname').textContent = a.base;
  }
  for (const o of document.querySelectorAll('select[data-act=family] option')) {
    o.textContent = P.familyTitle(brand, brand.families.find((x) => x.id === o.value)) || 'Main brand';
  }
  for (const h of document.querySelectorAll('.logo-block h3')) void h;
}

const openCards = new Set();
$('#assets').addEventListener('click', (e) => {
  if (e.target.dataset.act !== 'edit') return;
  const el = e.target.closest('.asset');
  const id = +el.dataset.id;
  if (openCards.has(id)) openCards.delete(id); else openCards.add(id);
  renderAssets();
  document.querySelector(`.asset[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

$('#assets').addEventListener('change', (e) => {
  const el = e.target.closest('.asset');
  if (!el) return;
  const a = brand.assets.find((x) => x.id === +el.dataset.id);
  const act = e.target.dataset.act;
  a.override = a.override || {};
  if (act === 'family') { a.familyId = e.target.value; a.override.famHue = brand.families.find((f) => f.id === a.familyId)?.hue; }
  if (act === 'type') { a.type = e.target.value; a.override.type = a.type; }
  if (act === 'role') { a.role = e.target.value; a.override.role = a.role; }
  renderAssets();
});

function renderAll() {
  renderColors();
  renderFamilies();
  renderAssets();
  updateBrandDot();
}

/* Phone tabs ---------------------------------------------------------- */
function showTab(tab) {
  $('#workspace').dataset.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  if (matchMedia('(max-width: 700px)').matches) window.scrollTo({ top: 0 });
}
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});
/** A dot on the Brand tab while the company or a sub-brand still needs a name. */
function updateBrandDot() {
  const missing = !brand.name.trim() || brand.families.some((f) => !f.isMain && !f.touched);
  $('#brand-dot').hidden = !missing || !brand.assets.length;
}
$('#brand').addEventListener('input', () => {
  updateBrandDot();
  if (brand.name.trim() && /company name/.test($('#progress-text').textContent)) setProgress('Check the names and colors, then download.', 0);
});
$('#families').addEventListener('input', updateBrandDot);

// iPhone/iPad file pickers can grey out .eps when an accept filter is set; files are checked after picking anyway.
if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
  $('#file-input').removeAttribute('accept');
}

/* ------------------------------------------------------------------ */
/* Guide preview & package                                              */
/* ------------------------------------------------------------------ */

function setProgress(text, frac) {
  if (text) $('#progress-text').textContent = text;
  $('#progress-fill').style.width = `${Math.round((frac || 0) * 100)}%`;
}
function estimate() {
  let n = 0;
  for (const a of brand.assets) n += 3 + P.PNG_SIZES.length * 2 + P.jpgBackgroundsFor(brand, a).length;
  return n + 9 + P.SOCIAL.length * 2 + 4 + 4 + 1;
}
function updateCount() {
  const ready = brand.assets.length && !pending.length;
  $('#file-count').textContent = ready ? `${brand.assets.length} logos · about ${estimate()} files` : pending.length ? `Reading ${pending.length} file(s)…` : 'No logos yet';
  $('#download').disabled = !ready || busy;
  $('#preview-guide').disabled = !ready || busy;
}

function checkReady() {
  if (!brand.name.trim()) { setProgress('Enter the company name first.', 0); showTab('brand'); $('#brand').focus(); return false; }
  return true;
}

let lastGuide = null;
$('#guide-build').addEventListener('click', () => $('#preview-guide').click());
$('#preview-guide').addEventListener('click', async () => {
  if (busy || !checkReady()) return;
  busy = true; updateCount();
  setProgress('Building the guidelines…', 0.2);
  await tick();
  try {
    lastGuide = buildGuide(brand);
    const doc = E.mupdf.Document.openDocument(lastGuide, 'application/pdf');
    const n = doc.countPages();
    const urls = [];
    for (let i = 0; i < n; i++) {
      const pix = doc.loadPage(i).toPixmap(E.mupdf.Matrix.scale(0.25, 0.25), E.mupdf.ColorSpace.DeviceRGB, false);
      urls.push(blobUrl(pix.asPNG(), 'image/png'));
      if (i % 4 === 3) { setProgress(`Rendering page ${i + 1} of ${n}…`, 0.2 + 0.8 * (i / n)); await tick(); }
    }
    $('#guide-pages').innerHTML = urls.map((u, i) => `<a href="${u}" target="_blank" rel="noopener"><img src="${u}" alt="Guide page ${i + 1}" loading="lazy"></a>`).join('');
    $('#guide-section').hidden = false;
    $('#workspace').classList.add('has-guide');
    if (matchMedia('(max-width: 700px)').matches) showTab('guide');
    $('#guide-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setProgress(`Guidelines ready: ${n} pages.`, 1);
  } catch (e) {
    console.error(e);
    setProgress('Could not build the guide: ' + (e.message || e), 0);
  } finally { busy = false; updateCount(); }
});

$('#guide-download').addEventListener('click', () => {
  if (lastGuide) save(new Blob([lastGuide], { type: 'application/pdf' }), P.layout(brand).guideName);
});

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}


$('#download').addEventListener('click', async () => {
  if (busy || !checkReady()) return;
  busy = true; updateCount();
  const t0 = performance.now();
  try {
    const zip = new JSZip();
    let count = 0;
    const L = await P.buildPackage(brand, (path, data) => { if (data) { zip.file(path, data); count++; } }, {
      progress: (t, f) => setProgress(`Creating ${t}…`, f * 0.85),
      guide: async () => (lastGuide = buildGuide(brand)),
    });
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      (m) => setProgress(`Compressing… ${Math.round(m.percent)}%`, 0.85 + 0.15 * (m.percent / 100)));
    save(blob, `${L.root}.zip`);
    setProgress(`Done: ${count} files, ${(blob.size / 1048576).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(0)}s.`, 1);
    window.__lastPack = blob;
  } catch (e) {
    console.error(e);
    setProgress('Something went wrong: ' + (e.message || e), 0);
  } finally { busy = false; updateCount(); }
});

updateCount();

// Installable app: cache the converters so repeat visits (and offline use) are fast.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
