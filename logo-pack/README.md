# Logo Pack

Drop in a vector logo (EPS, AI or PDF) and download a complete, organized logo package. It works like logopack.app, and everything runs in the browser, so files are never uploaded anywhere.

## What you get

```
<Brand> Logo Pack/
├── README.txt                      which file to use when
├── Print (CMYK)/
│   ├── EPS/   brand_logo_<version>.eps
│   └── PDF/   brand_logo_<version>.pdf
├── Digital (RGB)/
│   ├── SVG/   brand_logo_<version>.svg
│   ├── PNG/<Version>/  transparent, one file per width
│   └── JPG/<Version>/  solid background, one file per width
├── Favicon & App Icons/            favicon.ico, 16/32 px, apple-touch-icon, android 192/512, site.webmanifest
├── Social Media/                   1080 + 400 px profile images (light + dark), 1500×500 covers
├── Brand Colors/                   swatch sheet PDF, Adobe .ase swatches, HEX/RGB/CMYK .txt
└── Source/                         the original files
```

**Versions**
- **Full color**: the original artwork, unchanged.
- **Color on dark**: colors you mark "White on dark" (usually near-black text) turn white. Gradients and everything else are left as they are.
- **Black** (100% K), **White**, and **One-color** (any ink, e.g. a brand color): white details become real cut-outs, not white shapes, so they work on any background.
- **Grayscale**: a true gray conversion.

Print files are CMYK; original CMYK values from the EPS are kept exactly. Digital files are RGB. You can upload several layouts (horizontal, stacked, icon), and each one gets its own set of files. The most square layout is used for favicons and profile pictures.

## Run it

It is a static site with no build step. Serve the folder over HTTP. Opening `index.html` from disk won't work, because browsers block WebAssembly there.

```bash
cd logo-pack
python3 -m http.server 8000
# open http://localhost:8000
```

To host it, push the folder to any static host: GitHub Pages, Netlify, Cloudflare Pages, or S3. The libraries are bundled in `vendor/`, so it needs no CDN and also works offline. The first visit downloads about 26 MB of converters, which the browser then caches.

## How it works

| Step | Tool |
|---|---|
| Read EPS/AI/PDF, outline text, measure the artwork's bounding box | Ghostscript 9.56 (WebAssembly) |
| Record every shape and its exact color (CMYK, RGB, spot) | MuPDF (WebAssembly) custom device |
| Cut-outs for one-color versions (boolean path subtraction) | Paper.js |
| Swap colors for "Color on dark" by rewriting PDF color operators | `engine.js` |
| CMYK / gray conversion and EPS export | Ghostscript (`pdfwrite`, `eps2write`) |
| SVG, PNG, JPG | MuPDF |
| Zip | JSZip |

The code is in `engine.js` (conversion) and `app.js` (UI).

## Limitations
- SVG input isn't supported yet. Upload the EPS/AI/PDF master.
- In one-color versions, gradients and embedded bitmaps are filled solid, and strokes are not cut by white shapes drawn over them. The preview shows a note when a file has these.
- "Color on dark" only changes plain process colors (CMYK/RGB/gray). Spot colors stay as they are.
- AI files must be saved with "Create PDF Compatible File" on (Illustrator's default).

## License
Ghostscript and MuPDF are AGPL-3.0, so this tool is distributed under AGPL-3.0 too. Paper.js and JSZip are MIT. Their license files are in `vendor/`.
