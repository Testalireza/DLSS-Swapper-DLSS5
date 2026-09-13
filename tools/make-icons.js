'use strict';

/**
 * make-icons.js — generates the application icons procedurally.
 * Zero dependencies: signed-distance-field rendering into RGBA buffers,
 * a hand-rolled PNG encoder (zlib via node core) and a PNG-compressed ICO
 * container writer.
 *
 * Design: rounded-square tile with the app's green accent gradient
 * (#9BD494 → #68B260 on the #8BCA84 family), a faint "neural mesh" of
 * connected nodes (DLSS 5 Neural Rendering), and a bold white "5" drawn
 * from capsule segments.
 *
 * Outputs:
 *   resources/icons/icon.png        1024×1024 (electron-builder, index.html)
 *   resources/icons/icon.ico        256/48/32 multi-size ICO (Windows build)
 *   resources/icons/icon-256.png    256×256 (misc uses)
 *
 * Run: npm run icons
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'resources', 'icons');

// --------------------------------------------------------------------- SDFs

function sdRoundBox(px, py, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(px - cx) - (halfW - r);
  const dy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - r;
}

function sdCapsule(px, py, x1, y1, x2, y2, r) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = px - x1;
  const wy = py - y1;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(wx - t * vx, wy - t * vy) - r;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/** 1 inside, 0 outside, smooth over ~1.2px. */
function cover(d) {
  const a = 0.5 - d / 1.2;
  return Math.max(0, Math.min(1, a));
}

function lerp(a, b, t) { return a + (b - a) * t; }

// --------------------------------------------------------------- scene data

// Deterministic pseudo-random (mulberry32) so icons are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Neural mesh nodes/edges in unit coordinates (0..1). */
function neuralMesh() {
  const rand = rng(20260912);
  const nodes = [];
  for (let i = 0; i < 22; i++) {
    nodes.push({ x: 0.08 + rand() * 0.84, y: 0.08 + rand() * 0.84, r: 0.008 + rand() * 0.012 });
  }
  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      if (d < 0.22 && rand() < 0.55) edges.push([i, j]);
    }
  }
  return { nodes, edges };
}

const MESH = neuralMesh();

// The "5" glyph: five capsule segments (seven-segment style), unit coords.
const GLYPH = {
  // bounding box of the digit inside the tile
  left: 0.34, right: 0.66, top: 0.27, bottom: 0.73,
  thickness: 0.052,
};

function glyphSegments() {
  const g = GLYPH;
  const t = g.thickness / 2;
  const midY = (g.top + g.bottom) / 2;
  return [
    // top horizontal
    [g.left + t, g.top + t, g.right - t, g.top + t],
    // upper-left vertical
    [g.left + t, g.top + t, g.left + t, midY - t],
    // middle horizontal
    [g.left + t, midY, g.right - t, midY],
    // lower-right vertical
    [g.right - t, midY + t, g.right - t, g.bottom - t],
    // bottom horizontal
    [g.left + t, g.bottom - t, g.right - t, g.bottom - t],
  ];
}

// ------------------------------------------------------------------- render

function renderTile(size) {
  const px = new Float64Array(size * size * 4); // RGBA, 0..1
  const cx = size / 2;
  const half = size * 0.46;          // tile half-size (small margin)
  const radius = size * 0.185;       // corner radius
  const segs = glyphSegments().map(([x1, y1, x2, y2]) => [x1 * size, y1 * size, x2 * size, y2 * size]);
  const glyphR = (GLYPH.thickness / 2) * size;

  // gradient stops (accent family)
  const top = [0x9b / 255, 0xd4 / 255, 0x94 / 255];     // #9BD494
  const bottom = [0x5f / 255, 0xa8 / 255, 0x58 / 255];  // #5FA858
  const deep = [0x2f / 255, 0x6b / 255, 0x33 / 255];    // #2F6B33 (radial vignette)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // --- tile background ---
      const dTile = sdRoundBox(x + 0.5, y + 0.5, cx, cx, half, half, radius);
      const aTile = cover(dTile);
      if (aTile <= 0) { px[i + 3] = 0; continue; }

      const ty = (y + 0.5 - (cx - half)) / (2 * half); // 0 at tile top → 1 bottom
      let r = lerp(top[0], bottom[0], ty);
      let g = lerp(top[1], bottom[1], ty);
      let b = lerp(top[2], bottom[2], ty);

      // radial vignette toward the deep green at the corners
      const dCenter = Math.hypot(x + 0.5 - cx, y + 0.5 - cx) / (half * 1.45);
      const vig = Math.max(0, Math.min(1, (dCenter - 0.55) / 0.45)) * 0.35;
      r = lerp(r, deep[0], vig);
      g = lerp(g, deep[1], vig);
      b = lerp(b, deep[2], vig);

      // soft highlight near the top edge
      const dTopEdge = sdRoundBox(x + 0.5, y + 0.5, cx, cx - half * 0.92, half * 0.98, half * 0.25, radius);
      const hl = cover(dTopEdge) * 0.16 * (1 - ty);
      r = lerp(r, 1, hl); g = lerp(g, 1, hl); b = lerp(b, 1, hl);

      // --- neural mesh (subtle white, clipped to the tile) ---
      const ux = (x + 0.5) / size;
      const uy = (y + 0.5) / size;
      let mesh = 0;
      for (const [a, bIdx] of MESH.edges) {
        const na = MESH.nodes[a];
        const nb = MESH.nodes[bIdx];
        const d = sdCapsule(ux, uy, na.x, na.y, nb.x, nb.y, 0.0022);
        mesh = Math.max(mesh, cover(d * size) * 0.30);
      }
      for (const n of MESH.nodes) {
        const d = sdCircle(ux, uy, n.x, n.y, n.r);
        mesh = Math.max(mesh, cover(d * size) * 0.40);
      }
      r = lerp(r, 1, mesh); g = lerp(g, 1, mesh); b = lerp(b, 1, mesh);

      // --- "5" glyph: soft drop shadow then white body ---
      let dGlyph = Infinity;
      for (const [x1, y1, x2, y2] of segs) {
        dGlyph = Math.min(dGlyph, sdCapsule(x + 0.5, y + 0.5, x1, y1, x2, y2, glyphR));
      }
      const shadow = cover(dGlyph - size * 0.006) * 0.22;
      r = lerp(r, 0.10, shadow); g = lerp(g, 0.22, shadow); b = lerp(b, 0.10, shadow);

      const aGlyph = cover(dGlyph);
      r = lerp(r, 1, aGlyph); g = lerp(g, 1, aGlyph); b = lerp(b, 1, aGlyph);

      // --- inner rim light on the tile border ---
      const rim = Math.max(0, 1 - Math.abs(dTile + size * 0.006) / (size * 0.006)) * 0.25;
      r = lerp(r, 1, rim); g = lerp(g, 1, rim); b = lerp(b, 1, rim);

      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = aTile;
    }
  }
  return px;
}

// -------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(floatPx, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = y * (size * 4 + 1) + 1 + x * 4;
      const a = floatPx[s + 3];
      // premultiplied floats → straight 8-bit RGBA
      raw[d] = Math.round(Math.min(1, Math.max(0, floatPx[s])) * 255);
      raw[d + 1] = Math.round(Math.min(1, Math.max(0, floatPx[s + 1])) * 255);
      raw[d + 2] = Math.round(Math.min(1, Math.max(0, floatPx[s + 2])) * 255);
      raw[d + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------- ICO encoder

function encodeICO(pngsBySize) {
  const entries = Object.keys(pngsBySize).map(Number).sort((a, b) => b - a);
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const parts = [dir];
  for (const size of entries) {
    const png = pngsBySize[size];
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // width (0 = 256)
    e[1] = size >= 256 ? 0 : size; // height
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);          // planes
    e.writeUInt16LE(32, 6);         // bit count
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    parts.push(e);
    offset += png.length;
  }
  for (const size of entries) parts.push(pngsBySize[size]);
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------- main

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jobs = [
    { size: 1024, file: 'icon.png' },
    { size: 256, file: 'icon-256.png' },
  ];
  for (const { size, file } of jobs) {
    const png = encodePNG(renderTile(size), size);
    fs.writeFileSync(path.join(OUT_DIR, file), png);
    console.log(`wrote resources/icons/${file} (${size}×${size}, ${(png.length / 1024).toFixed(1)} KB)`);
  }
  const icoSizes = [256, 48, 32];
  const pngs = {};
  for (const s of icoSizes) pngs[s] = encodePNG(renderTile(s), s);
  const ico = encodeICO(pngs);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
  console.log(`wrote resources/icons/icon.ico (${icoSizes.join('/')} px, ${(ico.length / 1024).toFixed(1)} KB)`);
}

main();
