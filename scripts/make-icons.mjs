// Regenerates public/icons/*.png from an inline SVG. Requires `sharp` (npm i -D sharp).
import sharp from 'sharp';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="22" fill="#282a2e"/><rect x="14" y="22" width="100" height="68" rx="8" fill="#1d1f21" stroke="#81a2be" stroke-width="6"/><path d="M24 80l24-26 18 18 14-12 24 20z" fill="#8abeb7"/><circle cx="88" cy="42" r="8" fill="#f0c674"/><path d="M64 98v18m0 0l-12-12m12 12l12-12" stroke="#b5bd68" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
for (const n of [16, 48, 128]) await sharp(Buffer.from(svg)).resize(n, n).png().toFile(`public/icons/${n}.png`);
