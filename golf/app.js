// Relay Golf, stage 2: the one-hole prototype. A 3D scene built from the engine's grid (golf-sim.js stays the only
// authority: it decides every shot; this page only draws its layouts and replays its traces), seen through a fixed-angle
// plan camera that frames each shot, and a cinematic camera for the flyover, the ball in flight and reading putts.
//   app.html?course=4&hole=1
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const G = window.RelayGolf;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- units on screen (display only: the engine works in tiles) ----------
const YD = 18;             // yards in a long tile (driver 13 tiles ≈ 240 yd)
const FT = 4;              // feet in a short tile: the short game's own display scale (5 October 2026). At the long
                           // map's 18 yards a tile greens would be enormous (a 10-tile putt "180 ft"), so the two scales differ.
const MPH = 10;            // wind: mph for each tile it pushes a shot
const yards = (tiles) => Math.round((tiles * YD) / 5) * 5;

// ---------- the hole ----------
const qs = new URLSearchParams(location.search);
const courseNo = Math.max(1, Number(qs.get('course')) || window.RelayChain.today()); // (today's course by default)
const courseId = `links#${courseNo}`;
const course = G.getCourse(courseId);
// The round in progress on this course (chain.js keeps it between hole pages): it says which hole this is. A new round
// starts from home (or, for testing, at ?hole=k). Practice (?practice=1, a closed day): nothing hidden, nothing saved.
const C = window.RelayChain;
const practice = qs.get('practice') === '1';
let RS = C.loadRound(courseId);
if (RS && RS.round.done) { C.clearRound(courseId); RS = null; }
if (!RS) {
  RS = C.startRound(courseId, practice);
  const hq = Math.max(1, Math.min(3, Number(qs.get('hole')) || 1)) - 1;
  if (hq) { RS.round.hole = hq; RS.round.ball = course.holes[hq].tee.slice(); C.saveRound(courseId, RS); }
}
const round = RS.round;
const holeIdx = round.hole, hole = course.holes[holeIdx];
const persist = () => C.saveRound(courseId, RS);
const features = G.featuresOn(RS.faced, holeIdx); // what this golfer faces on this hole (the chain as the round began)
const L = G.layoutOf(hole, features);
const par = G.parOf(L);
const W = G.W, H = G.H, CUP = hole.cup, TEE = hole.tee;
const courseName = C.courseName(courseId);

// ---------- renderer, scene, lights ----------
const phone = $('phone'), canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#A8DBF2');
scene.fog = new THREE.Fog('#A8DBF2', 45, 110);
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 300);
scene.add(new THREE.HemisphereLight(0xffffff, 0x5f8f50, 1.5));
const sun = new THREE.DirectionalLight(0xfff4dd, 1.6);
sun.position.set(-12, 30, 10);
scene.add(sun);

// ---------- the long map: soft terrain from the tile grid ----------
// Each terrain type has a height (turf raised, sand and water sunk); the heights are blurred so edges round off, and
// the colours are painted from blurred, thresholded tile masks, so regions read as organic shapes that still line up
// with the tiles. Water sits low with the grid faintly visible through it.
const SUB = 4;                     // height samples per tile
const TPX = 24;                    // texture pixels per tile
const HEIGHT = { K: 0.0, R: 0.05, F: 0.1, G: 0.14, S: -0.12, W: -0.34, T: 0.05, P: 0.05, M: 0.6 };
const COLOR = { K: '#4F9A4B', R: '#6DBB5B', F: '#93D66C', G: '#ABE683', S: '#F3D78E', W: '#5BB8E8', M: '#6DBB5B', T: '#6DBB5B', P: '#6DBB5B', tee: '#BDF094' };
const RIM = { F: '#7FC35C', G: '#8DCF68', S: '#DDB866', W: '#3E97C9', tee: '#9ED877', R: '#5FAA4F' };
const tileAt = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? L.grid[y][x] : 'K');

function blur2d(a, w, h, r, passes) {
  let src = a, dst = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const xx = Math.min(w - 1, Math.max(0, x + k)); s += src[y * w + xx]; n++; } dst[y * w + x] = s / n; }
    [src, dst] = [dst, src];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const yy = Math.min(h - 1, Math.max(0, y + k)); s += src[yy * w + x]; n++; } dst[y * w + x] = s / n; }
    [src, dst] = [dst, src];
  }
  return src;
}
// Heights at (W*SUB+1) x (H*SUB+1) vertices.
const HW = W * SUB + 1, HH = H * SUB + 1;
const longH = (() => {
  const raw = new Float32Array(HW * HH);
  for (let iy = 0; iy < HH; iy++) for (let ix = 0; ix < HW; ix++) {
    const tx = Math.round(-0.5 + ix / SUB), ty = Math.round(-0.5 + iy / SUB), t = tileAt(tx, ty);
    raw[iy * HW + ix] = tx === TEE[0] && ty === TEE[1] ? 0.18 : HEIGHT[t] ?? 0.05;
  }
  return blur2d(raw, HW, HH, 2, 2);
})();
function hLong(x, z) {
  const fx = (x + 0.5) * SUB, fz = (z + 0.5) * SUB;
  const ix = Math.max(0, Math.min(HW - 2, Math.floor(fx))), iz = Math.max(0, Math.min(HH - 2, Math.floor(fz)));
  const ax = Math.min(1, Math.max(0, fx - ix)), az = Math.min(1, Math.max(0, fz - iz));
  const a = longH[iz * HW + ix], b = longH[iz * HW + ix + 1], c = longH[(iz + 1) * HW + ix], d = longH[(iz + 1) * HW + ix + 1];
  return (a * (1 - ax) + b * ax) * (1 - az) + (c * (1 - ax) + d * ax) * az;
}

// Paint a soft-tile texture: layers drawn as blurred, thresholded masks (rounded corners), each with a darker rim.
function paintSoft(w, h, px, typeAt, order, color, rim, extra) {
  const c = document.createElement('canvas'); c.width = w * px; c.height = h * px;
  const g = c.getContext('2d');
  g.fillStyle = color.base; g.fillRect(0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height), D = img.data;
  const m = document.createElement('canvas'); m.width = c.width; m.height = c.height;
  const mg = m.getContext('2d', { willReadFrequently: true });
  const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  for (const key of order) {
    mg.filter = 'none'; mg.clearRect(0, 0, m.width, m.height); mg.fillStyle = '#fff';
    let any = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (typeAt(x, y) === key) { mg.fillRect(x * px, y * px, px, px); any = true; }
    if (!any) continue;
    const blurred = document.createElement('canvas'); blurred.width = m.width; blurred.height = m.height;
    const bg = blurred.getContext('2d', { willReadFrequently: true });
    bg.filter = `blur(${Math.round(px * 0.28)}px)`; bg.drawImage(m, 0, 0);
    const A = bg.getImageData(0, 0, m.width, m.height).data;
    const col = hex(color[key]), rc = hex(rim[key] || color[key]);
    for (let i = 0; i < A.length; i += 4) {
      const a = A[i + 3];
      if (a > 128) { D[i] = col[0]; D[i + 1] = col[1]; D[i + 2] = col[2]; }
      else if (a > 92) { D[i] = rc[0]; D[i + 1] = rc[1]; D[i + 2] = rc[2]; }
    }
  }
  g.putImageData(img, 0, 0);
  if (extra) extra(g, c);
  return c;
}
function longTexture(withGrid) {
  const keyAt = (x, y) => (x === TEE[0] && y === TEE[1] ? 'tee' : ({ T: 'R', P: 'R', M: 'R' }[tileAt(x, y)] || tileAt(x, y)));
  const c = paintSoft(W, H, TPX, keyAt, ['R', 'F', 'G', 'S', 'W', 'tee'], { base: COLOR.K, ...COLOR }, RIM, (g) => {
    // Mown stripes on the fairway, the grid through the water, soft shade under trees, and (while aiming) the grid.
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = tileAt(x, y);
      if (t === 'F' && y % 2) { g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(x * TPX, y * TPX, TPX, TPX); }
      if (t === 'W') { g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 1; g.strokeRect(x * TPX + 0.5, y * TPX + 0.5, TPX - 1, TPX - 1); }
      if (t === 'T' || t === 'P') { g.fillStyle = 'rgba(20,60,25,.28)'; g.beginPath(); g.ellipse(x * TPX + TPX * 0.55, y * TPX + TPX * 0.6, TPX * 0.55, TPX * 0.45, 0, 0, 7); g.fill(); }
    }
    if (withGrid) { g.strokeStyle = 'rgba(255,255,255,.13)'; g.lineWidth = 1; for (let x = 0; x <= W; x++) { g.beginPath(); g.moveTo(x * TPX + 0.5, 0); g.lineTo(x * TPX + 0.5, H * TPX); g.stroke(); } for (let y = 0; y <= H; y++) { g.beginPath(); g.moveTo(0, y * TPX + 0.5); g.lineTo(W * TPX, y * TPX + 0.5); g.stroke(); } }
  });
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}
const texPlain = longTexture(false), texGrid = longTexture(true);
const longGeo = new THREE.PlaneGeometry(W, H, W * SUB, H * SUB);
longGeo.rotateX(-Math.PI / 2);
longGeo.translate(W / 2 - 0.5, 0, H / 2 - 0.5);
{
  const p = longGeo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, longH[i]);
  longGeo.computeVertexNormals();
}
const longMat = new THREE.MeshLambertMaterial({ map: texPlain });
const longMesh = new THREE.Mesh(longGeo, longMat);
scene.add(longMesh);
// A wide base around the hole, so the map never ends at the screen's edge: four strips around the map, never under it
// (a single plane under everything showed through sunken sand and water).
{
  const baseMat = new THREE.MeshLambertMaterial({ color: '#4A9446' }), F = 200, x0 = -0.5, x1 = W - 0.5, z0 = -0.5, z1 = H - 0.5;
  for (const [cx, cz, w, d] of [[(x0 + x1) / 2, z0 - F / 2, x1 - x0 + 2 * F, F], [(x0 + x1) / 2, z1 + F / 2, x1 - x0 + 2 * F, F], [x0 - F / 2, (z0 + z1) / 2, F, z1 - z0], [x1 + F / 2, (z0 + z1) / 2, F, z1 - z0]]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), baseMat); m.rotation.x = -Math.PI / 2; m.position.set(cx, 0, cz); scene.add(m);
  }
}
// Water surface: a translucent sheet just under the turf; it shows only over sunken water tiles.
const water = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshLambertMaterial({ color: '#7FD0F5', transparent: true, opacity: 0.45 }));
water.rotation.x = -Math.PI / 2; water.position.set(W / 2 - 0.5, -0.16, H / 2 - 0.5); scene.add(water);

// Trees: round, low-poly crowns on trunks, a few per tile, placed by a fixed hash so they never move.
{
  const spots = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ('TP'.includes(tileAt(x, y))) {
    const h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
    spots.push([x - 0.18 + ((h % 7) / 7) * 0.12, y - 0.15, 0.42 + (h % 3) * 0.05], [x + 0.2, y + 0.18 - ((h >> 3) % 5) * 0.03, 0.34 + ((h >> 5) % 3) * 0.05]);
  }
  const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshLambertMaterial({ color: '#2F7D3C', flatShading: true }), spots.length);
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.08, 1, 6), new THREE.MeshLambertMaterial({ color: '#7A5534' }), spots.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  spots.forEach(([x, z, r], i) => {
    const y0 = hLong(x, z);
    m.compose(new THREE.Vector3(x, y0 + 0.25 + r * 0.9, z), q, new THREE.Vector3(r, r * 1.05, r)); crown.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(x, y0 + 0.25, z), q, new THREE.Vector3(1, 0.5, 1)); trunk.setMatrixAt(i, m);
  });
  scene.add(crown, trunk);
}
// Golfers' features that don't change the ground: wind cones and calm patches as tinted tiles (wind with arrows its
// way), backstops and fairway banks as low banks. (Bunkers, water and trees change the ground itself; hills and ramps
// are drawn with the hidden things below.)
const KIND_COL = { harm: '#E8604C', boon: '#4C9BE8', bluff: '#A66BD9', either: '#6F7F8C' };
const decor = new THREE.Group(); scene.add(decor);
const tileGeo = new THREE.PlaneGeometry(0.92, 0.92); tileGeo.rotateX(-Math.PI / 2);
function tintTile(x, y, color, opacity, group = decor, lift = 0.035) { const m = new THREE.Mesh(tileGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })); m.position.set(x, hLong(x, y) + lift, y); m.renderOrder = 2; group.add(m); return m; }
function buildDecor() {
  for (const o of [...decor.children]) decor.remove(o);
  const bankGeo = new THREE.BoxGeometry(0.9, 0.22, 0.9);
  for (const k of L.calm) { const [x, y] = k.split(',').map(Number); tintTile(x, y, '#BFE3FF', 0.45); }
  for (const g of L.gusts) {
    const tiles = [...g.tiles].map((k) => k.split(',').map(Number));
    for (const [x, y] of tiles) tintTile(x, y, '#9FB4C4', 0.32);
    const cx = tiles.reduce((s, q) => s + q[0], 0) / tiles.length, cy = tiles.reduce((s, q) => s + q[1], 0) / tiles.length;
    const a = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false }));
    a.position.set(cx, hLong(cx, cy) + 0.06, cy); a.rotation.y = -Math.atan2(g.step[1], g.step[0]); a.scale.set(2.2, 1, 2); decor.add(a);
  }
  for (const set of [L.banks, L.fbanks]) for (const k of set) {
    const [x, y] = k.split(',').map(Number);
    const b = new THREE.Mesh(bankGeo, new THREE.MeshLambertMaterial({ color: '#8ED3F2' })); b.position.set(x, hLong(x, y) + 0.08, y); decor.add(b);
  }
}

// Suspicious hills and ramps the golfer hasn't scouted show a "?" (what they hide is the engine's secret).
function labelSprite(text, bg, fg = '#fff', size = 0.7) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); g.fillStyle = bg; g.beginPath(); g.arc(64, 64, 56, 0, 7); g.fill();
  g.fillStyle = fg; g.font = '800 76px "Baloo 2", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 64, 70);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false })); s.scale.set(size, size, 1); s.renderOrder = 5;
  return s;
}
// What the golfer can't see yet. Unscouted suspicious hills and ramps carry a "?" that can be tapped (and scouted);
// ground a hill hides lies under mist until it's scouted or the ball comes close (the engine's viewOf decides); a
// scouted ramp shows arrows the way it runs. Rebuilt whenever what's known changes.
const marks = new THREE.Group(); scene.add(marks);
const mistGeo = new THREE.SphereGeometry(1, 14, 10), mistMat = new THREE.MeshLambertMaterial({ color: '#D9D3E6', transparent: true, opacity: 0.94 });
const arrowShape = new THREE.Shape();
arrowShape.moveTo(-0.5, -0.07); arrowShape.lineTo(0.08, -0.07); arrowShape.lineTo(0.08, -0.2); arrowShape.lineTo(0.5, 0); arrowShape.lineTo(0.08, 0.2); arrowShape.lineTo(0.08, 0.07); arrowShape.lineTo(-0.5, 0.07); arrowShape.closePath();
const arrowGeo = new THREE.ShapeGeometry(arrowShape); arrowGeo.rotateX(-Math.PI / 2);
function updateHidden(ballAt) {
  for (const o of [...marks.children]) { marks.remove(o); if (o.isSprite) o.material.map.dispose(); }
  const known = new Set(round.known), v = G.viewOf(hole, features, known, ballAt || round.ball);
  for (const f of G.withSeed(hole, features)) {
    if ((f.kind === 'hill' || f.kind === 'ramp') && !known.has(f.id)) {
      const s = labelSprite('?', f.kind === 'hill' ? 'rgba(166,107,217,.95)' : 'rgba(111,127,140,.95)', '#fff', 0.62);
      s.position.set(f.x, hLong(f.x, f.y) + 0.9, f.y); s.userData.feature = f; marks.add(s);
    }
    if (f.kind === 'ramp' && known.has(f.id)) {
      const [dx, dy] = G.ORIENT[f.dir || 0];
      for (const [x, y] of G.footprint(f)) {
        const a = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: '#6F7F8C', transparent: true, opacity: 0.9, depthWrite: false }));
        a.position.set(x, hLong(x, y) + 0.04, y); a.rotation.y = -Math.atan2(dy, dx); a.scale.set(0.8, 1, 0.9); marks.add(a);
      }
    }
  }
  for (const k of v.hidden) {
    const [x, y] = k.split(',').map(Number);
    const m = new THREE.Mesh(mistGeo, mistMat); m.position.set(x, hLong(x, y) + 0.15, y); m.scale.set(0.78, 0.42, 0.78); marks.add(m);
  }
}
updateHidden(TEE);
buildDecor();
// The flag and the cup.
const flag = new THREE.Group();
{
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.6, 6), new THREE.MeshLambertMaterial({ color: '#ffffff' }));
  pole.position.y = 0.8;
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.34), new THREE.MeshLambertMaterial({ color: '#E8604C', side: THREE.DoubleSide }));
  cloth.position.set(0.28, 1.42, 0);
  const cup = new THREE.Mesh(new THREE.CircleGeometry(0.13, 20), new THREE.MeshBasicMaterial({ color: '#1E2A24' }));
  cup.rotation.x = -Math.PI / 2; cup.position.y = 0.012;
  flag.add(pole, cloth, cup);
  flag.position.set(CUP[0], hLong(CUP[0], CUP[1]), CUP[1]);
  scene.add(flag);
}
// The ball and its shadow.
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.15, 20, 14), new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#333333' }));
const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.17, 20), new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.25 }));
shadow.rotation.x = -Math.PI / 2;
scene.add(ball, shadow);
function placeBall(x, z, y) { const g = groundAt(x, z); ball.position.set(x, (y ?? 0) + g + 0.15, z); shadow.position.set(x, g + 0.015, z); shadow.material.opacity = 0.25 / (1 + (y ?? 0) * 0.6); }

// ---------- the short map: the green and its surrounds, with the seed's slopes ----------
const S = G.shortOf(hole, features);
const SN = G.SN, SC = G.SC, SCALE = G.SCALE;
const EX = 2.5; // slopes drawn 2.5 times taller than they are, so they read on a phone
const sToW = (sx, sy) => [CUP[0] + (sx - SC) / SCALE, CUP[1] + (sy - SC) / SCALE];
const wToS = (x, z) => [SC + (x - CUP[0]) * SCALE, SC + (z - CUP[1]) * SCALE];
const hCupS = S.h[SC][SC];
const sGreenBase = hLong(CUP[0], CUP[1]);
function hShortRaw(sx, sy) {
  const x = Math.max(0, Math.min(SN - 1.001, sx)), y = Math.max(0, Math.min(SN - 1.001, sy));
  const ix = Math.floor(x), iy = Math.floor(y), ax = x - ix, ay = y - iy, h = S.h;
  const v = (h[iy][ix] * (1 - ax) + h[iy][Math.min(SN - 1, ix + 1)] * ax) * (1 - ay) + (h[Math.min(SN - 1, iy + 1)][ix] * (1 - ax) + h[Math.min(SN - 1, iy + 1)][Math.min(SN - 1, ix + 1)] * ax) * ay;
  return sGreenBase + (v - hCupS) * EX;
}
// Near the edge of the short-game area the ground eases back to the long map's, so the two meet without a step.
function hShort(x, z) {
  const r = Math.hypot(x - CUP[0], z - CUP[1]), [sx, sy] = wToS(x, z), k = Math.min(1, Math.max(0, (r - (G.ZONE_R - 0.6)) / 1.1));
  return hShortRaw(sx, sy) * (1 - k) + hLong(x, z) * k;
}
let shortMesh = null, shortMode = false, shortTexPlain = null, shortTexHeights = null, heights = true;
// The green's height map: seven bands of colour from the lowest ground on the green (cool, darker) to the highest
// (warm, lighter), with a faint line where a band changes, over the plain texture. Off the green nothing changes.
function heightTexture(plain, SPX) {
  const c = document.createElement('canvas'); c.width = plain.width; c.height = plain.height;
  const g = c.getContext('2d'); g.drawImage(plain, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height), D = img.data;
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < SN; y++) for (let x = 0; x < SN; x++) if ('GD'.includes(S.grid[y][x])) { lo = Math.min(lo, S.h[y][x]); hi = Math.max(hi, S.h[y][x]); }
  const span = hi - lo || 1, BANDS = 7, LOW = [70, 160, 140], HIGH = [232, 236, 140];
  const band = (sx, sy) => Math.min(BANDS - 1, Math.floor(((((hShortRaw(sx, sy) - sGreenBase) / EX + hCupS) - lo) / span) * BANDS));
  for (let py = 0; py < c.height; py++) for (let px = 0; px < c.width; px++) {
    const sx = px / SPX - 0.5, sy = py / SPX - 0.5, tx = Math.round(sx), ty = Math.round(sy);
    if (tx < 0 || ty < 0 || tx >= SN || ty >= SN || !'GD'.includes(S.grid[ty][tx])) continue;
    const b = band(sx, sy), k = b / (BANDS - 1), i = (py * c.width + px) * 4;
    const edge = band(sx + 1 / SPX, sy) !== b || band(sx, sy + 1 / SPX) !== b;
    for (let ch = 0; ch < 3; ch++) { const col = LOW[ch] + (HIGH[ch] - LOW[ch]) * k; D[i + ch] = Math.round(D[i + ch] * 0.15 + col * 0.85 - (edge ? 34 : 0)); }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}
function groundAt(x, z) { return shortMode && Math.hypot(x - CUP[0], z - CUP[1]) < G.ZONE_R + 0.6 ? hShort(x, z) : hLong(x, z); }
function buildShort() {
  const SPX = 14, keyAt = (x, y) => { const t = S.grid[y][x]; return t === 'D' ? 'G' : t === 'K' ? 'K' : t; };
  const sCol = { base: COLOR.K, ...COLOR, F: '#9EDD74' };
  const c = paintSoft(SN, SN, SPX, keyAt, ['R', 'F', 'G', 'S', 'W'], sCol, { ...RIM, F: '#86C962' }, (g) => {
    // Slopes: a little lighter where the green is higher (the break itself is shown by arrows, built below).
    const img = g.getImageData(0, 0, SN * SPX, SN * SPX), D = img.data;
    for (let py = 0; py < SN * SPX; py += 1) for (let px = 0; px < SN * SPX; px += 1) {
      const sx = px / SPX - 0.5, sy = py / SPX - 0.5, tx = Math.round(sx), ty = Math.round(sy);
      if (tx < 0 || ty < 0 || tx >= SN || ty >= SN || !'GD'.includes(S.grid[ty][tx])) continue;
      const v = (hShortRaw(sx, sy) - sGreenBase) / EX, i = (py * SN * SPX + px) * 4, shade = Math.max(-1, Math.min(1, v / 0.15)) * 14;
      D[i] = Math.max(0, Math.min(255, D[i] + shade)); D[i + 1] = Math.max(0, Math.min(255, D[i + 1] + shade)); D[i + 2] = Math.max(0, Math.min(255, D[i + 2] + shade * 0.6));
    }
    g.putImageData(img, 0, 0);
    for (let y = 0; y < SN; y++) for (let x = 0; x < SN; x++) if (S.grid[y][x] === 'D') { g.fillStyle = '#9B9384'; g.beginPath(); g.arc(x * SPX + SPX / 2, y * SPX + SPX / 2, SPX * 0.3, 0, 7); g.fill(); }
  });
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  shortTexPlain = tex; shortTexHeights = heightTexture(c, SPX);
  const n = SN * 2, size = SN / SCALE;
  const geo = new THREE.PlaneGeometry(size, size, n, n);
  geo.rotateX(-Math.PI / 2);
  const [cx, cz] = sToW((SN - 1) / 2, (SN - 1) / 2);
  geo.translate(cx, 0, cz);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, hShort(p.getX(i), p.getZ(i)));
  geo.computeVertexNormals();
  shortMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: heights ? shortTexHeights : tex }));
  scene.add(shortMesh);
  buildBreakArrows();
  // The long map's ground under the short-game area drops out of sight.
  const lp = longGeo.attributes.position;
  for (let i = 0; i < lp.count; i++) if (Math.hypot(lp.getX(i) - CUP[0], lp.getZ(i) - CUP[1]) < G.ZONE_R + 0.3) lp.setY(i, longH[i] - 1.5);
  lp.needsUpdate = true; longGeo.computeVertexNormals();
  flag.position.y = hShort(CUP[0], CUP[1]);
}

// Break arrows: on the green and fringe, every other short tile, a flat arrow pointing the way the ground falls
// (the way a slow ball drifts), longer and stronger where it's steeper. Flat spots get none.
let breakArrows = null;
function buildBreakArrows() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, -0.07); shape.lineTo(0.08, -0.07); shape.lineTo(0.08, -0.2); shape.lineTo(0.5, 0); shape.lineTo(0.08, 0.2); shape.lineTo(0.08, 0.07); shape.lineTo(-0.5, 0.07); shape.closePath();
  const geo = new THREE.ShapeGeometry(shape); geo.rotateX(-Math.PI / 2);
  const cells = [];
  for (let y = 1; y < SN; y += 2) for (let x = 1; x < SN; x += 2) {
    if (!'GF'.includes(S.grid[y][x]) || (Math.abs(x - SC) <= 1 && Math.abs(y - SC) <= 1)) continue;
    const [gx, gy] = G.slopeAt(S, x, y), m = Math.hypot(gx, gy);
    if (m < 0.006) continue;
    cells.push({ x, y, dx: -gx / m, dz: -gy / m, m });
  }
  const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false });
  breakArrows = new THREE.InstancedMesh(geo, mat, Math.max(1, cells.length));
  const M4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  cells.forEach((c, i) => {
    const [wx, wz] = sToW(c.x, c.y), k = Math.min(1, c.m / 0.05), len = 0.18 + 0.32 * k;
    q.setFromAxisAngle(up, -Math.atan2(c.dz, c.dx));
    M4.compose(new THREE.Vector3(wx, hShort(wx, wz) + 0.025, wz), q, new THREE.Vector3(len, 1, 0.6 + 0.6 * k));
    breakArrows.setMatrixAt(i, M4);
  });
  breakArrows.count = cells.length;
  breakArrows.renderOrder = 2;
  scene.add(breakArrows);
}

// ---------- cameras ----------
// The plan camera looks down at a fixed tilt and frames a set of points in the part of the screen the sheet doesn't
// cover; the cinematic camera is placed directly. Both ease between positions.
const TILT = (24 * Math.PI) / 180;
const cam = { pos: new THREE.Vector3(TEE[0], 30, TEE[1] + 10), look: new THREE.Vector3(TEE[0], 0, TEE[1]), from: null, to: null, t0: 0, dur: 0, offset: 0 };
let viewOffset = 0;
function easeIO(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
// The plan camera uses a long lens (flatter, more map-like); the cinematic camera a wider one.
const FOV = { plan: 32, cine: 50 };
let fovWant = FOV.plan;
function moveCam(pos, look, dur = 0.7, offset = viewOffset) {
  cam.from = { pos: cam.pos.clone(), look: cam.look.clone(), offset: viewOffset };
  cam.to = { pos: pos.clone(), look: look.clone(), offset };
  cam.t0 = performance.now(); cam.dur = dur * 1000;
  if (dur === 0) { cam.pos.copy(pos); cam.look.copy(look); viewOffset = offset; cam.to = null; }
}
function visibleBand() {
  const r = phone.getBoundingClientRect(), sh = $('sheet');
  // (offsetHeight, not the sheet's on-screen position: it may still be sliding in.)
  const top = 64, bottom = sh.classList.contains('hidden') ? r.height - 20 : r.height - sh.offsetHeight - 10;
  return { top, bottom, h: r.height, w: r.width };
}
function framePlan(points, dur = 0.7) {
  const b = visibleBand();
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const pad = 1.6, cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, sx = maxX - minX + pad * 2, sz = maxZ - minZ + pad * 2;
  const fovV = (camera.fov * Math.PI) / 180, bandH = b.bottom - b.top, fovBand = 2 * Math.atan(Math.tan(fovV / 2) * (bandH / b.h));
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * (b.w / b.h));
  const d = Math.max((sz * Math.cos(TILT)) / 2 / Math.tan(fovBand / 2), sx / 2 / Math.tan(fovH / 2), 8);
  const look = new THREE.Vector3(cx, groundAt(cx, cz), cz), off = b.h / 2 - (b.top + b.bottom) / 2;
  // The estimate above ignores the tilt (nearer points spread wider), so check it: project every point through a test
  // camera at the final lens and offset, and back off until they all sit inside the free band (with a margin).
  const test = new THREE.PerspectiveCamera(FOV.plan, b.w / b.h, 0.1, 400);
  test.setViewOffset(b.w, b.h, 0, off, b.w, b.h);
  const at = (dd) => look.clone().add(new THREE.Vector3(0, Math.cos(TILT) * dd, Math.sin(TILT) * dd));
  let dist = d;
  for (let k = 0; k < 24; k++) {
    test.position.copy(at(dist)); test.lookAt(look); test.updateMatrixWorld(); test.updateProjectionMatrix();
    const ok = points.every(([x, z]) => {
      const v = new THREE.Vector3(x, groundAt(x, z), z).project(test), sx = ((v.x + 1) / 2) * b.w, sy = ((1 - v.y) / 2) * b.h;
      return sx > 22 && sx < b.w - 22 && sy > b.top + 14 && sy < b.bottom - 14;
    });
    if (ok) break;
    dist *= 1.08;
  }
  fovWant = FOV.plan;
  moveCam(at(dist), look, dur, off);
}
function updateCamera(now) {
  if (cam.to) {
    const t = Math.min(1, (now - cam.t0) / cam.dur), e = easeIO(t);
    cam.pos.lerpVectors(cam.from.pos, cam.to.pos, e); cam.look.lerpVectors(cam.from.look, cam.to.look, e);
    viewOffset = cam.from.offset + (cam.to.offset - cam.from.offset) * e;
    if (t >= 1) cam.to = null;
  }
  if (Math.abs(camera.fov - fovWant) > 0.05) { camera.fov += (fovWant - camera.fov) * 0.12; camera.updateProjectionMatrix(); }
  camera.position.copy(cam.pos); camera.lookAt(cam.look);
  // Fog starts past what the camera is looking at, so a high plan view isn't washed out.
  const dist = cam.pos.distanceTo(cam.look); scene.fog.near = dist + 15; scene.fog.far = dist + 80;
  const b = phone.getBoundingClientRect();
  if (Math.abs(viewOffset) > 0.5) camera.setViewOffset(b.width, b.height, 0, viewOffset, b.width, b.height); else camera.clearViewOffset();
}

// ---------- overlays: landing spots, lines, previews ----------
const overlay = new THREE.Group(); scene.add(overlay);
function clearOverlay() { for (const o of [...overlay.children]) { overlay.remove(o); o.geometry && o.geometry.dispose(); if (o.material && fatMats.has(o.material)) { fatMats.delete(o.material); o.material.dispose(); } } }
// Lines are three.js fat lines, their width in screen pixels (WebGL's own lines are one pixel wide). `dash` is the
// dash length in world units (tiles), or 0 for a solid line.
const fatMats = new Set();
function addLine(pts, color, dashed, opacity = 1, lift = 0.06, width = 3, dash = 0.3) {
  const geo = new LineGeometry();
  geo.setPositions(pts.flatMap(([x, z, y]) => [x, (y ?? groundAt(x, z)) + lift, z]));
  const mat = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthTest: false, dashed: !!dashed, dashSize: dash, gapSize: dash * 0.75, worldUnits: false });
  const r = phone.getBoundingClientRect(); mat.resolution.set(r.width, r.height);
  fatMats.add(mat);
  const l = new Line2(geo, mat); if (dashed) l.computeLineDistances(); l.renderOrder = 3; overlay.add(l); return l;
}
function addRing(x, z, r0, r1, color, opacity = 1) {
  const m = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 28), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, groundAt(x, z) + 0.05, z); m.renderOrder = 4; overlay.add(m); return m;
}
function addDot(x, z, r, color) { const m = new THREE.Mesh(new THREE.CircleGeometry(r, 20), new THREE.MeshBasicMaterial({ color, depthTest: false })); m.rotation.x = -Math.PI / 2; m.position.set(x, groundAt(x, z) + 0.06, z); m.renderOrder = 4; overlay.add(m); return m; }
function addCross(x, z, color) { const s = labelSprite('×', 'rgba(0,0,0,0)', color, 0.6); s.position.set(x, groundAt(x, z) + 0.2, z); overlay.add(s); }

// ---------- UI helpers ----------
const sheet = $('sheet'), body = $('sheetbody');
function showSheet(html) { body.innerHTML = html; sheet.classList.remove('hidden'); }
function hideSheet() { sheet.classList.add('hidden'); }
function topChips(left, right) { $('top').innerHTML = '<a class="chip" href="home.html" title="Home (the round waits)" style="text-decoration:none;color:var(--ink)">⌂</a>' + left.map((t, i) => `<span class="chip ${i === 0 ? 'dark' : ''}">${esc(t)}</span>`).join('') + '<span class="spacer"></span>' + right.map((t) => `<span class="chip">${esc(t)}</span>`).join(''); }
const windText = () => { const [dx, dy] = hole.wind; if (!dx && !dy) return 'No wind'; const a = Math.atan2(-dy, dx), arr = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'][((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8]; return `Wind ${Math.round(Math.hypot(dx, dy) * MPH)} ${arr}`; };
let callTimer = 0;
function call(tag, big, sub, ms = 1800) {
  const el = $('call'); el.innerHTML = `${tag ? `<div class="tag">${esc(tag)}</div>` : ''}<div class="big">${esc(big)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}`;
  el.classList.remove('hidden'); clearTimeout(callTimer); callTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
// The engine words distances in short tiles; on screen they're feet.
const inFeet = (s) => String(s).replace(/(\d+(?:\.\d+)?) tiles?/g, (_, n) => `${Math.max(1, Math.round(Number(n) * FT))} ft`).replace(/stops (\d+(?:\.\d+)?) from/g, (_, n) => `stops ${Math.max(1, Math.round(Number(n) * FT))} ft from`).replace(/\bclick\b/g, 'tap');
function explain(text) { text = text && inFeet(text); const el = $('explain'); if (!text) return el.classList.add('hidden'); el.textContent = text; el.classList.remove('hidden'); el.style.top = `${Math.max(70, sheet.getBoundingClientRect().top - phone.getBoundingClientRect().top - 50)}px`; }
let caddyLines = [], caddyDone = null;
function caddySay(text) { $('caddytext').innerHTML = esc(text); $('caddy').classList.remove('hidden'); }
function caddyHide() { $('caddy').classList.add('hidden'); }

// ---------- the caddy's notes: only what the golfer can see ----------
const terrainWord = { F: 'the fairway', R: 'the light rough', K: 'the thick rough', S: 'the sand', W: 'the water', G: 'the green', T: 'the trees', P: 'under the trees', M: 'a hill' };
function caddyNotes() {
  const known = new Set(round.known), V = G.believedLayout(hole, features, known, TEE);
  const g = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? V.grid[y][x] : 'K');
  const u = [CUP[0] - TEE[0], CUP[1] - TEE[1]], len = Math.hypot(...u), d = [u[0] / len, u[1] / len], right = [-d[1], d[0]];
  // The wind, told relative to the hole: helping or against, and across which way.
  const [wx, wy] = hole.wind, wlen = Math.hypot(wx, wy);
  let windLine = 'No wind today.';
  if (wlen) {
    const along = (wx * d[0] + wy * d[1]) / wlen, across = (wx * right[0] + wy * right[1]) / wlen;
    const parts = [];
    if (along > 0.38) parts.push('helping'); else if (along < -0.38) parts.push('against you');
    if (across > 0.38) parts.push('left to right'); else if (across < -0.38) parts.push('right to left');
    windLine = `The wind's ${Math.round(wlen * MPH)} mph, ${parts.join(' and ')}.`;
  }
  const lines = [`Hole ${holeIdx + 1}, par ${par}, ${yards(len)} yards. ${windLine}`];
  const side = (x, y) => { const v = [x - CUP[0], y - CUP[1]], a = v[0] * d[0] + v[1] * d[1], b = v[0] * right[0] + v[1] * right[1]; return Math.abs(a) > Math.abs(b) ? (a < 0 ? 'short of' : 'behind') : b < 0 ? 'left of' : 'right of'; };
  const near = {};
  for (let y = CUP[1] - 4; y <= CUP[1] + 4; y++) for (let x = CUP[0] - 4; x <= CUP[0] + 4; x++) { const t = g(x, y); if ((t === 'W' || t === 'S') && Math.hypot(x - CUP[0], y - CUP[1]) <= 4.5) { const k = `${t === 'W' ? 'Water' : 'Sand'} ${side(x, y)}`; near[k] = (near[k] || 0) + 1; } }
  const nearList = Object.keys(near).sort((a, b) => near[b] - near[a]).slice(0, 2);
  if (nearList.length) lines.push(`${nearList.join(', and ').replace(/^./, (c) => c.toUpperCase())} the green.`);
  // Hazards along the way, by distance from the tee.
  const along = [];
  for (let s = 4; s < len - 5; s++) {
    const px = TEE[0] + d[0] * s, py = TEE[1] + d[1] * s;
    for (let k = -3; k <= 3; k++) { const x = Math.round(px + right[0] * k), y = Math.round(py + right[1] * k), t = g(x, y); if (t === 'W' || t === 'S') { along.push({ t, s, k }); } }
  }
  if (along.length) { const a = along[0]; lines.push(`${a.t === 'W' ? 'Water' : 'A bunker'} ${a.k < 0 ? 'left' : a.k > 0 ? 'right' : 'right in the middle'} at about ${yards(a.s)} yards.`); }
  if ((hole.bends || []).length) lines.push(`The fairway doglegs, so there's a safe way round and a shortcut over the rough.`);
  const hills = G.withSeed(hole, features).filter((f) => f.kind === 'hill' && !known.has(f.id)).length;
  if (hills) lines.push(`${hills === 1 ? 'A suspicious hill' : `${hills} suspicious hills`} could be hiding something. Get close and you'll see behind.`);
  return lines.slice(0, 4);
}

// ---------- state ----------
let state = 'flyover';
const CLUB_KEYS = ['driver', 'wood', 'long', 'short', 'wedge'];
let club = null, swing = 'full', shape = '', selDir = null, spots = [], lastTiming = 0;
const strokes = () => round.strokes[holeIdx];
const known = () => new Set(round.known);
const believed = () => G.believedLayout(hole, features, known(), round.ball);

// ---------- the flyover, with the caddy ----------
function flyover() {
  state = 'flyover'; hideSheet();
  topChips([`Hole ${holeIdx + 1} · Par ${par}`, `${yards(Math.hypot(CUP[0] - TEE[0], CUP[1] - TEE[1]))} yards`], [windText()]);
  // The camera follows the fairway: from behind the tee, up the middle of the main fairway (through its bend on a
  // dogleg), to the green, looking a little ahead along the way. One smooth glide over the caddy's lines.
  const v = (p) => new THREE.Vector3(p[0], 0, p[1]);
  const route = [v(TEE), ...(hole.bends || []).slice(0, 1).map(v), v(CUP)];
  const d0 = route[1].clone().sub(route[0]).normalize(), d1 = route[route.length - 1].clone().sub(route[route.length - 2]).normalize();
  const camPts = [route[0].clone().addScaledVector(d0, -5), ...route.slice(1, -1), route[route.length - 1].clone().addScaledVector(d1, -7)];
  const lookPts = [route[0].clone().addScaledVector(d0, 8), ...route.slice(1, -1), route[route.length - 1].clone()];
  const camCurve = new THREE.CatmullRomCurve3(camPts), lookCurve = new THREE.CatmullRomCurve3(lookPts);
  caddyLines = caddyNotes();
  fovWant = FOV.cine; camera.fov = FOV.cine; camera.updateProjectionMatrix();
  const ms = Math.max(9000, caddyLines.length * 3000), gap = ms / caddyLines.length, t0 = performance.now();
  const at = (u) => {
    const c = camCurve.getPointAt(u), l = lookCurve.getPointAt(Math.min(1, u + 0.12));
    c.y = groundAt(c.x, c.z) + 2.4 + 3.1 * u + 4 * Math.sin(Math.PI * u);
    l.y = groundAt(l.x, l.z);
    return [c, l];
  };
  moveCam(...at(0), 0, 0);
  fly = (now) => {
    const k = Math.min(1, (now - t0) / ms), u = k * k * (3 - 2 * k); // ease in and out
    const [c, l] = at(u);
    cam.to = null; viewOffset = 0; cam.pos.copy(c); cam.look.copy(l);
  };
  let i = 0;
  const next = () => {
    if (state !== 'flyover') return;
    if (i >= caddyLines.length) return endFlyover();
    caddySay(caddyLines[i]);
    i++; caddyDone = setTimeout(next, gap);
  };
  $('top').insertAdjacentHTML('beforeend', '<button class="chip" id="skip">Skip</button>');
  $('skip').onclick = endFlyover;
  next();
}
let fly = null; // the flyover's camera, while it runs
function endFlyover() { clearTimeout(caddyDone); caddyHide(); fly = null; if (state === 'flyover') startAim(); }

// ---------- the long game: aiming ----------
function legalClubs() { const Lb = believed(); return CLUB_KEYS.filter((k) => G.clubAllowed(Lb, round.ball, k)); }
function spotsFor(k, sw, sh) {
  const Lb = believed(), out = [], seen = new Set();
  for (const dir of G.aimDirs(Lb, round.ball)) {
    const a = { club: k, dir, swing: sw, ...(sh && G.CURVE[k] ? { shape: sh } : {}) }, tr = {}, r = G.shot(Lb, round.ball, a, tr);
    const key = `${r.pos[0]},${r.pos[1]},${r.holed}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push({ dir, a, r, tr });
  }
  return out;
}
const goodSpot = (Lb, s) => s.r.holed || (!s.r.penalty && 'FG'.includes(Lb.grid[s.r.pos[1]][s.r.pos[0]]));
function startAim() {
  state = 'aim'; selDir = null; shape = ''; swing = 'full';
  longMat.map = texGrid; longMat.needsUpdate = true;
  const legal = legalClubs(), Lb = believed();
  club = legal.find((k) => spotsFor(k, 'full', '').some((s) => goodSpot(Lb, s))) || legal[legal.length - 1];
  placeBall(round.ball[0], round.ball[1]);
  renderAim(true);
}
function renderAim(reframe) {
  const Lb = believed(), legal = legalClubs();
  spots = spotsFor(club, swing, shape);
  topChips([`Hole ${holeIdx + 1} · Par ${par}`, `Stroke ${strokes() + 1}`], [windText()]);
  clearOverlay();
  const b = round.ball, sel = spots.find((s) => s.dir === selDir);
  for (const s of spots) {
    const on = s === sel, [x, z] = s.r.pos;
    // The flight: a curve for a shaped shot (aimed down its line, bending to where it lands), then the run.
    const pts = [[b[0], b[1]]];
    if (s.a.shape && s.tr.target) { const E0 = [s.tr.target[0] - s.tr.drift[0], s.tr.target[1] - s.tr.drift[1]], land = s.tr.land || s.tr.target; for (let i = 1; i <= 12; i++) { const t = i / 12; pts.push([b[0] + (E0[0] - b[0]) * t + s.tr.drift[0] * t * t, b[1] + (E0[1] - b[1]) * t + s.tr.drift[1] * t * t]); } pts[pts.length - 1] = land; }
    pts.push([x, z]);
    addLine(pts, on ? '#F2B52E' : '#ffffff', false, on ? 1 : 0.4, 0.06, on ? 5 : 2);
    const bad = s.r.penalty, col = s.r.holed ? '#F2B52E' : bad ? '#E8604C' : '#ffffff';
    if (on) { addRing(x, z, 0.26, 0.4, '#F2B52E'); addDot(x, z, 0.14, '#1E2A24'); } else addRing(x, z, 0.2, 0.3, col, 0.95);
  }
  let goodNext = 0;
  if (sel && !sel.r.holed && !sel.r.penalty) {
    // Dashed lines to the shots possible from there, and crosses where a mistimed swing would land.
    const from = sel.r.pos, seen = new Set();
    for (const k of CLUB_KEYS) {
      const L2 = G.believedLayout(hole, features, known(), from);
      if (!G.clubAllowed(L2, from, k)) continue;
      for (const dir of G.aimDirs(L2, from)) {
        const r = G.shot(L2, from, { club: k, dir, swing: 'full' }), key = `${r.pos[0]},${r.pos[1]}`;
        if (seen.has(key) || Math.hypot(r.pos[0] - CUP[0], r.pos[1] - CUP[1]) >= Math.hypot(from[0] - CUP[0], from[1] - CUP[1])) continue;
        seen.add(key); if (r.holed || (!r.penalty && 'FG'.includes(L2.grid[r.pos[1]][r.pos[0]]))) goodNext++;
        addLine([[from[0], from[1]], [r.pos[0], r.pos[1]]], '#ffffff', true, 0.7, 0.06, 2.5, 0.35);
      }
    }
    for (const tm of [-0.8, -0.4, 0.4, 0.8]) { const r = G.shot(Lb, b, { ...sel.a, timing: tm }); if (r.pos[0] !== sel.r.pos[0] || r.pos[1] !== sel.r.pos[1]) addCross(r.pos[0], r.pos[1], r.penalty ? '#E8604C' : '#F2B52E'); }
  }
  // The sheet: the selected shot, the clubs (in yards), swing size, shape, and Swing.
  const c = G.CLUBS[club], carryY = yards(G.carryOf(club, swing));
  const where = sel ? (sel.r.holed ? 'Holes out!' : sel.r.penalty ? `${sel.r.events.includes('water') ? 'Finds the water' : 'Goes out of bounds'}: a penalty stroke.` : `Lands in ${terrainWord[Lb.grid[sel.r.pos[1]][sel.r.pos[0]]] || 'play'}, ${yards(Math.hypot(sel.r.pos[0] - CUP[0], sel.r.pos[1] - CUP[1]))} to the cup.${goodNext ? ` ${goodNext === 1 ? 'One good line' : `${['', '', 'Two', 'Three', 'Four', 'Five'][goodNext] || goodNext} good lines`} from there.` : ''}`) : 'Tap a landing spot. Tap it again, or Swing, to play it.';
  const cards = CLUB_KEYS.map((k) => { const ok = legal.includes(k), good = ok && spotsFor(k, 'full', '').some((s) => goodSpot(Lb, s)); return `<button class="club ${k === club ? 'on' : ''}" data-club="${k}" ${ok ? '' : 'disabled'}>${!good && ok ? '<span class="warn">!</span>' : ''}${esc(G.CLUBS[k].label)}<small>${yards(G.carryOf(k, 'full'))}</small></button>`; }).join('');
  const bend = G.CURVE[club];
  showSheet(`<div class="row between"><div class="h2">${esc(c.label)}, ${swing === 'full' ? 'full' : '¾'}${shape ? `, ${shape}` : ''}</div><div class="muted">${carryY} yards</div></div>
    <div class="muted" style="margin-top:4px;color:var(--ink)">${esc(where)}</div>
    <div class="clubs">${cards}</div>
    <div class="row">
      <div class="seg"><button class="${swing === 'full' ? 'on' : ''}" data-swing="full">Full</button><button class="${swing === 'three' ? 'on' : ''}" data-swing="three">¾</button></div>
      ${bend ? `<div class="seg shape"><button class="${shape === 'draw' ? 'on' : ''}" data-shape="draw" title="Draw">↰</button><span class="mid">${shape ? (shape === 'draw' ? 'Draw' : 'Fade') : 'Straight'}</span><button class="${shape === 'fade' ? 'on' : ''}" data-shape="fade" title="Fade">↱</button></div><div class="note">Draw bends ${yards(bend)} yd left, fade ${yards(bend)} yd right</div>` : '<div class="note" style="width:auto">The wedge flies straight.</div>'}
    </div>
    <button class="primary" id="swingbtn" ${sel ? '' : 'disabled'}>Swing</button>`);
  for (const el of body.querySelectorAll('[data-club]')) el.onclick = () => { club = el.dataset.club; selDir = null; if (!G.CURVE[club]) shape = ''; renderAim(true); };
  for (const el of body.querySelectorAll('[data-swing]')) el.onclick = () => { swing = el.dataset.swing; selDir = null; renderAim(true); };
  for (const el of body.querySelectorAll('[data-shape]')) el.onclick = () => { shape = shape === el.dataset.shape ? '' : el.dataset.shape; selDir = null; renderAim(true); };
  $('swingbtn').onclick = () => sel && startSwing();
  if (reframe) {
    // Frame the ball and where this club can land; the cup too when it's within reach of them.
    const pts = [round.ball, ...spots.map((s) => s.r.pos)], reach = Math.max(...pts.map((p) => Math.hypot(p[0] - round.ball[0], p[1] - round.ball[1])));
    if (Math.hypot(CUP[0] - round.ball[0], CUP[1] - round.ball[1]) < reach + 5) pts.push(CUP);
    requestAnimationFrame(() => framePlan(pts, 0.6));
  }
}
function tapAim(point) {
  let best = null;
  for (const s of spots) { const d = Math.hypot(s.r.pos[0] - point.x, s.r.pos[1] - point.z); if (d < 1.1 && (!best || d < best.d)) best = { s, d }; }
  if (!best) return;
  if (selDir === best.s.dir) return startSwing();
  selDir = best.s.dir; renderAim(false);
}

// ---------- tapping a hidden thing: what it is, and Scout ----------
function showHidden(f) {
  state = 'info';
  const hill = f.kind === 'hill', spec = G.FEATURES[f.kind];
  clearOverlay(); addRing(f.x, f.y, 0.45, 0.6, hill ? '#A66BD9' : '#6F7F8C');
  showSheet(`<div class="row between"><div class="h2">${hill ? 'Suspicious hill' : 'Ramp'}</div><span class="chip" style="background:${hill ? 'rgba(166,107,217,.16);color:#7F45B5' : 'rgba(111,127,140,.18);color:#4E5C68'}">${hill ? 'Bluff' : 'Either'}</span></div>
    <div class="muted" style="color:var(--ink);margin-top:6px">${hill ? 'A mound that hides the ground behind it (the mist). It plays as rough. Get within 2 tiles of what it hides and you\'ll see it for free, or scout it now.' : `A slope: a ball that lands or rolls onto it runs on ${spec ? '2 to 4 tiles' : 'a few tiles'} the way it falls. Which way it runs is hidden until you scout it.`}</div>
    <div class="muted" style="margin-top:6px">${f.owner === 'seed' ? 'Part of the course.' : `Left by ${esc(f.owner)}.`}</div>
    <div class="row" style="margin-top:10px"><button class="secondary" id="infoback">Back</button><button class="primary" style="margin-top:0" id="scoutbtn">Scout · 1 stroke</button></div>`);
  $('infoback').onclick = () => startAim();
  $('scoutbtn').onclick = () => {
    G.scout(round, features, f.id); persist();
    let what = '';
    if (hill) {
      const counts = {};
      for (const [x, y] of G.hiddenBy(f)) { const w = terrainWord[L.grid[y][x]]; if (w) counts[w] = (counts[w] || 0) + 1; }
      what = `Behind it: ${Object.keys(counts).sort((a, b) => counts[b] - counts[a]).join(', ') || 'nothing'}.`;
    } else {
      const [dx, dy] = G.ORIENT[f.dir || 0], u = [CUP[0] - f.x, CUP[1] - f.y], l = Math.hypot(...u) || 1, along = (dx * u[0] + dy * u[1]) / (l * Math.hypot(dx, dy));
      what = along > 0.4 ? 'It runs toward the hole.' : along < -0.4 ? 'It runs back toward the tee.' : 'It runs across the fairway.';
    }
    updateHidden();
    call('Scouted · +1 stroke', hill ? 'Suspicious hill' : 'Ramp', what, 2400);
    startAim();
  };
  requestAnimationFrame(() => framePlan([round.ball, [f.x, f.y], ...(hill ? G.hiddenBy(f) : [])], 0.6));
}

// ---------- the swing (and stroke) meter ----------
let meter = null;
const PERIOD = { driver: 1000, wood: 1100, long: 1250, short: 1400, wedge: 1600, putter: 1600 };
const timingAt = (m, now) => { const ph = ((((now - m.start) % m.period) + m.period) % m.period) / m.period; return ph < 0.5 ? -1 + 4 * ph : 3 - 4 * ph; };
function runMeter(k, title, onDone) {
  meter = { start: performance.now(), period: PERIOD[k] || 1300, onDone };
  showSheet(`<div class="row between"><span class="label">Early · ${k === 'putter' || k === 'chip' ? 'softer' : 'pulls left'}</span><span class="label">Late · ${k === 'putter' || k === 'chip' ? 'firmer' : 'pushes right'}</span></div>
    <div class="meter"><div class="tick" id="tick"></div></div>
    <div class="row between muted" style="margin-top:6px"><span>←</span><span>${esc(title)}</span><span>→</span></div>`);
  $('tap').classList.remove('hidden'); $('taphint').classList.remove('hidden');
}
function stopMeter() {
  if (!meter) return;
  const t = Math.round(timingAt(meter, performance.now()) * 100) / 100, done = meter.onDone;
  meter = null; $('tap').classList.add('hidden'); $('taphint').classList.add('hidden');
  done(t);
}
$('tap').onclick = (ev) => { ev.stopPropagation(); stopMeter(); };
const timingWord = (t) => { const a = Math.abs(t); return a < G.TIMING.perfect ? 'Pure' : a < G.TIMING.near ? (t < 0 ? 'A touch early' : 'A touch late') : t < 0 ? 'Way early' : 'Way late'; };

function startSwing() {
  const sel = spots.find((s) => s.dir === selDir);
  if (!sel) return;
  state = 'swing'; clearOverlay();
  const s2 = sel.a;
  addLine([[round.ball[0], round.ball[1]], [sel.r.pos[0], sel.r.pos[1]]], '#ffffff', true, 0.8, 0.06, 3, 0.4);
  runMeter(club, 'Green keeps your line', (timing) => playLong({ ...s2, timing }));
}

// ---------- the ball in flight (long game) ----------
let anim = null; // { t0, segs: [{ ms, at(s) -> { p:[x,z], y, o } }], done, follow }
function playLong(action) {
  const before = round.hole, from = round.ball.slice();
  const res = G.play(round, features, action); persist();
  const tr = res.trace || {};
  state = 'flight'; hideSheet(); longMat.map = texPlain; longMat.needsUpdate = true; clearOverlay();
  const lerp2 = (a, b, s) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
  const segs = [];
  if (tr.target) {
    const F = tr.from, Tg = tr.target, Dr = tr.drift || [0, 0], E0 = [Tg[0] - Dr[0], Tg[1] - Dr[1]];
    const full = Math.hypot(Tg[0] - F[0], Tg[1] - F[1]) || 1, Hh = Math.max(1, Math.min(6, (tr.carry || full) * 0.42));
    const ground = (s) => { const q = lerp2(F, E0, s); return [q[0] + Dr[0] * s * s, q[1] + Dr[1] * s * s]; };
    const land = tr.land || Tg, sEnd = tr.tree ? Math.min(1, Math.hypot(tr.tree[0] - F[0], tr.tree[1] - F[1]) / full) : Math.min(1, Math.hypot(land[0] - F[0], land[1] - F[1]) / full);
    const flightMs = (900 + 110 * full) * Math.max(0.4, sEnd);
    segs.push({ ms: flightMs, at: (s) => { const u = s * sEnd; return { p: ground(u), y: 4 * Hh * u * (1 - u) }; } });
    const contact = ground(sEnd);
    if (res.events.includes('out')) { segs.push({ ms: 300, at: (s) => ({ p: contact, y: 0, o: 1 - s }) }, { ms: 300, at: (s) => ({ p: from, y: 0, o: s }) }); }
    else if (tr.wet) { segs.push({ ms: 500, at: (s) => ({ p: tr.wet, y: -0.2 * s, o: 1 - s }) }, { ms: 350, at: (s) => ({ p: res.pos, y: 0, o: s }) }); }
    else {
      const pts = [contact]; if (tr.tree) pts.push(land); for (const q of tr.roll || []) pts.push(q);
      const end = res.holed ? CUP : res.pos; if (Math.hypot(end[0] - pts[pts.length - 1][0], end[1] - pts[pts.length - 1][1]) > 0.01) pts.push(end);
      const cum = [0]; for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      const len = cum[cum.length - 1];
      const along = (d) => { let k = 1; while (k < cum.length - 1 && cum[k] < d) k++; const f = (d - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1); return lerp2(pts[k - 1], pts[k], Math.max(0, Math.min(1, f))); };
      segs.push({ ms: Math.max(350, Math.min(1500, 260 * len + 300)), at: (s) => { const e = 1 - (1 - s) * (1 - s), d = e * len, f = len ? d / len : 1; return { p: len ? along(d) : contact, y: f < 0.3 ? 0.35 * Math.sin((Math.PI * f) / 0.3) : 0 }; } });
    }
  }
  // Follow from behind and above, along the line of the shot; at the end, swing round a little toward the hole.
  const dirV = new THREE.Vector3((tr.target || CUP)[0] - from[0], 0, (tr.target || CUP)[1] - from[1]).normalize();
  fovWant = FOV.cine;
  anim = { t0: performance.now(), segs, follow: dirV, done: () => afterLong(before, action, res) };
}
function afterLong(before, action, res) {
  anim = null;
  if (round.phase !== 'short') updateHidden();
  const Lb = believed(), lie = round.phase === 'short' ? null : Lb.grid[round.ball[1]][round.ball[0]];
  const dist = Math.hypot(round.ball[0] - CUP[0], round.ball[1] - CUP[1]);
  const where = res.holed ? 'In the hole!' : res.events.includes('water') ? 'In the water: drop beside it, +1' : res.events.includes('out') ? 'Out of bounds: play it again, +1' : round.phase === 'short' ? 'Onto the green area' : `Into ${terrainWord[lie] || 'play'}`.replace('Into the fairway', 'On the fairway').replace('Into the green', 'On the green');
  const legalNow = round.phase === 'short' ? [] : CLUB_KEYS.filter((k) => G.clubAllowed(Lb, round.ball, k));
  const suggest = legalNow.filter((k) => G.CLUBS[k].carry * 1.25 >= dist).slice(-2).reverse().map((k) => G.CLUBS[k].label.toLowerCase());
  call(timingWord(action.timing ?? 0), where, round.phase === 'short' || res.holed ? '' : `${yards(dist)} to the cup${suggest.length ? ` · ${suggest.join(' or ')} from here` : ''}`, 2000);
  setTimeout(() => {
    if (round.hole !== before) return holeDone();
    if (round.phase === 'short') return startShort();
    startAim();
  }, 1700);
}

// ---------- the short game ----------
let sSel = null, sSpin = '', readYaw = 0;
const sLie = () => S.grid[round.sball[1]][round.sball[0]];
// Which clubs the lie allows (the engine's rule): the putter on the green, fringe or light rough, the wedge anywhere off
// the green.
const sLegal = () => ({ putter: G.PUTT_LIES.includes(sLie()), wedge: sLie() !== 'G' });
let sClub = null;
function startShort() {
  if (!shortMesh) { buildShort(); shortMode = true; }
  marks.visible = true;
  sSel = null;
  if (G.isTapIn(S, round.sball)) return tapIn();
  state = 'short';
  renderShort(true);
}
function sBallW() { return sToW(round.sball[0], round.sball[1]); }
function sActionAt(tx, ty) {
  const b = round.sball, dx = tx - b[0], dy = ty - b[1], d = Math.hypot(dx, dy);
  if (!d) return null;
  const dir = ((Math.round(Math.atan2(-dy, dx) / ((2 * Math.PI) / G.SDIR)) % G.SDIR) + G.SDIR) % G.SDIR;
  const putter = sClub === 'putter';
  if (putter) return tx === SC && ty === SC ? { club: 'putter', dir: 'cup', pace: Math.max(1, Math.min(G.PUTT_MAX, Math.ceil(d))), target: [tx, ty] } : { club: 'putter', dir, pace: Math.max(1, Math.min(G.PUTT_MAX, Math.round(d))), target: [tx, ty] };
  const carry = G.CHIP_CARRIES.reduce((a, c) => (Math.abs(c - d) < Math.abs(a - d) ? c : a), G.CHIP_CARRIES[0]);
  return { club: 'wedge', dir, carry, target: [tx, ty], ...(sSpin ? { spin: sSpin } : {}) };
}
function renderShort(reframe) {
  const [bx, bz] = sBallW(); placeBall(bx, bz);
  const dCup = Math.hypot(round.sball[0] - SC, round.sball[1] - SC);
  topChips([`Hole ${holeIdx + 1} · Stroke ${strokes() + 1}`], [`${'GF'.includes(sLie()) ? (sLie() === 'G' ? 'On the green' : 'On the fringe') : 'Off the green'} · ${Math.round(dCup * FT)} ft to the cup`]);
  clearOverlay();
  let r = null;
  if (sSel) {
    r = G.shortShot(S, round.sball, sSel, true);
    const tg = sSel.target || (r.holed ? [SC, SC] : r.pos), [tx, tz] = sToW(tg[0], tg[1]);
    addLine([[bx, bz], [tx, tz]], '#F2B52E', false, 1, 0.05, 5);
    addDot(tx, tz, 0.07, '#F2B52E');
    const path = (r.path || []).map(([x, y]) => sToW(x, y));
    if (path.length > 1) addLine(path, '#ffffff', true, 0.95, 0.07, 4, 0.14);
    const end = r.holed ? [CUP[0], CUP[1]] : sToW(r.pos[0], r.pos[1]);
    addRing(end[0], end[1], 0.09, 0.14, r.holed ? '#F2B52E' : '#ffffff');
  }
  explain(sSel ? G.explainShort(sSel, r) : '');
  const lg = sLegal();
  if (!sClub || !lg[sClub]) sClub = lg.putter ? 'putter' : 'wedge';
  const putt = sClub === 'putter';
  const v = sSel ? (putt ? sSel.pace : sSel.carry) : null;
  const gauge = putt ? `<div class="gauge">${Array.from({ length: G.PUTT_MAX }, (_, i) => `<i class="${v && i < v ? (i === v - 1 ? 'cap' : 'on') : ''}"></i>`).join('')}</div>` : '';
  showSheet(`<div class="row between" style="margin-bottom:8px"><div class="seg"><button class="${putt ? 'on' : ''}" data-sclub="putter" ${lg.putter ? '' : 'disabled title="Putt from the green or fringe"'}>Putter</button><button class="${!putt ? 'on' : ''}" data-sclub="wedge" ${lg.wedge ? '' : 'disabled title="On the green, putt"'}>Wedge</button></div>
      <div class="seg"><button class="${heights ? 'on' : ''}" id="heights">Heights</button></div></div>
    ${!lg.wedge ? '<div class="muted" style="margin:-2px 0 8px">On the green you putt; the wedge is for chipping from off it.</div>' : ''}
    ${!lg.putter ? '<div class="muted" style="margin:-2px 0 8px">From here you chip; the putter is for the green, fringe and light rough.</div>' : ''}
    ${sSel ? '' : `<div class="muted" style="color:var(--ink);margin-bottom:8px">${putt ? 'Tap where to aim on the green. Gold is your aim; white is where the ball really rolls. Tap the cup to putt straight at it.' : 'Tap where to land the chip. Gold is your aim; white is where it rolls after.'}</div>`}
    ${!putt ? `<div class="row" style="margin-bottom:8px"><span class="label" style="margin-right:4px">Spin</span><div class="seg">${[['', 'None'], ['back', 'Back'], ['top', 'Top']].map(([k, l]) => `<button class="${k === sSpin ? 'on' : ''}" data-spin="${k}">${l}</button>`).join('')}</div></div>` : ''}
    <div class="row between"><button class="pill" id="softer" ${sSel ? '' : 'disabled'}>− ${putt ? 'Softer' : 'Shorter'}</button>
      <div style="text-align:center"><div class="num" style="font-size:30px;line-height:1">${v ?? '–'}</div><div class="label">${putt ? 'pace' : 'carry'}</div></div>
      <button class="pill" id="firmer" ${sSel ? '' : 'disabled'}>${putt ? 'Firmer' : 'Longer'} +</button></div>
    ${gauge}
    <div class="row" style="margin-top:10px"><button class="round" id="read" ${putt ? '' : 'disabled'}>Read<br>putt</button><button class="primary" style="margin-top:0" id="hit" ${sSel ? '' : 'disabled'}>${putt ? 'Putt' : 'Chip'}</button></div>`);
  const bump = (k) => { if (sSel.club === 'putter') sSel = { ...sSel, pace: Math.max(1, Math.min(G.PUTT_MAX, sSel.pace + k)) }; else { const i = G.CHIP_CARRIES.indexOf(sSel.carry); sSel = { ...sSel, carry: G.CHIP_CARRIES[Math.max(0, Math.min(G.CHIP_CARRIES.length - 1, i + k))] }; } renderShort(false); };
  $('softer').onclick = () => sSel && bump(-1); $('firmer').onclick = () => sSel && bump(1);
  $('hit').onclick = () => sSel && startStroke();
  $('read').onclick = () => startRead();
  for (const el of body.querySelectorAll('[data-sclub]')) el.onclick = () => { if (el.disabled) return; sClub = el.dataset.sclub; sSel = null; renderShort(false); };
  $('heights').onclick = () => { heights = !heights; shortMesh.material.map = heights ? shortTexHeights : shortTexPlain; shortMesh.material.needsUpdate = true; renderShort(false); };
  for (const el of body.querySelectorAll('[data-spin]')) el.onclick = () => { sSpin = el.dataset.spin; if (sSel) { const { spin, ...rest } = sSel; sSel = sSpin ? { ...rest, spin: sSpin } : rest; } renderShort(false); };
  if (reframe) {
    const pts = [[bx, bz], CUP];
    requestAnimationFrame(() => framePlan(pts.map(([x, z]) => [x, z]).concat([[CUP[0] - 1.5, CUP[1] - 1.5], [CUP[0] + 1.5, CUP[1] + 1.5]]), 0.7));
  }
}
function tapShort(point) {
  const [sx, sy] = wToS(point.x, point.z), tx = Math.round(sx), ty = Math.round(sy);
  if (tx < 0 || ty < 0 || tx >= SN || ty >= SN) return;
  const a = sActionAt(tx, ty); if (!a) return;
  sSel = a; renderShort(false);
}
function startStroke() {
  const a = sSel; if (!a) return;
  state = 'stroke'; explain('');
  runMeter(a.club === 'putter' ? 'putter' : 'chip', 'Green strikes it as chosen', (timing) => playShort({ ...a, timing }));
}
function playShort(action) {
  const before = round.hole, from = round.sball.slice();
  const { target, ...a } = action;
  const struck = G.shortStruck(a, a.timing);
  const pre = G.shortShot(S, from, struck, true);
  const res = G.play(round, features, a); persist();
  state = 'roll'; hideSheet(); clearOverlay(); explain('');
  const pts = (pre.path || [from]).map(([x, y]) => sToW(x, y));
  if (res.holed) pts.push([CUP[0], CUP[1]]);
  const cum = [0]; for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const len = cum[cum.length - 1] || 0.001;
  const along = (d) => { let k = 1; while (k < cum.length - 1 && cum[k] < d) k++; const f = (d - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1); return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * f, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * f]; };
  const chip = a.club === 'wedge', segs = [];
  if (chip && pts.length > 1) { const l1 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]); segs.push({ ms: 500 + 120 * l1, at: (s) => ({ p: [pts[0][0] + (pts[1][0] - pts[0][0]) * s, pts[0][1] + (pts[1][1] - pts[0][1]) * s], y: 4 * Math.max(0.6, l1 * 0.35) * s * (1 - s) }) }); }
  const start = chip && pts.length > 1 ? cum[1] : 0;
  segs.push({ ms: Math.min(3200, 700 + 420 * (len - start)), at: (s) => { const e = 1 - (1 - s) * (1 - s); return { p: along(start + e * (len - start)), y: 0 }; } });
  if (res.holed) segs.push({ ms: 300, at: (s) => ({ p: [CUP[0], CUP[1]], y: -0.15 * s, o: 1 - s }) });
  else if (res.events.includes('water')) segs.push({ ms: 400, at: (s) => ({ p: pts[pts.length - 1], y: -0.2 * s, o: 1 - s }) });
  // A low camera behind the ball, turning with it toward the hole.
  const [bx, bz] = sToW(from[0], from[1]);
  const dirV = new THREE.Vector3(CUP[0] - bx, 0, CUP[1] - bz).normalize();
  fovWant = FOV.cine;
  anim = { t0: performance.now(), segs, follow: dirV, low: true, done: () => {
    anim = null;
    if (res.holed) call('', 'In the hole!', '', 1500);
    else call('', inFeet(G.explainShort(struck, pre)).split(':')[0], '', 1500);
    setTimeout(() => { if (round.hole !== before) holeDone(); else startShort(); }, res.holed ? 1300 : 1500);
  } };
}
function tapIn() {
  state = 'tapin'; clearOverlay(); explain('');
  const [bx, bz] = sBallW(); placeBall(bx, bz);
  topChips([`Hole ${holeIdx + 1} · Stroke ${strokes() + 1}`], ['Touching the cup']);
  requestAnimationFrame(() => framePlan([[bx, bz], CUP, [CUP[0] - 1, CUP[1] - 1], [CUP[0] + 1, CUP[1] + 1]], 0.6));
  showSheet(`<div class="h2">Tap it in</div><div class="muted" style="margin-top:4px">No meter for this one. It counts as a stroke.</div><button class="primary" id="tapin">Tap in · finish the hole</button>`);
  $('tapin').onclick = () => { sSel = { club: 'putter', dir: 'cup', pace: 1 }; playShort({ club: 'putter', dir: 'cup', pace: 1, timing: 0 }); };
}

// ---------- reading a putt (cinematic) ----------
function slopeWords() {
  const [sx, sy] = round.sball, d = [SC - sx, SC - sy], len = Math.hypot(...d) || 1, u = [d[0] / len, d[1] / len], right = [-u[1], u[0]];
  const up = S.h[SC][SC] - S.h[sy][sx];
  const m = [sx + d[0] / 2, sy + d[1] / 2], k = Math.min(3, len / 3);
  const lr = (S.h[Math.round(Math.max(0, Math.min(SN - 1, m[1] + right[1] * k)))][Math.round(Math.max(0, Math.min(SN - 1, m[0] + right[0] * k)))] - S.h[Math.round(Math.max(0, Math.min(SN - 1, m[1] - right[1] * k)))][Math.round(Math.max(0, Math.min(SN - 1, m[0] - right[0] * k)))]);
  const falls = Math.abs(lr) < 0.01 ? 'The line is fairly flat side to side' : `The green falls away to the ${lr < 0 ? 'right' : 'left'}${Math.abs(lr) > 0.05 ? ', sharply' : ''}`;
  const hill = Math.abs(up) < 0.01 ? 'and it\'s about level to the hole.' : up > 0 ? `and it's ${up > 0.05 ? 'uphill' : 'slightly uphill'} to the hole.` : `and it's ${up < -0.05 ? 'downhill' : 'slightly downhill'} to the hole.`;
  return `${falls}, ${hill}`;
}
function placeReadCam(dur) {
  const [bx, bz] = sBallW(), base = Math.atan2(CUP[1] - bz, CUP[0] - bx) + readYaw;
  const dist = Math.min(5, 2.6 + Math.hypot(CUP[0] - bx, CUP[1] - bz) * 0.3);
  const pos = new THREE.Vector3(bx - Math.cos(base) * dist, hShort(bx, bz) + 1.5, bz - Math.sin(base) * dist);
  // Look at a point a little past halfway to the cup, so the whole line from the ball to the hole is in view.
  const lx = bx + (CUP[0] - bx) * 0.6, lz = bz + (CUP[1] - bz) * 0.6;
  const look = new THREE.Vector3(lx, hShort(lx, lz), lz);
  fovWant = FOV.cine;
  moveCam(pos, look, dur, 0);
}
function startRead() {
  state = 'read'; readYaw = 0; hideSheet(); explain('');
  topChips(['Reading the putt'], []);
  $('top').insertAdjacentHTML('beforeend', '<button class="chip" id="backaim">Back to aim</button>');
  $('backaim').onclick = () => { caddyHide(); state = 'short'; renderShort(true); };
  caddySay(`${slopeWords()} Drag to look round the line.`);
  placeReadCam(0.8);
}

// ---------- hole done ----------
function holeDone() {
  state = 'done'; hideSheet(); caddyHide(); explain('');
  const n = round.strokes[holeIdx], diff = n - par;
  const name = { '-3': 'Albatross', '-2': 'Eagle', '-1': 'Birdie', 0: 'Par', 1: 'Bogey', 2: 'Double bogey' }[diff] || (diff > 0 ? `+${diff}` : `${diff}`);
  const shots = round.log.filter((l) => l.hole === holeIdx && !/Onto the short game/.test(l.text));
  // What each earlier golfer's feature did to this round (the engine's credit: beyond what the best line also suffers).
  const credit = features.length ? G.credit(course, features, round) : [];
  const fx = features.filter((f) => f.owner !== 'seed').map((f) => {
    const c = credit.find((q) => q.feature === f.id) || { harm: 0, aid: 0 };
    const what = c.harm ? `cost you ${c.harm} stroke${c.harm > 1 ? 's' : ''}` : c.aid ? `saved you ${c.aid} stroke${c.aid > 1 ? 's' : ''}` : 'made no difference';
    return `<div class="shotline"><span><span class="tag-dot" style="background:${KIND_COL[G.FEATURES[f.kind].kind]}"></span>${esc(f.owner)}'s ${esc(G.FEATURES[f.kind].label.toLowerCase())}</span><span class="muted">${what}</span></div>`;
  });
  $('done').innerHTML = `<div class="label">Hole ${holeIdx + 1} · Par ${par}</div>
    <div style="text-align:center;margin-top:18px"><div class="title" style="font-size:72px">${n}</div><span class="chip dark" style="font-size:15px">${esc(name)}${diff ? ` · ${diff > 0 ? '+' : ''}${diff}` : ''}</span></div>
    <div class="card">${shots.map((l, i) => `<div class="shotline"><span>${esc(l.text)}</span><span class="num">${i + 1}</span></div>`).join('')}</div>
    ${fx.length ? `<div class="card"><div class="label" style="margin-bottom:4px">Left by golfers before you</div>${fx.join('')}</div>` : ''}
    ${practice ? `<button class="primary" id="leaveit">${holeIdx < 2 ? `On to hole ${holeIdx + 2}` : 'See your card'}</button>` : `<button class="primary" id="shapeit">Shape this hole for the next golfer</button>
    <button class="secondary" style="width:100%;margin-top:10px" id="leaveit">Leave it as it is${holeIdx < 2 ? `, on to hole ${holeIdx + 2}` : ', finish the round'}</button>`}
    <a class="secondary" style="display:block;width:100%;margin-top:10px;text-align:center;line-height:56px;text-decoration:none;color:var(--ink)" href="home.html">Home (the round waits)</a>
    <div class="muted" style="margin-top:14px;text-align:center">${esc(courseName)} · course ${courseNo} · hole ${holeIdx + 1}</div>`;
  $('done').classList.remove('hidden');
  if ($('shapeit')) $('shapeit').onclick = () => { $('done').classList.add('hidden'); startDesign(); };
  $('leaveit').onclick = () => handOver(null);
}

// ---------- shaping the hole for the next golfer ----------
// One feature, paid for in strokes on your card. Tiles where the selected feature may go are lit (the engine's
// placement rules, quick form); tap one to place it (a fairway bank or trees: four connected tiles, one at a time; a
// backstop: tap the side of the green to guard); turn it; Keep it runs the full check (the hole must stay playable).
const design = { kind: 'bunker', shape: {}, dir: 0, draft: null, picks4: [] };
const designGroup = new THREE.Group(); scene.add(designGroup);
const KIND_WORD = { harm: 'Harm', boon: 'Boon', bluff: 'Bluff', either: 'Either' };
function shapeKey(kind) { const s = G.SHAPES[kind]; if (!s || G.FEATURES[kind].free4) return null; return design.shape[kind] || Object.keys(s)[0]; }
function candidate(x, y) {
  const k = design.kind, f = { id: `p${holeIdx}`, owner: round.golfer, hole: holeIdx, kind: k, x, y, dir: design.dir, age: 0 };
  const sk = shapeKey(k); if (sk) f.shape = sk;
  return f;
}
function draftTiles(f) { return f.kind === 'wind' ? G.windCone(f) : G.footprint(f); }
const turnable = (k) => !!G.FEATURES[k].oriented;
function litTiles() {
  const k = design.kind, spec = G.FEATURES[k], out = [];
  const taken = new Set(); for (const f of RS.faced) if (f.hole === holeIdx && !G.FEATURES[f.kind].area) for (const [x, y] of G.footprint(f)) taken.add(`${x},${y}`);
  if (spec.side) { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (hole.grid[y][x] === 'G' && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => (hole.grid[y + dy] || '')[x + dx] !== 'G')) out.push([x, y]); return out; }
  if (spec.free4) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!spec.on.includes(hole.grid[y][x]) || taken.has(`${x},${y}`) || Math.hypot(x - CUP[0], y - CUP[1]) <= G.ZONE_R) continue;
      if (design.picks4.some((q) => q[0] === x && q[1] === y)) continue;
      if (design.picks4.length && !design.picks4.some((q) => Math.max(Math.abs(q[0] - x), Math.abs(q[1] - y)) === 1)) continue;
      out.push([x, y]);
    }
    return out;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!G.placementError(course, RS.faced, candidate(x, y), true)) out.push([x, y]);
  return out;
}
function startDesign() {
  state = 'design'; caddyHide(); explain(''); clearOverlay();
  longMat.map = texGrid; longMat.needsUpdate = true;
  if (shortMesh) { shortMesh.visible = false; shortMode = false; const lp = longGeo.attributes.position; for (let i = 0; i < lp.count; i++) lp.setY(i, longH[i]); lp.needsUpdate = true; longGeo.computeVertexNormals(); }
  breakArrows && (breakArrows.visible = false);
  ball.visible = false; shadow.visible = false;
  renderDesign(true);
}
function renderDesign(reframe) {
  for (const o of [...designGroup.children]) designGroup.remove(o);
  const k = design.kind, spec = G.FEATURES[k], f = design.draft;
  for (const [x, y] of litTiles()) tintTile(x, y, '#F2B52E', f ? 0.12 : 0.24, designGroup, 0.03);
  for (const [x, y] of design.picks4) tintTile(x, y, KIND_COL[spec.kind], 0.8, designGroup, 0.05);
  if (f) {
    for (const [x, y] of draftTiles(f)) tintTile(x, y, KIND_COL[spec.kind], 0.72, designGroup, 0.05);
    if (k === 'hill') for (const [x, y] of G.hiddenBy(f)) tintTile(x, y, '#A66BD9', 0.3, designGroup, 0.05);
  }
  const cost = f ? G.costOf(f) : 0, card = round.strokes.reduce((a, b) => a + b, 0) + RS.picks.reduce((a, q) => a + (q ? G.costOf(q) : 0), 0);
  topChips([`Shaping hole ${holeIdx + 1}`], [`Your card: ${card}${f ? ` → ${card + cost}` : ''}`]);
  const cards = Object.entries(G.FEATURES).map(([key, s]) => `<button class="fcard ${key === k ? 'on' : ''}" data-kind="${key}"><span class="fsw" style="background:${KIND_COL[s.kind]}"></span><b>${esc(s.label)}</b><span class="ftag" style="color:${KIND_COL[s.kind]}">${KIND_WORD[s.kind]}</span><span class="fcost">${s.cost ? `${s.cost} stroke${s.cost > 1 ? 's' : ''}` : 'free'}</span></button>`).join('');
  const sk = shapeKey(k), shapes = sk ? Object.entries(G.SHAPES[k]).map(([key, s]) => `<button class="${key === sk ? 'on' : ''}" data-fshape="${key}">${esc(s.label)}${s.cost ? ` +${s.cost}` : ''}</button>`).join('') : '';
  const how = spec.side ? 'Tap the side of the green to guard.' : spec.free4 ? `Tap 4 connected tiles, one at a time (${design.picks4.length} of 4).` : 'Tap a lit tile to place it.';
  showSheet(`<div class="h2">Shape this hole for the next golfer</div>
    <div class="muted" style="margin-top:2px">Leave one feature. It's paid for in strokes on your card.</div>
    <div class="fcards">${cards}</div>
    <div class="muted" style="color:var(--ink);font-size:13px">${esc(spec.desc)}</div>
    <div class="row" style="margin-top:8px">${shapes ? `<div class="seg">${shapes}</div>` : ''}${turnable(k) ? '<button class="secondary" style="height:40px;padding:0 14px" id="turn">↻ Turn</button>' : ''}<span class="muted" style="font-size:13px">${esc(how)}</span></div>
    <div class="err" id="derr" style="color:var(--harm);font-size:13px;min-height:1em;margin-top:4px"></div>
    <div class="row"><button class="secondary" id="dnone">Leave nothing</button><button class="primary" style="margin-top:0" id="dkeep" ${f ? '' : 'disabled'}>Keep it, ${holeIdx < 2 ? `on to hole ${holeIdx + 2}` : 'finish the round'}</button></div>`);
  for (const el of body.querySelectorAll('[data-kind]')) el.onclick = () => { design.kind = el.dataset.kind; design.draft = null; design.picks4 = []; design.dir = 0; renderDesign(false); };
  for (const el of body.querySelectorAll('[data-fshape]')) el.onclick = () => { design.shape[k] = el.dataset.fshape; design.draft = null; renderDesign(false); };
  if ($('turn')) $('turn').onclick = () => { const n = G.FEATURES[k].oriented === 'dir' ? 8 : 4; design.dir = (design.dir + 1) % n; if (design.draft) { const d = { ...design.draft, dir: design.dir }; design.draft = G.placementError(course, RS.faced, d, true) ? null : d; } renderDesign(false); };
  $('dnone').onclick = () => handOver(null);
  $('dkeep').onclick = () => {
    const err = G.placementError(course, RS.faced, design.draft);
    if (err) { $('derr').textContent = err; return; }
    handOver(design.draft);
  };
  if (reframe) requestAnimationFrame(() => framePlan([TEE, CUP, [CUP[0] - 3, CUP[1] - 3], [CUP[0] + 3, CUP[1] + 3]], 0.7));
}
function tapDesign(point) {
  const x = Math.round(point.x), y = Math.round(point.z), k = design.kind, spec = G.FEATURES[k];
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  let f = null;
  if (spec.side) {
    // The side of the green: the nearest of eight directions from the cup to the tap.
    const a = Math.atan2(-(y - CUP[1]), x - CUP[0]), side = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
    f = { id: `p${holeIdx}`, owner: round.golfer, hole: holeIdx, kind: 'backstop', side, x: CUP[0], y: CUP[1], dir: 0, age: 0 };
  } else if (spec.free4) {
    const i = design.picks4.findIndex((q) => q[0] === x && q[1] === y);
    if (i >= 0) { design.picks4.splice(i, 1); design.draft = null; return renderDesign(false); }
    if (!litTiles().some((q) => q[0] === x && q[1] === y)) return;
    design.picks4.push([x, y]);
    if (design.picks4.length < 4) { design.draft = null; return renderDesign(false); }
    const tiles = design.picks4.slice();
    f = { id: `p${holeIdx}`, owner: round.golfer, hole: holeIdx, kind: k, tiles, x: tiles[0][0], y: tiles[0][1], dir: 0, age: 0 };
    design.picks4 = [];
  } else f = candidate(x, y);
  const err = G.placementError(course, RS.faced, f, true);
  if (err) { design.draft = null; renderDesign(false); $('derr').textContent = err; return; }
  design.draft = f; renderDesign(false);
}
// Hand over the hole: your pick (if any) is held with the round and joins the chain when the round ends, as in
// play.html (so you never face your own features). Then the next hole, or after hole 3 the round's result.
function handOver(f) {
  RS.picks[holeIdx] = f ? { ...f, age: 0 } : null;
  persist();
  if (round.done) { C.finishRound(courseId, RS); location.href = `home.html?view=result&course=${courseNo}`; }
  else location.href = `app.html?course=${courseNo}${practice ? '&practice=1' : ''}`;
}

// ---------- input: taps and (in the putt read) drags ----------
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let down = null;
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, yaw: readYaw }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!down || state !== 'read') return;
  readYaw = down.yaw - (e.clientX - down.x) * 0.008; placeReadCam(0);
});
canvas.addEventListener('pointerup', (e) => {
  const d = down; down = null;
  if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) return;
  if (meter) return stopMeter();
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (state === 'aim' || state === 'info') {
    const s = ray.intersectObjects(marks.children.filter((o) => o.isSprite))[0];
    if (s) return showHidden(s.object.userData.feature);
    if (state === 'info') return startAim();
  }
  const hit = ray.intersectObjects([shortMode ? shortMesh : longMesh].filter(Boolean))[0];
  if (!hit) return;
  if (state === 'aim') tapAim(hit.point);
  else if (state === 'short') tapShort(hit.point);
  else if (state === 'design') tapDesign(hit.point);
});
document.addEventListener('keydown', (e) => { if (meter && (e.code === 'Space' || e.key === ' ')) { e.preventDefault(); stopMeter(); } });

// ---------- the loop ----------
function resize() {
  const r = phone.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
  for (const m of fatMats) m.resolution.set(r.width, r.height);
}
window.addEventListener('resize', () => { resize(); if (state === 'aim') renderAim(true); else if (state === 'short') renderShort(true); });
function frame(now) {
  if (meter) { const t = timingAt(meter, now), tick = $('tick'); if (tick) tick.style.left = `${(t + 1) * 50}%`; }
  if (anim) {
    let el = now - anim.t0, st = null;
    for (const sg of anim.segs) { if (el <= sg.ms) { st = sg.at(Math.max(0, el / sg.ms)); break; } el -= sg.ms; }
    if (!st) { const last = anim.segs[anim.segs.length - 1]; if (last) st = last.at(1); const done = anim.done; anim.done = null; if (st) placeBall(st.p[0], st.p[1], st.y); ball.material.opacity = 1; if (done) done(); }
    else {
      placeBall(st.p[0], st.p[1], st.y);
      ball.material.transparent = st.o != null; ball.material.opacity = st.o ?? 1;
      // The follow camera: behind the ball along its line, higher for long shots, low for putts.
      const f = anim.follow, back = anim.low ? 2.2 : 6.5, up = anim.low ? 0.9 : 3.2;
      const want = new THREE.Vector3(ball.position.x - f.x * back, ball.position.y + up, ball.position.z - f.z * back);
      cam.to = null; viewOffset = 0;
      cam.pos.lerp(want, 0.08); cam.look.lerp(ball.position.clone().addScaledVector(f, anim.low ? 1.5 : 3), 0.12);
    }
  }
  if (fly && state === 'flyover') fly(now);
  updateCamera(now);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
resize();
placeBall(TEE[0], TEE[1]);
requestAnimationFrame(frame);
if (round.strokes[holeIdx] === 0 && round.phase === 'long' && round.ball[0] === hole.tee[0] && round.ball[1] === hole.tee[1]) flyover();
else if (round.phase === 'short') { fovWant = FOV.plan; startShort(); }
else { fovWant = FOV.plan; startAim(); }
window.__app = { round, camera, cam, get viewOffset() { return viewOffset; }, get state() { return state; }, G, course, hole, stopMeter, tapAt: (x, z) => (state === 'aim' ? tapAim({ x, z }) : state === 'short' ? tapShort({ x, z }) : state === 'design' ? tapDesign({ x, z }) : null), get spots() { return spots; }, get sSel() { return sSel; } }; // (for tests)
