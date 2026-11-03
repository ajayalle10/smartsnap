# SmartSnap

## Mobile app

`mobile/` is the main app: a web app that does the OCR on the device itself. Photos and text never leave the device. It works offline once installed.

**Install it**
- **iPhone (Safari):** open the site, tap **Share**, then **Add to Home Screen**.
- **Chrome (computer or Android):** open the site, then use the install icon in the address bar, or **⋮ → Cast, save and share → Install page as app** (or **Create shortcut**).

**Publishing:** every push to `main` builds the app and publishes it to GitHub Pages ([.github/workflows/pages.yml](.github/workflows/pages.yml)).

**Try it locally on your phone (same Wi-Fi as this PC):**

```bash
npm run mobile
```

Then scan the QR code printed in the terminal. Offline mode and Share only work on the published https site.

| Path | Role |
|---|---|
| `mobile/js/app.js` | Screens: collections, photos, photo viewer, text, settings |
| `mobile/js/cropper.js` | Crop & straighten screen (opens right after each photo) |
| `mobile/js/detect.js` | Finds page/screen edges so the crop starts in place |
| `mobile/js/find.js` | Find & replace in the merged text |
| `mobile/js/docx.js` | Word (.docx) export without a library |
| `mobile/js/ocr.js` | Tesseract worker pool and reading queue |
| `mobile/js/db.js` | On-device storage (IndexedDB) |
| `mobile/js/imaging.js` | Resize, rotate, perspective flatten, blur check, lighting cleanup before OCR |
| `mobile/sw.js` | Offline cache |
| `mobile/scripts/` | Build helpers: vendor OCR files, local server, icon generator |

## Desktop app (original prototype)

Take photos of any screen with your phone. SmartSnap reads the text on your computer and merges it into one ordered document, with the overlap between shots removed.

Everything runs locally. Photos go straight from the phone to this computer over your Wi-Fi, and OCR runs on the computer.

## Run

```bash
npm install
npm start
```

`npm install` also rebuilds the SQLite module for Electron.

## Use

1. Create a collection. Each collection becomes one document.
2. Click **Connect phone** and scan the QR code. Your phone must be on the same Wi-Fi.
   The first time, Windows Firewall may ask about SmartSnap. Allow it on **private networks**.
3. On the phone, tap **Take photo** for each page/screen, keeping a little overlap when you scroll.
   Photos appear in the gallery as they arrive, in the order you took them.
4. Optional: drag cards to reorder, untick ones to leave out, or use ✂ to crop and straighten a photo.
5. Click **Extract text**. The Document tab shows the merged text. **Copy all** or **Export .txt**.

Click any image to see its own text. Words the OCR was unsure about are highlighted. You can correct the text or re-run OCR on just that image.

## How it fits together

| Path | Role |
|---|---|
| `src/main/main.js` | Electron main process, IPC handlers |
| `src/main/server.js` | Local HTTP server for the phone (token from the QR code is required on every request) |
| `src/main/db.js` | SQLite (collections, image metadata); images stored as files on disk |
| `src/main/ocr.js` | Tesseract.js worker pool; language data downloaded once and cached |
| `src/shared/consolidate.js` | Merges per-image text and removes overlapping lines |
| `src/renderer/` | Desktop UI (gallery, editor, document) |
| `src/phone/index.html` | Phone capture page |

Data lives in `%APPDATA%\smartsnap`. Set `SMARTSNAP_DATA_DIR` to use a different folder.

## Tests

```bash
npm test
```
