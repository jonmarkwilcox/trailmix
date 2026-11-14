# TrailMix

**All the good stuff, one bag.** A FoundMark Creative tool: https://trailmix.foundmarkcreative.com

Upload a brand's final logo files (EPS, AI, PDF or SVG) and download a complete, client-ready brand package. It includes print and digital files in every format, favicons, social images, brand color files and a brand guidelines PDF. Everything runs in the browser, so files are never uploaded anywhere.

## Rules it follows

- **The artwork never changes.** Nothing is redrawn, recolored or regenerated. Each uploaded file is one deliverable.
- **CMYK is exact.** Print EPS files are the original files, byte for byte. Print PDFs, and any EPS that has to be generated (from AI, PDF or SVG), carry the exact CMYK values from the source. Ghostscript would otherwise round them to a 1/1024 grid; they are read from the source and written back.
- **SVG keeps its own bounds and colors.** An uploaded SVG is converted to vector PDF in the browser (jsPDF + svg2pdf.js), keeping its `viewBox` as the logo's bounds and its exact `#RRGGBB` colors. The original SVG is shipped as the digital SVG when its colors are unchanged. SVG has no CMYK, so the app asks for each color's official CMYK for print; colors left blank are converted automatically and flagged.
- **The artwork is the reference.** By default each color's HEX is how the artwork's exact CMYK renders on screen (color-managed). If you type a different HEX, the app flags the difference and offers the artwork value back. Digital files (SVG, PNG, JPG, WebP) use the HEX exactly; pixels are verified to match.
- **One color, one value.** Colors that look the same (CIEDE2000 under 5) are grouped into one brand color, so slight drift between exports (an SVG at `#F8F7F2` next to an EPS at `#F9F6EF`) doesn't create extra colors. A color from an EPS/AI/PDF leads its group, so its exact CMYK becomes the print value for the SVGs too, and every file uses the group's HEX on screen. Any variant can be kept separate with one click.
- **Brand backgrounds only.** Mark one color as the light background and one as the dark background, for example Blaze White and Bark. JPGs, social images, icons and every mockup in the guide use only those. A logo only gets a background where every color in it keeps enough contrast.
- **Pantone suggestions.** "Suggest closest Pantone" fills empty Pantone fields with the nearest PANTONE+ Solid Coated match (CIEDE2000, ΔE ≤ 4). The guide adds a note to confirm them against a printed guide.

## How it works

1. **Upload** every version: dark and light, with and without tagline, the mark.
2. **The scan proposes everything**:
   - **Primary / secondary**: dark logos are primary, light logos are secondary.
   - **Logo / no-tag / stacked / mark**: compact, simple artwork is the mark. When logos come in a wide and a narrower shape, the narrower ones are the stacked layout. Within each family, layout and role, the clearly simpler artwork is the version without tagline ("no-tag").
   - **Brand family**: logos are grouped by accent color, for sub-brands such as *Strategy* and *Creative*.
   - **Brand colors**: exact CMYK is read from the files, with a suggested HEX.
3. **Confirm**: name the company and the families, give colors names and usage notes, choose the light and dark background colors, and optionally suggest Pantone matches. You can correct any classification.
4. **Download** the package, or preview and download the guidelines on their own.

## Naming

```
company[-family][-stacked][-no-tag | -mark]-primary|secondary-cmyk|rgb[-1024px | -on-white].ext
```

- The company name comes first.
- The horizontal logo with its tagline is the main logo and gets no extra label. The stacked layout adds `stacked`, versions without the tagline add `no-tag`, and the symbol adds `mark`.
- `primary` is the dark logo (for light backgrounds); `secondary` is the light logo (for dark backgrounds).

Examples: `foundmark-primary-cmyk.eps`, `foundmark-strategy-no-tag-secondary-rgb-2048px.png`, `foundmark-mark-primary-rgb-on-off-white.jpg`.

## What's in the package

```
FoundMark_Brand_Assets/
├── FoundMark_Brand_Guidelines.pdf
├── 01_FoundMark/                      one folder per brand family
│   ├── 01_Logo/                       the main logo (with tagline)
│   │   ├── 01_Print_CMYK/
│   │   │   ├── 01_EPS/               original files, exact CMYK
│   │   │   └── 02_PDF/               vector, exact CMYK
│   │   └── 02_Digital_RGB/
│   │       ├── 01_SVG/
│   │       ├── 02_PNG/01_Small … 04_Extra_Large   512 / 1024 / 2048 / 4096 px, transparent
│   │       ├── 03_JPG/               primary on white, secondary on the dark brand color
│   │       └── 04_WEBP/              same sizes as PNG, lossless
│   ├── 02_Logo_No-Tag/
│   ├── 03_Stacked_Logo/               when stacked versions are uploaded
│   ├── 04_Stacked_Logo_No-Tag/
│   └── 05_Mark/
├── 02_FoundMark_Strategy/ …
├── 04_Favicon_and_App_Icons/          favicon.ico + .svg (switches in dark mode), 96 px, apple-touch, 192/512/1024, webmanifest, setup.html
├── 05_Social_Media/                   profile 1080², LinkedIn, X, Facebook, YouTube, Open Graph, light and dark
├── 06_Email_Signature/                600 px and 300 px, primary and secondary
└── 07_Brand_Colors/                   .ase (Adobe swatches, CMYK + RGB), .css, .json, .txt
```

**The guidelines PDF** (16:9, about 23 pages) has these sections:
- Cover and contents
- Package map
- Logo suite
- Primary and secondary logo
- Choosing a version
- Brand family
- Clear space
- Minimum size
- Brand colors (HEX, RGB, exact CMYK, Pantone)
- Approved backgrounds
- Incorrect usage
- Mockups: business cards, tote bags, drinkware, apparel, stationery, digital
- "Which file do I use?"
- How files are named

Logos in the guide are embedded as vectors.

## Run it

It is a static site with no build step. Every file in this repository is served as is.

**Locally:** serve the folder over HTTP. Opening `index.html` from disk won't work, because browsers block WebAssembly there.

```bash
python3 -m http.server 8000      # open http://localhost:8000
```

**Hosting:** GitHub Pages from `main` / root, with the custom domain in `CNAME` (`trailmix.foundmarkcreative.com`). It works on any static host that serves HTTPS and sends `.wasm` files as `application/wasm`. Libraries are bundled in `vendor/`, so no CDN is needed. The first visit downloads about 26 MB of converters; the service worker then keeps them on the device. If you change anything in `vendor/`, bump `CACHE` in `sw.js`.

## Phones and tablets

On phones the app splits into three tabs: **Logos** (cards two per row; tap *Edit* to change a file's family, version or role), **Brand** (company, colors, families; a dot marks anything still to fill in) and **Guide** (page-by-page preview). Controls are finger-sized and inputs use 16 px text so iOS doesn't zoom. It can be added to the home screen (web app manifest + icons). A service worker caches the converters, so after the first visit it opens instantly and works offline. WebP files are encoded by libwebp (WebAssembly), so Safari produces the same lossless WebP as Chrome.

## Code

| File | Role |
|---|---|
| `engine.js` | Read EPS/AI/PDF (Ghostscript WASM), restore exact source colors, map to official RGB, render PNG/JPG and SVG (MuPDF WASM), ICO and ASE writers |
| `pack.js` | Scan and classify, naming, contrast-checked backgrounds, folder layout, building every file |
| `guide.js` | Brand guidelines PDF (MuPDF), with logos as vector Form XObjects and mockups drawn as vectors |
| `app.js` | The interface |

## Limitations

- SVGs with live text use a fallback font: convert text to outlines before exporting. Compressed `.svgz` isn't supported.
- Family names (e.g. "Strategy") can't be read from outlined text, so you type them in once.
- For AI, PDF and SVG sources the EPS is generated by Ghostscript, with exact colors restored. For CMYK EPS sources the original file is used.
- AI files must be saved with "Create PDF Compatible File" on (Illustrator's default).

## License

Ghostscript and MuPDF are AGPL-3.0, so this tool is distributed under AGPL-3.0 too. Paper.js and JSZip are MIT. Their license files are in `vendor/`.
