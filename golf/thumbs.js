// Relay Golf: the home page's hole pictures, rendered with the game's own look (diorama.js) on the game's own board
// (board.js: forest ring, display-only trees, the green's detail). Each hole is built as the golfer will face it (seed
// plus the chain's features), in the course's time of day and weather, and seen through the game's plan camera angle.
// Renders are cached in localStorage by the layout they show, so a page load after the first costs nothing; until a
// render is ready the 2D tile picture screens.js drew stays in the canvas.
// screens.js marks each canvas with `canvas.__thumb = { courseId, hole, feats }`.
import * as THREE from 'three';
import { createDiorama, DEFAULTS, TIMES, WEATHER } from './diorama.js';
import { courseSky } from './sky.js';
import { holeBoard } from './board.js';

const G = window.RelayGolf;
const VERSION = 6; // (forest ring: 18 tiles, wide enough for a tall hole in a wide card)
const PW = 360, PH = 300; // (the picture's size, whatever the canvas: it's drawn in to cover it)
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch {
      // (full: drop older pictures, then try once more)
      try { for (const key of Object.keys(localStorage)) if (key.startsWith('relay-golf-thumb:')) localStorage.removeItem(key); localStorage.setItem(k, v); } catch { /* not cached */ }
    }
  },
};

function paint(canvas, src) {
  const img = new Image();
  img.onload = () => {
    // (the canvas's own size now, at the screen's pixel density; the picture centred and cropped to cover it)
    const dpr = window.devicePixelRatio || 1, w = Math.round((canvas.clientWidth || 100) * dpr), h = Math.round((canvas.clientHeight || 96) * dpr);
    canvas.width = w; canvas.height = h;
    const s = Math.max(w / img.width, h / img.height), g = canvas.getContext('2d');
    g.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
  };
  img.src = src;
}

let renderer = null;
const TILT = (24 * Math.PI) / 180, FOV = 32; // (the game's plan camera: app.js)
function renderHole({ courseId, hole, feats }, w, h) {
  const B = holeBoard(G, hole, feats, { forest: 18 }), L = B.L, W = G.W, H = G.H, TEE = hole.tee, CUP = hole.cup;
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  renderer.setPixelRatio(1); renderer.setSize(w, h, false);
  // The course's own time of day and weather, as the game draws them.
  const sky = courseSky(courseId), look = { ...DEFAULTS };
  Object.assign(look, TIMES[sky.time]); WEATHER[sky.weather](look);
  look.shells = Math.min(look.shells, 6);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(FOV, w / h, 0.1, 300);
  const dio = createDiorama({ renderer, scene, settings: look, origin: [-0.5 - B.FOREST, -0.5 - B.FOREST], quality: { sub: 6, px: 16, shadow: 2048, canopy: 2, fuzzShells: 1 }, map: B.map });
  dio.build(); dio.resize();
  // The pin: a white pole with a red flag.
  const gy = dio.heightAt(CUP[0], CUP[1]);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.6, 6), new THREE.MeshLambertMaterial({ color: '#ffffff' }));
  pole.position.set(CUP[0], gy + 0.8, CUP[1]);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.38), new THREE.MeshLambertMaterial({ color: '#E8604C', side: THREE.DoubleSide }));
  flag.position.set(CUP[0] + 0.3, gy + 1.4, CUP[1]);
  scene.add(pole, flag);
  // Frame the hole the way the plan camera does (tilted 24° from overhead, looking up the map), close enough that the
  // tee, cup and every fairway, green and bunker tile just fit.
  const pts = [TEE, CUP];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ('FGS'.includes(L.grid[y][x])) pts.push([x, y]);
  const P = pts.map(([x, z]) => new THREE.Vector3(x, dio.heightAt(x, z), z));
  const box = new THREE.Box3().setFromPoints(P), mid = box.getCenter(new THREE.Vector3());
  const back = new THREE.Vector3(0, Math.cos(TILT), Math.sin(TILT));
  const fits = (dist) => {
    camera.position.copy(mid).addScaledVector(back, dist); camera.lookAt(mid); camera.updateMatrixWorld();
    return P.every((p) => { const v = p.clone().project(camera); return Math.abs(v.x) < 0.94 && Math.abs(v.y) < 0.92; });
  };
  let lo = 4, hi = 160;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
  fits(hi);
  // (the fog is accumulated over frames, as in the game: let it settle)
  for (let f = 0; f < (look.fog > 0 ? 24 : 1); f++) dio.render(camera, 0);
const url = renderer.domElement.toDataURL('image/jpeg', 0.86);
  scene.traverse((n) => {
    if (n.geometry) n.geometry.dispose();
    if (n.material) for (const m of [].concat(n.material)) { for (const v of Object.values(m)) if (v && v.isTexture) v.dispose(); if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u.value && u.value.isTexture) u.value.dispose(); m.dispose(); }
  }, 30);
  return url;
}

try { for (const k of Object.keys(localStorage)) if (k.startsWith('relay-golf-thumb:') && !k.startsWith(`relay-golf-thumb:${VERSION}:`)) localStorage.removeItem(k); } catch { /* no storage */ } // (older pictures)
const jobs = [...document.querySelectorAll('canvas')].filter((c) => c.__thumb);
const todo = [];
for (const cv of jobs) {
  const t = cv.__thumb, L = G.layoutOf(t.hole, t.feats);
  const key = `relay-golf-thumb:${VERSION}:${t.courseId}:${hash(L.grid.join(''))}`;
  const hit = store.get(key);
  if (hit) paint(cv, hit); else todo.push({ cv, t, key });
}
// One hole at a time, yielding between them, so the page stays responsive while they render.
(function next() {
  const job = todo.shift();
  if (!job) { if (renderer) { renderer.dispose(); renderer.forceContextLoss(); renderer = null; } return; }
  setTimeout(() => {
    try {
      const url = renderHole(job.t, PW, PH);
      store.set(job.key, url); paint(job.cv, url);
    } catch (e) { console.warn('hole picture', e); }
    next();
  }, 30);
})();
