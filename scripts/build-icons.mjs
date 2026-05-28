// Rasterizes assets/icon.svg into the PNG icons the PWA needs.
// Run once locally (or whenever the artwork changes) via `npm run build:icons`.
// The generated PNGs are committed to the repo.

import sharp from "sharp";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../assets/icon.svg");
const OUT_DIR = resolve(__dirname, "../public/icons");

const svg = readFileSync(SRC);
mkdirSync(OUT_DIR, { recursive: true });

// The source SVG already has a full-bleed background, so it doubles as the maskable icon.
const targets = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "icon-maskable-512.png", size: 512 },
  { file: "apple-touch-icon-180.png", size: 180 },
  { file: "favicon-32.png", size: 32 },
];

await Promise.all(
  targets.map(({ file, size }) =>
    sharp(svg)
      .resize(size, size)
      .png()
      .toFile(resolve(OUT_DIR, file))
      .then(() => console.log(`wrote ${file} (${size}x${size})`))
  )
);

console.log("Icons generated.");
