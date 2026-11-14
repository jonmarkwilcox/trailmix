# Logo Pack

Upload a brand's final logo files (EPS, AI or PDF) and download a complete, client-ready brand package. It includes print and digital files in every format, favicons, social images, brand color files and a brand guidelines PDF. Everything runs in the browser, so files are never uploaded anywhere.

## Rules it follows

- **The artwork never changes.** Nothing is redrawn, recolored or regenerated. Each uploaded file is one deliverable.
- **CMYK is exact.** Print EPS files are the original files, byte for byte. Print PDFs carry the exact CMYK values written in the source file. Ghostscript would otherwise round them to a 1/1024 grid; they are read from the source and written back.
- **RGB is exact.** Digital files (SVG, PNG, JPG, WebP) use the official HEX value entered for each brand color. They do not use an automatic CMYK→RGB conversion. Pixels are verified to match the HEX exactly.

## How it works

1. **Upload** every version: dark and light, with and without tagline, the mark.
2. **The scan proposes everything**:
   - **Primary / secondary**: dark logos are primary, light logos are secondary.
   - **Logo / no-tag / mark**: compact artwork is the mark. Among same-width logos, the one without the extra tagline artwork is "no-tag".
   - **Brand family**: logos are grouped by accent color, for sub-brands such as *Strategy* and *Creative*.
   - **Brand colors**: exact CMYK is read from the files, with a suggested HEX.
3. **Confirm**: name the company and the families, and enter the official HEX (and Pantone) for each color. You can correct any classification.
4. **Download** the package, or preview and download the guidelines on their own.

## Naming

```
company[-family][-mark | -no-tag]-primary|secondary-cmyk|rgb[-1024px | -on-white].ext
```

- The company name comes first.
- The logo with its tagline is the main logo and gets no extra label. Versions without the tagline add `no-tag`; the symbol adds `mark`.
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
│   │       ├── 03_JPG/               on each background that passes a contrast check
│   │       └── 04_WEBP/              same sizes as PNG, lossless
│   ├── 02_Logo_No-Tag/
│   └── 03_Mark/
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

It is a static site with no build step. Serve the folder over HTTP. Opening `index.html` from disk won't work, because browsers block WebAssembly there.

```bash
cd logo-pack
python3 -m http.server 8000      # open http://localhost:8000
```

To host it, push the folder to any static host: GitHub Pages, Netlify, Cloudflare Pages, or S3. Libraries are bundled in `vendor/`, so it needs no CDN and also works offline. The first visit downloads about 26 MB of converters, which the browser then caches.

## Code

| File | Role |
|---|---|
| `engine.js` | Read EPS/AI/PDF (Ghostscript WASM), restore exact source colors, map to official RGB, render PNG/JPG and SVG (MuPDF WASM), ICO and ASE writers |
| `pack.js` | Scan and classify, naming, contrast-checked backgrounds, folder layout, building every file |
| `guide.js` | Brand guidelines PDF (MuPDF), with logos as vector Form XObjects and mockups drawn as vectors |
| `app.js` | The interface |

## Limitations

- SVG input isn't supported. Upload the EPS/AI/PDF masters.
- Family names (e.g. "Strategy") can't be read from outlined text, so you type them in once.
- For AI/PDF sources the EPS is converted by Ghostscript. For EPS sources the original file is used.
- AI files must be saved with "Create PDF Compatible File" on (Illustrator's default).

## License

Ghostscript and MuPDF are AGPL-3.0, so this tool is distributed under AGPL-3.0 too. Paper.js and JSZip are MIT. Their license files are in `vendor/`.
