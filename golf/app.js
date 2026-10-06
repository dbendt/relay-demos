// Relay Golf, stage 2: the one-hole prototype. A 3D scene built from the engine's grid (golf-sim.js stays the only
// authority: it decides every shot; this page only draws its layouts and replays its traces), seen through a fixed-angle
// plan camera that frames each shot, and a cinematic camera for the flyover, the ball in flight and reading putts.
//   app.html?course=4&hole=1
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { createDiorama, DEFAULTS as LOOK_DEFAULTS, TIMES, WEATHER, TOP_LAYER } from './diorama.js';
import { courseSky } from './sky.js';
import { holeBoard, EX } from './board.js';

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

// ---------- crash log (for phones, where a crash leaves no console) ----------
// Each step of loading and play, any error, a lost WebGL context, and every 2 s the frame rate, worst frame and GPU
// counts are written to localStorage as they happen, so the steps before a crash survive it. ?debug=1 shows the
// previous session's log (and this one's, live) in a box that can be copied. ?q=low (remembered) draws less.
const CRASH = 'relay-golf-crashlog';
const crashLog = (() => {
  let prev = [], cur = [];
  try { prev = JSON.parse(localStorage.getItem(CRASH) || '[]'); localStorage.setItem(CRASH + ':prev', JSON.stringify(prev)); } catch { /* no storage */ }
  const t0 = performance.now();
  const note = (msg) => {
    cur.push(`${((performance.now() - t0) / 1000).toFixed(1)}s ${msg}`); if (cur.length > 80) cur.shift();
    try { localStorage.setItem(CRASH, JSON.stringify(cur)); } catch { /* full */ }
    if (box) box.textContent = `PREVIOUS SESSION\n${prev.join('\n') || '(none)'}\n\nTHIS SESSION\n${cur.join('\n')}`;
  };
  let box = null;
  if (qs.get('debug') === '1') {
    box = document.createElement('pre');
    box.style.cssText = 'position:fixed;left:4px;right:4px;top:4px;max-height:45vh;overflow:auto;z-index:999;margin:0;padding:6px;background:rgba(0,0,0,.8);color:#9f9;font:10px/1.3 monospace;white-space:pre-wrap;user-select:text;-webkit-user-select:text';
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(box)); if (document.body) document.body.appendChild(box);
  }
  addEventListener('error', (e) => note(`ERROR ${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`));
  addEventListener('unhandledrejection', (e) => note(`REJECT ${e.reason && (e.reason.message || e.reason)}`));
  addEventListener('pagehide', () => note('pagehide'));
  document.addEventListener('visibilitychange', () => note(`visibility ${document.visibilityState}`));
  note(`boot ${location.search} ${innerWidth}x${innerHeight} dpr ${devicePixelRatio} ${navigator.userAgent.replace(/.*\((.*?)\).*/, '$1')}`);
  return note;
})();
// Quality: ?q=low or ?q=high, remembered on this device (?q=auto forgets it).
const QUALITY = (() => {
  let q = qs.get('q');
  try { if (q === 'auto') { localStorage.removeItem('relay-golf-q'); q = null; } else if (q) localStorage.setItem('relay-golf-q', q); else q = localStorage.getItem('relay-golf-q'); } catch { /* no storage */ }
  return q === 'low' ? 'low' : q === 'high' ? 'high' : 'auto';
})();
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

// ---------- the board (board.js): the short-game map round the cup, the forest ring, display-only trees ----------
const B = holeBoard(G, hole, features);
const { S, SN, SC, SCALE, hCupS, sToW, wToS, shortRel, DECOR, isDecor, FOREST } = B;

// ---------- renderer, scene, the diorama ----------
// The course is drawn by diorama.js (the look tuned in look.html): the long map's grid becomes the board, with the
// tee as its own type and planted trees (P) as trees. Time of day and weather from ?time= and ?weather= (the
// presets in diorama.js), noon and clear by default. Phones get a lighter build (fewer samples, fewer fur shells).
const phone = $('phone'), canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(QUALITY === 'low' ? 1 : Math.min(2, window.devicePixelRatio || 1));
renderer.info.autoReset = false; // (the crash log counts a whole frame's passes: reset in frame())
canvas.addEventListener('webglcontextlost', () => crashLog('WEBGL CONTEXT LOST'));
canvas.addEventListener('webglcontextrestored', () => crashLog('webgl context restored'));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 300);
// The course's seed picks its time of day and weather (sky.js); ?time= and ?weather= override it for testing.
const SKY = courseSky(courseId, { time: qs.get('time'), weather: qs.get('weather') });
const look = { ...LOOK_DEFAULTS };
Object.assign(look, TIMES[SKY.time]); WEATHER[SKY.weather](look);
const lowEnd = QUALITY === 'auto' ? window.matchMedia('(pointer: coarse)').matches : QUALITY === 'low';
if (lowEnd) Object.assign(look, { shells: Math.min(look.shells, 5), fogSteps: Math.min(look.fogSteps, 6) });
if (QUALITY === 'low') Object.assign(look, { shells: 0, fogSteps: 4, cards: 0 });
crashLog(`quality ${QUALITY}${lowEnd ? ' (low-end build)' : ''}, ${SKY.time} ${SKY.weather}`);
const dio = createDiorama({
  renderer, scene, settings: look, origin: [-0.5 - FOREST, -0.5 - FOREST], quality: QUALITY === 'low' ? { sub: 5, px: 14, shadow: 1024, canopy: 1, fuzzShells: 0 } : lowEnd ? { sub: 6, px: 24, shadow: 2048, canopy: 2, fuzzShells: 1 } : { sub: 8, px: 32, shadow: 4096, canopy: 3, fuzzShells: 2 },
  map: B.map,
});
crashLog('building the board');
dio.build();
crashLog('board built');

// ---------- the long map (drawn by the diorama); the soft-tile painter the short map still uses ----------
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
// The long map's ground height (tile centres on whole numbers), from the board.
const hLong = (x, z) => dio.heightAt(x, z);

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
// Golfers' features that don't change the ground: wind cones and calm patches as tinted tiles (wind with arrows its
// way), backstops and fairway banks as low banks. (Bunkers, water and trees change the ground itself; hills and ramps
// are drawn with the hidden things below.)
const KIND_COL = { harm: '#E8604C', boon: '#4C9BE8', bluff: '#A66BD9', either: '#6F7F8C' };
const decor = new THREE.Group(); scene.add(decor);
const tileGeo = new THREE.PlaneGeometry(0.92, 0.92); tileGeo.rotateX(-Math.PI / 2);
function tintTile(x, y, color, opacity, group = decor, lift = 0.035) { const m = new THREE.Mesh(tileGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })); m.position.set(x, hLong(x, y) + lift, y); m.renderOrder = 2; group.add(m); return m; }
// Golfers' features that change the air or hold a ball, drawn to match the board:
// - Wind gusts: white streaks gliding above the course along the gust, each curling at its tail and fading out,
//   staggered so the air reads as moving.
// - Calm patches: slow rings spreading and fading, like air settling.
// - Backstops and fairway banks (boons that hold a ball): translucent sky-blue glass cushions, brighter at the rim
//   where you see them edge-on, with a soft shine sweeping across.
const decorTime = { value: 0 };
const BOON = new THREE.Color(KIND_COL.boon);
// A ribbon along a path in the ground plane (x along, z across), width tapering toward the curl; u runs 0..1 along it.
function streakGeometry(len, curl) {
  const pts = [];
  for (let i = 0; i <= 24; i++) pts.push([-len / 2 + (len * 0.75 * i) / 24, 0]);
  const cx = -len / 2 + len * 0.75, r = curl;
  for (let i = 1; i <= 20; i++) { const a = -Math.PI / 2 + (i / 20) * Math.PI * 1.35; pts.push([cx + Math.cos(a) * r, -r - Math.sin(a) * r]); }
  let total = 0; const acc = [0]; for (let i = 1; i < pts.length; i++) { total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); acc.push(total); }
  const pos = [], uv = [], idx = [];
  pts.forEach((p, i) => {
    const q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)], dx = q[0] - o[0], dz = q[1] - o[1], l = Math.hypot(dx, dz) || 1, u = acc[i] / total;
    const w = 0.055 * (1 - 0.6 * u);
    pos.push(p[0] - (dz / l) * w, 0, p[1] + (dx / l) * w, p[0] + (dz / l) * w, 0, p[1] - (dx / l) * w); uv.push(u, 0, u, 1);
    if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  return g;
}
const streakMat = (phase, speed) => new THREE.ShaderMaterial({
  uniforms: { uTime: decorTime, uPhase: { value: phase }, uSpeed: { value: speed } }, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  // A bright head travels along the ribbon with a fading tail behind it; the whole streak fades as it curls away.
  fragmentShader: `uniform float uTime, uPhase, uSpeed; varying vec2 vUv;
    void main() {
      float h = fract(uTime * uSpeed + uPhase) * 1.45 - 0.15, u = vUv.x;
      float tail = smoothstep(h - 0.45, h - 0.05, u) * (1.0 - smoothstep(h - 0.01, h + 0.01, u));
      float edge = 1.0 - pow(abs(vUv.y - 0.5) * 2.0, 3.0);
      float life = 1.0 - smoothstep(0.7, 1.0, h);
      gl_FragColor = vec4(vec3(1.0), tail * edge * life * 0.85);
    }`,
});
const ringMat = (phase) => new THREE.ShaderMaterial({
  uniforms: { uTime: decorTime, uPhase: { value: phase } }, transparent: true, depthWrite: false,
  vertexShader: 'varying vec2 vP; void main() { vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform float uTime, uPhase; varying vec2 vP;
    void main() {
      float k = fract(uTime * 0.22 + uPhase), r = length(vP), R = 0.25 + k * 1.15;
      float ring = 1.0 - smoothstep(0.0, 0.06, abs(r - R));
      gl_FragColor = vec4(vec3(0.92, 0.97, 1.0), ring * (1.0 - k) * 0.75);
    }`,
});
const glassMat = new THREE.ShaderMaterial({
  uniforms: { uTime: decorTime, uColor: { value: BOON } }, transparent: true, depthWrite: false,
  vertexShader: 'varying vec3 vN, vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }',
  fragmentShader: `uniform float uTime; uniform vec3 uColor; varying vec3 vN, vW;
    void main() {
      vec3 V = normalize(cameraPosition - vW), N = normalize(vN);
      float fres = pow(1.0 - abs(dot(N, V)), 2.0);
      float s = fract((vW.x * 0.6 + vW.z * 0.4 + vW.y * 1.5) * 0.35 - uTime * 0.18);
      float band = smoothstep(0.0, 0.05, s) * (1.0 - smoothstep(0.05, 0.14, s));
      vec3 col = mix(uColor, vec3(1.0), 0.25 + 0.45 * fres + 0.6 * band);
      gl_FragColor = vec4(col, 0.22 + 0.5 * fres + 0.4 * band);
    }`,
});
function buildDecor() {
  for (const o of [...decor.children]) decor.remove(o);
  const keyOf = (x, y) => `${x},${y}`;
  // Calm: two staggered rings spreading from the middle of each 3×3 patch (no tint on the ground: it clipped).
  for (const k of L.calm) {
    const [x, y] = k.split(',').map(Number);
    let inner = true; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (!L.calm.has(keyOf(x + dx, y + dy))) inner = false;
    if (!inner) continue;
    for (const ph of [0, 0.5]) { const m = new THREE.Mesh(new THREE.CircleGeometry(1.5, 48).rotateX(-Math.PI / 2), ringMat(ph)); m.position.set(x, hLong(x, y) + 0.3, y); m.renderOrder = 3; decor.add(m); }
  }
  // Wind: streaks gliding along the cone, above the grid (no tint on the ground: it clipped into the terrain).
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const g of L.gusts) {
    const tiles = [...g.tiles].map((k) => k.split(',').map(Number));
    const yaw = -Math.atan2(g.step[1], g.step[0]), n = Math.max(3, Math.round(tiles.length / 3));
    for (let i = 0; i < n; i++) {
      const [tx, ty] = tiles[Math.floor(rnd() * tiles.length)], x = tx + (rnd() - 0.5) * 0.6, y = ty + (rnd() - 0.5) * 0.6;
      const m = new THREE.Mesh(streakGeometry(1.6 + rnd() * 0.8, 0.18 + rnd() * 0.1), streakMat(rnd(), 0.32 + rnd() * 0.12));
      m.position.set(x, hLong(x, y) + 0.4 + rnd() * 0.15, y); m.rotation.y = yaw; m.renderOrder = 4; decor.add(m);
    }
  }
  // Backstops and fairway banks: one continuous glass cushion along each connected run of their tiles.
  for (const set of [L.banks, L.fbanks]) {
    for (const k of set) { const [x, y] = k.split(',').map(Number); tintTile(x, y, KIND_COL.boon, 0.12); }
    for (const run of tileRuns(set)) decor.add(cushionAlong(run));
  }
}
// Order a set of tiles into runs: connected pieces (diagonals count), each walked from an end, preferring a straight
// neighbour to a diagonal one, so a curve round the green comes out in order.
function tileRuns(set) {
  const key = (x, y) => `${x},${y}`, left = new Set(set), runs = [];
  const nbrs = (x, y) => { const o = []; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if ((dx || dy) && left.has(key(x + dx, y + dy))) o.push([x + dx, y + dy, dx && dy ? 1.41 : 1]); return o; };
  while (left.size) {
    // Start from the tile with the fewest neighbours (an end of the run).
    let start = null, fewest = 9;
    for (const k of left) { const [x, y] = k.split(',').map(Number), n = nbrs(x, y).length; if (n < fewest) { fewest = n; start = [x, y]; } }
    const run = [start]; left.delete(key(...start));
    for (let cur = start; ;) {
      const next = nbrs(cur[0], cur[1]).sort((a, b) => a[2] - b[2])[0];
      if (!next) break;
      cur = [next[0], next[1]]; run.push(cur); left.delete(key(...cur));
    }
    runs.push(run);
  }
  return runs;
}
// A glass tube along a run: a smooth curve through the tile centres (reaching a little past the end tiles), following
// the ground, its radius easing to nothing over the last stretch so both ends are rounded.
function cushionAlong(run) {
  const R = 0.12, lift = 0.13;
  let pts = run.map(([x, y]) => new THREE.Vector3(x, 0, y));
  if (pts.length === 1) pts = [pts[0].clone().add(new THREE.Vector3(-0.38, 0, 0)), pts[0].clone().add(new THREE.Vector3(0.38, 0, 0))];
  else {
    const a = pts[0].clone().sub(pts[1]).normalize().multiplyScalar(0.36), b = pts[pts.length - 1].clone().sub(pts[pts.length - 2]).normalize().multiplyScalar(0.36);
    pts = [pts[0].clone().add(a), ...pts, pts[pts.length - 1].clone().add(b)];
  }
  // Smooth the stair steps of a diagonal run (a few passes of neighbour averaging; the ends stay put).
  for (let pass = 0; pass < 3 && pts.length > 3; pass++) pts = pts.map((q, i) => (i === 0 || i === pts.length - 1 ? q : q.clone().multiplyScalar(0.5).addScaledVector(pts[i - 1], 0.25).addScaledVector(pts[i + 1], 0.25)));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal'), len = curve.getLength();
  const N = Math.max(12, Math.round(len * 18)), M = 14, pos = [], nrm = [], idx = [];
  const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3(), n2 = new THREE.Vector3();
  // The ground's height along the run, smoothed (so the tube doesn't ride every felt cushion) but never below it.
  const gy = []; for (let i = 0; i <= N; i++) { const c = curve.getPointAt(i / N); gy.push(hLong(c.x, c.z)); }
  const win = Math.max(2, Math.round(N / len * 0.6)), ys = gy.map((_, i) => { let s = 0, n = 0; for (let q = Math.max(0, i - win); q <= Math.min(N, i + win); q++) { s += gy[q]; n++; } return Math.max(s / n, gy[i] - 0.03); });
  for (let i = 0; i <= N; i++) {
    const u = i / N, c = curve.getPointAt(u), tg = curve.getTangentAt(u).setY(0).normalize();
    c.y = ys[i] + lift;
    const d = Math.min(u, 1 - u) * len, r = R * Math.sin(Math.min(1, d / R) * Math.PI / 2) + 0.002;
    side.crossVectors(up, tg).normalize();
    for (let k = 0; k <= M; k++) {
      const a = (k / M) * Math.PI * 2, cs = Math.cos(a), sn = Math.sin(a);
      n2.copy(side).multiplyScalar(cs).addScaledVector(up, sn);
      pos.push(c.x + n2.x * r, c.y + n2.y * r * 0.85, c.z + n2.z * r);
      // (at the rounded ends the surface turns toward the tip)
      const tip = d < R ? (1 - d / R) * (u < 0.5 ? -1 : 1) : 0, nn = n2.clone().addScaledVector(tg, tip).normalize();
      nrm.push(nn.x, nn.y, nn.z);
    }
    if (i) for (let k = 0; k < M; k++) { const a0 = (i - 1) * (M + 1) + k, b0 = i * (M + 1) + k; idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); g.setIndex(idx);
  const m = new THREE.Mesh(g, glassMat); m.renderOrder = 3;
  return m;
}

// Suspicious hills and ramps the golfer hasn't scouted show a "?" (what they hide is the engine's secret).
function labelSprite(text, bg, fg = '#fff', size = 0.7) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); g.fillStyle = bg; g.beginPath(); g.arc(64, 64, 56, 0, 7); g.fill();
  g.fillStyle = fg; g.font = '800 76px "Baloo 2", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 64, 70);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false })); s.scale.set(size, size, 1); s.renderOrder = 5; s.layers.set(TOP_LAYER);
  return s;
}
// What the golfer can't see yet. Unscouted suspicious hills and ramps carry a "?" that can be tapped (and scouted);
// ground a hill hides lies under mist until it's scouted or the ball comes close (the engine's viewOf decides); a
// scouted ramp shows arrows the way it runs. Rebuilt whenever what's known changes.
const marks = new THREE.Group(); scene.add(marks);
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
  dio.setMist([...v.hidden].map((k) => k.split(',').map(Number)).map(([x, y]) => [x + FOREST, y + FOREST])); // (board tiles: the hole sits inside the forest ring)
}
updateHidden(TEE);
buildDecor();
// The flag and the cup.
// The cup and pin, in long-map units (a cup is about 2.5 balls across; the pin is thin enough for a ball beside it).
const CUP_R = 0.13, CUP_DEPTH = 0.3, POLE_R = 0.02;
dio.setHole(CUP[0], CUP[1], CUP_R);
const flag = new THREE.Group();
{
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(POLE_R, POLE_R, 1.6 + CUP_DEPTH, 8), new THREE.MeshLambertMaterial({ color: '#ffffff' }));
  pole.position.y = (1.6 - CUP_DEPTH) / 2; // (it stands on the bottom of the cup)
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.34), new THREE.MeshLambertMaterial({ color: '#E8604C', side: THREE.DoubleSide }));
  cloth.position.set(0.28, 1.42, 0);
  // The cup: the board has a round hole cut at the pin (dio.setHole); under it a dark liner and floor, and a pale rim.
  const dark = new THREE.MeshLambertMaterial({ color: '#1b2620', side: THREE.DoubleSide });
  const base = hLong(CUP[0], CUP[1]), groundRel = (a, r) => hLong(CUP[0] + Math.cos(a) * r, CUP[1] + Math.sin(a) * r) - base;
  const linerGeo = new THREE.CylinderGeometry(CUP_R, CUP_R, CUP_DEPTH, 32, 1, true); linerGeo.translate(0, -CUP_DEPTH / 2, 0);
  { const pa = linerGeo.attributes.position; for (let i = 0; i < pa.count; i++) if (pa.getY(i) > -0.001) pa.setY(i, groundRel(Math.atan2(pa.getZ(i), pa.getX(i)), CUP_R) - 0.004); pa.needsUpdate = true; }
  const liner = new THREE.Mesh(linerGeo, dark);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(CUP_R, 28), dark); floor.rotation.x = -Math.PI / 2; floor.position.y = -CUP_DEPTH;
  const rimGeo = new THREE.RingGeometry(CUP_R - 0.012, CUP_R + 0.004, 48); rimGeo.rotateX(-Math.PI / 2);
  { const pa = rimGeo.attributes.position; for (let i = 0; i < pa.count; i++) { const x = pa.getX(i), z = pa.getZ(i); pa.setY(i, groundRel(Math.atan2(z, x), Math.hypot(x, z)) + 0.003); } pa.needsUpdate = true; }
  const rim = new THREE.Mesh(rimGeo, new THREE.MeshLambertMaterial({ color: '#e9eee4' }));
  flag.add(pole, cloth, liner, floor, rim);
  flag.position.set(CUP[0], base, CUP[1]);
  scene.add(flag);
}
const DEBRIS = []; // { sx, sy, h, kind: 0 stones, 1 twig, 2 divot }
for (let sy = 0; sy < SN; sy++) for (let sx = 0; sx < SN; sx++) if (S.grid[sy][sx] === 'D') { const h = ((sx * 73856093) ^ (sy * 19349663)) >>> 0; DEBRIS.push({ sx, sy, h, kind: h % 3 }); }
const DEBRIS_WORD = ['stones', 'twig', 'divot'];
// Debris on the short-game map (twigs, stones, divots: a rolling ball bounces off them): a small felt prop on each
// debris tile, so the kick has something to come off. Which prop is fixed by the tile.
{
  const felt = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1 });
  const stone = new THREE.IcosahedronGeometry(1, 1), twig = new THREE.CylinderGeometry(0.012, 0.016, 1, 6), clod = new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const scar = new THREE.CircleGeometry(1, 16); scar.rotateX(-Math.PI / 2);
  for (const { sx, sy, h, kind } of DEBRIS) {
    const yaw = ((h >> 4) % 628) / 100;
    const [wx, wz] = sToW(sx, sy), g = new THREE.Group(); g.position.set(wx, hLong(wx, wz), wz); g.rotation.y = yaw;
    if (kind === 0) { // stones
      for (const [x, z, s] of [[-0.05, 0.02, 0.05], [0.04, -0.03, 0.04], [0.02, 0.06, 0.032]]) { const m = new THREE.Mesh(stone, felt(['#9d978b', '#8a8478', '#b0a998'][(h >> (x > 0 ? 2 : 6)) % 3])); m.position.set(x, s * 0.45, z); m.scale.set(s, s * 0.6, s * 0.85); m.castShadow = true; g.add(m); }
    } else if (kind === 1) { // a twig with a side shoot
      const a = new THREE.Mesh(twig, felt('#7a4f2c')); a.rotation.z = Math.PI / 2; a.scale.y = 0.3; a.position.y = 0.016; a.castShadow = true;
      const b = new THREE.Mesh(twig, felt('#6b4426')); b.rotation.set(0, 0.7, Math.PI / 2); b.scale.y = 0.12; b.position.set(0.05, 0.016, 0.03); b.castShadow = true;
      g.add(a, b);
    } else { // a divot: a bare scar, and the torn clod of turf beside it
      const s = new THREE.Mesh(scar, felt('#7a5636')); s.scale.set(0.08, 1, 0.05); s.position.y = 0.004; g.add(s);
      const c = new THREE.Mesh(clod, felt('#5aa338')); c.scale.set(0.07, 0.035, 0.045); c.position.set(0.11, 0.004, 0.02); c.rotation.z = 0.35; c.castShadow = true; g.add(c);
    }
    scene.add(g);
  }
}
// The ball and its shadow.
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.15, 20, 14), new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#333333' }));
const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.17, 20), new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.25 }));
shadow.rotation.x = -Math.PI / 2;
scene.add(ball, shadow);
// The ball's trail while it moves (the follow camera's shots, chips and putts): the path it covered in the last
// TRAIL_S seconds, so a fast ball draws a long streak and a slow one a short one. A ribbon turned to face the camera,
// as wide as the ball at its head, tapering and fading to nothing at its tail.
const TRAIL_S = 0.26, TRAIL_MAX = 72;
const trail = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 2 * 3), 3));
  g.setAttribute('aA', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 2), 1));
  const idx = []; for (let i = 0; i < TRAIL_MAX - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
  g.setIndex(idx); g.setDrawRange(0, 0);
  const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: 'attribute float aA; varying float vA; void main() { vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying float vA; void main() { gl_FragColor = vec4(vec3(1.0, 0.98, 0.92), vA); }',
  }));
  m.frustumCulled = false; m.renderOrder = 5;
  scene.add(m);
  return { mesh: m, pts: [] };
})();
function updateTrail(now, moving) {
  const pts = trail.pts, head = ball.position;
  if (moving && ball.visible && ball.material.opacity > 0.5) {
    const last = pts[pts.length - 1];
    if (last && last.p.distanceTo(head) > 3) pts.length = 0; // (a jump, as when a ball out of bounds comes back: no streak)
    if (!last || last.p.distanceToSquared(head) > 1e-6) pts.push({ p: head.clone(), t: now });
  }
  while (pts.length && (now - pts[0].t > TRAIL_S * 1000 || pts.length > TRAIL_MAX)) pts.shift();
  const n = pts.length, g = trail.mesh.geometry;
  if (n < 2) { g.setDrawRange(0, 0); return; }
  const pos = g.attributes.position.array, al = g.attributes.aA.array, r = 0.15 * ballScale * 0.85;
  const view = new THREE.Vector3(), dir = new THREE.Vector3(), side = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const p = pts[i].p, q = pts[Math.min(n - 1, i + 1)].p, o = pts[Math.max(0, i - 1)].p;
    dir.subVectors(q, o).normalize(); view.subVectors(camera.position, p).normalize();
    side.crossVectors(dir, view).normalize();
    const k = i / (n - 1), w = r * k; // (0 at the tail, the ball's width at the head)
    pos.set([p.x + side.x * w, p.y + side.y * w, p.z + side.z * w, p.x - side.x * w, p.y - side.y * w, p.z - side.z * w], i * 6);
    al[i * 2] = al[i * 2 + 1] = 0.55 * k * k;
  }
  g.attributes.position.needsUpdate = true; g.attributes.aA.needsUpdate = true;
  g.setDrawRange(0, (n - 1) * 6);
}
// The ball is drawn big for the plan view (it has to be found at a glance) and shrinks toward its true size when the
// camera comes close: in the cinematic views (flyover, flight, reading putts) and more so on the short-game map,
// whose tiles are a third of a long tile.
let ballScale = 1;
function ballScaleWant() {
  if (ballInCup || (anim && anim.holed)) return BALL_IN_CUP;
  const cine = !!anim || camera.fov > (FOV.plan + FOV.cine) / 2;
  return shortMode ? (cine ? 0.32 : 0.55) : (cine ? 0.55 : 1);
}
// Where a holed ball goes: it reaches the lip on its way in, then drops to the floor of the cup beside the pin.
const BALL_IN_CUP = 0.3; // the ball's scale as it holes out (so it fits between the pin and the wall)
function cupDrop(prev) {
  let dx = CUP[0] - prev[0], dz = CUP[1] - prev[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
  const off = CUP_R - 0.15 * BALL_IN_CUP - 0.008;
  return { lip: [CUP[0] - dx * off, CUP[1] - dz * off], depth: CUP_DEPTH - 0.15 * BALL_IN_CUP };
}
function dropSeg(drop) { return { ms: 280, at: (s) => { if (s >= 1) ballInCup = true; return { p: drop.lip, y: -drop.depth * s * s, inCup: true }; } }; }
let ballY = 0, ballInCup = false; // (its height above the ground as last placed; whether it has holed out)
function placeBall(x, z, y) {
  ballY = y ?? 0;
  const g = groundAt(x, z), r = 0.15 * ballScale;
  ball.scale.setScalar(ballScale); shadow.scale.setScalar(ballScale);
  ball.position.set(x, (y ?? 0) + g + r, z); shadow.position.set(x, g + 0.015, z); shadow.material.opacity = (y ?? 0) < 0 ? 0 : 0.25 / (1 + (y ?? 0) * 0.6);
}

// ---------- the short map: the green and its surrounds, with the seed's slopes ----------
const sGreenBase = hLong(CUP[0], CUP[1]);
function hShortRaw(sx, sy) { return sGreenBase + shortRel(sx, sy); }
// The board carries the short-game map's ground (its tiles and its slopes), so the short game's ground is the board's.
const hShort = (x, z) => hLong(x, z);
let shortMesh = null, shortMode = false, heights = true;
// The green's height map, an overlay on the board: seven bands from the lowest ground on the green (cool) to the
// highest (warm), with a faint line where a band changes. Transparent off the green; shown with the Heights toggle.
function bandTexture(SPX) {
  const c = document.createElement('canvas'); c.width = c.height = SN * SPX;
  const g = c.getContext('2d'), img = g.createImageData(c.width, c.height), D = img.data;
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < SN; y++) for (let x = 0; x < SN; x++) if ('GD'.includes(S.grid[y][x])) { lo = Math.min(lo, S.h[y][x]); hi = Math.max(hi, S.h[y][x]); }
  const span = hi - lo || 1, BANDS = 7, LOW = [70, 160, 140], HIGH = [232, 236, 140];
  const band = (sx, sy) => Math.min(BANDS - 1, Math.floor(((shortRel(sx, sy) / EX + hCupS - lo) / span) * BANDS));
  for (let py = 0; py < c.height; py++) for (let px = 0; px < c.width; px++) {
    const sx = px / SPX - 0.5, sy = py / SPX - 0.5, tx = Math.round(sx), ty = Math.round(sy);
    if (tx < 0 || ty < 0 || tx >= SN || ty >= SN || !'GD'.includes(S.grid[ty][tx])) continue;
    const b = band(sx, sy), k = b / (BANDS - 1), i = (py * c.width + px) * 4;
    const edge = band(sx + 1 / SPX, sy) !== b || band(sx, sy + 1 / SPX) !== b;
    for (let ch = 0; ch < 3; ch++) D[i + ch] = Math.round(LOW[ch] + (HIGH[ch] - LOW[ch]) * k - (edge ? 40 : 0));
    D[i + 3] = edge ? 190 : 120;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}
function groundAt(x, z) { return hLong(x, z); }
function buildShort() {
  const n = SN * 2, size = SN / SCALE;
  const geo = new THREE.PlaneGeometry(size, size, n, n);
  geo.rotateX(-Math.PI / 2);
  const [cx, cz] = sToW((SN - 1) / 2, (SN - 1) / 2);
  geo.translate(cx, 0, cz);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, hLong(p.getX(i), p.getZ(i)) + 0.012);
  geo.computeVertexNormals();
  shortMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: bandTexture(14), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  shortMesh.renderOrder = 1; shortMesh.visible = heights;
  scene.add(shortMesh);
  buildBreakArrows();
}

// Break arrows: on the green and fringe, every other short tile, a flat arrow pointing the way the ground falls
// (the way a slow ball drifts), longer and stronger where it's steeper. Flat spots get none.
let breakArrows = null;
function buildBreakArrows() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, -0.07); shape.lineTo(0.08, -0.07); shape.lineTo(0.08, -0.2); shape.lineTo(0.5, 0); shape.lineTo(0.08, 0.2); shape.lineTo(0.08, 0.07); shape.lineTo(-0.5, 0.07); shape.closePath();
  const geo = new THREE.ShapeGeometry(shape); geo.rotateX(-Math.PI / 2);
  const cells = [];
  for (let y = 1; y < SN; y += 3) for (let x = 1; x < SN; x += 3) {
    if (!'GF'.includes(S.grid[y][x]) || (Math.abs(x - SC) <= 1 && Math.abs(y - SC) <= 1)) continue;
    const [gx, gy] = G.slopeAt(S, x, y), m = Math.hypot(gx, gy);
    if (m < 0.006) continue;
    cells.push({ x, y, dx: -gx / m, dz: -gy / m, m });
  }
  const mat = new THREE.MeshBasicMaterial({ color: '#f4f8e8', transparent: true, opacity: 0.42, depthWrite: false });
  breakArrows = new THREE.InstancedMesh(geo, mat, Math.max(1, cells.length));
  const M4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  cells.forEach((c, i) => {
    const [wx, wz] = sToW(c.x, c.y), k = Math.min(1, c.m / 0.05), len = 0.14 + 0.24 * k; // (small pale marks painted on the felt)
    q.setFromAxisAngle(up, -Math.atan2(c.dz, c.dx));
    M4.compose(new THREE.Vector3(wx, hShort(wx, wz) + 0.02, wz), q, new THREE.Vector3(len, 1, 0.45 + 0.35 * k));
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
  const b = phone.getBoundingClientRect();
  if (Math.abs(viewOffset) > 0.5) camera.setViewOffset(b.width, b.height, 0, viewOffset, b.width, b.height); else camera.clearViewOffset();
}

// ---------- overlays: landing spots, lines, previews ----------
// A marigold ring pulsing outward from a point (debris the aim line kicks off).
const pulseGeo = (() => { const g = new THREE.CircleGeometry(0.42, 40); g.rotateX(-Math.PI / 2); return g; })();
const pulseMat = new THREE.ShaderMaterial({
  uniforms: { uTime: decorTime }, transparent: true, depthWrite: false, depthTest: false,
  vertexShader: 'varying vec2 vP; void main() { vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform float uTime; varying vec2 vP;
    void main() {
      float r = length(vP) / 0.42, a = 0.0;
      for (int i = 0; i < 2; i++) { float k = fract(uTime * 0.9 + float(i) * 0.5), R = 0.25 + k * 0.7; a = max(a, (1.0 - smoothstep(0.0, 0.07, abs(r - R))) * (1.0 - k)); }
      a = max(a, (1.0 - smoothstep(0.17, 0.22, r)) * 0.35); // (a steady core, so it reads in a still frame)
      gl_FragColor = vec4(0.95, 0.71, 0.18, a);
    }`,
});
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
  const l = new Line2(geo, mat); if (dashed) l.computeLineDistances(); l.renderOrder = 3; l.layers.set(TOP_LAYER); overlay.add(l); return l;
}
function addRing(x, z, r0, r1, color, opacity = 1) {
  const m = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 28), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, groundAt(x, z) + 0.05, z); m.renderOrder = 4; m.layers.set(TOP_LAYER); overlay.add(m); return m;
}
function addDot(x, z, r, color) { const m = new THREE.Mesh(new THREE.CircleGeometry(r, 20), new THREE.MeshBasicMaterial({ color, depthTest: false })); m.rotation.x = -Math.PI / 2; m.position.set(x, groundAt(x, z) + 0.06, z); m.renderOrder = 4; m.layers.set(TOP_LAYER); overlay.add(m); return m; }
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
  // Heights come from smoothed profiles along the route, not the ground right underneath, so bumps don't jolt the
  // camera: the camera rides a smoothed upper envelope of the ground around it (so it clears the hills), the look
  // point a smoothed average.
  const N = 160, camG = new Float32Array(N + 1), lookG = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const u = i / N, c = camCurve.getPointAt(u), l = lookCurve.getPointAt(Math.min(1, u + 0.12));
    let top = -Infinity; for (let dx = -1.5; dx <= 1.5; dx += 0.75) for (let dz = -1.5; dz <= 1.5; dz += 0.75) top = Math.max(top, groundAt(c.x + dx, c.z + dz));
    camG[i] = top; lookG[i] = groundAt(l.x, l.z);
  }
  const smooth = (a, R) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) { let s = 0, w = 0; for (let j = -R; j <= R; j++) { const k = Math.min(a.length - 1, Math.max(0, i + j)), g = Math.exp(-(j * j) / (R * R / 2)); s += a[k] * g; w += g; } o[i] = s / w; } return o; };
  const camH = smooth(camG, 18), lookH = smooth(lookG, 12);
  const lerpAt = (a, u) => { const f = u * N, i = Math.min(N - 1, Math.floor(f)); return a[i] + (a[i + 1] - a[i]) * (f - i); };
  const at = (u) => {
    const c = camCurve.getPointAt(u), l = lookCurve.getPointAt(Math.min(1, u + 0.12));
    c.y = lerpAt(camH, u) + 2.4 + 3.1 * u + 4 * Math.sin(Math.PI * u);
    l.y = lerpAt(lookH, u);
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
  dio.hideTreesNear(round.ball[0], round.ball[1], 1.4);
  state = 'aim'; selDir = null; shape = ''; swing = 'full';
  dio.setGrid(0.32);
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
  // The marker sweeps by CSS (the browser animates it off the main thread, so a slow 3D frame never makes it jump),
  // started at meter.start; the timing comes from the moment of the touch (the event's own timestamp).
  showSheet(`<div class="row between"><span class="label">Early · ${k === 'putter' || k === 'chip' ? 'softer' : 'pulls left'}</span><span class="label">Late · ${k === 'putter' || k === 'chip' ? 'firmer' : 'pushes right'}</span></div>
    <div class="meter"><div class="rail" id="rail"><div class="tick" id="tick"></div></div></div>
    <div class="row between muted" style="margin-top:6px"><span>←</span><span>${esc(title)}</span><span>→</span></div>`);
  $('tap').classList.remove('hidden'); $('taphint').classList.remove('hidden');
  const sweep = $('rail').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], { duration: meter.period, iterations: Infinity, easing: 'linear' });
  sweep.startTime = meter.start; // (so the marker is exactly where timingAt says it is)
}
function stopMeter(at) {
  if (!meter) return;
  const t = Math.round(timingAt(meter, at ?? performance.now()) * 100) / 100, done = meter.onDone;
  meter = null; $('tap').classList.add('hidden'); $('taphint').classList.add('hidden');
  done(t);
}
$('zin').onclick = () => zoomBy(0.8); $('zout').onclick = () => zoomBy(1.25);
$('tap').onpointerdown = (ev) => { ev.stopPropagation(); ev.preventDefault(); stopMeter(ev.timeStamp); };
$('tap').onclick = (ev) => ev.stopPropagation();
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
  state = 'flight'; hideSheet(); dio.setGrid(null); clearOverlay();
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
      const drop = res.holed ? cupDrop(pts[pts.length - 1]) : null;
      const end = drop ? drop.lip : res.pos; if (Math.hypot(end[0] - pts[pts.length - 1][0], end[1] - pts[pts.length - 1][1]) > 0.01) pts.push(end);
      const cum = [0]; for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      const len = cum[cum.length - 1];
      const along = (d) => { let k = 1; while (k < cum.length - 1 && cum[k] < d) k++; const f = (d - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1); return lerp2(pts[k - 1], pts[k], Math.max(0, Math.min(1, f))); };
      segs.push({ ms: Math.max(350, Math.min(1500, 260 * len + 300)), at: (s) => { const e = 1 - (1 - s) * (1 - s), d = e * len, f = len ? d / len : 1; return { p: len ? along(d) : contact, y: f < 0.3 ? 0.35 * Math.sin((Math.PI * f) / 0.3) : 0 }; } });
      if (drop) segs.push(dropSeg(drop));
    }
  }
  // Follow from behind and above, along the line of the shot; at the end, swing round a little toward the hole.
  const dirV = new THREE.Vector3((tr.target || CUP)[0] - from[0], 0, (tr.target || CUP)[1] - from[1]).normalize();
  fovWant = FOV.cine;
  anim = { t0: performance.now(), segs, follow: dirV, holed: !!res.holed, done: () => afterLong(before, action, res) };
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
  crashLog('short game: start');
  if (!shortMesh) { buildShort(); crashLog('short game: overlays built'); }
  shortMode = true; shortMesh.visible = heights;
  marks.visible = true;
  sSel = null;
  if (G.isTapIn(S, round.sball)) return tapIn();
  state = 'short';
  renderShort(true);
  debrisWarning();
}
// The caddy points out debris lying near the straight line from the ball to the cup (within a tile and a half of it,
// between them or just past the hole), naming the nearest piece and where it sits.
let debrisSaid = '';
function debrisWarning() {
  const [bx, by] = round.sball, key = `${holeIdx}:${bx},${by}`;
  if (debrisSaid === key) return;
  debrisSaid = key;
  const vx = SC - bx, vy = SC - by, L2 = vx * vx + vy * vy || 1;
  let best = null;
  for (const d of DEBRIS) {
    const t = ((d.sx - bx) * vx + (d.sy - by) * vy) / L2;
    if (t < 0.15 || t > 1.35) continue;
    const px = bx + vx * t, py = by + vy * t, off = Math.hypot(d.sx - px, d.sy - py);
    if (off > 1.5) continue;
    if (!best || off < best.off) best = { d, t, off, side: vx * (d.sy - by) - vy * (d.sx - bx) };
  }
  if (!best) return;
  const w = DEBRIS_WORD[best.d.kind], what = w === 'stones' ? 'the stones' : `the ${w}`;
  const where = best.t > 1.02 ? 'just past the hole' : best.off < 0.6 ? 'right on your line' : `${best.side > 0 ? 'right' : 'left'} of your line${best.t > 0.75 ? ', near the hole' : ''}`;
  caddySay(`Watch ${what} ${where}.`);
  clearTimeout(caddyDone); caddyDone = setTimeout(() => { if (state === 'short') caddyHide(); }, 3500);
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
    // The debris this line kicks off (the engine names the pieces it hits), each with a pulsing ring.
    const seenD = new Set();
    for (const [sx, sy] of (r.events && r.events.debrisAt) || []) {
      if (seenD.has(`${sx},${sy}`)) continue; seenD.add(`${sx},${sy}`);
      const [dx, dz] = sToW(sx, sy), m = new THREE.Mesh(pulseGeo, pulseMat); m.layers.set(TOP_LAYER); m.position.set(dx, hLong(dx, dz) + 0.03, dz); m.renderOrder = 4; overlay.add(m);
    }
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
  $('heights').onclick = () => { heights = !heights; shortMesh.visible = heights; renderShort(false); };
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
  const drop = res.holed ? cupDrop(pts[pts.length - 1]) : null;
  if (drop) pts.push(drop.lip);
  const cum = [0]; for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const len = cum[cum.length - 1] || 0.001;
  const along = (d) => { let k = 1; while (k < cum.length - 1 && cum[k] < d) k++; const f = (d - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1); return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * f, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * f]; };
  const chip = a.club === 'wedge', segs = [];
  if (chip && pts.length > 1) { const l1 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]); segs.push({ ms: 500 + 120 * l1, at: (s) => ({ p: [pts[0][0] + (pts[1][0] - pts[0][0]) * s, pts[0][1] + (pts[1][1] - pts[0][1]) * s], y: 4 * Math.max(0.6, l1 * 0.35) * s * (1 - s) }) }); }
  const start = chip && pts.length > 1 ? cum[1] : 0;
  segs.push({ ms: Math.min(3200, 700 + 420 * (len - start)), at: (s) => { const e = 1 - (1 - s) * (1 - s); return { p: along(start + e * (len - start)), y: 0 }; } });
  if (drop) segs.push(dropSeg(drop));
  else if (res.events.includes('water')) segs.push({ ms: 400, at: (s) => ({ p: pts[pts.length - 1], y: -0.2 * s, o: 1 - s }) });
  // A low camera behind the ball, turning with it toward the hole.
  const [bx, bz] = sToW(from[0], from[1]);
  const dirV = new THREE.Vector3(CUP[0] - bx, 0, CUP[1] - bz).normalize();
  fovWant = FOV.cine;
  anim = { t0: performance.now(), segs, follow: dirV, low: true, holed: !!res.holed, done: () => {
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
  // Only the ones that made a difference (cost strokes, scouting included, or saved them).
  const fx = features.filter((f) => f.owner !== 'seed').map((f) => ({ f, c: credit.find((q) => q.feature === f.id) || { harm: 0, aid: 0, scouted: 0 } }))
    .filter(({ c }) => c.harm || c.aid || c.scouted).map(({ f, c }) => {
    const cost = (c.harm || 0) + (c.scouted || 0);
    const what = cost ? `cost you ${cost} stroke${cost > 1 ? 's' : ''}` : `saved you ${c.aid} stroke${c.aid > 1 ? 's' : ''}`;
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
// Small drawings for the palette's felt tokens (one per feature).
const TOKEN_ICON = {
  bunker: '<svg viewBox="0 0 40 40"><ellipse cx="20" cy="21" rx="13" ry="9" fill="#B18C5C"/><ellipse cx="20" cy="21" rx="10.5" ry="7" fill="#F1DFB4"/></svg>',
  water: '<svg viewBox="0 0 40 40"><path d="M8 21c0-6 6-10 13-9s12 4 11 10-7 9-13 8-11-3-11-9z" fill="#7A5636"/><path d="M10 21c0-4.5 5-7.5 11-7s10 3.5 9.5 8-6 7-11 6-9.5-2.5-9.5-7z" fill="#3C93D6"/></svg>',
  wind: '<svg viewBox="0 0 40 40" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M8 15h18l-4-4M8 25h22l-4 4"/></svg>',
  hill: '<svg viewBox="0 0 40 40"><path d="M5 30c4-12 9-17 15-17s11 5 15 17z" fill="#6CB444"/><circle cx="27" cy="11" r="6" fill="#A66BD9"/><text x="27" y="14.5" font-size="9" font-weight="800" text-anchor="middle" fill="#fff" font-family="Nunito,sans-serif">?</text></svg>',
  ramp: '<svg viewBox="0 0 40 40"><path d="M6 29h28V16z" fill="#9FDC66"/><path d="M6 29h28V16z" fill="none" stroke="#5AA338" stroke-width="2"/></svg>',
  trees: '<svg viewBox="0 0 40 40"><rect x="13" y="22" width="3" height="8" fill="#7A4F2C"/><rect x="24" y="23" width="3" height="7" fill="#7A4F2C"/><circle cx="14.5" cy="18" r="7" fill="#3F8F35"/><circle cx="25.5" cy="19" r="6.5" fill="#5AA83C"/><circle cx="20" cy="13" r="6" fill="#4F9D3A"/></svg>',
  bank: '<svg viewBox="0 0 40 40"><path d="M6 30v-6h14v-6h14v12z" fill="#6CB444"/></svg>',
  backstop: '<svg viewBox="0 0 40 40" fill="none"><path d="M9 27a11 11 0 0 1 22 0" stroke="#5AA338" stroke-width="5" stroke-linecap="round"/><circle cx="20" cy="27" r="2.5" fill="#1E2A24"/></svg>',
  calm: '<svg viewBox="0 0 40 40" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M29 20a9 9 0 1 1-4-7.5"/><path d="M14 20h12"/></svg>',
};
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
      if (!spec.on.includes(hole.grid[y][x]) || taken.has(`${x},${y}`) || isDecor(x, y) || Math.hypot(x - CUP[0], y - CUP[1]) <= G.ZONE_R) continue;
      if (design.picks4.some((q) => q[0] === x && q[1] === y)) continue;
      if (design.picks4.length && !design.picks4.some((q) => Math.max(Math.abs(q[0] - x), Math.abs(q[1] - y)) === 1)) continue;
      out.push([x, y]);
    }
    return out;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!isDecor(x, y) && !G.placementError(course, RS.faced, candidate(x, y), true)) out.push([x, y]);
  return out;
}
function startDesign() {
  state = 'design'; caddyHide(); explain(''); clearOverlay();
  // The board calms down (softer colour, a glowing tile grid) so the placement marks and the piece stand out.
  dio.setGrid(0.42, 1);
  dio.postUniforms.uSat.value = look.psat * 0.72; dio.postUniforms.uExposure.value = look.exposure * 1.05;
  if (shortMesh) { shortMesh.visible = false; shortMode = false; }
  breakArrows && (breakArrows.visible = false);
  ball.visible = false; shadow.visible = false;
  marks.visible = false; dio.setMist([]); // (the golfer's own view of hidden things doesn't belong in shaping)
  fovWant = FOV.plan;
  $('zoomctl').classList.remove('hidden');
  renderDesign(true);
}
// Placement marks: a rounded frame on a tile with a soft glow round it and a faint fill, in the feature's kind colour
// (lifted just above the fur).
function roundRect(w, r) {
  const s = new THREE.Shape(), h = w / 2;
  s.moveTo(-h + r, -h); s.lineTo(h - r, -h); s.quadraticCurveTo(h, -h, h, -h + r); s.lineTo(h, h - r); s.quadraticCurveTo(h, h, h - r, h);
  s.lineTo(-h + r, h); s.quadraticCurveTo(-h, h, -h, h - r); s.lineTo(-h, -h + r); s.quadraticCurveTo(-h, -h, -h + r, -h);
  return s;
}
const frameGeo = (outer, inner, ro, ri) => { const s = roundRect(outer, ro); s.holes.push(new THREE.Path(roundRect(inner, ri).getPoints(6))); const g = new THREE.ShapeGeometry(s, 6); g.rotateX(-Math.PI / 2); return g; };
const MARK = { frame: frameGeo(0.9, 0.76, 0.18, 0.12), glow: frameGeo(1.08, 0.9, 0.26, 0.18), fill: (() => { const g = new THREE.ShapeGeometry(roundRect(0.86, 0.16), 6); g.rotateX(-Math.PI / 2); return g; })() };
// Marks are gathered, then drawn as one instanced mesh per shape, colour and strength (hundreds of tiles can be lit).
let markList = [];
function tileMark(x, y, color, strength, quiet) {
  // Quiet marks (every tile a feature could go): a faint fill and a thin frame. Picked and draft tiles glow.
  const add = (geo, opacity) => markList.push({ geo, color, opacity, x, y });
  if (quiet) { add(MARK.fill, 0.13 * strength); add(MARK.frame, 0.3 * strength); return; }
  add(MARK.glow, 0.22 * strength); add(MARK.frame, 0.95 * strength); add(MARK.fill, 0.16 * strength);
}
function flushMarks() {
  const groups = new Map();
  for (const m of markList) { const k = `${m.geo.uuid}|${m.color}|${m.opacity.toFixed(3)}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  const M4 = new THREE.Matrix4();
  for (const list of groups.values()) {
    const { geo, color, opacity } = list[0];
    const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }), list.length);
    list.forEach((m, i) => { M4.makeTranslation(m.x, hLong(m.x, m.y) + 0.15, m.y); im.setMatrixAt(i, M4); }); // (just above the fur; trees in front still hide them)
    im.renderOrder = 3; designGroup.add(im);
  }
  markList = [];
}
// The piece being placed: a felt token in the kind's colour with a small model of the feature on top, hovering over
// its tiles with a soft shadow on the ground, like a game piece about to be set down.
let designPiece = null;
function featureModel(kind, dir) {
  const g = new THREE.Group(), felt = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1 });
  const add = (geo, c, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, felt(c)); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
  if (kind === 'bunker') add(new THREE.CylinderGeometry(0.28, 0.3, 0.05, 28), '#F1DFB4', 0, 0.09, 0).scale.set(1.25, 1, 0.85);
  else if (kind === 'water') add(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 28), '#3C93D6', 0, 0.09, 0).scale.set(1.2, 1, 0.9);
  else if (kind === 'trees') for (const [x, z, s] of [[-0.15, 0.08, 0.17], [0.15, 0.1, 0.15], [0, -0.13, 0.19]]) { add(new THREE.CylinderGeometry(0.03, 0.04, 0.16, 8), '#7A4F2C', x, 0.15, z); add(new THREE.SphereGeometry(s, 16, 12), '#4F9D3A', x, 0.24 + s * 0.7, z); }
  else if (kind === 'hill') add(new THREE.SphereGeometry(0.3, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), '#6CB444', 0, 0.06, 0).scale.set(1, 0.7, 1);
  else if (kind === 'ramp') { const w = add(new THREE.BoxGeometry(0.5, 0.06, 0.34), '#9FDC66', 0, 0.16, 0); w.rotation.z = 0.32; }
  else if (kind === 'bank') { add(new THREE.BoxGeometry(0.5, 0.08, 0.16), '#6CB444', 0, 0.1, -0.08); add(new THREE.BoxGeometry(0.5, 0.15, 0.14), '#5AA338', 0, 0.14, 0.09); }
  else if (kind === 'backstop') add(new THREE.TorusGeometry(0.24, 0.05, 8, 24, Math.PI), '#5AA338', 0, 0.08, 0).rotation.x = -Math.PI / 2 + 0.6;
  else if (kind === 'wind' || kind === 'calm') {
    const s = new THREE.Shape(); s.moveTo(-0.28, -0.05); s.lineTo(0.08, -0.05); s.lineTo(0.08, -0.14); s.lineTo(0.3, 0); s.lineTo(0.08, 0.14); s.lineTo(0.08, 0.05); s.lineTo(-0.28, 0.05); s.closePath();
    if (kind === 'wind') { const a = add(new THREE.ShapeGeometry(s), '#ffffff', 0, 0.1, 0); a.rotation.x = -Math.PI / 2; }
    else add(new THREE.TorusGeometry(0.2, 0.035, 8, 28, Math.PI * 1.6), '#ffffff', 0, 0.1, 0).rotation.x = -Math.PI / 2;
  }
  const o = G.ORIENT && dir != null ? G.ORIENT[dir % G.ORIENT.length] : null;
  if (o && G.FEATURES[kind].oriented) g.rotation.y = -Math.atan2(o[1], o[0]);
  return g;
}
function makePiece(f) {
  const spec = G.FEATURES[f.kind], col = KIND_COL[spec.kind];
  const piece = new THREE.Group();
  const puck = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.12, 36), new THREE.MeshStandardMaterial({ color: col, roughness: 1 }));
  puck.castShadow = true; piece.add(puck);
  piece.add(featureModel(f.kind, f.dir));
  if (f.kind === 'hill') { const q = labelSprite('?', 'rgba(166,107,217,.95)', '#fff', 0.34); q.position.set(0, 0.62, 0); piece.add(q); }
  const tiles = draftTiles(f), cx = tiles.reduce((a, q) => a + q[0], 0) / tiles.length, cz = tiles.reduce((a, q) => a + q[1], 0) / tiles.length, base = hLong(cx, cz);
  piece.scale.setScalar(1.25);
  piece.position.set(cx, base + 1.0, cz);
  const blob = new THREE.Mesh(new THREE.CircleGeometry(0.55, 28), new THREE.MeshBasicMaterial({ color: '#1E2A24', transparent: true, opacity: 0.22, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.set(cx, base + 0.04, cz); blob.renderOrder = 2;
  designGroup.add(piece, blob);
  return { piece, blob, base };
}
function renderDesign(reframe) {
  for (const o of [...designGroup.children]) { designGroup.remove(o); o.traverse((n) => { if (n.material) n.material.dispose(); if (n.isInstancedMesh) n.dispose(); }); }
  designPiece = null;
  const k = design.kind, spec = G.FEATURES[k], f = design.draft, col = KIND_COL[spec.kind];
  for (const [x, y] of litTiles()) tileMark(x, y, col, f ? 0.5 : 1, true);
  for (const [x, y] of design.picks4) tileMark(x, y, col, 1);
  if (f) {
    for (const [x, y] of draftTiles(f)) tileMark(x, y, col, 1.1);
    if (k === 'hill') for (const [x, y] of G.hiddenBy(f)) tileMark(x, y, '#A66BD9', 0.45);
    designPiece = makePiece(f);
  }
  flushMarks();
  const cost = f ? G.costOf(f) : 0, card = round.strokes.reduce((a, b) => a + b, 0) + RS.picks.reduce((a, q) => a + (q ? G.costOf(q) : 0), 0);
  topChips([`Shaping hole ${holeIdx + 1}`], [`Your card: ${card}${f ? ` → ${card + cost}` : ''}`]);
  const cards = Object.entries(G.FEATURES).map(([key, s]) => `<button class="fcard ${key === k ? 'on' : ''}" data-kind="${key}"><span class="ftok" style="--kc:${KIND_COL[s.kind]}">${TOKEN_ICON[key] || ''}</span><b>${esc(s.label)}</b><span class="ftag" style="color:${KIND_COL[s.kind]}">${KIND_WORD[s.kind]}</span><span class="fcost">${s.cost ? `${s.cost} stroke${s.cost > 1 ? 's' : ''}` : 'free'}</span></button>`).join('');
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
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(); ray.layers.enable(TOP_LAYER);
let down = null;
// In the designer the view can be moved: drag to pan, pinch (or the wheel, or the + and − buttons) to zoom. A tap
// still places; a drag or pinch doesn't.
const pointers = new Map();
let gesture = null;
function groundPoint(cx, cy) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const out = new THREE.Vector3();
  return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -cam.look.y), out) ? out : null;
}
function syncCam() { cam.to = null; camera.position.copy(cam.pos); camera.lookAt(cam.look); camera.updateMatrixWorld(); }
function zoomBy(k) {
  const d = cam.pos.clone().sub(cam.look), len = Math.max(5, Math.min(150, d.length() * k));
  cam.pos.copy(cam.look).addScaledVector(d.normalize(), len); syncCam();
}
function panBy(delta) {
  const nx = Math.max(-3, Math.min(W + 2, cam.look.x + delta.x)) - cam.look.x, nz = Math.max(-3, Math.min(H + 2, cam.look.z + delta.z)) - cam.look.z;
  cam.pos.x += nx; cam.pos.z += nz; cam.look.x += nx; cam.look.z += nz; syncCam();
}
const pinchDist = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
canvas.addEventListener('pointerdown', (e) => {
  // During the swing meter a touch anywhere on the view swings, timed from the touch itself.
  if (meter) { e.preventDefault(); return stopMeter(e.timeStamp); }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 1) down = { x: e.clientX, y: e.clientY, yaw: readYaw, moved: false };
  if (state === 'design') gesture = pointers.size >= 2 ? { pinch: pinchDist() } : { pan: groundPoint(e.clientX, e.clientY) };
  if (pointers.size >= 2 && down) down.moved = true;
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!down) return;
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) down.moved = true;
  if (state === 'read') { readYaw = down.yaw - (e.clientX - down.x) * 0.008; placeReadCam(0); return; }
  if (state !== 'design' || !down.moved || !gesture) return;
  if (pointers.size >= 2 && gesture.pinch) { const d = pinchDist(); zoomBy(gesture.pinch / Math.max(1, d)); gesture.pinch = d; return; }
  if (gesture.pan) { const p = groundPoint(e.clientX, e.clientY); if (p) panBy(gesture.pan.clone().sub(p)); }
});
canvas.addEventListener('wheel', (e) => { if (state !== 'design') return; e.preventDefault(); zoomBy(e.deltaY > 0 ? 1.12 : 0.89); }, { passive: false });
const endPointer = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2 && gesture && gesture.pinch) gesture = null; };
canvas.addEventListener('pointercancel', (e) => { endPointer(e); if (!pointers.size) down = null; });
canvas.addEventListener('pointerup', (e) => {
  endPointer(e);
  if (pointers.size) return;
  const d = down; down = null; gesture = null;
  if (!d || d.moved || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) return;
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (state === 'aim' || state === 'info') {
    const s = ray.intersectObjects(marks.children.filter((o) => o.isSprite))[0];
    if (s) return showHidden(s.object.userData.feature);
    if (state === 'info') return startAim();
  }
  const hit = ray.intersectObjects([dio.ground].filter(Boolean))[0];
  if (!hit) return;
  if (state === 'aim') tapAim(hit.point);
  else if (state === 'short') tapShort(hit.point);
  else if (state === 'design') tapDesign(hit.point);
});
document.addEventListener('keydown', (e) => { if (meter && (e.code === 'Space' || e.key === ' ')) { e.preventDefault(); stopMeter(e.timeStamp); } });

// ---------- the loop ----------
function resize() {
  const r = phone.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
  for (const m of fatMats) m.resolution.set(r.width, r.height);
  dio.resize();
}
window.addEventListener('resize', () => { resize(); if (state === 'aim') renderAim(true); else if (state === 'short') renderShort(true); });
// Frame-rate overlay (?fps=1): frames per second, the slowest frame, and what the board draws.
const fpsBox = qs.get('fps') ? Object.assign(document.createElement('div'), { style: 'position:absolute;left:8px;top:64px;z-index:20;background:rgba(30,42,36,.8);color:#fff;font:700 11px/1.35 monospace;padding:6px 8px;border-radius:8px;pointer-events:none;white-space:pre' }) : null;
if (fpsBox) phone.appendChild(fpsBox);
const fpsLog = { n: 0, t0: 0, worst: 0, last: 0 };
function frame(now) {
  decorTime.value = now / 1000;
  { const aiming = shortMode && !anim && (state === 'short' || state === 'read'); // (not while the ball moves)
    if (shortMesh) shortMesh.visible = heights && aiming;
    if (breakArrows) breakArrows.visible = aiming; }
  updateTrail(now, !!anim);
  if (fpsBox) {
    if (fpsLog.last) fpsLog.worst = Math.max(fpsLog.worst, now - fpsLog.last);
    fpsLog.last = now; fpsLog.n++;
    if (now - fpsLog.t0 > 1000) { const st = dio.stats(); fpsBox.textContent = `${Math.round((fpsLog.n * 1000) / (now - fpsLog.t0))} fps  worst ${Math.round(fpsLog.worst)} ms\n${(st.tris / 1e6).toFixed(2)}M tris  ${st.calls} draws\n${renderer.getPixelRatio()}x ${lowEnd ? 'phone' : 'desktop'} quality`; fpsLog.n = 0; fpsLog.t0 = now; fpsLog.worst = 0; }
  }
  if (designPiece) { const b = Math.sin(now / 450) * 0.1; designPiece.piece.position.y = designPiece.base + 1.0 + b; designPiece.piece.rotation.y = Math.sin(now / 1300) * 0.12; designPiece.blob.scale.setScalar(1 - b * 0.4); }
  { const want = ballScaleWant(); if (Math.abs(want - ballScale) > 0.002) { ballScale += (want - ballScale) * 0.15; if (!anim) placeBall(ball.position.x, ball.position.z, ballY); } }
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
  if (state !== watch.state) { crashLog(`state ${state}`); watch.state = state; }
  if (watch.last) watch.worst = Math.max(watch.worst, now - watch.last);
  watch.last = now; watch.n++;
  if (!watch.t0) { watch.t0 = now; crashLog('first frame'); }
  else if (now - watch.t0 > 2000) {
    const i = renderer.info;
    crashLog(`${Math.round((watch.n * 1000) / (now - watch.t0))} fps, worst ${Math.round(watch.worst)} ms, ${i.render.calls} calls, ${Math.round(i.render.triangles / 1000)}k tris, ${i.memory.geometries} geos, ${i.memory.textures} texs, cam y ${camera.position.y.toFixed(1)}`);
    watch.t0 = now; watch.n = 0; watch.worst = 0;
  }
  renderer.info.reset();
  dio.render(camera, now / 1000);
  requestAnimationFrame(frame);
}
const watch = { state: null, t0: 0, n: 0, worst: 0, last: 0 }; // (the crash log's frame watch)
resize();
placeBall(TEE[0], TEE[1]);
requestAnimationFrame(frame);
if (round.strokes[holeIdx] === 0 && round.phase === 'long' && round.ball[0] === hole.tee[0] && round.ball[1] === hole.tee[1]) flyover();
else if (round.phase === 'short') { fovWant = FOV.plan; startShort(); }
else { fovWant = FOV.plan; startAim(); }
window.__app = { cupDrop, placeBall, setBallScale: (s) => { ballScale = s; }, get meter() { return meter; }, DECOR, get design() { return design; }, get designPiece() { return designPiece; }, startDesign, SKY, dio, look, round, camera, cam, get viewOffset() { return viewOffset; }, get state() { return state; }, G, course, hole, stopMeter, tapAt: (x, z) => (state === 'aim' ? tapAim({ x, z }) : state === 'short' ? tapShort({ x, z }) : state === 'design' ? tapDesign({ x, z }) : null), get spots() { return spots; }, get sSel() { return sSel; } }; // (for tests)
