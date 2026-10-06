// Relay Golf's 3D look (the chunky toy diorama), shared by the game (app.js) and the look test (look.js, where the
// settings are tuned). createDiorama builds a board from a tile map: a height field over the tiles (blurred so edges
// round off) with colour and a baked normal map painted per pixel from the same blurred type masks; basins for sand
// and water; fur shells and grass cards on the rough; felt trees with bark; a refracting water shader; a sky dome
// with clouds, stars and rain; and a post pass (half-resolution accumulated fog with light shafts, then grading).
//
// Tile types: F fairway, R light rough, K thick rough, T trees, S sand, W water, G green, E tee, M hill, P ramp.
// Board space: tile (x, z) covers x..x+1, z..z+1; `origin` moves the board (the game's tile centres sit on whole
// numbers, so it passes [-0.5, -0.5]).
import * as THREE from 'three';

const ANISO = 8;

export const GROUPS = {
  Light: { sunEl: ['Sun height', 15, 85, 1, 67], sunAz: ['Sun bearing', -180, 180, 1, -83], sun: ['Sun', 0, 4, 0.05, 2.2], sky: ['Sky fill', 0, 3, 0.05, 1.6], exposure: ['Exposure', 0.4, 2, 0.01, 1.5], soft: ['Shadow blur', 0, 12, 0.5, 6.5] },
  Colour: { sat: ['Saturation', 0, 2, 0.01, 0.97], grain: ['Felt grain', 0, 0.6, 0.01, 0.43], bump: ['Grain relief', 0, 0.06, 0.001, 0.029], outline: ['Edge lines', 0, 0.4, 0.01, 0.09], cavity: ['Crease shade', 0, 3, 0.05, 0.6], stripes: ['Stripes', 0, 1, 0.01, 0.83], grid: ['Grid lines', 0, 0.6, 0.01, 0.1] },
  Shape: { lift: ['Turf heights', 0, 2.5, 0.05, 0.8], pillow: ['Cushions', 0, 0.4, 0.01, 0.38], round: ['Roundness', 1, 8, 1, 7], bevel: ['Edge bevel', 0, 3, 0.05, 1.15], hill: ['Hill height', 0, 2, 0.05, 0.65], ramp: ['Ramp height', 0, 0.8, 0.01, 0.35], sand: ['Bunker depth', 0, 0.6, 0.01, 0.26], dirt: ['Dirt band', 0, 1, 0.01, 0.5], sandGrain: ['Sand grain', 0, 1, 0.01, 0.45], pond: ['Pond depth', 0, 1, 0.01, 0.55], board: ['Board depth', 0, 1.5, 0.05, 0.75] },
  Trees: { tree: ['Tree size', 0.5, 1.8, 0.01, 1.5], lumps: ['Canopy lumps', 1, 6, 1, 5], fuzz: ['Canopy fuzz', 0, 1, 0.01, 0.86], sheen: ['Felt sheen', 0, 1.5, 0.01, 0.88], bark: ['Bark relief', 0, 3, 0.05, 1.2] },
  Grass: { cards: ['Cones / cards', 0, 1, 1, 1], blades: ['Blade style', 1, 3, 1, 3], tufts: ['Thick rough', 0, 3, 0.05, 1.6], tuftsR: ['Light rough', 0, 3, 0.05, 0.15], tuftH: ['Tuft height', 0.4, 2.5, 0.05, 0.6], tuftW: ['Tuft width', 0.4, 2.5, 0.05, 0.75], sway: ['Sway', 0, 1, 0.01, 0.35], lip: ['Edge blades', 0, 3, 0.05, 0.25], pebbles: ['Pebbles', 0, 3, 0.05, 1.75] },
  Fur: { shells: ['Shells', 0, 20, 1, 10], furLen: ['Fur length', 0, 0.4, 0.005, 0.13], furDensity: ['Strands', 8, 128, 1, 56], clump: ['Clumping', 0, 1, 0.01, 0.35], furRoot: ['Root shade', 0, 1, 0.01, 0.5] },
  'Water and mist': { ripple: ['Refraction', 0, 3, 0.05, 0.55], clear: ['Clarity', 0, 1, 0.01, 0.48], mist: ['Mist', 0, 1, 0.01, 0.41], puffs: ['Mist puffs', 1, 5, 1, 3] },
  Post: { post: ['Post pass', 0, 1, 1, 1], even: ['Even out', 0, 1, 0.01, 0.36], contrast: ['Contrast', 0.6, 1.5, 0.01, 1.16], psat: ['Saturation', 0, 2, 0.01, 1.12], warm: ['Warmth', -1, 1, 0.01, 0.04], shadowLift: ['Shadow lift', 0, 0.25, 0.005, 0.01], vignette: ['Vignette', 0, 1, 0.01, 0.07] },
  Fog: { fog: ['Fog', 0, 2, 0.01, 0.19], fogH: ['Fog height', 0.1, 4, 0.05, 1.05], fogNoise: ['Fog patches', 0, 1, 0.01, 0.09], fogSun: ['Sun glow', 0, 3, 0.05, 0.55], fogStart: ['Fog start', 0, 30, 0.5, 3], fogSteps: ['Fog steps', 4, 48, 1, 10], shafts: ['Light shafts', 0, 4, 0.05, 1.3] },
  'Sky and weather': { clouds: ['Cloud cover', 0, 1, 0.01, 0.15], cloudDark: ['Cloud shade', 0, 1, 0.01, 0.1], rain: ['Rain', 0, 1, 0.01, 0], wind: ['Wind', 0, 1, 0.01, 0.3], stars: ['Stars', 0, 1, 0.01, 0] },
};
export const DEFAULTS = {};
// Markers that draw over everything (depthTest off: labels, aim lines) go on this layer: drawn after the water, so
// the water neither covers them nor refracts a ghost of them.
export const TOP_LAYER = 2;
for (const g of Object.values(GROUPS)) for (const [k, d] of Object.entries(g)) DEFAULTS[k] = d[4];
// Colours the time-of-day presets set (sRGB hex; no sliders): sky zenith and horizon, the sun, ambient sky and ground.
Object.assign(DEFAULTS, { skyTop: 0x4a90e2, skyHorizon: 0xcde8fa, sunCol: 0xfff2da, hemiTop: 0xe6f4ff, hemiBottom: 0x6c8f4a, timeOfDay: 'noon', weather: 'clear' });
// Time of day: absolute values for the light. Weather then adjusts whatever time is set.
export const TIMES = {
  morning: { sunEl: 22, sunAz: 105, sun: 2.1, sky: 1.45, exposure: 1.55, warm: 0.16, sunCol: 0xffc68c, skyTop: 0x86b2e6, skyHorizon: 0xffdcb4, hemiTop: 0xc4d6f0, hemiBottom: 0x6b7a4a, fog: 0.17, fogH: 1.4, fogSun: 1.3, fogNoise: 0.35, shafts: 1.7, stars: 0, even: 0.4, contrast: 1.1, psat: 1.08, soft: 6.5 },
  noon: { sunEl: 67, sunAz: -83, sun: 2.2, sky: 1.6, exposure: 1.5, warm: 0.04, sunCol: 0xfff2da, skyTop: 0x4a90e2, skyHorizon: 0xcde8fa, hemiTop: 0xe6f4ff, hemiBottom: 0x6c8f4a, fog: 0.13, fogH: 1.05, fogSun: 0.55, fogNoise: 0.09, shafts: 1.3, stars: 0, even: 0.36, contrast: 1.16, psat: 1.12, soft: 6.5 },
  sunset: { sunEl: 19, sunAz: -100, sun: 2.2, sky: 1.4, exposure: 1.6, warm: 0.12, sunCol: 0xffc290, skyTop: 0x5b6cb0, skyHorizon: 0xffa575, hemiTop: 0xe0c2d0, hemiBottom: 0x66683e, fog: 0.14, fogH: 1.3, fogSun: 1.7, fogNoise: 0.25, shafts: 1.9, stars: 0, even: 0.42, contrast: 1.1, psat: 1.15, soft: 7 },
  evening: { sunEl: 10, sunAz: -112, sun: 0.9, sky: 1.85, exposure: 2.0, warm: -0.25, sunCol: 0xff8466, skyTop: 0x1f2b5c, skyHorizon: 0x8b6f9f, hemiTop: 0x7e8ac8, hemiBottom: 0x30362a, fog: 0.12, fogH: 1.2, fogSun: 0.8, fogNoise: 0.3, shafts: 0.5, stars: 0.7, even: 0.45, contrast: 1.05, psat: 0.95, soft: 9 },
};
export const WEATHER = {
  clear: (s) => Object.assign(s, { clouds: 0.15, cloudDark: 0.1, rain: 0 }),
  hazy: (s) => Object.assign(s, { clouds: 0.3, cloudDark: 0.15, rain: 0, fog: s.fog + 0.2, fogH: Math.max(s.fogH, 1.8), contrast: s.contrast * 0.95, psat: s.psat * 0.92 }),
  foggy: (s) => Object.assign(s, { clouds: 0.55, cloudDark: 0.2, rain: 0, fog: s.fog + 0.4, fogH: 2.2, fogNoise: 0.5, fogStart: 0, sun: s.sun * 0.55, contrast: s.contrast * 0.88, psat: s.psat * 0.8, mist: 0.7 }),
  cloudy: (s) => Object.assign(s, { clouds: 0.82, cloudDark: 0.4, rain: 0, sun: s.sun * 0.35, sky: s.sky * 1.2, soft: 11, shafts: s.shafts * 0.4, psat: s.psat * 0.88, contrast: s.contrast * 0.95 }),
  rainy: (s) => Object.assign(s, { clouds: 1, cloudDark: 0.7, rain: 0.8, wind: 0.45, sun: s.sun * 0.15, sky: s.sky * 1.05, exposure: s.exposure * 0.92, soft: 12, shafts: s.shafts * 0.2, fog: s.fog + 0.22, fogH: 2.2, psat: s.psat * 0.75, contrast: s.contrast * 0.92, ripple: 1.6 }),
};

// ---------- noise and shared textures ----------
// ---------- noise and small textures ----------
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hash2 = (x, y) => { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
function vnoise(x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0), b = hash2(x0 + 1, y0), c = hash2(x0, y0 + 1), d = hash2(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
// Tileable value noise on an N x N canvas (periodic lattice), several octaves.
function tileNoise(N, octaves, seed) {
  const out = new Float32Array(N * N), r = rng(seed);
  for (const [cells, amp] of octaves) {
    const g = []; for (let i = 0; i < cells * cells; i++) g.push(r());
    const v = (i, j) => g[((j % cells + cells) % cells) * cells + ((i % cells + cells) % cells)];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = (x / N) * cells, fy = (y / N) * cells, x0 = Math.floor(fx), y0 = Math.floor(fy), u = fx - x0, w = fy - y0, su = u * u * (3 - 2 * u), sw = w * w * (3 - 2 * w);
      const top = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * su, bot = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * su;
      out[y * N + x] += amp * (top + (bot - top) * sw);
    }
  }
  return out;
}
function grayTexture(N, data, srgb) {
  const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'), img = g.createImageData(N, N);
  for (let i = 0; i < N * N; i++) { const k = Math.max(0, Math.min(255, Math.round(255 * data[i]))); img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = k; img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = ANISO;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// A normal map from a tileable height array.
function normalTexture(N, h, k) {
  const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'), img = g.createImageData(N, N), q = (x, y) => h[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let nx = -(q(x + 1, y) - q(x - 1, y)) * k, ny = (q(x, y + 1) - q(x, y - 1)) * k, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * N + x) * 4; img.data[i] = (nx * 0.5 + 0.5) * 255; img.data[i + 1] = (ny * 0.5 + 0.5) * 255; img.data[i + 2] = (nz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = ANISO;
  return t;
}
// Felt: soft blotches and fine fibres, tiled in world space over the ground.
const FELT = (() => { const n = tileNoise(512, [[8, 0.35], [32, 0.3], [128, 0.35]], 7); return grayTexture(512, n, false); })();
// Canopy fibres: a fine fibre normal map, and an alpha pattern for the fuzz shells.
const FIBRE = (() => { const n = tileNoise(256, [[16, 0.3], [64, 0.4], [128, 0.3]], 31); return normalTexture(256, n, 6); })();
const SAND = (() => {
  const N = 512, r = rng(83), d = new Float32Array(N * N), m = tileNoise(N, [[32, 0.5], [96, 0.5]], 84);
  for (let i = 0; i < N * N; i++) { const g = r(); d[i] = 0.5 + 0.35 * (m[i] - 0.5) + (g > 0.93 ? 0.35 : g < 0.06 ? -0.3 : (g - 0.5) * 0.25); }
  return grayTexture(N, d, false);
})();
function strandTexture(clump) {
  const N = 128, r = rng(91), cl = tileNoise(N, [[8, 0.6], [16, 0.4]], 92), d = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) d[i] = Math.max(0, Math.min(1, r() * (1 - clump) + cl[i] * clump * 1.1));
  const t = grayTexture(N, d, false); t.magFilter = THREE.NearestFilter;
  return t;
}
const FUZZ = (() => { const n = tileNoise(256, [[64, 0.5], [128, 0.5]], 47); return grayTexture(256, n, false); })();
function softDot(color) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  gr.addColorStop(0, color); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function markerTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const glow = g.createRadialGradient(64, 64, 20, 64, 64, 64); glow.addColorStop(0, 'rgba(255,214,90,.9)'); glow.addColorStop(1, 'rgba(255,214,90,0)');
  g.fillStyle = glow; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#F2B52E'; g.beginPath(); g.arc(64, 64, 30, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff'; g.font = '800 40px Nunito, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', 64, 67);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------- colours (sRGB) ----------
// ---------- colours (sRGB) ----------
const COL = { F: 0x8fd24e, F2: 0x6cb83a, R: 0x58a338, cut: 0xa3d052, K: 0x3a8a2c, T: 0x46902f, S: 0xf1dfb4, sandLip: 0xc9b07a, W: 0x2c86c4, sandDirt: 0xb18c5c, earth: 0x7a5636, earthWet: 0x5a3f27, bedShallow: 0x6f9a5a, bedDeep: 0x1f6fae, G: 0xa5dc62, fringe: 0x79c348, E: 0x94d658, M: 0x66b444, P: 0x9fdc66, soilTop: 0x7a4a2a, soilBot: 0x55331d };
const TREE_COLS = [0x3f8f35, 0x5aa83c, 0x2f7a33, 0x78bd45, 0x4f9d3a];

// ---------- grass cards: three crossed quads per tuft, with a painted blade texture ----------
// Blade styles: 1 fine and dense, 2 broad blades, 3 a curly clump. Light at the tips, dark at the base (the instance
// colour tints it). Normals point up so the cards light like the ground they stand on.
function bladeTexture(style) {
  const N = 128, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'), r = rng(100 + style);
  const count = style === 1 ? 26 : style === 2 ? 11 : 18;
  for (let b = 0; b < count; b++) {
    const x0 = N * (0.12 + 0.76 * r()), h = N * (0.55 + 0.42 * r()), lean = (r() - 0.5) * N * (style === 3 ? 0.7 : 0.35), w = style === 1 ? 2.5 + r() * 2 : style === 2 ? 6 + r() * 5 : 4 + r() * 3;
    const grad = g.createLinearGradient(0, N, 0, N - h);
    const tip = 225 + Math.round(r() * 30), base = 120 + Math.round(r() * 40);
    grad.addColorStop(0, `rgb(${base},${base},${base})`); grad.addColorStop(1, `rgb(${tip},${tip},${tip})`);
    g.fillStyle = grad; g.beginPath();
    g.moveTo(x0 - w, N);
    g.quadraticCurveTo(x0 - w * 0.4 + lean * 0.3, N - h * 0.55, x0 + lean, N - h);
    g.quadraticCurveTo(x0 + w * 0.4 + lean * 0.3, N - h * 0.55, x0 + w, N);
    g.closePath(); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = ANISO;
  return t;
}
const BLADES = [null, bladeTexture(1), bladeTexture(2), bladeTexture(3)];
// Bark: long vertical ridges (a noise lattice stretched along the trunk, periodic around it so it wraps without a
// seam), dark cracks between them, fine fibres and a few knots. A colour map and a normal map from the same heights.
const BARK = (() => {
  const N = 256, r = rng(131), CX = 14, CY = 3, g = [];
  for (let i = 0; i < CX * CY; i++) g.push(r());
  const lat = (i, j) => g[((j % CY + CY) % CY) * CX + ((i % CX + CX) % CX)];
  const smooth3 = (q) => q * q * (3 - 2 * q);
  const fib = []; for (let x = 0; x < N; x++) fib.push(r());
  const knots = []; for (let k = 0; k < 4; k++) knots.push([r() * N, r() * N, 6 + r() * 8]);
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const fx = (x / N) * CX, fy = (y / N) * CY, i = Math.floor(fx), j = Math.floor(fy), u = smooth3(fx - i), v = smooth3(fy - j);
    const a = lat(i, j) + (lat(i + 1, j) - lat(i, j)) * u, b = lat(i, j + 1) + (lat(i + 1, j + 1) - lat(i, j + 1)) * u;
    let val = a + (b - a) * v;
    val = Math.pow(Math.abs(Math.sin(val * Math.PI * 2.2)), 0.6); // ridges with sharp cracks
    val = val * 0.85 + fib[x] * 0.15;
    for (const [kx, ky, kr] of knots) { let dx = Math.abs(x - kx); dx = Math.min(dx, N - dx); const d = Math.hypot(dx, (y - ky) * 0.8) / kr; if (d < 1) val = val * d + (1 - d) * (0.25 + 0.5 * d); }
    h[y * N + x] = val;
  }
  const c = document.createElement('canvas'); c.width = c.height = N;
  const cg = c.getContext('2d'), img = cg.createImageData(N, N), lo = [56, 35, 21], hi = [162, 114, 72];
  for (let i = 0; i < N * N; i++) { const q = Math.min(1, h[i] * 1.1); for (let ch = 0; ch < 3; ch++) img.data[i * 4 + ch] = lo[ch] + (hi[ch] - lo[ch]) * q; img.data[i * 4 + 3] = 255; }
  cg.putImageData(img, 0, 0);
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.wrapS = map.wrapT = THREE.RepeatWrapping; map.anisotropy = ANISO;
  return { map, normal: normalTexture(N, h, 3) };
})();
function cardGeometry() {
  const parts = [];
  for (let k = 0; k < 3; k++) {
    const g = new THREE.PlaneGeometry(1, 1); g.translate(0, 0.5, 0); g.rotateY((k * Math.PI) / 3);
    parts.push(g);
  }
  const pos = [], uv = [], nrm = [], idx = [];
  for (const g of parts) {
    const o = pos.length / 3;
    pos.push(...g.attributes.position.array); uv.push(...g.attributes.uv.array);
    for (let i = 0; i < g.attributes.position.count; i++) nrm.push(0, 1, 0);
    for (const i of g.index.array) idx.push(o + i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  return geo;
}

// opts: renderer, scene, map { W, H, at(x, z) -> type }, settings (the S object, shared and edited by the caller),
// origin [x, z], quality { sub, px }, mist (a list of [x, z] tiles under mist, or none).
export function createDiorama({ renderer, scene, map, settings, origin = [0, 0], quality = {}, mist = [] }) {
const S = settings, W = map.W, H = map.H, [ox, oz] = origin, at = (x, z) => map.at(Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(H - 1, z)));
const Q = { sub: quality.sub || 12, px: quality.px || 64, shadow: quality.shadow || 2048, canopy: quality.canopy ?? 3, fuzzShells: quality.fuzzShells ?? 3 };
// Parts of the board can be marked low detail (map.lowDetail: scenery nobody plays on, such as the game's forest ring):
// their trees are simpler, and the fur shells don't cover them.
const lowDetail = (x, z) => (map.lowDetail ? map.lowDetail(x, z) : false);
const TYPES = 'FRKTSWGEMP';
const tilesOf = (t) => { const o = []; for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) if (at(x, z) === t) o.push([x, z]); return o; };
let mistTiles = mist, gridBoost = null, ground = null, groundGeo = null, baseY = null;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // (PCF honours shadow.radius; PCFSoft doesn't)
renderer.toneMapping = THREE.NeutralToneMapping; // (ACES washes the greens out)
// The sky: a dome that follows the camera (drawn first, writing no depth, so the fog pass leaves it alone): a gradient
// from horizon to zenith, the sun's disc and glow, drifting clouds over a plane above the board, and stars at dusk.
const skyUniforms = { uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() }, uCover: { value: 0 }, uShade: { value: 0 }, uTime: { value: 0 }, uWind: { value: 0 }, uStars: { value: 0 } };
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(90, 48, 24), new THREE.ShaderMaterial({
  uniforms: skyUniforms, side: THREE.BackSide, depthWrite: false,
  vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform vec3 uTop, uHorizon, uSunDir, uSunCol; uniform float uCover, uShade, uTime, uWind, uStars; varying vec3 vDir;
    float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float n2(vec2 p) { vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f); return mix(mix(h2(i), h2(i + vec2(1, 0)), u.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), u.x), u.y); }
    float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * n2(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
    void main() {
      vec3 d = normalize(vDir); float up = max(d.y, 0.0);
      vec3 col = mix(uHorizon, uTop, pow(up, 0.5));
      vec3 below = mix(uHorizon, vec3(dot(uHorizon, vec3(0.3, 0.5, 0.2))), 0.55) * 0.82; // (under the board: quieter)
      if (d.y < 0.0) col = mix(uHorizon, below, min(1.0, -d.y * 4.0));
      float mu = max(dot(d, uSunDir), 0.0);
      col += uSunCol * (pow(mu, 6.0) * 0.35 + pow(mu, 60.0) * 0.6) * (1.0 - uCover * 0.85);
      col += uSunCol * smoothstep(0.9993, 0.9997, mu) * 6.0 * (1.0 - uCover * 0.95);
      if (uStars > 0.0 && d.y > 0.0) {
        vec2 sp = d.xz / (d.y + 0.3) * 60.0; vec2 cell = floor(sp);
        float st = step(0.985, h2(cell)) * smoothstep(0.35, 0.0, length(fract(sp) - 0.5));
        col += vec3(st) * uStars * up * (1.0 - uCover);
      }
      if (d.y > 0.0) {
        vec2 uv = d.xz / (d.y + 0.12) * 0.9 + vec2(uTime * 0.012, uTime * 0.006) * (0.3 + uWind * 2.0);
        float n = fbm(uv);
        float c = smoothstep(0.62 - uCover * 0.55, 0.85 - uCover * 0.45, n) * smoothstep(0.0, 0.12, d.y);
        float lit = 0.6 + 0.4 * smoothstep(0.3, 0.9, fbm(uv + uSunDir.xz * 0.15));
        vec3 cloud = mix(uHorizon * 0.55 + uSunCol * 0.25, vec3(1.0) * 0.95 + uSunCol * 0.15, lit) * (1.0 - uShade * 0.6);
        col = mix(col, cloud, c);
      }
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
}));
skyDome.renderOrder = -1; skyDome.frustumCulled = false;
scene.add(skyDome);
const hemi = new THREE.HemisphereLight(0xe6f4ff, 0x6c8f4a, 1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2da, 2);
sun.castShadow = true;
sun.shadow.autoUpdate = false; // (redrawn when the board or the light changes: build, light, hiding a tree)
sun.shadow.mapSize.set(Q.shadow, Q.shadow);
{ const half = Math.hypot(W, H) / 2 + 1; Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 30 + half * 2 }); }
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
const rainUniforms = { uTime: { value: 0 }, uRain: { value: 0 }, uWind: { value: 0 }, uCol: { value: new THREE.Color(0xdfe9f2) } };
const rain = (() => {
  const N = Math.round(6000 * ((W + 6) * (H + 6)) / 440), r = (() => { let s = 5; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
  const seed = new Float32Array(N * 2 * 3), end = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) { const x = ox - 3 + r() * (W + 6), y = r() * 14, z = oz - 3 + r() * (H + 6); for (const e of [0, 1]) { seed.set([x, y, z], (i * 2 + e) * 3); end[i * 2 + e] = e; } }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(seed, 3)); g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  const m = new THREE.LineSegments(g, new THREE.ShaderMaterial({
    uniforms: rainUniforms, transparent: true, depthWrite: false,
    vertexShader: `uniform float uTime, uWind; attribute float aEnd; varying float vEnd;
      void main() { vec3 p = position; float y = mod(p.y - uTime * 9.0, 14.0) - 1.0;
        vec3 v = normalize(vec3(uWind * 0.6, -1.0, uWind * 0.2));
        vec3 q = vec3(p.x - v.x * (14.0 - y) * 0.4, y, p.z) - v * aEnd * 0.35; vEnd = aEnd;
        gl_Position = projectionMatrix * viewMatrix * vec4(q, 1.0); }`,
    fragmentShader: 'uniform float uRain; uniform vec3 uCol; varying float vEnd; void main() { gl_FragColor = vec4(uCol, uRain * 0.45 * (0.3 + 0.7 * vEnd)); }',
  }));
  m.frustumCulled = false; m.visible = false; m.userData.N = N;
  return m;
})();
scene.add(rain);
const world = new THREE.Group();
world.position.set(ox, 0, oz);
scene.add(world);
// The scene without the water, for the water's refraction.
const sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
// The post pass: the scene renders (linear, before tone mapping) into postRT with its depth; one full-screen shader
// then adds height fog (marched along each view ray through drifting noise, lit by the sky and the sun) and grades
// the colours (even out, warmth, saturation, tone mapping, contrast, shadow lift, vignette).
const postRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType) });
const postUniforms = {
  tColor: { value: postRT.texture }, tDepth: { value: postRT.depthTexture }, uInvViewProj: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() },
  uTime: { value: 0 }, uExposure: { value: 1 }, uEven: { value: 0 }, uContrast: { value: 1 }, uSat: { value: 1 }, uWarm: { value: 0 }, uLift: { value: 0 }, uVignette: { value: 0 },
  uFog: { value: 0 }, uFogH: { value: 1 }, uFogBase: { value: 0 }, uFogNoise: { value: 0 }, uFogSun: { value: 1 }, uFogStart: { value: 0 }, uSteps: { value: 14 },
  uDebug: { value: 0 }, tShadow: { value: null }, uShadowMatrix: { value: new THREE.Matrix4() }, uShafts: { value: 0 }, uSunPower: { value: 1 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(0xfff2da) }, uSkyCol: { value: new THREE.Color(0xbfe3f6) },
};
const postScene = new THREE.Scene(), postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
// Fog runs in its own pass at half resolution: each frame marches every ray with a fresh offset (interleaved gradient
// noise, turned each frame) and blends into the frames before it while the view holds still, so a few steps per frame
// add up to many. The composite then upsamples it with a blur that respects depth (no halos round the trees).
const fogRTs = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
const fogState = { ping: 0, frames: 0, key: '' };
Object.assign(postUniforms, { tHistory: { value: null }, uBlend: { value: 1 }, uFrame: { value: 0 }, tFog: { value: null }, uFogTexel: { value: new THREE.Vector2(1, 1) } });
const FOG_LIB = `precision highp float;
    #include <packing>
    uniform sampler2D tShadow; uniform mat4 uShadowMatrix; uniform float uShafts, uSunPower, uDebug;
    uniform sampler2D tColor, tDepth, tHistory, tFog; uniform mat4 uInvViewProj; uniform vec3 uCam, uSunDir, uSunCol, uSkyCol;
    uniform float uTime, uExposure, uEven, uContrast, uSat, uWarm, uLift, uVignette, uFog, uFogH, uFogBase, uFogNoise, uFogSun, uFogStart, uBlend, uFrame;
    uniform int uSteps; uniform vec2 uFogTexel;
    varying vec2 vUv;
    float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float noise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
                 mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
    float density(vec3 p) {
      float h = exp(-max(p.y - uFogBase, 0.0) / uFogH);
      vec3 q = p * 0.32 + vec3(uTime * 0.05, uTime * 0.01, uTime * 0.03);
      float n = noise(q) * 0.65 + noise(q * 2.3) * 0.35;
      return uFog * 0.12 * h * mix(1.0, smoothstep(0.25, 0.85, n) * 1.8, uFogNoise);
    }
    float sunlit(vec3 p) {
      vec4 sc = uShadowMatrix * vec4(p, 1.0); sc.xyz /= sc.w;
      if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
      return step(sc.z - 0.003, unpackRGBAToDepth(texture2D(tShadow, sc.xy)));
    }
    vec3 worldAt(vec2 uv, float z) { vec4 w = uInvViewProj * vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0); return w.xyz / w.w; }`;
const quad = (uniforms, fragmentShader) => new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms, depthTest: false, depthWrite: false, toneMapped: false, fragmentShader,
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
}));
const copyScene = new THREE.Scene();
copyScene.add(quad({ tColor: { value: postRT.texture } }, 'uniform sampler2D tColor; varying vec2 vUv; void main() { gl_FragColor = texture2D(tColor, vUv); }'));
const fogScene = new THREE.Scene();
fogScene.add(quad(postUniforms, FOG_LIB + `
    void main() {
      float z = texture2D(tDepth, vUv).x;
      vec4 cur = vec4(0.0, 0.0, 0.0, 1.0); // in-scattered light, transmittance
      if (uFog > 0.0 && z < 1.0) { // (not on the sky: the board floats in it)
        vec3 dir = worldAt(vUv, z) - uCam; float len = length(dir); dir /= len;
        float start = min(uFogStart, len), span = len - start, stp = span / float(uSteps);
        float mu = dot(dir, uSunDir), phase = 0.5 + 0.5 * mu;
        vec3 sky = uSkyCol * mix(0.75 + 0.35 * phase, 0.45, min(uShafts, 1.0)); // (less sky when shafts are on, so shade reads)
        // Sunlight scattered toward the eye: a forward glow toward the sun plus a broad part, only where the sun reaches.
        vec3 sunS = uSunCol * uSunPower * (uFogSun * 0.5 * pow(max(mu, 0.0), 6.0) + uShafts * 0.6 * (0.25 + 1.5 * pow(0.5 + 0.5 * mu, 4.0)));
        bool shafts = uShafts > 0.0 || uFogSun > 0.0;
        // Interleaved gradient noise, shifted each frame: an even spread of offsets that averages out over frames.
        float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy + mod(uFrame, 64.0) * vec2(5.588238), vec2(0.06711056, 0.00583715))));
        float T = 1.0; vec3 L = vec3(0.0);
        for (int i = 0; i < 48; i++) {
          if (i >= uSteps) break;
          vec3 p = uCam + dir * (start + (float(i) + jit) * stp);
          float d = density(p) * stp;
          L += T * d * (sky + sunS * (shafts ? sunlit(p) : 1.0)); T *= exp(-d);
        }
        cur = vec4(L, T);
      }
      gl_FragColor = mix(texture2D(tHistory, vUv), cur, uBlend);
    }`));
postScene.add(quad(postUniforms, FOG_LIB + `
    vec3 neutral(vec3 c) { // Khronos PBR Neutral tone mapping
      float x = min(c.r, min(c.g, c.b)), off = x < 0.08 ? x - 6.25 * x * x : 0.04; c -= off;
      float peak = max(c.r, max(c.g, c.b)); if (peak < 0.76) return c;
      float d = 0.24, np = 1.0 - d * d / (peak + d - 0.76); c *= np / peak;
      return mix(c, vec3(np), 1.0 - 1.0 / (0.15 * (peak - np) + 1.0));
    }
    vec3 toSRGB(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    void main() {
      vec3 col = texture2D(tColor, vUv).rgb;
      float z = texture2D(tDepth, vUv).x;
      if (uDebug > 0.0) { gl_FragColor = vec4(vec3(sunlit(worldAt(vUv, z) + uSunDir * 0.02)), 1.0); return; }
      // Fog, upsampled from half resolution: a 3x3 blur weighted by how close each neighbour's depth is to this pixel's.
      if (uFog > 0.0 && z < 1.0) {
        float dc = distance(worldAt(vUv, z), uCam);
        vec4 sum = vec4(0.0); float wsum = 0.0;
        for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
          vec2 uv = vUv + vec2(float(i), float(j)) * uFogTexel;
          float zo = texture2D(tDepth, uv).x;
          if (zo >= 1.0) continue;
          float w = exp(-abs(distance(worldAt(uv, zo), uCam) - dc) / (0.02 * dc + 0.03)) * (i == 0 && j == 0 ? 1.0 : (i == 0 || j == 0 ? 0.6 : 0.36));
          sum += texture2D(tFog, uv) * w; wsum += w;
        }
        vec4 f = wsum > 0.0 ? sum / wsum : texture2D(tFog, vUv);
        col = col * f.a + f.rgb;
      }
      // Grading, in linear light: warmth, then even out (pull luminance toward mid grey in log space, keeping hue).
      col *= vec3(1.0 + 0.08 * uWarm, 1.0 + 0.01 * uWarm, 1.0 - 0.09 * uWarm);
      col *= uExposure;
      float l = max(dot(col, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
      col *= (0.18 * pow(l / 0.18, 1.0 - 0.45 * uEven)) / l;
      col = neutral(col);
      vec3 c = toSRGB(col);
      float g = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(g), c, uSat);
      c = (c - 0.5) * uContrast + 0.5;
      c = c + uLift * (1.0 - c);
      c *= 1.0 - uVignette * smoothstep(0.35, 0.95, length((vUv - 0.5) * vec2(1.0, 0.9)) * 1.4);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`));
function col(hex) {
  const c = new THREE.Color(hex), hsl = {};
  c.getHSL(hsl, THREE.SRGBColorSpace);
  c.setHSL(hsl.h, Math.min(1, hsl.s * S.sat), hsl.l, THREE.SRGBColorSpace);
  return c;
}
// The same, as sRGB 0-1 triples for painting canvases.
function srgb(hex) { const c = col(hex), o = {}; c.getRGB(o, THREE.SRGBColorSpace); return [o.r, o.g, o.b]; }
// ---------- the terrain ----------
const SUB = Q.sub, NX = W * SUB + 1, NZ = H * SUB + 1, PX = Q.px;
function blur(a, r, passes) {
  let src = Float32Array.from(a);
  const tmp = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < NX) { s += src[z * NX + xx]; n++; } } tmp[z * NX + x] = s / n; }
    for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { const zz = z + d; if (zz >= 0 && zz < NZ) { s += tmp[zz * NX + x]; n++; } } src[z * NX + x] = s / n; }
  }
  return src;
}
const BASE = { F: 0, R: 0.08, K: 0.3, T: 0.14, S: -0.14, W: -0.26, G: 0.04, E: 0.08, M: 0.1, P: 0 };
// Virtual heights for the baked normal map: each step up catches the light like a lip (fairway, first cut, light
// rough, thick rough), sand sits below with a rim.
const VH = { F: 0, P: 0, E: 0.25, G: 0.1, R: 0.9, K: 1.9, T: 1.5, S: -0.8, W: -0.4, M: 0.9 };
let heights = null, waterY = 0, levelF = null, ponds = [];
const hAt = (x, z) => {
  const fx = Math.max(0, Math.min(NX - 1.001, x * SUB)), fz = Math.max(0, Math.min(NZ - 1.001, z * SUB));
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, q = (a, b) => heights[b * NX + a];
  return (q(i, j) * (1 - u) + q(i + 1, j) * u) * (1 - v) + (q(i, j + 1) * (1 - u) + q(i + 1, j + 1) * u) * v;
};
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Shader additions for the ground: felt grain and the tile grid, in world space (sharp at any distance).
const groundUniforms = { tFelt: { value: FELT }, tSand: { value: SAND }, uSandGrain: { value: 0 }, tGrainMask: { value: null }, uGrain: { value: 0 }, uGrid: { value: 0 }, uGridGlow: { value: 0 }, uHole: { value: new THREE.Vector3(0, 0, 0) }, uWaterY: { value: 0 }, uGridOrigin: { value: new THREE.Vector2(ox, oz) } };
function groundMaterial(opts) {
  const m = new THREE.MeshStandardMaterial(opts);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, groundUniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorldL;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWorldL = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorldL;\nuniform sampler2D tFelt, tGrainMask, tSand;\nuniform float uGrain, uGrid, uGridGlow, uWaterY, uSandGrain; uniform vec2 uGridOrigin; uniform vec3 uHole;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (uHole.z > 0.0 && distance(vWorldL.xz, uHole.xy) < uHole.z) discard; // (the cup)
        float felt = texture2D(tFelt, vWorldL.xz * 0.9).r;
        float gmask = 1.0, wet = 0.0;
        #ifdef USE_MAP
          vec4 gm = texture2D(tGrainMask, vMapUv); gmask = gm.r; wet = gm.b;
        #endif
        diffuseColor.rgb *= 1.0 - uGrain * gmask * (1.0 - felt);
        float sg = texture2D(tSand, vWorldL.xz * 1.6).r;
        diffuseColor.rgb *= 1.0 + uSandGrain * (sg - 0.5) * (1.0 - gmask);
        vec2 fr = fract(vWorldL.xz - uGridOrigin), gd = min(fr, 1.0 - fr), fw = fwidth(vWorldL.xz);
        vec2 ln = 1.0 - smoothstep(vec2(0.008), vec2(0.008) + fw * 1.2, gd);
        float line = max(ln.x, ln.y);
        float under = step(0.5, wet);
        vec3 lined = mix(diffuseColor.rgb * (1.0 - uGrid * line), diffuseColor.rgb + vec3(0.85, 1.0, 0.7) * line * uGrid * 0.9, uGridGlow);
        diffuseColor.rgb = mix(lined, diffuseColor.rgb + line * 0.16, under);`);
  };
  return m;
}

function buildTerrain() {
  const r = Math.round((S.round * SUB) / 8), ind = {};
  // A map can carry finer detail over part of the board (the game's short-game map round the cup): map.detail gives
  // a type at any point (or null outside it), how much of the fine detail applies there (0..1), and extra height. There
  // the type masks use a finer blur, so small shapes (a greenside bunker, the green's edge) survive.
  const D = map.detail || null;
  const fineW = new Float32Array(NX * NZ), types = new Array(NX * NZ);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const k = j * NX + i, dt = D ? D.at(i / SUB, j / SUB) : null;
    types[k] = dt || at(Math.min(W - 1, Math.floor(i / SUB)), Math.min(H - 1, Math.floor(j / SUB)));
    if (D) fineW[k] = D.weight(i / SUB, j / SUB);
  }
  const tileOfSample = (i, j) => types[j * NX + i];
  const rFine = Math.max(2, Math.round(SUB * 0.45)); // (about a short tile: rounds the stair steps of the fine map)
  const mixFine = (coarse, fine) => { if (!D) return coarse; for (let k = 0; k < coarse.length; k++) coarse[k] += (fine[k] - coarse[k]) * fineW[k]; return coarse; };
  for (const t of TYPES) {
    const a = new Float32Array(NX * NZ);
    for (let k = 0; k < NX * NZ; k++) a[k] = types[k] === t ? 1 : 0;
    ind[t] = mixFine(blur(a, r, 2), D ? blur(a, rFine, 3) : null);
  }
  // Bunkers and the pond are basins: a softer blur of their tiles (so outlines come out round, not square), sunk by
  // their own depths below the ground around them (which fills them first, at light-rough level).
  const raw = (ty) => { const a = new Float32Array(NX * NZ); for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) a[j * NX + i] = tileOfSample(i, j) === ty ? 1 : 0; return a; };
  const rb = Math.max(3, Math.round(0.45 * SUB));
  const basin = (ty) => { const a = raw(ty); return mixFine(blur(a, rb, 3), D ? blur(a, Math.max(2, Math.round(rb * 0.6)), 3) : null).map((v) => smooth(0.2, 0.6, v)); };
  const basinS = basin('S'), basinW = basin('W');
  heights = new Float32Array(NX * NZ);
  for (let k = 0; k < NX * NZ; k++) { let h = (ind.S[k] + ind.W[k]) * BASE.R; for (const t of TYPES) if (t !== 'S' && t !== 'W') h += ind[t][k] * BASE[t]; heights[k] = h * S.lift; }
  // Hills: mounds over the M tiles (a wide blur of them, so a group of tiles makes one rounded hill). Ramps (P, the
  // look test's only): a wedge rising up the hole, with a short drop at its lip.
  if (tilesOf('M').length) {
    const hm = blur(raw('M'), Math.round(0.9 * SUB), 3);
    let top = 0; for (const v of hm) top = Math.max(top, v);
    for (let k = 0; k < NX * NZ; k++) heights[k] += S.hill * Math.pow(hm[k] / Math.max(top, 1e-3), 0.8);
  }
  for (const ramp of tilesOf('P')) for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const x = i / SUB, z = j / SUB, k = j * NX + i, rx = x - ramp[0], rz = z - ramp[1];
    const side = Math.min(1, Math.max(0, Math.min(rx + 0.15, 1.15 - rx) / 0.25));
    if (rz >= 0 && rz <= 1.05 && side > 0) heights[k] += S.ramp * Math.min(1, (1.05 - rz)) * side * Math.min(1, rz / 0.12 + 0.05);
  }
  // Cushions: thick rough and the ground under trees puff up tile by tile (light rough a little), with creases.
  const PILLOW = { K: 1, T: 0.8, R: 0.3 };
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const k = j * NX + i, fx = (i % SUB) / SUB, fz = (j % SUB) / SUB;
    const dome = Math.sin(Math.PI * Math.min(1, fx + 0.5 / SUB)) * Math.sin(Math.PI * Math.min(1, fz + 0.5 / SUB));
    let w = 0; for (const [ty, s] of Object.entries(PILLOW)) w += ind[ty][k] * s;
    heights[k] += S.pillow * Math.sqrt(dome) * w * (1 - fineW[k]);
  }
  for (let k = 0; k < NX * NZ; k++) heights[k] -= S.sand * basinS[k] + S.pond * basinW[k];
  if (D) for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) heights[j * NX + i] += D.height(i / SUB, j / SUB);
  const big = blur(heights, Math.round(0.75 * SUB), 2), cav = new Float32Array(NX * NZ);
  for (let k = 0; k < NX * NZ; k++) cav[k] = Math.max(0, big[k] - heights[k]);
  waterY = BASE.R * S.lift - S.pond * 0.42; // (the bank stands above the water)
  // Each pond (a connected patch of the water basin) sits at its own level: its banks' mean height, less the gap the
  // pond depth sets. (On flat ground that is waterY; on a slope, as round the green, the pond still fills.)
  levelF = new Float32Array(NX * NZ).fill(waterY); ponds = [];
  { const comp = new Int32Array(NX * NZ).fill(-1);
    for (let s = 0; s < NX * NZ; s++) {
      if (comp[s] >= 0 || basinW[s] < 0.04) continue;
      const id = ponds.length, stack = [s], cells = []; comp[s] = id;
      while (stack.length) { const k = stack.pop(); cells.push(k); const i = k % NX, j = (k / NX) | 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= NX || jj >= NZ) continue; const q = jj * NX + ii; if (comp[q] < 0 && basinW[q] >= 0.04) { comp[q] = id; stack.push(q); } } }
      let sum = 0, n = 0, i0 = NX, i1 = 0, j0 = NZ, j1 = 0;
      for (const k of cells) { const i = k % NX, j = (k / NX) | 0; i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); if (basinW[k] < 0.15) { sum += heights[k]; n++; } }
      const level = (n ? sum / n : waterY + S.pond * 0.42) - S.pond * 0.42 + BASE.R * S.lift * 0.0;
      for (const k of cells) levelF[k] = level;
      ponds.push({ level, box: [i0 / SUB, j0 / SUB, i1 / SUB, j1 / SUB] });
    } }

  // ---- paint the colour map and the bevel normal map at PX pixels per tile ----
  const CW = W * PX, CH = H * PX, PAL = {};
  for (const [k, v] of Object.entries(COL)) PAL[k] = srgb(v);
  const cc = document.createElement('canvas'); cc.width = CW; cc.height = CH;
  const cg = cc.getContext('2d'), cimg = cg.createImageData(CW, CH);
  const vh = new Float32Array(CW * CH), wmask = new Float32Array(CW * CH), gmask = new Float32Array(CW * CH), furm = new Float32Array(CW * CH), wetUnder = new Float32Array(CW * CH);
  const FUR = { K: 1, T: 0.85, R: 0.55, M: 0.45 };
  const T = TYPES.split(''), vals = new Float32Array(T.length), wts = new Float32Array(T.length);
  const stripeMix = 1 - S.stripes;
  for (let py = 0; py < CH; py++) {
    const z = (py + 0.5) / PX, sz = z * SUB, j0 = Math.min(NZ - 2, Math.floor(sz)), fz = sz - j0;
    for (let px = 0; px < CW; px++) {
      const x = (px + 0.5) / PX, sx = x * SUB, i0 = Math.min(NX - 2, Math.floor(sx)), fx = sx - i0;
      const k00 = j0 * NX + i0, k10 = k00 + 1, k01 = k00 + NX, k11 = k01 + 1;
      const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
      const L = (a) => a[k00] * w00 + a[k10] * w10 + a[k01] * w01 + a[k11] * w11;
      let best = 0, bv = -1, wsum = 0;
      for (let t = 0; t < T.length; t++) {
        const v = L(ind[T[t]]); vals[t] = v;
        if (t === 4 || t === 5) { wts[t] = 0; continue; } // sand and water are layered on below
        if (v > bv) { bv = v; best = t; } const w = smooth(0.4, 0.6, v); wts[t] = w; wsum += w;
      }
      if (wsum < 1e-4) { wts[1] = 1; wsum = 1; }
      const near = vals[0] + vals[9] + vals[7]; // fairway, ramp, tee
      let R = 0, G = 0, B = 0, hv = 0;
      for (let t = 0; t < T.length; t++) {
        const w = wts[t] / wsum; if (w < 1e-3) continue;
        const ty = T[t]; let c, h = VH[ty];
        if (ty === 'F' || ty === 'P') {
          const s = Math.floor(x / 0.8) % 2 ? PAL.F : PAL.F2, m = PAL.F;
          c = [s[0] + (m[0] - s[0]) * stripeMix * 0.5, s[1] + (m[1] - s[1]) * stripeMix * 0.5, s[2] + (m[2] - s[2]) * stripeMix * 0.5];
          if (ty === 'P') c = c.map((q) => Math.min(1, q * 1.08));
        } else if (ty === 'R' && near > 0.2) { c = PAL.cut; h = 0.45; }
        else if (ty === 'G') c = vals[t] < 0.8 ? PAL.fringe : PAL.G;
        else c = PAL[ty];
        let shade = 1;
        if (ty === 'K' || ty === 'T') { const n = vnoise(x * 5, z * 5); shade = 0.84 + 0.3 * n; h += 0.5 * n; }
        else if (ty === 'R') { const n = vnoise(x * 9, z * 9); shade = 0.93 + 0.14 * n; h += 0.15 * n; }
        else if (ty === 'S') { const rip = Math.sin((x * 0.7 + z * 0.7) * 26 + vnoise(x * 2, z * 2) * 4); shade = 0.97 + 0.03 * rip + 0.04 * (hash2(px, py) - 0.5); h += 0.06 * rip; }
        else if (ty === 'W') { shade = 0.85 + 0.15 * vnoise(x * 3, z * 3); }
        R += w * c[0] * shade; G += w * c[1] * shade; B += w * c[2] * shade; hv += w * h;
      }
      // Bunkers: grass to the lip, a band of sandy dirt just inside it, then cream sand with ripples. No felt grain.
      const bs = L(basinS), bw = L(basinW), aS = smooth(0.06, 0.16, bs), aW = smooth(0.06, 0.16, bw);
      if (aS > 0) {
        const band = 0.16 + 0.4 * S.dirt, dirt = 1 - smooth(band * 0.55, band, bs);
        const rip = Math.sin((x * 0.7 + z * 0.7) * 26 + vnoise(x * 2, z * 2) * 4), grit = vnoise(x * 40, z * 40);
        const sh = (0.985 + 0.015 * rip) * (1 - dirt) + (0.86 + 0.24 * grit) * dirt + 0.05 * (hash2(px, py) - 0.5);
        const c = PAL.S, d = PAL.sandDirt;
        const sr = (c[0] + (d[0] - c[0]) * dirt) * sh, sg = (c[1] + (d[1] - c[1]) * dirt) * sh, sb = (c[2] + (d[2] - c[2]) * dirt) * sh;
        R += (sr - R) * aS; G += (sg - G) * aS; B += (sb - B) * aS; hv += (0.05 * rip * (1 - dirt) + 0.35 * grit * dirt - hv) * aS;
      }
      // The pond: grass to the lip, an earth bank (darker and wetter near the water), then a bed darkening with depth.
      if (aW > 0) {
        const gh = L(heights), lv = L(levelF), under = 1 - smooth(lv - 0.03, lv + 0.02, gh), deep = smooth(0.04, S.pond * 0.5, lv - gh);
        const n = 0.9 + 0.1 * vnoise(x * 4, z * 4), grit = vnoise(x * 34, z * 34), wet = 1 - smooth(lv, lv + 0.12, gh);
        wetUnder[py * CW + px] = under * aW;
        const e = PAL.earth, ew = PAL.earthWet, s0 = PAL.bedShallow, s1 = PAL.bedDeep, es = 0.85 + 0.25 * grit;
        let wr = (e[0] + (ew[0] - e[0]) * wet) * es, wg = (e[1] + (ew[1] - e[1]) * wet) * es, wb = (e[2] + (ew[2] - e[2]) * wet) * es;
        const br = s0[0] + (s1[0] - s0[0]) * deep, bgc = s0[1] + (s1[1] - s0[1]) * deep, bb = s0[2] + (s1[2] - s0[2]) * deep;
        wr += (br * n - wr) * under; wg += (bgc * n - wg) * under; wb += (bb * n - wb) * under;
        R += (wr - R) * aW; G += (wg - G) * aW; B += (wb - B) * aW; hv += ((1 - under) * 0.3 * grit - hv) * aW;
      }
      // Edge lines where types meet (and round each basin), and crease shade where the ground sits below its surroundings.
      const rim = Math.max(aS * (1 - aS), aW * (1 - aW)) * 4;
      const edge = (1 - S.outline * (1 - smooth(0.55, 0.75, bv)) * (1 - Math.max(aS, aW))) * (1 - S.outline * 1.5 * rim);
      const crease = 1 - Math.min(0.5, L(cav) * S.cavity * 2.2) * (1 - Math.max(aS, aW));
      const m = edge * crease, i = (py * CW + px) * 4;
      cimg.data[i] = Math.min(255, R * m * 255); cimg.data[i + 1] = Math.min(255, G * m * 255); cimg.data[i + 2] = Math.min(255, B * m * 255); cimg.data[i + 3] = 255;
      vh[py * CW + px] = hv + S.bump * 7 * (vnoise(x * 22, z * 22) - 0.5);
      wmask[py * CW + px] = smooth(0.01, 0.06, bw); // reaches the banks; the banks clip it by depth
      gmask[py * CW + px] = 1 - Math.max(aS, aW);
      let fl = 0; for (let q = 0; q < T.length; q++) fl += (wts[q] / wsum) * (FUR[T[q]] || 0);
      if (near > 0.2) fl *= 0.55; // the first cut is shorter
      furm[py * CW + px] = fl * (1 - Math.max(aS, aW));
    }
  }
  cg.putImageData(cimg, 0, 0);
  // The grain mask (red: felt on grass, none in basins; green: fur length), at half resolution.
  { const c = document.createElement('canvas'); c.width = CW / 2; c.height = CH / 2; const g = c.getContext('2d'), img = g.createImageData(c.width, c.height);
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const k = (y * 2) * CW + x * 2, i = (y * c.width + x) * 4; img.data[i] = gmask[k] * 255; img.data[i + 1] = furm[k] * 255; img.data[i + 2] = wetUnder[k] * 255; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0); if (groundUniforms.tGrainMask.value) groundUniforms.tGrainMask.value.dispose(); groundUniforms.tGrainMask.value = new THREE.CanvasTexture(c); }
  const colourTex = new THREE.CanvasTexture(cc);
  colourTex.colorSpace = THREE.SRGBColorSpace; colourTex.anisotropy = ANISO;
  // Normal map from the virtual heights (one unit per type step, so each boundary leans like a lip).
  const nc = document.createElement('canvas'); nc.width = CW; nc.height = CH;
  const ng = nc.getContext('2d'), nimg = ng.createImageData(CW, CH), q = (x, y) => vh[Math.max(0, Math.min(CH - 1, y)) * CW + Math.max(0, Math.min(CW - 1, x))];
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    let nx = -(q(x + 1, y) - q(x - 1, y)) * 2, ny = (q(x, y + 1) - q(x, y - 1)) * 2, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * CW + x) * 4; nimg.data[i] = (nx * 0.5 + 0.5) * 255; nimg.data[i + 1] = (ny * 0.5 + 0.5) * 255; nimg.data[i + 2] = (nz * 0.5 + 0.5) * 255; nimg.data[i + 3] = 255;
  }
  ng.putImageData(nimg, 0, 0);
  const normalTex = new THREE.CanvasTexture(nc); normalTex.anisotropy = ANISO;

  // ---- the mesh ----
  const pos = new Float32Array(NX * NZ * 3), uv = new Float32Array(NX * NZ * 2);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) { const k = j * NX + i; pos.set([i / SUB, heights[k], j / SUB], k * 3); uv.set([i / SUB / W, 1 - j / SUB / H], k * 2); }
  const idx = [];
  for (let j = 0; j < NZ - 1; j++) for (let i = 0; i < NX - 1; i++) { const a = j * NX + i, b = a + 1, d = a + NX, e = d + 1; idx.push(a, d, b, b, d, e); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx); geo.computeVertexNormals();
  const mat = groundMaterial({ map: colourTex, normalMap: normalTex, normalScale: new THREE.Vector2(S.bevel, S.bevel), roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true; mesh.castShadow = true; mesh.userData.ground = true; ground = mesh; groundGeo = geo; baseY = Float32Array.from(pos.filter((_, q) => q % 3 === 1));
  world.add(mesh);
  // Fur shells over the rough: copies of the ground lifted step by step, each keeping fewer strands (they taper), dark at
  // the roots and light at the tips, swaying a little. Fur length per pixel comes from the mask's green channel.
  let shellGeo = geo;
  if (map.lowDetail) { // (the same vertices, only the triangles of tiles that aren't low detail)
    const sidx = [];
    for (let j = 0; j < NZ - 1; j++) for (let i = 0; i < NX - 1; i++) {
      if (lowDetail(Math.floor(i / SUB), Math.floor(j / SUB))) continue;
      const a = j * NX + i, b = a + 1, d = a + NX, e = d + 1; sidx.push(a, d, b, b, d, e);
    }
    shellGeo = new THREE.BufferGeometry();
    for (const k of ['position', 'uv', 'normal']) shellGeo.setAttribute(k, geo.attributes[k]);
    shellGeo.setIndex(sidx);
  }
  if (S.shells > 0 && S.furLen > 0) {
    const strands = strandTexture(S.clump);
    for (let k = 1; k <= S.shells; k++) {
      const h = k / S.shells, u = { ...groundUniforms, ...swayUniforms, tStrand: { value: strands }, uH: { value: h }, uLift: { value: h * S.furLen }, uDensity: { value: S.furDensity / 128 }, uRoot: { value: S.furRoot } };
      const sm = new THREE.MeshStandardMaterial({ map: colourTex, roughness: 1 });
      sm.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, u);
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorldL;\nuniform float uLift, uH, uTime, uSway;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            transformed += objectNormal * uLift;
            transformed.xz += vec2(sin(uTime * 1.3 + position.x * 1.7 + position.z), cos(uTime * 1.1 + position.z * 1.9)) * uSway * 0.04 * uH * uH;`)
          .replace('#include <project_vertex>', '#include <project_vertex>\nvWorldL = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorldL;\nuniform sampler2D tGrainMask, tStrand;\nuniform float uH, uDensity, uRoot;')
          .replace('#include <map_fragment>', `#include <map_fragment>
            float furLen = texture2D(tGrainMask, vMapUv).g;
            if (uH > furLen) discard;
            float strand = texture2D(tStrand, vWorldL.xz * uDensity).r;
            if (strand < uH / max(furLen, 0.001)) discard;
            diffuseColor.rgb *= mix(1.0 - uRoot * 0.6, 1.0 + uRoot * 0.25, uH / max(furLen, 0.001));`);
      };
      const shell = new THREE.Mesh(shellGeo, sm);
      shell.receiveShadow = true; shell.userData.shell = true;
      world.add(shell);
    }
  }
  // The board's soil sides.
  if (S.board > 0) {
    const sp = [], sc = [], si = [], top = col(COL.soilTop), bot = col(COL.soilBot);
    const edge = (pts) => { const n0 = sp.length / 3; for (const [x, z] of pts) { sp.push(x, hAt(x, z) - 0.002, z, x, -S.board, z); sc.push(top.r, top.g, top.b, bot.r, bot.g, bot.b); } for (let p = 0; p < pts.length - 1; p++) { const a = n0 + p * 2; si.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); } };
    const line = (x0, z0, x1, z1) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0)) * SUB; const o = []; for (let p = 0; p <= n; p++) o.push([x0 + ((x1 - x0) * p) / n, z0 + ((z1 - z0) * p) / n]); return o; };
    edge(line(0, H, W, H)); edge(line(W, H, W, 0)); edge(line(W, 0, 0, 0)); edge(line(0, 0, 0, H));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
    g.setIndex(si); g.computeVertexNormals();
    const m = new THREE.Mesh(g, groundMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
    m.castShadow = true; world.add(m);
  }
  return { ind, wmask, CW, CH, basinS, basinW };
}

// ---------- water: refracts the scene behind it through moving ripples ----------
let water = null;
const waterUniforms = { tScene: { value: sceneRT.texture }, tMask: { value: null }, tHeight: { value: null }, uWaterY: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 }, uStrength: { value: 1 }, uClear: { value: 0.6 }, uDeep: { value: new THREE.Color() }, uSky: { value: new THREE.Color(0xd8efff) }, uSunDir: { value: new THREE.Vector3(0, 1, 0) } };
function buildWater({ wmask, CW, CH }) {
  const c = document.createElement('canvas'); c.width = CW / 2; c.height = CH / 2;
  const g = c.getContext('2d'), img = g.createImageData(c.width, c.height);
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const v = wmask[(y * 2) * CW + x * 2], i = (y * c.width + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v * 255; img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  waterUniforms.tMask.value = new THREE.CanvasTexture(c);
  // The ground's height under the water (rows from z = H up, as the plane's v runs), 8 bits over -2.5..0.5.
  const hd = new Uint8Array(NX * NZ);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) hd[(NZ - 1 - j) * NX + i] = Math.max(0, Math.min(255, Math.round(((heights[j * NX + i] + 2.5) / 3) * 255)));
  const ht = new THREE.DataTexture(hd, NX, NZ, THREE.RedFormat, THREE.UnsignedByteType);
  ht.magFilter = ht.minFilter = THREE.LinearFilter; ht.needsUpdate = true;
  waterUniforms.tHeight.value = ht; waterUniforms.uWaterY.value = waterY;
  waterUniforms.uDeep.value = col(0x1767a8);
  const mat = new THREE.ShaderMaterial({
    uniforms: waterUniforms, transparent: true, depthWrite: false,
    vertexShader: `varying vec3 vW; varying vec2 vUv;
      void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform sampler2D tScene, tMask, tHeight; uniform vec2 uRes; uniform float uTime, uStrength, uClear, uWaterY; uniform vec3 uDeep, uSky, uSunDir;
      varying vec3 vW; varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) { vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
      float wave(vec2 p) { return noise(p * 2.3 + vec2(uTime * 0.35, uTime * 0.2)) * 0.6 + noise(p * 5.7 - vec2(uTime * 0.3, -uTime * 0.45)) * 0.4; }
      void main() {
        float m = texture2D(tMask, vUv).r;
        if (m < 0.01) discard;
        vec2 e = vec2(0.02, 0.0);
        vec2 grad = vec2(wave(vW.xz + e.xy) - wave(vW.xz - e.xy), wave(vW.xz + e.yx) - wave(vW.xz - e.yx)) / (2.0 * e.x);
        vec3 N = normalize(vec3(-grad.x * 0.06, 1.0, -grad.y * 0.06));
        vec3 V = normalize(cameraPosition - vW);
        vec2 suv = gl_FragCoord.xy / uRes + grad * uStrength * 0.005 * smoothstep(0.0, 0.6, m);
        float depth = uWaterY - (texture2D(tHeight, vUv).r * 3.0 - 2.5);
        vec3 refr = texture2D(tScene, suv).rgb;
        float murk = smoothstep(0.0, 0.45, depth) * (1.0 - uClear * 0.7);
        vec3 col = mix(refr * vec3(0.8, 0.94, 1.0), uDeep, murk);
        col = mix(col, vec3(0.93, 0.98, 1.0), (1.0 - smoothstep(0.0, 0.035, depth)) * 0.55); // the shoreline
        float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
        col = mix(col, uSky, fres * 0.55);
        col += pow(max(dot(reflect(-uSunDir, N), V), 0.0), 140.0) * 1.6;
        gl_FragColor = vec4(col, smoothstep(0.0, 0.3, m) * smoothstep(-0.004, 0.012, depth));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  // One sheet per pond, over its box, at its own level (uv still spans the whole board, for the mask and heights).
  water = new THREE.Group();
  for (const pd of ponds) {
    const [x0, z0, x1, z1] = [pd.box[0] - 0.5, pd.box[1] - 0.5, pd.box[2] + 0.5, pd.box[3] + 0.5];
    const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0); geo.rotateX(-Math.PI / 2); geo.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
    const pa = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < pa.count; i++) uv.setXY(i, pa.getX(i) / W, 1 - pa.getZ(i) / H);
    const m = new THREE.Mesh(geo, mat.clone()); m.material.uniforms = { ...waterUniforms, uWaterY: { value: pd.level } };
    m.position.y = pd.level; m.layers.set(1); // (drawn after the rest, over a copy of it: see render)
    water.add(m);
  }
  world.add(water);
}
const swayUniforms = { uTime: { value: 0 }, uSway: { value: 0 } };
// Instanced cards from a list of { p, s: [w, h, w], rot: Euler, c: Color }.
function addCards(list) {
  if (!list.length) return;
  const map = BLADES[S.blades];
  const mat = new THREE.MeshStandardMaterial({ map, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, swayUniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime, uSway;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec4 swayW = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float sway = sin(uTime * 1.7 + swayW.x * 1.3 + swayW.z * 0.9) + 0.5 * sin(uTime * 2.9 + swayW.z * 2.1);
          transformed.x += sway * uSway * 0.18 * position.y * position.y;
        #endif`);
    // Both faces of a card light like the ground (three.js would flip the normal on back faces, darkening them).
    sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
  };
  const im = new THREE.InstancedMesh(cardGeometry(), mat, list.length), m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
  list.forEach((b, k) => { q.setFromEuler(b.rot); m4.compose(new THREE.Vector3(...b.p), q, new THREE.Vector3(...b.s)); im.setMatrixAt(k, m4); im.setColorAt(k, b.c); });
  im.castShadow = true; im.receiveShadow = true;
  im.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.45 });
  world.add(im);
}
function buildGrass({ ind, basinS, basinW }) {
  const r = rng(61), cards = [], cones = [];
  const tint = (hex, v) => col(hex).multiplyScalar(v);
  // Tufts on the rough.
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const ty = at(x, z), n = Math.round((ty === 'K' ? 14 : ty === 'R' ? 5 : 0) * (ty === 'K' ? S.tufts : S.tuftsR));
    for (let q = 0; q < n; q++) {
      const px = x + r(), pz = z + r(), k = Math.round(pz * SUB) * NX + Math.round(px * SUB);
      if (ind[ty][k] < 0.6 || basinS[k] > 0.02 || basinW[k] > 0.02) continue;
      const big = ty === 'K' ? 1 : 0.7, hh = 0.22 * big * S.tuftH * (0.75 + r() * 0.5), ww = 0.2 * big * S.tuftW * (0.8 + r() * 0.4);
      const c = tint(ty === 'K' ? 0x4a9a34 : 0x6cb540, 1 + r() * 0.3);
      if (S.cards) cards.push({ p: [px, hAt(px, pz) - 0.01, pz], s: [ww, hh, ww], rot: new THREE.Euler((r() - 0.5) * 0.3, r() * 6.28, (r() - 0.5) * 0.3), c });
      else cones.push([px, hAt(px, pz), pz, big, c]);
    }
  }
  // Blades hanging over each basin's lip, leaning in (down the slope).
  const grad = (a, i, j) => [a[j * NX + Math.min(NX - 1, i + 1)] - a[j * NX + Math.max(0, i - 1)], a[Math.min(NZ - 1, j + 1) * NX + i] - a[Math.max(0, j - 1) * NX + i]];
  for (const [basin, hex] of [[basinS, 0x6cb540], [basinW, 0x5aa83a]]) for (let j = 1; j < NZ - 1; j++) for (let i = 1; i < NX - 1; i++) {
    const k = j * NX + i, v = basin[k];
    if (v < 0.07 || v > 0.2 || r() > 0.55 * S.lip) continue;
    const [gx, gz] = grad(basin, i, j), yaw = Math.atan2(gx, gz), x = i / SUB + (r() - 0.5) / SUB, z = j / SUB + (r() - 0.5) / SUB;
    const hh = 0.2 * S.tuftH * (0.8 + r() * 0.5), ww = 0.18 * S.tuftW * (0.8 + r() * 0.4);
    cards.push({ p: [x, hAt(x, z) - 0.01, z], s: [ww, hh, ww], rot: new THREE.Euler(0.75 + r() * 0.35, yaw, 0, 'YXZ'), c: tint(hex, 0.9 + r() * 0.25) });
  }
  addCards(cards);
  if (cones.length) {
    const tg = new THREE.ConeGeometry(0.045, 0.16, 5); tg.translate(0, 0.08, 0);
    const tim = new THREE.InstancedMesh(tg, new THREE.MeshStandardMaterial({ roughness: 1 }), cones.length), m4 = new THREE.Matrix4();
    cones.forEach(([x, y, z, s, c], k) => { m4.compose(new THREE.Vector3(x, y - 0.01, z), new THREE.Quaternion().setFromEuler(new THREE.Euler((r() - 0.5) * 0.5, r() * 6, (r() - 0.5) * 0.5)), new THREE.Vector3(s * S.tuftW, s * S.tuftH * (0.8 + r() * 0.6), s * S.tuftW)); tim.setMatrixAt(k, m4); tim.setColorAt(k, c); });
    tim.castShadow = true; tim.receiveShadow = true; world.add(tim);
  }
  // Pebbles along the pond's waterline.
  const peb = [];
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const k = j * NX + i; if (basinW[k] < 0.15) continue;
    const h = heights[k]; if (Math.abs(h - levelF[k]) > 0.05 || r() > 0.35 * S.pebbles) continue;
    const x = i / SUB + (r() - 0.5) / SUB, z = j / SUB + (r() - 0.5) / SUB, s = 0.035 + r() * 0.05;
    peb.push([x, hAt(x, z), z, s, r()]);
  }
  if (peb.length) {
    const pm = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), peb.length), m4 = new THREE.Matrix4();
    peb.forEach(([x, y, z, s, v], k) => { m4.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(v * 3, v * 7, 0)), new THREE.Vector3(s * 1.3, s * 0.7, s)); pm.setMatrixAt(k, m4); pm.setColorAt(k, col([0x9d978b, 0x8a8478, 0xb0a998, 0x7d756a][Math.floor(v * 4)])); });
    pm.castShadow = true; pm.receiveShadow = true; world.add(pm);
  }
}
// ---------- trees: felt canopies (with fuzz shells near the play), bark trunks ----------
// Trees on low-detail tiles are simpler: fewer lumps, coarser spheres, no fuzz. Trees on map.decor tiles (display only)
// remember their instances, so hideTreesNear can take them away if a ball ever comes to rest beside one.
let treeSets = [], decorTrees = [];
function buildProps(ind) {
  const r = rng(11);
  const sets = { near: { canopy: [], trunks: [], lumps: S.lumps, geo: new THREE.IcosahedronGeometry(1, Q.canopy), fuzz: Q.fuzzShells },
                 far: { canopy: [], trunks: [], lumps: Math.min(3, S.lumps), geo: new THREE.IcosahedronGeometry(1, 1), fuzz: 0 } };
  decorTrees = [];
  for (const [x, z] of tilesOf('T')) {
    const roll = r(), n = roll < 0.3 ? 1 : roll < 0.8 ? 2 : 3, set = lowDetail(x, z) ? sets.far : sets.near, decor = map.decor ? map.decor(x, z) : false;
    for (let q = 0; q < n; q++) {
      const cx = x + 0.5 + (r() - 0.5) * (n > 1 ? 0.7 : 0.25), cz = z + 0.5 + (r() - 0.5) * (n > 1 ? 0.7 : 0.25), s = S.tree * (0.36 + r() * 0.12), base = hAt(cx, cz);
      if (map.detail) { const dt = map.detail.at(cx, cz); if (dt && dt !== 'T') continue; }
      const tree = { x: cx, z: cz, set, trunk: set.trunks.length, from: set.canopy.length };
      set.trunks.push([cx, base, cz, s]);
      const tone = TREE_COLS[Math.floor(r() * TREE_COLS.length)];
      for (let l = 0; l < set.lumps; l++) {
        const a = (l / set.lumps) * Math.PI * 2 + r(), off = l === 0 ? 0 : s * 0.42;
        set.canopy.push({ p: [cx + Math.cos(a) * off, base + s * (1.25 + (l === 0 ? 0.25 : r() * 0.2)), cz + Math.sin(a) * off], s: s * (l === 0 ? 0.85 : (set === sets.far ? 0.62 : 0.55) + r() * 0.15), c: tone, v: 0.92 + r() * 0.16, rot: r() * 6.28 });
      }
      tree.to = set.canopy.length;
      if (decor) decorTrees.push(tree);
    }
  }
  const m4 = new THREE.Matrix4(), quat = new THREE.Quaternion();
  const felt = new THREE.MeshPhysicalMaterial({ roughness: 1, metalness: 0, sheen: S.sheen, sheenRoughness: 0.55, sheenColor: new THREE.Color(0xeaffc8), normalMap: FIBRE, normalScale: new THREE.Vector2(0.6, 0.6) });
  FIBRE.repeat.set(6, 3); FUZZ.repeat.set(10, 5);
  const tg = new THREE.CylinderGeometry(0.05, 0.07, 1, 12, 6);
  { const pa = tg.attributes.position; for (let i = 0; i < pa.count; i++) { const yy = pa.getY(i) + 0.5, flare = 1 + 0.45 * Math.pow(Math.max(0, 1 - yy * 4), 2); pa.setX(i, pa.getX(i) * flare); pa.setZ(i, pa.getZ(i) * flare); } tg.computeVertexNormals(); }
  BARK.map.repeat.set(1, 1); BARK.normal.repeat.set(1, 1);
  const barkMat = new THREE.MeshStandardMaterial({ map: BARK.map, normalMap: BARK.normal, normalScale: new THREE.Vector2(S.bark, S.bark), roughness: 1 });
  treeSets = [];
  for (const set of Object.values(sets)) {
    if (!set.trunks.length) continue;
    const place = (im, grow, lighten) => set.canopy.forEach((b, k) => {
      const s = b.s * (1 + grow);
      quat.setFromEuler(new THREE.Euler(0, b.rot, 0));
      m4.compose(new THREE.Vector3(...b.p), quat, new THREE.Vector3(s, s * 0.92, s)); im.setMatrixAt(k, m4);
      im.setColorAt(k, col(b.c).multiplyScalar(b.v * lighten));
    });
    set.canopyMeshes = [];
    const im = new THREE.InstancedMesh(set.geo, felt, set.canopy.length);
    place(im, 0, 1); im.castShadow = im.receiveShadow = true; world.add(im); set.canopyMeshes.push(im);
    // Fuzz: shells a little bigger than each canopy, cut by a fibre pattern, sparser further out.
    if (S.fuzz > 0) for (let k = 1; k <= set.fuzz; k++) {
      const shell = new THREE.MeshStandardMaterial({ roughness: 1, alphaMap: FUZZ, alphaTest: 0.38 + k * 0.1, normalMap: FIBRE, normalScale: new THREE.Vector2(0.6, 0.6) });
      const sm = new THREE.InstancedMesh(set.geo, shell, set.canopy.length);
      place(sm, 0.028 * k * S.fuzz, 1 + 0.04 * k); sm.receiveShadow = true; world.add(sm); set.canopyMeshes.push(sm);
    }
    // Trunks: bark-textured, flaring a little at the roots, each turned and tinted a little differently.
    const tm = new THREE.InstancedMesh(tg, barkMat, set.trunks.length);
    set.trunks.forEach(([x, y, z, s], k) => { m4.compose(new THREE.Vector3(x, y + s * 0.55, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (x * 7.3 + z * 3.1) % 6.28, 0)), new THREE.Vector3(1, s * 1.3, 1)); tm.setMatrixAt(k, m4); tm.setColorAt(k, new THREE.Color(1, 1, 1).multiplyScalar(0.85 + ((x * 13.7 + z * 5.3) % 1) * 0.3)); });
    tm.castShadow = true; tm.receiveShadow = true; tm.userData.trunks = true; world.add(tm);
    set.trunkMesh = tm; treeSets.push(set);
  }
}
// Take away display-only trees within r of a point (board space): their instances shrink to nothing.
function hideTreesNear(x, z, r) {
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  let any = false;
  for (const tr of decorTrees) {
    if (tr.hidden || Math.hypot(tr.x - x, tr.z - z) > r) continue;
    tr.hidden = true; any = true;
    tr.set.trunkMesh.setMatrixAt(tr.trunk, zero); tr.set.trunkMesh.instanceMatrix.needsUpdate = true;
    for (const im of tr.set.canopyMeshes) { for (let k = tr.from; k < tr.to; k++) im.setMatrixAt(k, zero); im.instanceMatrix.needsUpdate = true; }
  }
  if (any) sun.shadow.needsUpdate = true;
}

// ---------- mist: soft drifting puffs over the tiles it hides ----------
let mistSprites = [];
const mistTex = softDot('rgba(255,255,255,1)');
function setMist(tiles) {
  mistTiles = tiles || [];
  for (const sp of mistSprites) { world.remove(sp); sp.material.dispose(); }
  mistSprites = [];
  const r = rng(23);
  for (const [x, z] of mistTiles) for (let q = 0; q < S.puffs; q++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, transparent: true, depthWrite: false, opacity: S.mist * (0.45 + r() * 0.35) }));
    const s = 1.6 + r() * 1.4;
    sp.scale.set(s, s * 0.7, 1);
    sp.userData = { x: x + r(), z: z + r(), y: hAt(x + 0.5, z + 0.5) + 0.25 + r() * 0.45, ph: r() * 6.28 };
    world.add(sp); mistSprites.push(sp);
  }
}

// ---------- build, light, render ----------
// ---------- build, light, camera ----------
const SHARED = new Set([FELT, FIBRE, FUZZ, SAND, BARK.map, BARK.normal, ...BLADES.filter(Boolean)]);
function clear() {
  for (const o of [...world.children]) {
    world.remove(o);
    o.traverse((n) => { if (n.geometry) n.geometry.dispose(); if (n.material) { for (const k of ['map', 'normalMap', 'alphaMap']) if (n.material[k] && !SHARED.has(n.material[k])) n.material[k].dispose(); n.material.dispose(); } });
  }
  for (const k of ['tMask', 'tHeight']) if (waterUniforms[k].value) { waterUniforms[k].value.dispose(); waterUniforms[k].value = null; }
  water = null; mistSprites = []; ground = null;
}
function build() {
  clear();
  const t = buildTerrain();
  buildWater(t);
  buildProps(t.ind);
  buildGrass(t);
  setMist(mistTiles);
  light();
}
function light() {
  renderer.toneMapping = THREE.NeutralToneMapping;
  sun.shadow.needsUpdate = true;
  renderer.toneMappingExposure = S.exposure;
  postUniforms.uExposure.value = S.exposure; postUniforms.uEven.value = S.even; postUniforms.uContrast.value = S.contrast; postUniforms.uSat.value = S.psat;
  postUniforms.uWarm.value = S.warm; postUniforms.uLift.value = S.shadowLift; postUniforms.uVignette.value = S.vignette;
  postUniforms.uFog.value = S.fog; postUniforms.uFogH.value = S.fogH; postUniforms.uFogNoise.value = S.fogNoise; postUniforms.uFogSun.value = S.fogSun; postUniforms.uFogStart.value = S.fogStart; postUniforms.uSteps.value = S.fogSteps;
  postUniforms.uShafts.value = S.shafts; postUniforms.uSunPower.value = S.sun / 2.2;
  hemi.intensity = S.sky; sun.intensity = S.sun;
  { const cover = S.clouds, grey = new THREE.Color(0x9aa2ac), greyH = new THREE.Color(0xc2c8ce), dim = 1 - S.cloudDark * 0.55 * cover;
    const top = new THREE.Color(S.skyTop).lerp(grey, Math.min(1, cover * 0.65 + S.rain * 0.3)).multiplyScalar(dim);
    const hor = new THREE.Color(S.skyHorizon).lerp(greyH, Math.min(1, cover * 0.55 + S.rain * 0.3)).multiplyScalar(dim);
    skyUniforms.uTop.value.copy(top); skyUniforms.uHorizon.value.copy(hor); skyUniforms.uSunCol.value.set(S.sunCol);
    skyUniforms.uCover.value = cover; skyUniforms.uShade.value = S.cloudDark; skyUniforms.uWind.value = S.wind; skyUniforms.uStars.value = S.stars;
    sun.color.set(S.sunCol); hemi.color.set(S.hemiTop).lerp(greyH, cover * 0.4); hemi.groundColor.set(S.hemiBottom);
    { const l = hor.r * 0.3 + hor.g * 0.5 + hor.b * 0.2; postUniforms.uSkyCol.value.copy(hor).lerp(new THREE.Color(l, l, l), 0.45); } // (the fog: the horizon, less saturated)
    postUniforms.uSunCol.value.set(S.sunCol); waterUniforms.uSky.value.copy(hor);
    rainUniforms.uRain.value = S.rain; rainUniforms.uWind.value = S.wind; rain.visible = S.rain > 0;
    rain.geometry.setDrawRange(0, Math.round(rain.userData.N * 2 * S.rain)); }
  const el = (S.sunEl * Math.PI) / 180, az = (S.sunAz * Math.PI) / 180, c = new THREE.Vector3(ox + W / 2, 0, oz + H / 2);
  sun.position.set(c.x + Math.sin(az) * Math.cos(el) * 30, Math.sin(el) * 30, c.z + Math.cos(az) * Math.cos(el) * 30);
  sun.target.position.copy(c);
  sun.shadow.radius = S.soft; sun.shadow.blurSamples = 16;
  waterUniforms.uSunDir.value.copy(sun.position).sub(c).normalize();
  skyUniforms.uSunDir.value.copy(waterUniforms.uSunDir.value);
  postUniforms.uSunDir.value.copy(waterUniforms.uSunDir.value);
  swayUniforms.uSway.value = S.sway;
  waterUniforms.uStrength.value = S.ripple; waterUniforms.uClear.value = S.clear;
  groundUniforms.uSandGrain.value = S.sandGrain;
  groundUniforms.uGrain.value = S.grain; groundUniforms.uGrid.value = gridBoost ?? S.grid; groundUniforms.uWaterY.value = waterY;
  for (const o of world.children) if (o.userData.trunks) o.material.normalScale.set(S.bark, S.bark);
  for (const o of world.children) if (o.userData.ground) { o.material.normalScale.set(S.bevel, S.bevel); o.material.roughness = 1 - 0.5 * S.rain; } // (rain wets the ground)
}
const buf = new THREE.Vector2();
function resize() {
  renderer.getDrawingBufferSize(buf); sceneRT.setSize(buf.x, buf.y); postRT.setSize(buf.x, buf.y);
  for (const rt of fogRTs) rt.setSize(Math.ceil(buf.x / 2), Math.ceil(buf.y / 2));
  postUniforms.uFogTexel.value.set(2 / buf.x, 2 / buf.y); fogState.key = ''; waterUniforms.uRes.value.copy(buf);
}
function drawTop(camera) { // (into whatever target is bound, over what's there)
  const ac = renderer.autoClear, bg = scene.background; renderer.autoClear = false; scene.background = null;
  camera.layers.set(TOP_LAYER); renderer.render(scene, camera); camera.layers.set(0);
  renderer.autoClear = ac; scene.background = bg;
}
function render(camera, t) {
  for (const sp of mistSprites) { const u = sp.userData; sp.position.set(u.x + Math.sin(t * 0.25 + u.ph) * 0.25, u.y + Math.sin(t * 0.4 + u.ph) * 0.05, u.z + Math.cos(t * 0.2 + u.ph) * 0.15); }
  waterUniforms.uTime.value = t; swayUniforms.uTime.value = t; skyUniforms.uTime.value = t; rainUniforms.uTime.value = t;
  skyDome.position.copy(camera.position);
  // The water refracts the scene rendered without it.
  if (!S.post) { // (without the post pass: the scene without water for the refraction, then everything)
    if (water) { renderer.setRenderTarget(sceneRT); renderer.render(scene, camera); renderer.setRenderTarget(null); }
    camera.layers.enable(1); renderer.render(scene, camera); camera.layers.disable(1);
    drawTop(camera);
    return;
  }
  renderer.setRenderTarget(postRT); renderer.render(scene, camera);
  // The water refracts a copy of what was just drawn (one scene render, not two), then is drawn over it.
  if (water) {
    renderer.setRenderTarget(sceneRT); renderer.render(copyScene, postCam);
    renderer.setRenderTarget(postRT);
    const ac = renderer.autoClear; renderer.autoClear = false;
    camera.layers.set(1); renderer.render(scene, camera); camera.layers.set(0);
    renderer.autoClear = ac;
  }
  drawTop(camera);
  camera.updateMatrixWorld();
  postUniforms.uInvViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
  postUniforms.uCam.value.copy(camera.position); postUniforms.uTime.value = t;
  if (sun.shadow.map) { postUniforms.tShadow.value = sun.shadow.map.texture; postUniforms.uShadowMatrix.value.copy(sun.shadow.matrix); }
  if (S.fog > 0) {
    const vp = postUniforms.uInvViewProj.value.elements, key = vp.map((v) => v.toFixed(4)).join(',') + [S.fog, S.fogH, S.fogNoise, S.fogSun, S.fogStart, S.fogSteps, S.shafts, S.sunEl, S.sunAz, S.sun, S.clouds, S.rain].join(',');
    if (key !== fogState.key) { fogState.key = key; fogState.frames = 0; }
    postUniforms.uBlend.value = Math.max(0.06, 1 / (fogState.frames + 1)); // (an average over the frames so far, then a slow running blend)
    postUniforms.uFrame.value = fogState.frames++;
    postUniforms.tHistory.value = fogRTs[fogState.ping].texture;
    renderer.setRenderTarget(fogRTs[1 - fogState.ping]); renderer.render(fogScene, postCam);
    fogState.ping = 1 - fogState.ping;
    postUniforms.tFog.value = fogRTs[fogState.ping].texture;
  }
  renderer.setRenderTarget(null);
  renderer.render(postScene, postCam);
}
// Sink the ground inside a disc (board space) by `depth`, or restore it (depth 0): the game drops the long map under
// its short-game area. The fur shells share the ground's geometry, so they go with it.
function sink(cx, cz, r, depth) {
  if (!groundGeo) return;
  const p = groundGeo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, baseY[i] - (depth && Math.hypot(p.getX(i) - cx, p.getZ(i) - cz) < r ? depth : 0));
  p.needsUpdate = true; groundGeo.computeVertexNormals();
}
return {
  S, world, build, light, render, resize, setMist,
  heightAt: (x, z) => (heights ? hAt(x - ox, z - oz) : 0),
  get ground() { return ground; },
  setGrid(v, glow = 0) { gridBoost = v; groundUniforms.uGrid.value = v ?? S.grid; groundUniforms.uGridGlow.value = glow; },
  sink: (x, z, r, depth) => sink(x - ox, z - oz, r, depth),
  hideTreesNear: (x, z, r) => hideTreesNear(x - ox, z - oz, r),
  setHole(x, z, r) { groundUniforms.uHole.value.set(x, z, r); }, // (world space)
  stats() { let tris = 0, calls = 0; world.traverse((o) => { if (!o.isMesh || !o.visible) return; const g = o.geometry, n = (g.index ? g.index.count : g.attributes.position.count) / 3; tris += n * (o.isInstancedMesh ? o.count : 1); calls++; }); return { calls, tris: Math.round(tris) }; },
  postUniforms, sun,
};
}
