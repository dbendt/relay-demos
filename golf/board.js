// Relay Golf: the board a hole is drawn on, shared by the game (app.js) and the home page's hole pictures (thumbs.js).
// The hole plus a ring of forest, display-only trees in the gaps nobody plays, and round the cup the short-game map's
// tiles and slopes. holeBoard returns the diorama's `map` and the short-map helpers the game uses.
export const EX = 2.5; // slopes drawn 2.5 times taller than they are, so they read on a phone

export function holeBoard(G, hole, features, { forest = 7 } = {}) {
  const L = G.layoutOf(hole, features), W = G.W, H = G.H, CUP = hole.cup, TEE = hole.tee;
  const S = G.shortOf(hole, features);
  const SN = G.SN, SC = G.SC, SCALE = G.SCALE;
  const sToW = (sx, sy) => [CUP[0] + (sx - SC) / SCALE, CUP[1] + (sy - SC) / SCALE];
  const wToS = (x, z) => [SC + (x - CUP[0]) * SCALE, SC + (z - CUP[1]) * SCALE];
  const hCupS = S.h[SC][SC];
  // The green's height relative to the cup (exaggerated by EX), from the engine's short-map heights.
  function shortRel(sx, sy) {
    const x = Math.max(0, Math.min(SN - 1.001, sx)), y = Math.max(0, Math.min(SN - 1.001, sy));
    const ix = Math.floor(x), iy = Math.floor(y), ax = x - ix, ay = y - iy, h = S.h;
    const v = (h[iy][ix] * (1 - ax) + h[iy][Math.min(SN - 1, ix + 1)] * ax) * (1 - ay) + (h[Math.min(SN - 1, iy + 1)][ix] * (1 - ax) + h[Math.min(SN - 1, iy + 1)][Math.min(SN - 1, ix + 1)] * ax) * ay;
    return (v - hCupS) * EX;
  }
  // The board is the hole plus a ring of forest (FOREST tiles each side) the simulation knows nothing about: shots
  // can't reach it (anything that far is out of bounds), it only stops the course ending at the edge of the screen.
  const FOREST = forest;
  // Display-only trees in the gaps nobody plays. Realistic play is simulated on this hole as this golfer faces it: from the
  // tee, mostly the best shot (sometimes the next few), with timing spread like a real swing, many times over. Rough
  // tiles no simulated ball came within 2 tiles of get trees. (A ball can still end up there after a truly wild run of
  // shots: then the trees beside it step aside, see hideTreesNear.)
  const DECOR = (() => {
    const key = (x, y) => `${x},${y}`, togo = G.togoMap(L), seen = new Set();
    let s = 12345; const rand = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
    const gauss = () => (rand() + rand() + rand() - 1.5) * 0.8;
    for (let n = 0; n < 160; n++) {
      let p = TEE.slice();
      for (let k = 0; k < 10; k++) {
        seen.add(key(p[0], p[1]));
        if (Math.hypot(p[0] - CUP[0], p[1] - CUP[1]) <= G.ZONE_R) break;
        // (every spot a golfer is offered from here counts as played, not only the shot the simulation takes)
        const opts = G.actionsAt(L, p).map((a) => { const r = G.shot(L, p, a); seen.add(key(r.pos[0], r.pos[1])); return { a, v: 1 + r.penalty + (r.holed ? 0 : togo[key(r.pos[0], r.pos[1])] ?? 9) }; }).sort((u, v) => u.v - v.v);
        if (!opts.length) break;
        const pick = opts[Math.min(opts.length - 1, Math.floor(rand() * rand() * 4))].a;
        const r = G.shot(L, p, { ...pick, timing: Math.max(-1, Math.min(1, gauss())) });
        p = r.pos;
      }
    }
    const out = new Set(), near = (x, y) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (seen.has(key(x + dx, y + dy))) return true; return false; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!'RK'.includes(L.grid[y][x]) || Math.hypot(x - CUP[0], y - CUP[1]) <= G.ZONE_R + 1 || near(x, y)) continue;
      out.add(key(x, y));
    }
    return out;
  })();
  const isDecor = (x, y) => DECOR.has(`${x},${y}`);
  const forestAt = (x, z) => { const h = (Math.imul(x + 101, 73856093) ^ Math.imul(z + 211, 19349663)) >>> 0; return h % 100 < 82 ? 'T' : 'K'; };
  const map = {
    W: W + 2 * FOREST, H: H + 2 * FOREST,
    at: (bx, bz) => {
      const x = bx - FOREST, z = bz - FOREST;
      if (x < 0 || z < 0 || x >= W || z >= H) return forestAt(x, z);
      if (isDecor(x, z)) return forestAt(x, z);
      return x === TEE[0] && z === TEE[1] ? 'E' : L.grid[z][x] === 'P' ? 'T' : L.grid[z][x];
    },
    decor: (bx, bz) => isDecor(bx - FOREST, bz - FOREST),
    lowDetail: (bx, bz) => { const x = bx - FOREST, z = bz - FOREST; return x < 0 || z < 0 || x >= W || z >= H || isDecor(x, z); },
    // Round the cup the board takes the short-game map's tiles (under debris, the ground round it) and slopes, easing back to the
    // long map at the edge of the short-game area.
    detail: {
      at: (bx, bz) => {
        const [sx, sy] = wToS(bx - 0.5 - FOREST, bz - 0.5 - FOREST), tx = Math.round(sx), ty = Math.round(sy);
        if (tx < 0 || ty < 0 || tx >= SN || ty >= SN) return null;
        const st = S.grid[ty][tx];
        if (st === 'O') return null;
        if (st !== 'D') return st;
        const n = {}; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const q = (S.grid[ty + dy] || '')[tx + dx]; if (q && q !== 'D' && q !== 'O') n[q] = (n[q] || 0) + 1; }
        return Object.keys(n).sort((a, b) => n[b] - n[a])[0] || 'G';
      },
      weight: (bx, bz) => { const r = Math.hypot(bx - 0.5 - FOREST - CUP[0], bz - 0.5 - FOREST - CUP[1]); return 1 - Math.min(1, Math.max(0, (r - (G.ZONE_R - 0.8)) / 1.0)); },
      height: (bx, bz) => {
        const gx = bx - 0.5 - FOREST, gz = bz - 0.5 - FOREST, r = Math.hypot(gx - CUP[0], gz - CUP[1]), k = Math.min(1, Math.max(0, (r - (G.ZONE_R - 0.6)) / 1.1));
        if (k >= 1) return 0;
        const [sx, sy] = wToS(gx, gz);
        return shortRel(sx, sy) * (1 - k);
      },
    },
  };
  return { L, S, SN, SC, SCALE, sToW, wToS, shortRel, DECOR, isDecor, FOREST, map };
}
