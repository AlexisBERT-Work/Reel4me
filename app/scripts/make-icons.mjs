/**
 * Genere les icones PWA sans aucune dependance.
 *
 * Encoder un PNG a la main revient a trois chunks (IHDR, IDAT, IEND) plus un
 * CRC32 : c'est plus court que d'ajouter sharp ou canvas au projet pour deux
 * fichiers generes une seule fois.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'public');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixel) {
  // Une ligne = 1 octet de filtre (0 = aucun) + size * RGBA.
  const raw = Buffer.alloc(size * (1 + size * 4));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // profondeur 8 bits
  ihdr[9] = 6; // RGBA
  // 10-12 : compression, filtre, entrelacement — tous a 0.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Distance signee a un rectangle a coins arrondis, pour un bord net. */
function roundedRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

const lerp = (a, b, t) => a + (b - a) * t;

function draw(x, y, size) {
  const u = x / size;
  const v = y / size;

  // Fond : degrade diagonal violet -> bleu nuit, dans l'esprit des cartes.
  const t = Math.min(1, Math.max(0, (u + v) / 2));
  let r = lerp(88, 24, t);
  let g = lerp(101, 26, t);
  let b = lerp(242, 54, t);

  // Trois barres empilees : la pile de cartes du feed.
  const bars = [
    { cy: 0.34, halfW: 0.16, halfH: 0.045 },
    { cy: 0.5, halfW: 0.24, halfH: 0.045 },
    { cy: 0.66, halfW: 0.2, halfH: 0.045 },
  ];

  for (const bar of bars) {
    const d = roundedRect(u, v, 0.5, bar.cy, bar.halfW, bar.halfH, 0.042);
    // Anti-aliasing sur ~1 pixel.
    const alpha = Math.min(1, Math.max(0, 0.5 - d * size));
    if (alpha > 0) {
      r = lerp(r, 250, alpha);
      g = lerp(g, 250, alpha);
      b = lerp(b, 252, alpha);
    }
  }

  return [Math.round(r), Math.round(g), Math.round(b), 255];
}

mkdirSync(OUT, { recursive: true });
for (const size of [192, 512]) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, png(size, draw));
  console.log(`${file} (${size}x${size})`);
}
