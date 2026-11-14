import * as E from './engine.js';

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */

const VARIANTS = [
  { id: 'full-color', label: 'Full color', bg: 'light', note: 'original colors', on: true },
  { id: 'full-color-on-dark', label: 'Color on dark', bg: 'dark', note: 'for dark backgrounds', on: true },
  { id: 'black', label: 'Black', bg: 'light', note: '100% K', on: true },
  { id: 'white', label: 'White', bg: 'dark', note: 'knock-out', on: true },
  { id: 'grayscale', label: 'Grayscale', bg: 'light', note: '', on: true },
  { id: 'brand-color', label: 'One-color', bg: 'light', note: 'any single ink', on: false },
];
const WIDTHS = [250, 500, 1000, 2000, 4000];
const PADDINGS = [{ v: 0, label: 'None' }, { v: 0.05, label: '5%' }, { v: 0.1, label: '10%' }, { v: 0.2, label: '20%' }];
const EXTRAS = [
  { id: 'icons', label: 'Favicon & app icons', note: 'ico, 16–512 px' },
  { id: 'social', label: 'Social media images', note: 'profile & cover' },
  { id: 'colors', label: 'Brand color sheet', note: 'pdf, ase, txt' },
  { id: 'source', label: 'Original source files', note: '' },
];

const state = {
  logos: [],
  brand: '',
  variants: Object.fromEntries(VARIANTS.map((v) => [v.id, v.on])),
  widths: new Set([500, 1000, 2000]),
  padding: 0,
  darkBg: '#111827',
  darkBgTouched: false,
  brandColor: null,
  extras: { icons: true, social: true, colors: true, source: true },
  palette: [], // merged across logos
  roles: {},
  bgMode: 'auto',
  busy: false,
};
let nextId = 1;

const $ = (s) => document.querySelector(s);
const tick = () => new Promise((r) => setTimeout(r, 0));
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const blobUrl = (bytes, type) => URL.createObjectURL(new Blob([bytes], { type }));

/* ------------------------------------------------------------------ */
/* Engine start-up                                                      */
/* ------------------------------------------------------------------ */

const status = $('#engine-status');
const engineReady = E.warmUp().then(
  () => { status.textContent = 'Converter ready'; status.className = 'pill ok'; },
  (e) => { status.textContent = 'Converter failed to load'; status.className = 'pill err'; console.error(e); throw e; },
);

/* ------------------------------------------------------------------ */
/* Files in                                                             */
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
  const word = stem.split(/\s+/).find((w) => w && !/^(logo|final|cmyk|rgb|vector|v\d+)$/i.test(w));
  return word ? word[0].toUpperCase() + word.slice(1) : '';
}

async function addFiles(files) {
  $('#intro').hidden = true;
  $('#workspace').hidden = false;
  $('#bar').hidden = false;
  for (const file of files) {
    const logo = {
      id: nextId++, fileName: file.name, label: state.logos.length ? slug(file.name.replace(/\.[^.]+$/, '')) || 'logo-' + nextId : 'logo',
      bytes: new Uint8Array(await file.arrayBuffer()), status: 'loading', isIcon: false, previews: {}, geo: null, padCache: new Map(),
    };
    if (!state.brand) { state.brand = guessBrand(file.name); $('#brand').value = state.brand; }
    state.logos.push(logo);
    renderLogoList();
  }
  for (const logo of state.logos.filter((l) => l.status === 'loading')) {
    try {
      await engineReady;
      await tick();
      const loaded = await E.loadLogo(logo.bytes);
      logo.pdf = loaded.pdf;
      logo.analysis = E.analyze(loaded.pdf);
      logo.thumb = blobUrl(E.render(loaded.pdf, { width: 160 }), 'image/png');
      logo.status = 'ok';
      mergePalette();
    } catch (e) {
      console.error(e);
      logo.status = 'error';
      logo.error = e.message || String(e);
    }
    renderLogoList();
    renderAll();
  }
}

function mergePalette() {
  const map = new Map();
  for (const l of state.logos) if (l.analysis) for (const c of l.analysis.palette) {
    const e = map.get(c.key);
    if (e) e.area += c.area; else map.set(c.key, { ...c });
  }
  state.palette = [...map.values()].sort((a, b) => b.area - a.area);
  const defaults = E.defaultColorRoles(state.palette);
  for (const c of state.palette) if (!state.roles[c.key]) state.roles[c.key] = defaults[c.key];
  if (!state.brandColor) {
    const vivid = state.palette.find((c) => !state.roles[c.key].knockout && E.luminance(c.rgb) < 0.8) || state.palette[0];
    if (vivid) { state.brandColor = vivid.hex; $('#brand-color').value = vivid.hex.toLowerCase(); }
  }
  if (!state.darkBgTouched) {
    const dark = state.palette.find((c) => E.luminance(c.rgb) < 0.12 && Math.max(...c.rgb) - Math.min(...c.rgb) > 0.05);
    state.darkBg = dark ? dark.hex.toLowerCase() : '#111827';
    $('#dark-bg').value = state.darkBg;
  }
  for (const l of state.logos) l.geo = null;
}

/* ------------------------------------------------------------------ */
/* Settings UI                                                          */
/* ------------------------------------------------------------------ */

function renderLogoList() {
  const ul = $('#logo-list');
  ul.innerHTML = state.logos.map((l) => `
    <li class="logo-item ${l.status}" data-id="${l.id}">
      <div class="logo-thumb">${l.thumb ? `<img src="${l.thumb}" alt="">` : ''}</div>
      <div class="logo-meta">
        <input type="text" value="${esc(l.label)}" data-act="label" aria-label="Layout name for ${esc(l.fileName)}">
        <small>${l.status === 'error' ? esc(l.error) : l.status === 'loading' ? 'Reading ' + esc(l.fileName) + '…' : esc(l.fileName)}
        ${state.logos.length > 1 && l.status === 'ok' ? `<label><input type="radio" name="icon-src" data-act="icon" ${iconLogo() === l ? 'checked' : ''}> use for icons</label>` : ''}</small>
      </div>
      <button class="icon-btn" data-act="remove" type="button" aria-label="Remove ${esc(l.fileName)}">×</button>
    </li>`).join('');
}

$('#logo-list').addEventListener('input', (e) => {
  const li = e.target.closest('.logo-item');
  const logo = state.logos.find((l) => l.id === +li.dataset.id);
  if (e.target.dataset.act === 'label') { logo.label = e.target.value; updateCount(); renderPreviews(); }
});
$('#logo-list').addEventListener('change', (e) => {
  const li = e.target.closest('.logo-item');
  const logo = state.logos.find((l) => l.id === +li.dataset.id);
  if (e.target.dataset.act === 'icon') { state.logos.forEach((l) => { l.isIcon = l === logo; }); }
});
$('#logo-list').addEventListener('click', (e) => {
  if (e.target.dataset.act !== 'remove') return;
  const id = +e.target.closest('.logo-item').dataset.id;
  state.logos = state.logos.filter((l) => l.id !== id);
  if (!state.logos.length) { location.reload(); return; }
  mergePalette();
  renderLogoList();
  renderAll();
});

$('#brand').addEventListener('input', (e) => { state.brand = e.target.value; });

function renderVariants() {
  $('#variant-list').innerHTML = VARIANTS.map((v) => `
    <label class="check"><input type="checkbox" data-v="${v.id}" ${state.variants[v.id] ? 'checked' : ''}>
      <span class="sw" style="${swatchStyle(v.id)}"></span>${v.label}<small>${v.note}</small></label>`).join('');
  $('#brand-color-row').hidden = !state.variants['brand-color'];
}
function swatchStyle(id) {
  switch (id) {
    case 'full-color': return `background: linear-gradient(135deg, ${(state.palette[0]?.hex) || '#4338ca'} 50%, ${(state.palette[1]?.hex) || '#f59e0b'} 50%)`;
    case 'full-color-on-dark': return `background: linear-gradient(135deg, ${state.darkBg} 50%, ${(state.palette[0]?.hex) || '#4338ca'} 50%)`;
    case 'black': return 'background:#000';
    case 'white': return 'background:#fff';
    case 'grayscale': return 'background: linear-gradient(135deg,#333 50%,#aaa 50%)';
    default: return `background:${state.brandColor || '#4338ca'}`;
  }
}
$('#variant-list').addEventListener('change', (e) => {
  state.variants[e.target.dataset.v] = e.target.checked;
  renderVariants();
  renderPreviews();
});
$('#brand-color').addEventListener('input', (e) => { state.brandColor = e.target.value.toUpperCase(); renderVariants(); schedulePreviews(['brand-color']); });

function renderPalette() {
  $('#palette').innerHTML = state.palette.map((c, i) => {
    const r = state.roles[c.key];
    const name = c.spot ? esc(c.spot) : `Color ${i + 1}`;
    return `<div class="color-row" data-key="${esc(c.key)}">
      <button class="color-sw" type="button" style="background:${c.hex}" data-act="ink" title="Use as one-color ink" aria-label="Use ${c.hex} as one-color ink"></button>
      <div class="color-info">
        <div><code>${c.hex}</code> <span class="sub">${name}</span></div>
        <div class="sub">CMYK ${c.cmyk.map((v) => Math.round(v * 100)).join(' ')}${c.cmykExact ? '' : ' (converted)'} · RGB ${c.rgb.map((v) => Math.round(v * 255)).join(' ')}</div>
        <div class="color-opts">
          <label><input type="checkbox" data-act="knockout" ${r.knockout ? 'checked' : ''}> Cut out in one-color</label>
          <label><input type="checkbox" data-act="onDark" ${r.onDark === 'white' ? 'checked' : ''}> White on dark</label>
        </div>
      </div></div>`;
  }).join('') || '<p class="hint">Upload a logo to see its colors.</p>';
}
$('#palette').addEventListener('change', (e) => {
  const key = e.target.closest('.color-row').dataset.key;
  const act = e.target.dataset.act;
  if (act === 'knockout') { state.roles[key].knockout = e.target.checked; state.logos.forEach((l) => { l.geo = null; }); schedulePreviews(['black', 'white', 'brand-color']); }
  if (act === 'onDark') { state.roles[key].onDark = e.target.checked ? 'white' : 'keep'; schedulePreviews(['full-color-on-dark']); }
});
$('#palette').addEventListener('click', (e) => {
  if (e.target.dataset.act !== 'ink') return;
  const c = state.palette.find((p) => p.key === e.target.closest('.color-row').dataset.key);
  state.brandColor = c.hex;
  $('#brand-color').value = c.hex.toLowerCase();
  state.variants['brand-color'] = true;
  renderVariants();
  renderPreviews();
});

function renderWidths() {
  const all = [...new Set([...WIDTHS, ...state.widths])].sort((a, b) => a - b);
  $('#widths').innerHTML = all.map((w) => `<label class="chip"><input type="checkbox" value="${w}" ${state.widths.has(w) ? 'checked' : ''}><span>${w} px</span></label>`).join('');
}
$('#widths').addEventListener('change', (e) => { const w = +e.target.value; if (e.target.checked) state.widths.add(w); else state.widths.delete(w); updateCount(); });
$('#add-width').addEventListener('click', () => {
  const w = Math.round(+$('#custom-width').value);
  if (w >= 16 && w <= 10000) { state.widths.add(w); $('#custom-width').value = ''; renderWidths(); updateCount(); }
});
$('#custom-width').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#add-width').click(); });

function renderSegmented(el, name, options, current, onChange) {
  el.innerHTML = options.map((o) => `<label><input type="radio" name="${name}" value="${o.v}" ${String(o.v) === String(current) ? 'checked' : ''}><span>${o.label}</span></label>`).join('');
  el.onchange = (e) => onChange(e.target.value);
}

$('#dark-bg').addEventListener('input', (e) => {
  state.darkBg = e.target.value;
  state.darkBgTouched = true;
  document.documentElement.style.setProperty('--dark-bg', state.darkBg);
  renderVariants();
});

function renderExtras() {
  const icon = readyLogos().length ? iconLogo() : null;
  const tip = icon && aspect(icon) > 1.6
    ? '<p class="hint">Tip: add an icon-only version of the logo (just the symbol) for sharper favicons and profile pictures.</p>' : '';
  $('#extras').innerHTML = EXTRAS.map((x) => `<label class="check"><input type="checkbox" data-x="${x.id}" ${state.extras[x.id] ? 'checked' : ''}>${x.label}<small>${x.note}</small></label>`).join('') + tip;
}
$('#extras').addEventListener('change', (e) => { state.extras[e.target.dataset.x] = e.target.checked; updateCount(); });

/* ------------------------------------------------------------------ */
/* Variant generation                                                   */
/* ------------------------------------------------------------------ */

const readyLogos = () => state.logos.filter((l) => l.status === 'ok');
const aspect = (l) => Math.max(l.analysis.width, l.analysis.height) / Math.min(l.analysis.width, l.analysis.height);
// Icons come from the logo marked "use for icons", else the most square one.
const iconLogo = () => readyLogos().find((l) => l.isIcon) || [...readyLogos()].sort((a, b) => aspect(a) - aspect(b))[0];
const activeVariants = () => VARIANTS.filter((v) => state.variants[v.id]);

function padFor(logo) {
  return state.padding * Math.max(logo.analysis.width, logo.analysis.height);
}
function paddedPdf(logo) {
  const pad = padFor(logo);
  if (!logo.padCache.has(pad)) logo.padCache.set(pad, E.padPdf(logo.pdf, pad));
  return logo.padCache.get(pad);
}
function geometry(logo) {
  if (!logo.geo) logo.geo = E.buildOneColorGeometry(logo.analysis, state.roles);
  return logo.geo;
}
function inkFor(id) {
  if (id === 'black') return { rgb: [0, 0, 0], cmyk: [0, 0, 0, 1] };
  if (id === 'white') return { rgb: [1, 1, 1], cmyk: [0, 0, 0, 0] };
  const hex = state.brandColor || '#000000';
  const match = state.palette.find((c) => c.hex === hex.toUpperCase());
  const rgb = match ? match.rgb : E.hexToRgb(hex);
  return { rgb, cmyk: match ? match.cmyk : E.rgbToCmyk(rgb) };
}

/** Returns { screen, print } PDFs for one logo + version. print is CMYK/Gray. */
async function variantPdfs(logo, id, withPrint) {
  const base = paddedPdf(logo);
  const pad = padFor(logo);
  switch (id) {
    case 'full-color':
      return { screen: base, print: withPrint ? await E.toCmykPdf(base) : null };
    case 'full-color-on-dark': {
      const screen = E.reversedPdf(base, state.roles, state.palette);
      return { screen, print: withPrint ? await E.toCmykPdf(screen) : null };
    }
    case 'grayscale': {
      const gray = await E.toGrayPdf(base);
      return { screen: gray, print: gray };
    }
    default: {
      const geo = geometry(logo);
      const ink = inkFor(id);
      return {
        screen: E.oneColorPdf(logo.analysis, geo, ink, 'rgb', pad),
        print: withPrint ? E.oneColorPdf(logo.analysis, geo, ink, 'cmyk', pad) : null,
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Previews                                                             */
/* ------------------------------------------------------------------ */

renderSegmented($('#bg-mode'), 'bg-mode', [{ v: 'auto', label: 'Auto' }, { v: 'light', label: 'Light' }, { v: 'dark', label: 'Dark' }, { v: 'checker', label: 'Transparent' }], state.bgMode, (v) => {
  state.bgMode = v;
  document.querySelectorAll('.stage').forEach((s) => { s.className = 'stage ' + stageBg(s.dataset.v); });
});
renderSegmented($('#padding'), 'padding', PADDINGS, state.padding, (v) => { state.padding = +v; state.logos.forEach((l) => { l.previews = {}; }); renderPreviews(); });

function stageBg(id) {
  if (state.bgMode !== 'auto') return state.bgMode;
  return VARIANTS.find((v) => v.id === id).bg;
}

let previewTimer;
function schedulePreviews(ids) {
  for (const l of state.logos) for (const id of ids) delete l.previews[id];
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreviews, 150);
}

let previewRun = 0;
async function renderPreviews() {
  const run = ++previewRun;
  const grid = $('#preview-grid');
  const logos = readyLogos();
  const notes = new Set();
  logos.forEach((l) => l.analysis.notes.forEach((n) => notes.add(n)));
  $('#notes').hidden = !notes.size;
  $('#notes').innerHTML = notes.size ? '<ul>' + [...notes].map((n) => `<li>${esc(n)}</li>`).join('') + '</ul>' : '';
  grid.innerHTML = logos.map((l) => `
    <div class="logo-block">
      ${logos.length > 1 ? `<h3>${esc(l.label || 'logo')}</h3>` : ''}
      <div class="grid">${activeVariants().map((v) => `
        <figure class="tile" style="margin:0">
          <div class="stage ${stageBg(v.id)}" data-v="${v.id}" data-logo="${l.id}">${l.previews[v.id] ? `<img src="${l.previews[v.id]}" alt="${esc(v.label)} version">` : '<div class="spinner"></div>'}</div>
          <figcaption class="tile-cap"><span>${v.label}</span><small>${v.note}</small></figcaption>
        </figure>`).join('')}</div>
    </div>`).join('');
  updateCount();
  for (const l of logos) {
    for (const v of activeVariants()) {
      if (l.previews[v.id]) continue;
      await tick();
      if (run !== previewRun) return;
      try {
        const { screen } = await variantPdfs(l, v.id, false);
        if (l.geo?.problems?.length) l.geo.problems.forEach((p) => notes.add(p));
        l.previews[v.id] = blobUrl(E.render(screen, { width: 640 }), 'image/png');
      } catch (e) {
        console.error(e);
        continue;
      }
      if (run !== previewRun) return;
      const stage = grid.querySelector(`.stage[data-v="${v.id}"][data-logo="${l.id}"]`);
      if (stage) stage.innerHTML = `<img src="${l.previews[v.id]}" alt="${esc(v.label)} version">`;
    }
  }
}

function renderAll() {
  document.documentElement.style.setProperty('--dark-bg', state.darkBg);
  renderVariants();
  renderPalette();
  renderWidths();
  renderExtras();
  renderPreviews();
}

/* ------------------------------------------------------------------ */
/* File count & pack                                                    */
/* ------------------------------------------------------------------ */

function plan() {
  const logos = readyLogos();
  const vs = activeVariants();
  const widths = [...state.widths].sort((a, b) => a - b);
  let n = logos.length * vs.length * (3 + widths.length * 2); // pdf, eps, svg + png & jpg per width
  if (state.extras.icons && logos.length) n += 7;
  if (state.extras.social && logos.length) n += 5;
  if (state.extras.colors && state.palette.length) n += 3;
  if (state.extras.source) n += logos.length;
  n += 1; // README
  return { logos, vs, widths, n };
}
function updateCount() {
  const { n, logos } = plan();
  $('#file-count').textContent = logos.length ? `${n} files` : 'No logos yet';
  $('#download').disabled = !logos.length || state.busy;
}

function progress(done, total, text) {
  $('#progress-fill').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
  if (text) $('#progress-text').textContent = text;
}

$('#download').addEventListener('click', buildPack);

async function buildPack() {
  if (state.busy) return;
  const { logos, vs, widths } = plan();
  if (!logos.length) return;
  state.busy = true;
  updateCount();
  const btn = $('#download');
  btn.textContent = 'Building…';
  const t0 = performance.now();
  try {
    const brand = state.brand.trim() || 'Brand';
    const b = slug(brand) || 'brand';
    const root = `${brand} Logo Pack`;
    const zip = new JSZip();
    const dir = zip.folder(root);
    const dark = E.hexToRgb(state.darkBg);
    const steps = logos.length * vs.length + (state.extras.icons ? 1 : 0) + (state.extras.social ? 1 : 0) + 2;
    let step = 0;

    for (const logo of logos) {
      const layout = slug(logo.label) || 'logo';
      for (const v of vs) {
        progress(step, steps, `${logo.label || 'Logo'} · ${v.label}`);
        await tick();
        const name = `${b}_${layout}_${v.id}`;
        const { screen, print } = await variantPdfs(logo, v.id, true);
        dir.file(`Print (CMYK)/PDF/${name}.pdf`, print);
        dir.file(`Print (CMYK)/EPS/${name}.eps`, await E.toEps(print));
        dir.file(`Digital (RGB)/SVG/${name}.svg`, E.toSvg(screen));
        const bg = v.bg === 'dark' ? dark : [1, 1, 1];
        for (const w of widths) {
          dir.file(`Digital (RGB)/PNG/${v.label}/${name}_${w}px.png`, E.render(screen, { width: w }));
          dir.file(`Digital (RGB)/JPG/${v.label}/${name}_${w}px.jpg`, E.render(screen, { width: w, background: bg, format: 'jpg' }));
          await tick();
        }
        step++;
      }
      if (state.extras.source) dir.file(`Source/${logo.fileName}`, logo.bytes);
    }

    const icon = iconLogo();
    if (state.extras.icons && icon) {
      progress(step, steps, 'Favicon & app icons');
      await tick();
      const base = icon.pdf; // tight crop: icons get their own margins
      const sq = (size, inset, background = null) => E.render(base, { box: [size, size], inset, background });
      const f = 'Favicon & App Icons/';
      const ico = [16, 32, 48].map((size) => ({ size, bytes: sq(size, 0.02) }));
      dir.file(f + 'favicon.ico', E.buildIco(ico));
      dir.file(f + 'favicon-16x16.png', ico[0].bytes);
      dir.file(f + 'favicon-32x32.png', ico[1].bytes);
      dir.file(f + 'apple-touch-icon.png', sq(180, 0.12, [1, 1, 1]));
      dir.file(f + 'android-chrome-192x192.png', sq(192, 0.08));
      dir.file(f + 'android-chrome-512x512.png', sq(512, 0.08));
      dir.file(f + 'site.webmanifest', JSON.stringify({
        name: brand, short_name: brand,
        icons: [{ src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' }, { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' }],
        theme_color: state.brandColor || '#ffffff', background_color: '#ffffff', display: 'standalone',
      }, null, 2));
      step++;
    }

    if (state.extras.social && icon) {
      progress(step, steps, 'Social media images');
      await tick();
      const light = icon.pdf;
      const darkPdf = E.reversedPdf(light, state.roles, state.palette);
      const whitePdf = E.oneColorPdf(icon.analysis, geometry(icon), inkFor('white'), 'rgb', 0);
      const hasDarkMapping = state.palette.some((c) => state.roles[c.key].onDark === 'white');
      const onDark = hasDarkMapping ? darkPdf : whitePdf;
      const s = 'Social Media/';
      dir.file(s + `${b}_profile_light_1080x1080.png`, E.render(light, { box: [1080, 1080], inset: 0.18, background: [1, 1, 1] }));
      dir.file(s + `${b}_profile_dark_1080x1080.png`, E.render(onDark, { box: [1080, 1080], inset: 0.18, background: dark }));
      dir.file(s + `${b}_profile_light_400x400.png`, E.render(light, { box: [400, 400], inset: 0.18, background: [1, 1, 1] }));
      const wide = logos[0];
      const wideLight = wide.pdf;
      dir.file(s + `${b}_cover_light_1500x500.png`, E.render(wideLight, { box: [1500, 500], inset: 0.28, background: [1, 1, 1] }));
      dir.file(s + `${b}_cover_dark_1500x500.png`, E.render(hasDarkMapping ? E.reversedPdf(wideLight, state.roles, state.palette) : E.oneColorPdf(wide.analysis, geometry(wide), inkFor('white'), 'rgb', 0), { box: [1500, 500], inset: 0.28, background: dark }));
      step++;
    }

    if (state.extras.colors && state.palette.length) {
      progress(step, steps, 'Brand colors');
      const colors = state.palette.map((c, i) => ({ ...c, name: c.spot || `${brand} Color ${i + 1}` }));
      dir.file(`Brand Colors/${b}_colors.pdf`, E.colorSheetPdf(brand, colors));
      dir.file(`Brand Colors/${b}_colors.ase`, E.buildAse(colors.map((c) => ({
        name: `${c.name} ${c.hex}`, model: c.cmykExact ? 'CMYK' : 'RGB', values: c.cmykExact ? c.cmyk : c.rgb, spot: !!c.spot,
      }))));
      dir.file(`Brand Colors/${b}_colors.txt`, colorsText(brand, colors));
    }
    step++;

    dir.file('README.txt', readme(brand, b, logos, vs, widths));
    progress(step, steps, 'Compressing…');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } }, (m) => {
      progress(steps - 1 + m.percent / 100, steps, `Compressing… ${Math.round(m.percent)}%`);
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${b}-logo-pack.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    progress(steps, steps, `Done in ${((performance.now() - t0) / 1000).toFixed(1)}s · ${(blob.size / 1048576).toFixed(1)} MB`);
    window.__lastPack = blob;
  } catch (e) {
    console.error(e);
    progress(0, 1, 'Something went wrong: ' + (e.message || e));
  } finally {
    state.busy = false;
    btn.textContent = 'Download logo pack';
    updateCount();
  }
}

function colorsText(brand, colors) {
  const lines = [`${brand} brand colors`, ''];
  for (const c of colors) {
    lines.push(c.name);
    lines.push(`  HEX   ${c.hex}`);
    lines.push(`  RGB   ${c.rgb.map((v) => Math.round(v * 255)).join(', ')}`);
    lines.push(`  CMYK  ${c.cmyk.map((v) => Math.round(v * 100)).join(', ')}${c.cmykExact ? '' : '  (converted from RGB, check with your printer)'}`);
    if (c.spot) lines.push(`  Spot  ${c.spot}`);
    lines.push('');
  }
  return lines.join('\r\n');
}

function readme(brand, b, logos, vs, widths) {
  return [
    `${brand} logo pack`,
    '='.repeat(brand.length + 10),
    '',
    'WHICH FILE SHOULD I USE?',
    '',
    'Print (CMYK)/',
    '  EPS and PDF vector files in CMYK. Send these to printers, sign makers and',
    '  anyone producing physical items. They scale to any size without losing quality.',
    '',
    'Digital (RGB)/',
    '  SVG  - vector for websites and apps. Sharp at every size.',
    '  PNG  - transparent background. Use in presentations, documents and on the web.',
    '  JPG  - solid background. Use where transparency is not supported (some email',
    '         clients, office tools). Dark versions sit on the brand\'s dark color.',
    `  Widths included: ${widths.map((w) => w + 'px').join(', ')}.`,
    '',
    'Favicon & App Icons/   Drop these in the root of a website.',
    'Social Media/          Profile pictures and cover images.',
    'Brand Colors/          HEX, RGB and CMYK values. The .ase file imports into',
    '                       Adobe Illustrator, InDesign and Photoshop swatches.',
    '',
    'VERSIONS',
    '',
    ...vs.map((v) => `  ${v.id.padEnd(20)} ${{
      'full-color': 'Primary logo. Use on white or light backgrounds.',
      'full-color-on-dark': 'Color logo adjusted for dark backgrounds.',
      black: 'One-color black. For single-color print, faxes, engraving.',
      white: 'One-color white. For dark backgrounds and photos.',
      grayscale: 'Shades of gray. For black-and-white print.',
      'brand-color': 'Single brand color.',
    }[v.id]}`),
    '',
    logos.length > 1 ? 'LAYOUTS\n\n' + logos.map((l) => '  ' + (slug(l.label) || 'logo')).join('\n') + '\n' : '',
    `File names follow: ${b}_<layout>_<version>[_<width>px].<ext>`,
    '',
  ].join('\r\n');
}

renderExtras();
updateCount();
