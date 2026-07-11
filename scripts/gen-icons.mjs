// One-shot generator for the PWA icon set. Run: npm run gen-icons
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const outDir = fileURLToPath(new URL('../public/icons/', import.meta.url));

// Simple photo glyph. maskable variant keeps the glyph inside the 80% safe zone
// by rendering the same drawing smaller on a full-bleed background.
const icon = (glyphScale) => {
  const s = glyphScale;
  const t = (512 * (1 - s)) / 2; // translate to keep glyph centered
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0a0a0a"/>
  <g transform="translate(${t} ${t}) scale(${s})">
    <rect x="80" y="120" width="352" height="272" rx="28" fill="none" stroke="#fafafa" stroke-width="22"/>
    <circle cx="190" cy="212" r="30" fill="#fafafa"/>
    <path d="M112 356 L232 252 L300 314 L356 268 L400 356 Z" fill="#fafafa"/>
  </g>
</svg>`);
};

await mkdir(outDir, { recursive: true });
await sharp(icon(1)).resize(192, 192).png().toFile(`${outDir}icon-192.png`);
await sharp(icon(1)).resize(512, 512).png().toFile(`${outDir}icon-512.png`);
await sharp(icon(0.72)).resize(512, 512).png().toFile(`${outDir}icon-512-maskable.png`);
await sharp(icon(1)).resize(180, 180).png().toFile(`${outDir}apple-touch-icon.png`);
console.log('icons written to public/icons/');
