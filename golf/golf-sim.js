// Relay Golf engine (prototype): seeded three-hole courses, a deterministic shot model, the features golfers leave for
// each other, the par solver, the golfer's view (what they can and can't see), and credit for features.
// Shared by the browser (global RelayGolf) and Node (require). See "Relay Golf — Concept.md".
(function (root) {
  'use strict';

  const W = 22, H = 46; // tiles per hole: x across, y down the page (the tee near the bottom, the cup near the top)
  const GREEN_R = 4.5; // a green is every tile within this distance of the cup
  const PIN_GAP = 3; // a full shot can't come to rest closer to the cup than this: it rolls on past
  const TAP_IN = 2.5; // a putt drops only from this close; longer putts reaching the cup stop beside it
  const MAX_STROKES = 10; // a hole is picked up at this many

  // Terrain: F fairway, R rough, S sand, W water, T tree, G green, M the suspicious hill's mound (plays as rough).
  const AIM_CONE = 45; // degrees: the golfer aims within this cone toward the cup (unless a tree is in the way)
  const TEE_BOX = 2;
  const ROUGH_LOSS = 1; // tiles of carry lost from the light rough (or a hill's mound); the wood can't be played from it
  const LIGHT_W = 2; // the light rough: rough within this many tiles of the fairway, green or tee; beyond it, thick rough (K)
  // Thick rough halves the next carry, as sand does, and nothing rolls in it.
  const BANK_ARC = Math.PI / 2; // a backstop guards this much of the green's edge, centred on its side // no harm within this many tiles of the tee
  const WIND_R = 4.5; // a wind feature's cone: this long, 90° wide
  // How far a gust carries a shot aimed into its cone: long clubs more than short ones, as real wind does.
  const GUST = { long: 3, short: 2 }; // driver and wood: 3 tiles; irons: 2 (the wedge and putts: none)
  const gustPush = (carry) => (carry >= 10 ? GUST.long : GUST.short);
  // Shapes for sand and water, as tile offsets before rotation (a quarter turn per `dir`). The first of each is the
  // default; a shape may cost more than the feature's base price.
  const rect = (w, h) => { const o = []; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o.push([x, y]); return o; };
  const SHAPES = {
    bunker: {
      pot: { label: 'Pot', tiles: rect(2, 2) },
      strip: { label: 'Strip', tiles: rect(4, 1) },
      waste: { label: 'Waste area', tiles: rect(3, 3), cost: 2 },
    },
    water: {
      creek: { label: 'Creek', tiles: rect(5, 1) },
      pond: { label: 'Pond', tiles: rect(3, 2) },
      bend: { label: 'Bend', tiles: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [2, 3]] },
      lake: { label: 'Lake', tiles: rect(4, 3), cost: 3 },
    },
    // A ramp's size; a bigger slope runs the ball further (`run`). Ramps aren't turned by shape: `dir` is the fall line.
    ramp: {
      single: { label: 'Single', tiles: rect(1, 1), run: 2, fixed: true },
      pad: { label: 'Pad (2×2)', tiles: rect(2, 2), run: 3, fixed: true },
      slope: { label: 'Slope (3×3)', tiles: rect(3, 3), run: 4, cost: 2, fixed: true },
    },
    bank: {
      short: { label: 'Bank (4)', tiles: rect(4, 1) },
      diagonal: { label: 'Diagonal (4)', tiles: [[0, 0], [1, 1], [2, 2], [3, 3]] },
      long: { label: 'Bank (7)', tiles: rect(7, 1), cost: 2 },
    },
    trees: {
      single: { label: 'Tree', tiles: rect(1, 1) },
      pair: { label: 'Pair', tiles: rect(2, 1) },
      copse: { label: 'Copse (2×2)', tiles: rect(2, 2), cost: 2 },
    },
  };
  const WATER_SHAPES = SHAPES.water; // (older name)
  const shapeOf = (f) => SHAPES[f.kind] && SHAPES[f.kind][f.shape];
  const costOf = (f) => (shapeOf(f) && shapeOf(f).cost) || FEATURES[f.kind].cost;
  // P: trees a golfer planted. Unlike the seed's trees (T), a ball can end up under them, and plays out from there.
  const TERRAIN = { F: 'Fairway', R: 'Rough', K: 'Thick rough', S: 'Sand', W: 'Water', T: 'Trees', G: 'Green', M: 'Hill', P: 'Planted trees' };
  const PUNCH = 3; // from under planted trees: a punch out, any direction, carrying at most this far, with no roll

  // Clubs: how far a shot carries (tiles), how far it rolls on fairway or green, whether the wind moves it, and where it
  // may be hit from (tee: only the tee; TF: the tee or fairway; anywhere otherwise). As in golf: the driver off the
  // tee of a par 4 or 5, the wood off the tee or fairway, irons into the green, the putter on it.
  // Every full club can also be hit with a three-quarter swing (`swing: 'three'`): 75% of the carry, the same roll.
  const CLUBS = {
    driver: { label: 'Driver', carry: 13, roll: 2, wind: true, from: 'tee', maxMiss: 2 },
    wood: { label: 'Wood', carry: 11, roll: 2, wind: true, from: 'TF', maxMiss: 2 },
    long: { label: 'Long iron', carry: 8, roll: 1, wind: true, maxMiss: 2 },
    short: { label: 'Short iron', carry: 5, roll: 1, wind: true, maxMiss: 1 },
    wedge: { label: 'Wedge', carry: 3, roll: 0, wind: false, maxMiss: 1 },
    putter: { label: 'Putter', putt: true, max: 5, from: 'G' },
  };
  const SWINGS = { full: { label: 'Full', k: 1 }, three: { label: '¾', k: 0.75 } };
  // Shaping a full shot (4 October 2026): a draw curves left of the line it's aimed along and runs on a tile further;
  // a fade curves right and stops a tile sooner. CURVE is how far it bends by the time it lands: 2 tiles off the driver
  // and wood, 1 off an iron; the wedge and putter don't shape. The flight really bends (trees are checked along the
  // curve), so a shot can be aimed past a tree and shaped back round it.
  const CURVE = { driver: 2, wood: 2, long: 1, short: 1 };
  const SHAPES_OF = { draw: { label: 'Draw', side: -1, roll: 1 }, fade: { label: 'Fade', side: 1, roll: -1 } };
  // The swing meter: every full shot carries a timing, -1 (as early as it gets) to 1 (as late), 0 perfect. Within
  // TIMING.perfect of 0 the shot lands as previewed; within TIMING.near it goes 1 tile off line; beyond, 2 (capped by the
  // club's maxMiss). Early pulls left of the line of flight, late pushes right. Par is solved for perfect timing, so a
  // miss costs the golfer, and a hazard beside the ideal landing earns its author those strokes.
  const TIMING = { perfect: 0.2, near: 0.6 };
  function missOf(club, timing) {
    const c = CLUBS[club];
    if (!c || c.putt || !timing) return 0;
    const a = Math.abs(timing), k = a < TIMING.perfect ? 0 : a < TIMING.near ? 1 : 2;
    return Math.sign(timing) * Math.min(k, c.maxMiss || 0);
  }
  const carryOf = (club, swing) => Math.max(1, Math.round(CLUBS[club].carry * (SWINGS[swing] || SWINGS.full).k));

  // 32 aiming directions, 0 = east, counterclockwise; y grows down, so north is -y.
  const NDIR = 32;
  const DIRS = Array.from({ length: NDIR }, (_, i) => { const a = (i * 2 * Math.PI) / NDIR; return [Math.cos(a), -Math.sin(a)]; });
  // 8 orientations for features (ramp, wind), as whole-tile steps.
  const ORIENT = [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]];
  const ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];

  // What a golfer can leave behind, paid for in strokes on their own card.
  const FEATURES = {
    // `on`: the seed terrain every tile of the feature must sit on (F fairway, R rough, S sand, G green).
    bunker: { label: 'Bunker', cost: 1, kind: 'harm', on: 'FRK', oriented: 'rot4', shaped: true, desc: 'Sand on fairway or rough: a pot (2×2), a strip (4×1) or a waste area (3×3, +2).' },
    water: { label: 'Water', cost: 2, kind: 'harm', on: 'FRK', oriented: 'rot4', shaped: true, desc: 'Water on fairway or rough: a creek (5×1), a pond (3×2), a bend or a lake (4×3, +3).' },
    wind: { label: 'Wind', cost: 1, kind: 'either', on: 'FRSGK', oriented: 'dir', area: true, desc: `A gust over a cone ${WIND_R} tiles long, in any of 8 directions. A full shot whose flight passes through the cone (anywhere along its way, not only where it lands) is carried ${GUST.long} tiles further in the wind's direction with the driver or wood, ${GUST.short} with an iron; the wedge and putts are unaffected. With the shot it's a free boost; across it, a push sideways; against it, a shorter carry.` },
    hill: { label: 'Suspicious hill', cost: 1, kind: 'bluff', on: 'FRSGK', oriented: 'rot4', rotLabels: ['↑', '→', '↓', '←'], desc: 'A mound that hides the 3×2 ground beyond it, on the side it faces (turn it), until scouted or approached. On fairway, rough or sand, outside the short-game area. The mound plays as rough.' },
    ramp: { label: 'Ramp', cost: 1, kind: 'either', on: 'FRGK', oriented: 'dir', shaped: true, hidden: true, desc: 'A slope: a single tile, a 2×2 pad or a 3×3 slope (+2). On fairway or rough, outside the short-game area, any ball that lands or rolls onto it runs on its way (2 tiles, 3 off a pad, 4 off a slope), and which way is hidden until scouted. On the green or fringe, 2 tiles or more from the cup, it tilts the short game\'s ground its way: putts break along it, in plain sight.' },
    trees: { label: 'Trees', cost: 1, kind: 'harm', on: 'RK', free4: true, desc: `Trees planted in the rough, light or thick: any 4 connected tiles you choose. A shot flying into them drops underneath, and from there the golfer punches out, any direction but ${PUNCH} tiles at most.` },
    bank: { label: 'Fairway bank', cost: 0, kind: 'boon', on: 'RKS', free4: true, desc: 'A low bank beside the fairway: any 4 connected tiles of rough (light or thick) or sand you choose, at least one of them touching the fairway. A shot aimed to land on the fairway whose flight crosses it, finishing in the rough, a bunker or water beyond, is held on the fairway instead, and a ball rolling off the fairway into it stops. Shots aimed at the rough are unaffected. Run it out into the thick rough or over a fairway bunker to save pushed and pulled drives from them, and earn its author those strokes.' },
    backstop: { label: 'Backstop', cost: 1, kind: 'boon', on: 'G', side: true, desc: 'A bank along one side of the green (north, north-east, east and so on), on the green\'s outermost ring of tiles, a quarter of the way round (90°). A shot aimed to land on the green that would leave it through that side (mistimed, blown by the wind, or running through) stops on the bank instead. A shot aimed short of the green, or a ball coming from off it, is unaffected. A well-struck shot never needs it; it saves the misses, and earns its author those strokes.' },
    calm: { label: 'Calm winds', cost: 1, kind: 'boon', on: 'FRSGK', area: true, desc: 'No wind, the hole\'s or a gust\'s, on shots aimed into this 3×3 patch.' },
  };

  // ---------- seeded randomness ----------
  function hashStr(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const key = (x, y) => `${x},${y}`;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  // The tiles on the straight line from pos toward the cup, up to max tiles (ending on the cup if it's in reach).
  function lineToCup(pos, cup, max) {
    const len = dist(pos, cup), out = [];
    for (let i = 1; i <= Math.ceil(Math.min(len, max)); i++) {
      const p = i >= len ? cup.slice() : [Math.round(pos[0] + ((cup[0] - pos[0]) * i) / len), Math.round(pos[1] + ((cup[1] - pos[1]) * i) / len)];
      const last = out[out.length - 1];
      if (!(last && last[0] === p[0] && last[1] === p[1]) && !(p[0] === pos[0] && p[1] === pos[1])) out.push(p);
    }
    return out;
  }
  // The nearest of the aiming directions to the line toward the cup (for logs and the aim rule).
  const dirToCup = (pos, cup) => { const a = Math.atan2(-(cup[1] - pos[1]), cup[0] - pos[0]); return ((Math.round(a / ((2 * Math.PI) / NDIR)) % NDIR) + NDIR) % NDIR; };
  const isTee = (L, p) => p[0] === L.tee[0] && p[1] === L.tee[1];
  const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

  // ---------- the course ----------
  // A hole is built for a par, as real holes are, by its length from tee to cup:
  //   par 3: 8-11 tiles, an iron from the tee onto the green, then two putts;
  //   par 4: 21-28, a drive and an approach;
  //   par 5: 33-40, a drive, a wood and a short approach.
  // Fours and fives bend (a dogleg) along a fairway 5 tiles wide; two in five also have a second, narrower fairway
  // round the other side, so there are two ways to the green. The straight line (the shortcut) runs through the rough,
  // where the seed puts its pond or bunker and most of its trees: the classic "lay up or go for it". Threes play over
  // rough, often over water. The solver must agree with the intended par, or the hole is drawn again.
  const LENGTHS = { 3: [8, 11], 4: [21, 28], 5: [33, 40] };
  function genHole(rng, par) {
    const [lo, hi] = LENGTHS[par];
    let best = null, tried = 0;
    for (let attempt = 0; attempt < 400; attempt++) {
      const g = Array.from({ length: H }, () => Array(W).fill('R'));
      const tee = [5 + Math.floor(rng() * (W - 10)), H - 2];
      const len = lo + Math.floor(rng() * (hi - lo + 1));
      // The cup sits at least ZONE_R tiles inside every edge, so the whole short-game map lies on the course.
      const cx = ZONE_R + Math.floor(rng() * (W - 2 * ZONE_R));
      const dy = Math.sqrt(Math.max(0, len * len - (cx - tee[0]) ** 2));
      const cup = [cx, Math.round(tee[1] - dy)];
      if (cup[1] < ZONE_R + 1 || cup[1] > H - 2 - ZONE_R) continue;
      if (dy < len * 0.6) continue; // holes run up the map, not across it
      const paint = (a, b, r, t) => {
        const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) * 2 || 1;
        for (let i = 0; i <= n; i++) {
          const x = Math.round(a[0] + ((b[0] - a[0]) * i) / n), y = Math.round(a[1] + ((b[1] - a[1]) * i) / n);
          for (let ddx = -r; ddx <= r; ddx++) for (let ddy = -r; ddy <= r; ddy++) if (Math.hypot(ddx, ddy) <= r + 0.5 && inside(x + ddx, y + ddy) && g[y + ddy][x + ddx] === 'R') g[y + ddy][x + ddx] = t;
        }
      };
      const put = (x, y, t, over) => { if (inside(x, y) && (over || g[y][x] === 'R') && !(x === tee[0] && y === tee[1]) && dist([x, y], cup) > GREEN_R) g[y][x] = t; };
      const sc = [Math.round((tee[0] + cup[0]) / 2), Math.round((tee[1] + cup[1]) / 2)];
      const mids = []; // the bends of the fairways, for fours and fives
      if (par === 3) {
        // A tee box, then rough (and often water or sand) up to an apron in front of the green.
        paint(tee, [tee[0], tee[1] - 1], 1, 'F');
        const apron = [Math.round(cup[0] + (tee[0] - cup[0]) * (GREEN_R + 1.5) / len), Math.round(cup[1] + (tee[1] - cup[1]) * (GREEN_R + 1.5) / len)];
        paint(apron, apron, 2, 'F');
        if (rng() < 0.6) for (let ddx = -2; ddx <= 2; ddx++) for (let ddy = 0; ddy <= 1; ddy++) put(sc[0] + ddx, sc[1] + ddy, 'W', false);
        else for (let ddx = -1; ddx <= 1; ddx++) put(sc[0] + ddx, sc[1], 'S', false);
      } else {
        const side = rng() < 0.5 ? -1 : 1;
        const bend = (s, k) => [Math.max(2, Math.min(W - 3, Math.round((tee[0] + cup[0]) / 2 + s * k))), Math.round((tee[1] + cup[1]) / 2 + (rng() * 6 - 3))];
        mids.push(bend(side, 5 + rng() * 3));
        paint(tee, mids[0], 2, 'F'); paint(mids[0], cup, 2, 'F');
        if (rng() < 0.4) { mids.push(bend(-side, 4 + rng() * 3)); paint(tee, mids[1], 1, 'F'); paint(mids[1], cup, 1, 'F'); }
        if (rng() < 0.6) { for (let ddx = -1; ddx <= 1; ddx++) for (let ddy = -1; ddy <= 1; ddy++) put(sc[0] + ddx, sc[1] + ddy, 'W', false); }
        else { for (let ddx = -1; ddx <= 1; ddx++) for (let ddy = 0; ddy <= 1; ddy++) put(sc[0] + ddx, sc[1] + ddy, 'S', false); }
      }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (dist([x, y], cup) <= GREEN_R) g[y][x] = 'G';
      // A greenside bunker, just off the green (on the side with room for it).
      const off = Math.ceil(GREEN_R); // right at the green's edge, where a missed approach finishes
      let side = rng() < 0.5 ? -1 : 1;
      if (!inside(cup[0] + side * off, cup[1])) side = -side;
      const gb = [cup[0] + side * off, cup[1] + 1];
      put(gb[0], gb[1], 'S', true); put(gb[0], gb[1] + 1, 'S', true);
      // Strategic hazards, placed where they make the golfer choose: fairway bunkers at driving distance, a creek
      // across a par 5's lay-up, water or sand on the other side of the green, and a par 3's green guarded front left
      // and right. Each is on one side of the ideal line or demands a carry, never the whole hole.
      const route = [tee].concat(mids.slice(0, 1), [cup]);
      const along = (d) => {
        for (let i = 0; i < route.length - 1; i++) {
          const a = route[i], b = route[i + 1], l = dist(a, b);
          if (d <= l || i === route.length - 2) { const k = Math.min(1, d / l); return { p: [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k)], u: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] }; }
          d -= l;
        }
        return { p: cup.slice(), u: [0, -1] };
      };
      const patchAt = (c, w, h, t) => { for (let ddx = 0; ddx < w; ddx++) for (let ddy = 0; ddy < h; ddy++) put(c[0] + ddx, c[1] + ddy, t, true); };
      if (par > 3) {
        // Fairway bunkers where drives land, one each side, staggered.
        for (const [d, s] of [[13 + rng() * 2, rng() < 0.5 ? -1 : 1], [15 + rng() * 2, 0]]) {
          const { p, u } = along(d), side = s || (rng() < 0.5 ? -1 : 1), n = [-u[1] * side, u[0] * side];
          if (rng() < 0.85) patchAt([Math.round(p[0] + n[0] * 2), Math.round(p[1] + n[1] * 2)], 2, 2, 'S');
        }
        // A par 5: a creek across the fairway at the lay-up, to carry or lay up short of.
        if (par === 5 && rng() < 0.6) {
          const { p, u } = along(24 + rng() * 3), n = [-u[1], u[0]];
          for (let k = -3; k <= 3; k++) put(Math.round(p[0] + n[0] * k), Math.round(p[1] + n[1] * k), 'W', true);
        }
      }
      // The green's other side: water on longer holes, sand on threes; a three also gets a bunker short of the green.
      const gs = [cup[0] - side * off, cup[1] + (rng() < 0.5 ? 0 : 1)];
      patchAt(gs, 2, 2, par > 3 && rng() < 0.6 ? 'W' : 'S');
      if (par === 3) { const { p } = along(Math.max(2, dist(tee, cup) - GREEN_R - 1.5)); patchAt([p[0] + (rng() < 0.5 ? -2 : 1), p[1]], 2, 1, 'S'); }
      // Trees in the rough, thickest near the shortcut, and only where they matter: between the tee and the hole (the
      // rows from just in front of the tee up to the cup, across the corridor the hole plays through, 3 tiles either
      // side). Scenery trees elsewhere can be drawn later without being part of the simulation.
      const xs = [tee[0], cup[0]].concat(mids.map((m) => m[0]));
      const x0 = Math.max(0, Math.min(...xs) - 3), x1 = Math.min(W - 1, Math.max(...xs) + 3);
      const y0 = cup[1], y1 = tee[1] - 1;
      const trees = par === 3 ? 30 : 70;
      for (let i = 0; i < trees; i++) {
        const near = rng() < 0.4;
        const x = near ? sc[0] + Math.floor(rng() * 7) - 3 : x0 + Math.floor(rng() * (x1 - x0 + 1));
        const y = near ? sc[1] + Math.floor(rng() * 7) - 3 : y0 + Math.floor(rng() * (y1 - y0 + 1));
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        put(x, y, 'T', false);
      }
      g[tee[1]][tee[0]] = 'F';
      // Rough more than LIGHT_W tiles from any fairway, green or tee is thick rough.
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (g[y][x] !== 'R') continue;
        let near = false;
        for (let dy = -LIGHT_W; dy <= LIGHT_W && !near; dy++) for (let dx = -LIGHT_W; dx <= LIGHT_W && !near; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && xx >= 0 && yy < H && xx < W && (g[yy][xx] === 'F' || g[yy][xx] === 'G')) near = true;
        }
        if (!near) g[y][x] = 'K';
      }
      const wind = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]][Math.floor(rng() * 6)];
      const seed = seedFeatures(rng, g, tee, cup, par, mids);
      const short = genShort(rng, g, cup);
      short.estimate = true;
      const hole = { grid: g.map((r) => r.join('')), tee, cup, wind, par, seed, short, bends: mids.map((m) => m.slice()) };
      if (parOf(layoutOf(hole, [])) !== par) continue;
      if (!fairTee(hole)) continue; // the natural tee shot must have somewhere good to go
      const it = interestOf(hole);
      hole.interest = it;
      hole.regrow = () => genShort(rng, g, cup);
      if (it.score >= MIN_INTEREST && settle(hole, par)) return hole;
      if (it.score < MIN_INTEREST && (!best || it.score > best.interest.score)) best = hole;
      if (++tried >= 40 && best && settle(best, par)) return best; // the most interesting of 40 playable draws
    }
    if (best && settle(best, par)) return best;
    throw new Error(`Could not generate a par ${par} hole.`);
  }
  // The seed's own hills and ramps (owner 'seed': they never age out and earn no one credit). Hills stand just short
  // of the landing zones, facing the green, so the ground a drive or approach comes down on is hidden from the tee.
  // Ramps lie on the fairway near those zones, and sometimes on the green, in any size; their fall line is hidden until
  // scouted. Landing zones: a third to a half of the way on a par 3; a drive out and an approach in on longer holes.
  function seedFeatures(rng, g, tee, cup, par, mids) {
    const out = [], used = new Set();
    const route = [tee].concat(mids.slice(0, 1), [cup]);
    const along = (d) => { // the point d tiles along the route from the tee
      for (let i = 0; i < route.length - 1; i++) {
        const a = route[i], b = route[i + 1], l = dist(a, b);
        if (d <= l || i === route.length - 2) { const k = Math.min(1, d / l); return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k)]; }
        d -= l;
      }
      return cup.slice();
    };
    const total = route.slice(1).reduce((s, p, i) => s + dist(route[i], p), 0);
    const zones = par === 3 ? [total * 0.45] : par === 4 ? [14, total - 9] : [14, 25, total - 9];
    const free = (x, y, allowed) => inside(x, y) && dist([x, y], cup) > ZONE_R && allowed.includes(g[y][x]) && cheb([x, y], tee) > TEE_BOX + 1 && !(x === cup[0] && y === cup[1]) && !used.has(key(x, y));
    const take = (tiles) => tiles.forEach(([x, y]) => used.add(key(x, y)));
    const facing = (from) => { const v = [cup[0] - from[0], cup[1] - from[1]]; return Math.abs(v[1]) >= Math.abs(v[0]) ? (v[1] < 0 ? 0 : 2) : (v[0] > 0 ? 1 : 3); };
    // Hills: just short of a landing zone, facing the green.
    // Base counts by par, plus 2-3 more of each anywhere along the route (`extra`).
    const extra = () => 2 + (rng() < 0.5 ? 1 : 0);
    const anywhere = () => 5 + rng() * Math.max(1, total - 10); // a point along the route, clear of tee and green
    const hillsAtZones = par === 3 ? 1 : par === 4 ? 1 + (rng() < 0.5 ? 1 : 0) : 2;
    const hills = hillsAtZones + extra();
    for (let i = 0; i < hills; i++) {
      const z = along(i < hillsAtZones ? zones[Math.floor(rng() * zones.length)] - 3 + rng() * 2 : anywhere());
      for (let t = 0; t < 20; t++) {
        const x = z[0] + Math.floor(rng() * 5) - 2, y = z[1] + Math.floor(rng() * 3) - 1;
        if (!free(x, y, 'FRK')) continue;
        const f = { id: `h${i}`, owner: 'seed', kind: 'hill', x, y, dir: facing([x, y]) };
        out.push(f); take([[x, y]]); break;
      }
    }
    // Ramps: near the landing zones, or (one time in three) on the green.
    const rampsAtZones = par === 3 ? (rng() < 0.6 ? 1 : 0) : par === 4 ? 1 + (rng() < 0.5 ? 1 : 0) : 2 + (rng() < 0.5 ? 1 : 0);
    const ramps = rampsAtZones + extra();
    for (let i = 0; i < ramps; i++) {
      const u = rng(), shape = u < 0.5 ? 'single' : u < 0.85 ? 'pad' : 'slope';
      const onGreen = false; rng(); // (ramps used to go on greens; the short game has its own slopes now)
      const z = onGreen ? cup : along(i < rampsAtZones ? zones[Math.floor(rng() * zones.length)] : anywhere());
      for (let t = 0; t < 16; t++) {
        const x = z[0] + Math.floor(rng() * 7) - 3, y = z[1] + Math.floor(rng() * 7) - 3;
        const f = { id: `r${i}`, owner: 'seed', kind: 'ramp', shape, x, y, dir: Math.floor(rng() * 8) };
        const tiles = footprint(f);
        if (!tiles.every(([a, b]) => free(a, b, 'FRGK') && dist([a, b], cup) >= 1.5)) continue;
        out.push(f); take(tiles); break;
      }
    }
    return out;
  }
  // The seed's features plus the chain's on a hole (seed first; a chain feature never repeats a seed id).
  const withSeed = (hole, features) => (hole.seed || []).concat(features);

  // A fair tee shot: on a par 4 or 5 the driver (full or ¾) has at least one line onto the fairway with no penalty;
  // on a par 3 some club reaches the green. Otherwise every natural option from the tee is trouble.
  // anyClub: any club will do (the rule for golfers' features: they mustn't leave the tee with no good shot at all).
  function fairTee(hole, features, anyClub) {
    const L = layoutOf(hole, features || []);
    return actionsAt(L, hole.tee).some((a) => {
      if (hole.par > 3 && !anyClub && a.club !== 'driver') return false;
      const r = shot(L, hole.tee, a);
      return !r.penalty && terrainAt(L, r.pos[0], r.pos[1]) === (hole.par > 3 ? 'F' : 'G');
    });
  }
  // A hole was chosen on the short game's estimate: solve its short map and confirm par, growing a new short map (up to
  // four) if an awkward green changes it.
  function settle(hole, par) {
    for (let k = 0; k < 4; k++) {
      if (k) hole.short = hole.regrow();
      delete hole.short.estimate;
      if (parOf(layoutOf(hole, [])) === par) { delete hole.regrow; return true; }
    }
    hole.short.estimate = true;
    return false;
  }

  // A day's three holes always mix lengths: one of these orders.
  const PAR_SETS = [[4, 3, 5], [4, 4, 3], [5, 3, 4], [3, 4, 4], [4, 5, 3], [4, 3, 4]];

  const courseCache = {};
  function getCourse(id) {
    if (courseCache[id]) return courseCache[id];
    const m = /^links#(\d+)$/.exec(id || '');
    if (!m) throw new Error(`Unknown course "${id}". Use links#<n>.`);
    const rng = mulberry32(hashStr(id));
    const holes = PAR_SETS[Math.floor(rng() * PAR_SETS.length)].map((par) => genHole(rng, par));
    holes.forEach((h, i) => h.seed.forEach((f) => { f.hole = i; f.id = `s${i}${f.id}`; }));
    const course = { id, n: Number(m[1]), name: `Relay Links · course ${m[1]}`, holes, pars: holes.map((h) => parOf(layoutOf(h, []))) };
    courseCache[id] = course;
    return course;
  }

  // ---------- features on a hole ----------
  function footprint(f) {
    const [x, y] = [f.x, f.y];
    if (FEATURES[f.kind] && FEATURES[f.kind].free4 && Array.isArray(f.tiles)) return f.tiles.map((q) => q.slice()); // chosen tile by tile
    if (SHAPES[f.kind]) {
      const s = shapeOf(f);
      if (!s && f.kind === 'ramp') return [[x, y]]; // saved before ramp sizes
      if (s && s.fixed) return s.tiles.map(([dx, dy]) => [x + dx, y + dy]);
      if (!s && f.kind === 'bunker') return [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]; // saved before shapes
      if (!s) return (f.dir || 0) % 4 === 0 ? [[x, y], [x + 1, y]] : [[x, y], [x, y + 1]]; // the first prototype's 2-tile water
      return s.tiles.map(([dx, dy]) => { for (let r = 0; r < (f.dir || 0) % 4; r++) [dx, dy] = [-dy, dx]; return [x + dx, y + dy]; });
    }
    if (f.kind === 'wind') return windCone(f);
    if (f.kind === 'backstop') return bankTiles(f);
    if (f.kind === 'calm') { const out = []; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push([x + dx, y + dy]); return out; }
    return [[x, y]];
  }
  // The bank that holds a ball finishing off the green at p: the backstop on that side of the cup (by the nearest of the
  // eight sides), and the tile of it nearest p. Null when that side has none.
  function holdByBank(L, p) {
    if (!L.bankSides || !L.bankSides.length) return null;
    const v = [p[0] - L.cup[0], p[1] - L.cup[1]], vl = Math.hypot(v[0], v[1]) || 1;
    let best = null;
    for (const b of L.bankSides) {
      const [ux, uy] = ORIENT[b.side], ul = Math.hypot(ux, uy);
      if ((v[0] * ux + v[1] * uy) / (vl * ul) < Math.cos(BANK_ARC / 2) - 1e-9 || !b.tiles.length) continue; // not this bank's side
      const q = b.tiles.reduce((a, s) => (dist(s, p) < dist(a, p) ? s : a), b.tiles[0]);
      if (!best || dist(q, p) < dist(best, p)) best = q;
    }
    return best && best.slice();
  }
  // The fairway tile beside a fairway-bank tile where a held ball rests (the nearest; ties to the first found).
  function fairwayBeside(L, p) {
    let best = null;
    for (let r = 1; r <= LIGHT_W + 2 && !best; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const q = [p[0] + dx, p[1] + dy];
      if (terrainAt(L, q[0], q[1]) === 'F' && (!best || dist(q, p) < dist(best, p))) best = q;
    }
    return best;
  }
  // A backstop's tiles: the green's outermost ring (within a tile of its edge) on one side, BANK_ARC wide (90°: about
  // three of the eight sides), centred on the
  // feature's `side` (0 east, then counterclockwise in eighths: 2 north, 4 west, 6 south). f.x, f.y is the cup.
  function bankTiles(f) {
    const [ux, uy] = ORIENT[f.side || 0], ul = Math.hypot(ux, uy), out = [];
    const r = Math.ceil(GREEN_R);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const l = Math.hypot(dx, dy);
      if (l > GREEN_R || l <= GREEN_R - 1.2 || !inside(f.x + dx, f.y + dy)) continue;
      if ((dx * ux + dy * uy) / (l * ul) >= Math.cos(BANK_ARC / 2) - 1e-9) out.push([f.x + dx, f.y + dy]);
    }
    return out;
  }
  // A wind feature's cone: tiles within WIND_R of its spot and within 45° of its direction, plus the spot itself.
  function windCone(f) {
    const [ux, uy] = ORIENT[f.dir || 0], ul = Math.hypot(ux, uy), out = [[f.x, f.y]];
    const r = Math.ceil(WIND_R);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const l = Math.hypot(dx, dy);
      if (!l || l > WIND_R || !inside(f.x + dx, f.y + dy)) continue;
      if ((dx * ux + dy * uy) / (l * ul) >= Math.SQRT1_2 - 1e-9) out.push([f.x + dx, f.y + dy]);
    }
    return out;
  }
  // The ground a suspicious hill hides: the 3×2 tiles beyond it on the side it faces (dir: 0 up the page, then a
  // quarter turn clockwise each: right, down, left).
  const hiddenBy = (f) => [[-1, -1], [0, -1], [1, -1], [-1, -2], [0, -2], [1, -2]]
    .map(([dx, dy]) => { for (let r = 0; r < (f.dir || 0) % 4; r++) [dx, dy] = [-dy, dx]; return [f.x + dx, f.y + dy]; })
    .filter(([x, y]) => inside(x, y));

  // A playable layout: the seed's hole with the features applied.
  function layoutOf(hole, features, seedIncluded) {
    if (!seedIncluded) features = withSeed(hole, features);
    const g = hole.grid.map((r) => r.split(''));
    const over = {}; // ramps: slopes on single tiles
    const greenHills = new Set(); // hills standing on a green: putt off them, but never hole out from them
    const calm = new Set();
    const gusts = []; // wind features: { tiles, step }
    const banks = new Set(), bankSides = []; // backstops: their tiles, and which side of the green each guards
    const fbanks = new Set(); // fairway banks: rough tiles that hold a ball aimed at the fairway
    const zoneRamps = []; // ramps on the green: they tilt the short map
    for (const f of features) {
      if (f.kind === 'bunker' || f.kind === 'water') {
        for (const [x, y] of footprint(f)) if (inside(x, y) && g[y][x] !== 'G' && !(x === hole.tee[0] && y === hole.tee[1])) g[y][x] = f.kind === 'bunker' ? 'S' : 'W';
      } else if (f.kind === 'hill') { if (g[f.y][f.x] === 'G') greenHills.add(key(f.x, f.y)); g[f.y][f.x] = 'M'; }
      else if (f.kind === 'ramp' && hole.short && greenRamp(hole, f)) zoneRamps.push(f);
      else if (f.kind === 'ramp') for (const [x, y] of footprint(f)) { if (inside(x, y)) over[key(x, y)] = f; }
      else if (f.kind === 'trees') for (const [x, y] of footprint(f)) { if (inside(x, y) && (g[y][x] === 'R' || g[y][x] === 'K')) g[y][x] = 'P'; }
      else if (f.kind === 'wind') gusts.push({ tiles: new Set(windCone(f).map(([a, b]) => key(a, b))), step: ORIENT[f.dir || 0] });
      else if (f.kind === 'calm') for (const [x, y] of footprint(f)) calm.add(key(x, y));
      else if (f.kind === 'bank') { for (const [x, y] of footprint(f)) if (inside(x, y)) fbanks.add(key(x, y)); }
      else if (f.kind === 'backstop') { bankSides.push({ side: f.side || 0, tiles: footprint(f) }); for (const [x, y] of footprint(f)) banks.add(key(x, y)); }
    }
    return { grid: g, tee: hole.tee, cup: hole.cup, bends: hole.bends || [], wind: hole.wind, over, calm, gusts, banks, bankSides, fbanks, greenHills, short: hole.short ? shortWith(hole.short, hole.cup, zoneRamps) : null };
  }

  // ---------- the shot ----------
  // Whether a flight from a to b (the line the ball travels, before any wind) passes over any of a set of tiles.
  function flightCrosses(a, b, tiles) {
    const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) * 2 || 1;
    for (let i = 1; i <= n; i++) if (tiles.has(key(Math.round(a[0] + ((b[0] - a[0]) * i) / n), Math.round(a[1] + ((b[1] - a[1]) * i) / n)))) return true;
    return false;
  }
  // Where a ball that landed in water at p is dropped: the nearest dry, playable tile (within 3), the one farther
  // from the cup on a tie. Null if there's none (then it goes back where it was played).
  function dropNear(L, p) {
    let best = null, bd = Infinity;
    for (let r = 1; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const q = [p[0] + dx, p[1] + dy], tt = terrainAt(L, q[0], q[1]);
        if (tt === 'W' || tt === 'T' || tt === 'O' || tt === 'P') continue;
        const d = Math.hypot(dx, dy);
        if (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && dist(q, L.cup) > dist(best, L.cup))) { best = q; bd = d; }
      }
      if (best) break;
    }
    return best;
  }
  const terrainAt = (L, x, y) => (inside(x, y) ? L.grid[y][x] : 'O');
  // Tiles along a line from (x0, y0), one per step, for n steps along a direction.
  const along = (x0, y0, d, from, to) => { const out = []; for (let i = from; i <= to; i++) out.push([Math.round(x0 + d[0] * i), Math.round(y0 + d[1] * i)]); return out; };

  // One shot from pos with action { club, dir } (or { club: 'putter', dir, dist }). Returns where the ball ends up and
  // what happened: { pos, holed, penalty, events }. Water and out of bounds put the ball back where it was, +1 stroke.
  // tr (optional): filled with what the page needs to animate the shot: from, target (where it flies to, wind
  // included), drift (the wind's share of that), carry, land (where the flight ends: on the ground, or at a tree),
  // tree (the tree it hit), roll (tiles it rolled across, in order), wet (the water it landed in).
  function shot(L, pos, action, tr) {
    const events = [];
    if (tr) { tr.from = pos.slice(); tr.roll = []; tr.club = action.club; }
    const back = (why) => ({ pos: pos.slice(), holed: false, penalty: 1, events: events.concat(why) });
    // Water: +1, and a drop beside it (as golf does), not back where the shot was played. A ball that lands in the
    // water drops on the nearest dry tile (never nearer the hole when it's a tie); one that rolls in stays on the last
    // dry tile it crossed. Out of bounds is still stroke and distance (back).
    const splash = (wet) => { if (tr) tr.wet = wet.slice(); const d = dropNear(L, wet); return d ? { pos: d, holed: false, penalty: 1, events: events.concat('water') } : back('water'); };
    const dropAt = (dry) => ({ pos: dry.slice(), holed: false, penalty: 1, events: events.concat('water') });
    const lie = terrainAt(L, pos[0], pos[1]);
    const club = CLUBS[action.club];
    const d = DIRS[action.dir];
    let cur = pos.slice();
    const isCup = (p) => p[0] === L.cup[0] && p[1] === L.cup[1];
    if (club.putt) {
      if (isCup(pos)) return { pos: pos.slice(), holed: true, penalty: 0, events: events.concat('holed') };
      const onGreenHill = lie === 'M' && L.greenHills && L.greenHills.has(key(pos[0], pos[1]));
      if (lie !== 'G' && !onGreenHill && !isCup(pos)) return { pos: pos.slice(), holed: false, penalty: 0, events: ['illegal'] };
      // Only a short putt drops; a longer one that reaches the cup stops beside it.
      // From a hill on the green the line to the hole is unplayable: nothing drops, a putt reaching the cup stops beside it.
      const drops = !onGreenHill && dist(pos, L.cup) <= TAP_IN;
      // A putt "at the cup" ({ club: 'putter', toCup: true }) follows the exact line to the cup, as far as the putter
      // reaches; any other putt goes `dist` tiles along one of the 16 directions.
      const path = action.toCup ? lineToCup(pos, L.cup, club.max) : along(pos[0], pos[1], d, 1, Math.max(1, Math.min(club.max, action.dist || 1)));
      for (const p of path) {
        const t = terrainAt(L, p[0], p[1]);
        if (t === 'O' || t === 'W') return back(t === 'W' ? 'water' : 'out');
        if (t === 'T') { events.push('tree'); break; }
        if (isCup(p)) {
          if (drops) return { pos: p, holed: true, penalty: 0, events: events.concat('holed') };
          events.push('lag');
          break;
        }
        cur = p;
        if (t === 'S') { events.push('sand'); break; }
        if (t === 'M') { events.push('hill'); break; } // the mound plays as rough: a putt stops on it
        if (L.over[key(p[0], p[1])]) break; // a ramp takes the ball: it runs on along the slope (below)
      }
    } else {
      if (club.from === 'tee' && !isTee(L, pos)) return { pos: pos.slice(), holed: false, penalty: 0, events: ['illegal'] };
      if (club.from === 'TF' && !isTee(L, pos) && lie !== 'F') return { pos: pos.slice(), holed: false, penalty: 0, events: ['illegal'] };
      let carry = carryOf(action.club, action.swing);
      const swingCarry = carry;
      if (lie === 'R' || lie === 'M') carry -= ROUGH_LOSS; // the rough grabs the club: the next shot carries less
      if (lie === 'P') { carry = Math.min(carry, PUNCH); events.push('punch'); }
      if (lie === 'S' || lie === 'K') carry = Math.floor(carry / 2); // sand and thick rough
      // Where the golfer aimed it: the landing a perfectly timed swing would have, before wind. A backstop only holds
      // shots aimed to land on the green.
      const aimed = [Math.round(pos[0] + d[0] * carry), Math.round(pos[1] + d[1] * carry)];
      const banked = !!(L.banks && L.banks.size && terrainAt(L, aimed[0], aimed[1]) === 'G');
      const fbanked = !!(L.fbanks && L.fbanks.size && terrainAt(L, aimed[0], aimed[1]) === 'F');
      let crossed = null; // the last fairway-bank tile the flight passed over
      // A badly mistimed swing (beyond TIMING.near) is also struck heavy: it comes up short, by the club's maxMiss.
      if (action.timing && Math.abs(action.timing) >= TIMING.near && club.maxMiss) { carry = Math.max(1, carry - club.maxMiss); events.push('short'); }
      let target = [Math.round(pos[0] + d[0] * carry), Math.round(pos[1] + d[1] * carry)];
      let shift = [0, 0];
      const tk = key(target[0], target[1]);
      if (club.wind && !L.calm.has(tk)) {
        if (L.wind[0] || L.wind[1]) { shift = L.wind.slice(); events.push('wind'); }
        // A wind feature acts on the flight: a shot whose path passes through its cone (anywhere, not only where it lands)
        // is carried further in the wind's direction.
        for (const gst of L.gusts) if (flightCrosses(pos, target, gst.tiles)) { const n = gustPush(swingCarry); shift = [shift[0] + gst.step[0] * n, shift[1] + gst.step[1] * n]; events.push('gust'); }
      }
      target = [target[0] + shift[0], target[1] + shift[1]];
      // A shaped shot bends off its line: left for a draw, right for a fade.
      let curve = [0, 0];
      const shp = action.shape && CURVE[action.club] ? SHAPES_OF[action.shape] : null;
      if (shp) {
        const right = [-d[1], d[0]], k = shp.side * CURVE[action.club];
        curve = [Math.round(right[0] * k), Math.round(right[1] * k)];
        target = [target[0] + curve[0], target[1] + curve[1]];
        shift = [shift[0] + curve[0], shift[1] + curve[1]];
        events.push(action.shape);
      }
      // A mistimed swing: pulled left (early) or pushed right (late) of the line of flight.
      const miss = missOf(action.club, action.timing);
      if (miss) {
        const right = [-d[1], d[0]];
        target = [target[0] + Math.round(right[0] * miss), target[1] + Math.round(right[1] * miss)];
        events.push(miss < 0 ? `pull${-miss}` : `push${miss}`);
      }
      if (tr) { tr.target = target.slice(); tr.drift = shift.slice(); tr.carry = carry; }
      // The flight: trees in the way stop the ball short. A shaped shot's flight curves: along the line to where it
      // would land unshaped, bent by the curve growing with the square of the way travelled (as it's drawn).
      const n = Math.max(Math.abs(target[0] - pos[0]), Math.abs(target[1] - pos[1]), 1);
      const lineEnd = [target[0] - curve[0], target[1] - curve[1]];
      let stopped = false;
      for (let i = 1; i <= n; i++) {
        const s = i / n;
        const p = [Math.round(pos[0] + (lineEnd[0] - pos[0]) * s + curve[0] * s * s), Math.round(pos[1] + (lineEnd[1] - pos[1]) * s + curve[1] * s * s)];
        if (terrainAt(L, p[0], p[1]) === 'T') { events.push('tree'); stopped = true; if (tr) tr.tree = p.slice(); break; }
        cur = p;
        if (fbanked && L.fbanks.has(key(p[0], p[1]))) crossed = p;
        if (i > 0 && terrainAt(L, p[0], p[1]) === 'P' && !(p[0] === pos[0] && p[1] === pos[1])) { events.push('undertree'); stopped = true; break; } // drops under planted trees
      }
      if (tr) tr.land = cur.slice();
      // Aimed at the green, stopped short of it by a tree on a side with a backstop: held on the bank.
      if (stopped && banked && terrainAt(L, cur[0], cur[1]) !== 'G') { const hb = holdByBank(L, cur); if (hb) { cur = hb; events.push('backstop'); } }
      // A ball a tree drops into water or out of bounds is still lost.
      if (stopped && cur !== pos) { const t = terrainAt(L, cur[0], cur[1]); if (t === 'W') return splash(cur); if (t === 'O') return back('out'); }
      if (!stopped) {
        let t = terrainAt(L, cur[0], cur[1]);
        // Aimed at the green but landing off it, on a side with a backstop: the bank holds it on the green's edge.
        const held = banked && t !== 'G' ? holdByBank(L, cur) : null;
        if (held) { cur = held; t = 'banked'; events.push('backstop'); }
        // Aimed at the fairway but landing in the rough on or beyond a fairway bank: held on the fairway's edge.
        if (!held && fbanked && t !== 'F' && crossed) { const hf = fairwayBeside(L, crossed); if (hf) { cur = hf; t = 'banked'; events.push('bank'); } }
        if (t === 'W') return splash(cur);
        if (t === 'O') return back('out');
        // Roll on fairway and green, along the line of the shot.
        const roll = (p) => {
          // Rolling off the green on a side with a backstop: held on the bank (only shots aimed at the green).
          if (fbanked && terrainAt(L, cur[0], cur[1]) === 'F' && L.fbanks.has(key(p[0], p[1]))) { if (!events.includes('bank')) events.push('bank'); return 'stop'; } // rolls into a fairway bank: stops
          if (banked && terrainAt(L, cur[0], cur[1]) === 'G' && terrainAt(L, p[0], p[1]) !== 'G') { const hb = holdByBank(L, p); if (hb) { cur = hb; if (!events.includes('backstop')) events.push('backstop'); return 'stop'; } }
          const tt = terrainAt(L, p[0], p[1]);
          if (tt === 'O' || tt === 'W') return tt;
          if (tt === 'T') return 'stop';
          cur = p;
          if (tr) tr.roll.push(p.slice());
          if (L.over[key(p[0], p[1])]) return 'stop'; // a ramp takes the ball: it runs on along the slope (below)
          return tt === 'F' || tt === 'G' ? 'go' : 'stop';
        };
        const rollN = Math.max(0, club.roll + (shp ? shp.roll : 0)); // a draw runs on a tile further, a fade a tile less
        if ((t === 'F' || t === 'G') && rollN && lie !== 'P') {
          const land = cur.slice();
          for (let j = 1; j <= rollN; j++) {
            const r = roll([Math.round(land[0] + d[0] * j), Math.round(land[1] + d[1] * j)]);
            if (r === 'W') return dropAt(cur);
            if (r === 'O') return back('out');
            if (r === 'stop') break;
          }
        }
        // Nobody sticks it to the pin: a full shot that would stop within PIN_GAP of the cup is kept PIN_GAP away. Short
        // of the pin it checks up short (back along its line, on tiles it could rest on); past the pin it runs on.
        if (dist(cur, L.cup) < PIN_GAP && (L.cup[0] - cur[0]) * d[0] + (L.cup[1] - cur[1]) * d[1] > 0) {
          const end = cur.slice();
          for (let j = 1; j <= 8; j++) {
            const p = [Math.round(end[0] - d[0] * j), Math.round(end[1] - d[1] * j)], tt = terrainAt(L, p[0], p[1]);
            if (tt === 'W' || tt === 'O' || tt === 'T') continue;
            if (dist(p, L.cup) >= PIN_GAP) { cur = p; if (tr) tr.roll.push(p.slice()); break; }
          }
        }
        const start = cur.slice();
        for (let j = 1; j <= 8 && dist(cur, L.cup) < PIN_GAP; j++) {
          const r = roll([Math.round(start[0] + d[0] * j), Math.round(start[1] + d[1] * j)]);
          if (r === 'W') return dropAt(cur);
          if (r === 'O') return back('out');
          if (r === 'stop' && dist(cur, L.cup) < PIN_GAP) break;
        }
        if (terrainAt(L, cur[0], cur[1]) === 'S') events.push('sand');
      }
    }
    // A ball that lands or rolls onto a ramp runs 2 more tiles along it.
    const o = L.over[key(cur[0], cur[1])];
    if (o) {
      const step = ORIENT[o.dir];
      const steps = (shapeOf(o) && shapeOf(o).run) || 2;
      events.push('ramp');
      for (let j = 1; j <= steps; j++) {
        const p = [cur[0] + step[0], cur[1] + step[1]];
        const t = terrainAt(L, p[0], p[1]);
        if (t === 'W') return dropAt(cur);
        if (t === 'O') return back('out');
        if (t === 'T') break;
        cur = p;
        if (tr) tr.roll.push(p.slice());
        if (isCup(p)) return { pos: p, holed: true, penalty: 0, events: events.concat('holed') };
      }
    }
    if (isCup(cur) && (club.putt || events.includes('ramp'))) return { pos: cur, holed: true, penalty: 0, events: events.concat('holed') };
    return { pos: cur, holed: false, penalty: 0, events };
  }

  // Where a golfer may aim from a spot: a cone AIM_CONE degrees wide centred on the straight line to the cup, plus,
  // while a fairway's bend still lies ahead (nearer the cup than the ball, and at least 3 tiles off), a cone toward
  // that bend, so a dogleg can be played round as well as cut across. Unless a tree stands on that line within 2 tiles of the ball, when every direction is open
  // (chip out sideways or back). Trees that close are never hidden by a hill, so the golfer always sees why.
  function blocked(L, pos) {
    const v = [L.cup[0] - pos[0], L.cup[1] - pos[1]], len = Math.hypot(v[0], v[1]);
    if (!len) return false;
    if (terrainAt(L, pos[0], pos[1]) === 'P') return true; // under planted trees: punch out any way
    for (const i of [1, 1.5, 2]) {
      if (i > len) break;
      const p = [Math.round(pos[0] + (v[0] / len) * i), Math.round(pos[1] + (v[1] / len) * i)];
      const tt = terrainAt(L, p[0], p[1]);
      if (tt === 'T' || tt === 'P') return true;
    }
    return false;
  }
  function aimTargets(L, pos) {
    const toCup = dist(pos, L.cup);
    return [L.cup].concat((L.bends || []).filter((b) => dist(b, L.cup) < toCup - 1 && dist(pos, b) >= 3));
  }
  function aimDirs(L, pos) {
    const all = DIRS.map((_, i) => i);
    if (!dist(pos, L.cup) || blocked(L, pos)) return all;
    const cosHalf = Math.cos(((AIM_CONE / 2) * Math.PI) / 180) - 1e-9;
    const targets = aimTargets(L, pos).map((t) => { const v = [t[0] - pos[0], t[1] - pos[1]], l = Math.hypot(v[0], v[1]); return [v[0] / l, v[1] / l]; });
    return all.filter((i) => targets.some((u) => DIRS[i][0] * u[0] + DIRS[i][1] * u[1] >= cosHalf));
  }
  // Whether a club may be hit from a spot: the driver only from the tee, the wood from the tee or fairway, the putter
  // only on the green (off it, chip with the wedge).
  function clubAllowed(L, pos, club) {
    if (L.short && CLUBS[club] && CLUBS[club].putt) return false; // putting happens on the short map
    const c = CLUBS[club];
    if (!c) return false;
    if (c.from === 'tee') return isTee(L, pos);
    if (c.from === 'TF') return isTee(L, pos) || terrainAt(L, pos[0], pos[1]) === 'F';
    if (c.from === 'G') return terrainAt(L, pos[0], pos[1]) === 'G' || !!(L.greenHills && L.greenHills.has(key(pos[0], pos[1])));
    return true;
  }
  // Every legal action from a spot. On the green that includes a putt straight at the cup, which is always toward it.
  const actionsAt = (L, pos) => {
    const ok = new Set(aimDirs(L, pos));
    const out = ACTIONS.filter((a) => ok.has(a.dir) && clubAllowed(L, pos, a.club));
    if (!L.short && terrainAt(L, pos[0], pos[1]) === 'G' && !(pos[0] === L.cup[0] && pos[1] === L.cup[1])) out.push({ club: 'putter', toCup: true, dir: dirToCup(pos, L.cup) });
    return out;
  };

  // Every action a golfer can take from a spot, before the aim rule.
  function actionsFrom() {
    const out = [];
    for (const club of ['driver', 'wood', 'long', 'short', 'wedge']) for (const swing of ['full', 'three']) for (let dir = 0; dir < NDIR; dir++) out.push({ club, dir, swing });
    // Shaped shots, full swings only (a ¾ swing can be shaped too; the solver doesn't need it).
    for (const club of Object.keys(CURVE)) for (const shape of Object.keys(SHAPES_OF)) for (let dir = 0; dir < NDIR; dir++) out.push({ club, dir, swing: 'full', shape });
    for (let dir = 0; dir < NDIR; dir++) for (let dist = 1; dist <= CLUBS.putter.max; dist++) out.push({ club: 'putter', dir, dist });
    return out;
  }
  const ACTIONS = actionsFrom();

  // A tap-in: from inside the tap-in ring, with nothing on the line (a hill would stop the putt, a ramp turn it), the
  // putt at the cup is the only sensible shot. The seed never puts anything there: the green is clear of seed hazards
  // and trees, and the ring sits inside it. Returns true when the putt at the cup holes out cleanly.
  function tapInClear(L, pos) {
    if (terrainAt(L, pos[0], pos[1]) !== 'G' || dist(pos, L.cup) > TAP_IN) return false;
    const r = shot(L, pos, { club: 'putter', toCup: true, dir: 0 });
    return r.holed && !r.events.includes('ramp');
  }

  // ---------- the short game ----------
  // Once a ball comes to rest within ZONE_R long tiles of the cup, the hole moves to its short-game map: the green and
  // its surrounds at SCALE times the detail, with the seed's own elevation (slopes that bend and speed or slow a
  // rolling ball) and debris (twigs and stones a rolling ball stops against). Putts and chips there are aim + pace:
  // a putt is a direction and how far it would roll on flat green; a chip is a direction and a carry, then a short
  // roll. A ball drops when it passes within CUP_R of the cup slowly enough (CAPTURE); faster, it lips out and runs on.
  // A stroke meter sets each stroke's weight (shortStruck). Of golfers' features, only ramps on the green reach the
  // short map (shortWith).
  const ZONE_R = 7;                        // long tiles from the cup
  const SCALE = 3;                         // short tiles per long tile
  const SN = (2 * ZONE_R + 1) * SCALE;     // the short map's side (45)
  const SC = Math.floor(SN / 2);           // the cup's short tile (22, 22)
  const SDIR = 32;                         // aiming directions on the short map
  const SDIRS = Array.from({ length: SDIR }, (_, i) => { const a = (i * 2 * Math.PI) / SDIR; return [Math.cos(a), -Math.sin(a)]; });
  const PUTT_MAX = 14;                     // pace: tiles a putt would roll on flat green
  const CHIP_CARRIES = [2, 3, 4, 5, 6, 8, 10];
  const CHIP_ROLL = 2;                     // a chip's roll on flat green after it lands
  // Where the putter may be used on the short map: the green, the fringe, and (since 5 October 2026) the light rough,
  // as golfers putt from just off the green. A putt from the rough loses its pace quickly there (the rough's friction).
  const PUTT_LIES = 'GFR';
  // Chip spin (4 October 2026): backspin checks the ball where it lands and draws it back about a tile; topspin lets it
  // run about 4 tiles instead of 2. In tiles of roll on flat green (negative: back toward the golfer).
  const CHIP_SPIN = { back: -1, top: 4 };
  const FRICTION = { G: 0.08, F: 0.2, R: 0.45, K: 0.7, M: 0.45, P: 0.6 }; // slowing per tile travelled; sand stops a ball
  const SLOPE_G = 1;                       // how hard a slope pulls a rolling ball
  const CUP_R = 0.15, CAPTURE = 0.42;        // drop radius (tiles) and the fastest a ball can be going and still drop
  const DT = 0.5;                          // simulation step
  const inZone = (L, p) => dist(p, L.cup) <= ZONE_R;
  // Par counts the short game as regulation, as golf does: two putts from the green; from off it (fringe, rough,
  // sand), a chip and two putts. A one-putt, or getting up and down, beats par.
  const REG = { green: 2, off: 3 };
  // What a ball at rest in the short-game area is worth to the long game: regulation, or more where the short game
  // really costs more (debris in the way, a buried lie). While the generator is still choosing a hole it uses
  // regulation alone (S.estimate), and solves the short map once the hole is chosen.
  const zoneValue = (S, cup, p) => {
    const sp = toShort(cup, p), reg = S.grid[sp[1]][sp[0]] === 'G' ? REG.green : REG.off;
    return S.estimate ? reg : Math.max(reg, shortValue(S, sp));
  };
  const toShort = (cup, p) => [SC + (p[0] - cup[0]) * SCALE, SC + (p[1] - cup[1]) * SCALE];
  const sInside = (x, y) => x >= 0 && y >= 0 && x < SN && y < SN;
  const sTerrain = (S, x, y) => (sInside(x, y) ? S.grid[y][x] : 'O');
  const paceSpeed = (pace, f) => Math.sqrt(2 * f * pace);

  // The short map: the long map's tiles around the cup, each split SCALE × SCALE, plus the seed's elevation and debris.
  function genShort(rng, grid, cup) {
    const g = [];
    for (let sy = 0; sy < SN; sy++) {
      const row = [];
      for (let sx = 0; sx < SN; sx++) {
        const lx = cup[0] + Math.floor((sx - SC + 1) / SCALE), ly = cup[1] + Math.floor((sy - SC + 1) / SCALE);
        const t = lx >= 0 && ly >= 0 && lx < W && ly < H ? grid[ly][lx] : 'O';
        row.push(t === 'M' || t === 'P' ? 'R' : t);
      }
      g.push(row);
    }
    // Elevation: a gentle tilt plus a few bumps and hollows, flattened right at the cup; slopes capped so a slow ball
    // always comes to rest.
    const h = Array.from({ length: SN }, () => Array(SN).fill(0));
    const ang = rng() * 2 * Math.PI, tilt = 0.012 + rng() * 0.014;
    const bumps = Array.from({ length: 3 + Math.floor(rng() * 3) }, () => ({ x: SC + (rng() * 2 - 1) * 16, y: SC + (rng() * 2 - 1) * 16, a: (rng() < 0.5 ? -1 : 1) * (0.12 + rng() * 0.2), s: 3 + rng() * 5 }));
    const raw = (x, y) => { let v = tilt * ((x - SC) * Math.cos(ang) - (y - SC) * Math.sin(ang)); for (const b of bumps) v += b.a * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.s * b.s)); return v; };
    const atCup = raw(SC, SC);
    for (let y = 0; y < SN; y++) for (let x = 0; x < SN; x++) {
      const dc = Math.hypot(x - SC, y - SC);
      // Flat within 3 tiles of the cup (tap-ins are tap-ins), blending into the contours by 5.
      const w = dc <= 3 ? 0 : dc >= 5 ? 1 : (dc - 3) / 2;
      h[y][x] = raw(x, y) * w + atCup * (1 - w);
    }
    let gmax = 0;
    for (let y = 1; y < SN - 1; y++) for (let x = 1; x < SN - 1; x++) gmax = Math.max(gmax, Math.hypot((h[y][x + 1] - h[y][x - 1]) / 2, (h[y + 1][x] - h[y - 1][x]) / 2));
    const k = gmax > 0.055 ? 0.055 / gmax : 1;
    for (let y = 0; y < SN; y++) for (let x = 0; x < SN; x++) h[y][x] = Math.round(h[y][x] * k * 1000) / 1000;
    // Debris: a few twigs, stones and divots on and around the green (a ball kicks off them), at least 3 tiles from the
    // cup (close enough for a bank shot) and never on a long tile's centre (where
    // a ball arriving from the long game comes to rest).
    const n = 3 + Math.floor(rng() * 4);
    for (let i = 0, t = 0; i < n && t < 200; t++) {
      const x = Math.floor(rng() * SN), y = Math.floor(rng() * SN);
      if ((g[y][x] !== 'G' && g[y][x] !== 'F') || Math.hypot(x - SC, y - SC) < 3 || ((x - SC) % SCALE === 0 && (y - SC) % SCALE === 0)) continue;
      g[y][x] = 'D'; i++;
    }
    g[SC][SC] = 'G';
    return { grid: g.map((r) => r.join('')), h, sid: Math.floor(rng() * 1e9) };
  }

  // Fast lookups for the rolling simulation, built once per short map: each tile's friction (-1: stops a ball
  // entering it, -2: water, -3: off the map) and slope.
  const FR_CODE = (t) => (t === 'W' ? -2 : t === 'T' ? -1 : t === 'D' ? -5 : t === 'S' ? -4 : FRICTION[t] == null ? 0.45 : FRICTION[t]);
  // Debris (twigs, stones, divots) is a bumper: a rolling ball that runs into it bounces off at the mirror angle and runs
  // on BOUNCE tiles (on flat green; 2 for a soft arrival, up to 3 for a hard one), still free to roll into the cup.
  const BOUNCE = { min: 2, max: 3 };
  const bounceSpeed = (sp) => paceSpeed(BOUNCE.min + Math.min(1, sp / 1.2) * (BOUNCE.max - BOUNCE.min), FRICTION.G);
  function sFast(S) {
    if (S.fast) return S.fast;
    const fr = new Float64Array(SN * SN), gx = new Float64Array(SN * SN), gy = new Float64Array(SN * SN);
    for (let y = 0; y < SN; y++) for (let x = 0; x < SN; x++) {
      const i = y * SN + x, xi = Math.max(1, Math.min(SN - 2, x)), yi = Math.max(1, Math.min(SN - 2, y));
      fr[i] = FR_CODE(S.grid[y][x]);
      gx[i] = (S.h[yi][xi + 1] - S.h[yi][xi - 1]) / 2; gy[i] = (S.h[yi + 1][xi] - S.h[yi - 1][xi]) / 2;
    }
    Object.defineProperty(S, 'fast', { value: { fr, gx, gy }, enumerable: false });
    return S.fast;
  }
  // Ramps on the green: each of a ramp's long tiles is SCALE × SCALE short tiles whose ground tilts its way (the fall
  // line, ORIENT[dir]) by RAMP_G more, capped at RAMP_CAP so a slow ball still comes to rest on it. The ramped map is a
  // copy of the seed's with its own slopes and its own solver cache; it's built once per set of ramps.
  const RAMP_G = 0.05, RAMP_CAP = 0.075;
  const RAMP_GAP = 2; // long tiles: a green ramp's nearest tile is at least this far from the cup's (no tile touching it)
  const greenRamp = (hole, f) => footprint(f).some((p) => dist(p, hole.cup) <= ZONE_R);
  function shortWith(S, cup, ramps) {
    if (!ramps.length) return S;
    const k = JSON.stringify(ramps.map((f) => [f.x, f.y, f.shape, f.dir])) + (S.estimate ? 'e' : '');
    if (!S.variants) Object.defineProperty(S, 'variants', { value: new Map(), enumerable: false });
    if (S.variants.has(k)) return S.variants.get(k);
    const base = sFast(S), fr = base.fr, gx = Float64Array.from(base.gx), gy = Float64Array.from(base.gy);
    const tiles = [];
    for (const f of ramps) {
      const [ux, uy] = ORIENT[f.dir || 0], ul = Math.hypot(ux, uy);
      for (const p of footprint(f)) {
        const [cx, cy] = toShort(cup, p);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx, y = cy + dy;
          if (!sInside(x, y)) continue;
          const i = y * SN + x;
          gx[i] -= (RAMP_G * ux) / ul; gy[i] -= (RAMP_G * uy) / ul; // the ball runs downhill: toward the fall line
          const m = Math.hypot(gx[i], gy[i]);
          if (m > RAMP_CAP) { gx[i] *= RAMP_CAP / m; gy[i] *= RAMP_CAP / m; }
          tiles.push([x, y, f.dir || 0]);
        }
      }
    }
    const V = { grid: S.grid, h: S.h, sid: `${S.sid}r${k}`, ramps: tiles };
    if (S.estimate) V.estimate = true;
    Object.defineProperty(V, 'fast', { value: { fr, gx, gy }, enumerable: false });
    S.variants.set(k, V);
    return V;
  }
  // The short map a hole plays with its features (ramps on the green change it).
  const shortOf = (hole, features) => (hole.short ? shortWith(hole.short, hole.cup, withSeed(hole, features).filter((f) => f.kind === 'ramp' && greenRamp(hole, f))) : null);
  const slopeAt = (S, x, y) => { const F = sFast(S), i = Math.max(0, Math.min(SN - 1, Math.round(y))) * SN + Math.max(0, Math.min(SN - 1, Math.round(x))); return [F.gx[i], F.gy[i]]; };

  // Roll a ball from (x, y) with a velocity. Returns where it comes to rest (a tile), whether it dropped, the path it
  // took (for the preview), and what happened.
  // near (optional): filled with the ball's closest pass to the cup: d (tiles), speed there, and side (how far off its
  // line of travel the cup was: + the cup was to the ball's left, − to its right).
  function sRoll(S, x, y, vx, vy, events, path, near) {
    const F = sFast(S);
    let bounces = 0;
    for (let step = 0; step < 2000; step++) {
      const sp = Math.sqrt(vx * vx + vy * vy);
      const tx = Math.round(x), ty = Math.round(y), i = ty * SN + tx;
      const dc = Math.sqrt((x - SC) * (x - SC) + (y - SC) * (y - SC));
      if (near && dc < near.d) { near.d = dc; near.speed = sp; near.side = sp > 0 ? ((SC - x) * vy - (SC - y) * vx) / sp : 0; near.ahead = sp > 0 ? ((SC - x) * vx + (SC - y) * vy) / sp : 0; }
      if (dc <= CUP_R && sp <= CAPTURE) return { pos: [SC, SC], holed: true };
      if (dc <= CUP_R && sp > CAPTURE && !events.includes('lip')) events.push('lip');
      const f = F.fr[i] > 0 ? F.fr[i] : 0.45;
      const gx = F.gx[i], gy = F.gy[i];
      if (sp < f * DT * 1.5 && Math.sqrt(gx * gx + gy * gy) * SLOPE_G < f) break; // slow enough, and the slope can't move it: at rest
      const ax = -SLOPE_G * gx - (sp > 0 ? (f * vx) / sp : 0), ay = -SLOPE_G * gy - (sp > 0 ? (f * vy) / sp : 0);
      const nx = x + vx * DT, ny = y + vy * DT, ntx = Math.round(nx), nty = Math.round(ny);
      if (ntx < 0 || nty < 0 || ntx >= SN || nty >= SN) { events.push('edge'); break; }
      const nf = F.fr[nty * SN + ntx];
      if (nf === -2) return { pos: restTile(x, y), holed: false, water: true }; // rolled into water: dropped where it went in
      if (nf === -1) { events.push('tree'); break; }
      if (nf === -5) {
        // Off the debris: mirror the velocity about the line from the debris to the ball, and run on.
        if (++bounces > 6) break;
        let nx2 = x - ntx, ny2 = y - nty, nl = Math.hypot(nx2, ny2);
        if (nl < 1e-6) { nx2 = -vx; ny2 = -vy; nl = Math.hypot(nx2, ny2) || 1; }
        nx2 /= nl; ny2 /= nl;
        const dot = vx * nx2 + vy * ny2;
        let rvx = vx - 2 * dot * nx2, rvy = vy - 2 * dot * ny2;
        const rl = Math.hypot(rvx, rvy) || 1, bs = bounceSpeed(sp);
        vx = (rvx / rl) * bs; vy = (rvy / rl) * bs;
        if (!events.includes('debris')) events.push('debris');
        (events.debrisAt || (events.debrisAt = [])).push([ntx, nty]); // (which pieces, for drawing; no effect on play)
        continue;
      }
      x = nx; y = ny;
      if (path && step % 2 === 0) path.push([x, y]);
      if (nf === -4) { events.push('sand'); break; }
      const nvx = vx + ax * DT, nvy = vy + ay * DT;
      if (nvx * vx + nvy * vy < 0 && Math.hypot(gx, gy) * SLOPE_G < f) break; // friction would turn it round: stopped
      vx = nvx; vy = nvy;
    }
    if (path) path.push([x, y]);
    return { pos: restTile(x, y), holed: false };
  }
  // The tile a ball at rest sits on. The cup's own tile is only for a holed ball: one that stops beside the cup
  // without dropping rests on the next tile out, on its side of the cup.
  function restTile(x, y) {
    let rx = Math.round(x), ry = Math.round(y);
    if (rx === SC && ry === SC) {
      const dx = x - SC, dy = y - SC;
      if (Math.abs(dx) >= Math.abs(dy)) rx += dx >= 0 ? 1 : -1; else ry += dy >= 0 ? 1 : -1;
    }
    return [rx, ry];
  }

  // One short-game stroke from a tile: { club: 'putter', dir, pace } or { club: 'wedge', dir, carry }.
  // The tap-in: a ball at rest on a tile touching the cup's (sides or corners) on the green or fringe is a gimme. A putt
  // at the cup from there drops whatever its pace or timing, so the page skips the stroke meter. The solver sees it
  // through shortShot, so those tiles are worth 1.
  const isTapIn = (S, pos) => Math.max(Math.abs(pos[0] - SC), Math.abs(pos[1] - SC)) === 1 && 'GF'.includes(sTerrain(S, pos[0], pos[1]));
  function shortShot(S, pos, a, withPath) {
    const events = [], path = withPath ? [pos.slice()] : null, near = { d: Infinity, speed: 0, side: 0, ahead: 0 };
    const lie = sTerrain(S, pos[0], pos[1]);
    const cl = Math.hypot(SC - pos[0], SC - pos[1]) || 1;
    const u = a.dir === 'cup' ? [(SC - pos[0]) / cl, (SC - pos[1]) / cl] : SDIRS[a.dir];
    const back = (why) => ({ pos: pos.slice(), holed: false, penalty: 1, events: events.concat(why), path });
    if (pos[0] === SC && pos[1] === SC) return { pos, holed: true, penalty: 0, events: ['holed'], path };
    let r;
    if (a.club === 'putter' && a.dir === 'cup' && isTapIn(S, pos)) { if (path) path.push([SC, SC]); return { pos: [SC, SC], holed: true, penalty: 0, events: ['tapin', 'holed'], path, near: { d: 0, speed: 0, side: 0, ahead: 0 } }; }
    if (a.club === 'putter') {
      if (!PUTT_LIES.includes(lie)) return { pos: pos.slice(), holed: false, penalty: 0, events: ['illegal'], path };
      const v = paceSpeed(Math.max(1, Math.min(PUTT_MAX, a.pace || 1)), FRICTION.G);
      r = sRoll(S, pos[0], pos[1], u[0] * v, u[1] * v, events, path, near);
    } else {
      let carry = a.carry || CHIP_CARRIES[0];
      if (lie === 'S') carry = Math.max(1, Math.round(carry * 0.6));
      // The flight: a tree or debris on the way stops it short; it lands at the carry, then rolls on.
      let x = pos[0], y = pos[1];
      for (let i = 1; i <= carry; i++) {
        const px = pos[0] + u[0] * i, py = pos[1] + u[1] * i, t = sTerrain(S, Math.round(px), Math.round(py));
        if (t === 'O') { events.push('edge'); break; }
        if (t === 'T') { events.push('tree'); break; }
        x = px; y = py;
      }
      if (path) path.push([x, y]);
      const lt = sTerrain(S, Math.round(x), Math.round(y));
      if (lt === 'W') { const d = sDropNear(S, [Math.round(x), Math.round(y)]); return d ? { pos: d, holed: false, penalty: 1, events: events.concat('water'), path } : back('water'); }
      if (lt === 'S') r = { pos: restTile(x, y), holed: false };
      else if (lt === 'D') { // lands on debris: it kicks back the way it came, and rolls
        events.push('debris');
        (events.debrisAt || (events.debrisAt = [])).push([Math.round(x), Math.round(y)]);
        x -= u[0]; y -= u[1];
        const bs = bounceSpeed(1.2);
        r = sRoll(S, x, y, -u[0] * bs, -u[1] * bs, events, path, near);
      }
      else {
        const tiles = a.spin && CHIP_SPIN[a.spin] != null ? CHIP_SPIN[a.spin] : CHIP_ROLL;
        if (a.spin) events.push(a.spin === 'back' ? 'backspin' : 'topspin');
        const v = Math.sign(tiles) * paceSpeed(Math.abs(tiles), FRICTION.G) * Math.sqrt((FRICTION[lt] || 0.45) / FRICTION.G);
        r = sRoll(S, x, y, u[0] * v, u[1] * v, events, path, near);
      }
      if (lt === 'S') events.push('sand');
    }
    if (r.water) return { pos: r.pos, holed: false, penalty: 1, events: events.concat('water'), path };
    if (r.holed) return { pos: [SC, SC], holed: true, penalty: 0, events: events.concat('holed'), path, near };
    return { pos: r.pos, holed: false, penalty: 0, events, path, near };
  }

  // A chip that lands in water drops on the nearest dry short-map tile (farther from the cup on a tie).
  function sDropNear(S, p) {
    let best = null, bd = Infinity;
    for (let r = 1; r <= 4 && !best; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const q = [p[0] + dx, p[1] + dy], tt = sTerrain(S, q[0], q[1]);
      if (tt === 'W' || tt === 'T' || tt === 'D' || tt === 'O' || (q[0] === SC && q[1] === SC)) continue;
      const d = Math.hypot(dx, dy);
      if (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && Math.hypot(q[0] - SC, q[1] - SC) > Math.hypot(best[0] - SC, best[1] - SC))) { best = q; bd = d; }
    }
    return best;
  }
  // Every short-game stroke from a tile: putts on the green and fringe, chips from anywhere off the green.
  // forSolver: only strokes heading within 67.5° of the cup, and putts no stronger than the distance plus 5 (the
  // solver's search; nothing useful lies outside it on these greens). Golfers may play any of the full set.
  function shortActions(S, pos, forSolver) {
    const lie = sTerrain(S, pos[0], pos[1]), out = [];
    const d = Math.hypot(SC - pos[0], SC - pos[1]) || 1, cu = [(SC - pos[0]) / d, (SC - pos[1]) / d];
    const dirs = [...Array(SDIR).keys()].filter((i) => !forSolver || SDIRS[i][0] * cu[0] + SDIRS[i][1] * cu[1] >= 0.38);
    const maxPace = forSolver ? Math.min(PUTT_MAX, Math.ceil(d) + 5) : PUTT_MAX;
    if (PUTT_LIES.includes(lie)) for (const dir of dirs.concat('cup')) for (let pace = 1; pace <= maxPace; pace++) out.push({ club: 'putter', dir, pace });
    if (lie !== 'G') for (const dir of dirs) for (const carry of CHIP_CARRIES) for (const spin of [undefined, 'back', 'top']) out.push(spin ? { club: 'wedge', dir, carry, spin } : { club: 'wedge', dir, carry });
    return out;
  }

  // Strokes to hole out from every short-map tile (exact for this deterministic model), cached on the short map.
  function shortTogo(S) {
    if (S.T) return S.T;
    const T = new Map(), spots = [];
    // Every tile a ball can rest on within the short-game circle (a long ball arrives no further out than ZONE_R).
    for (let y = 0; y < SN; y++) for (let x = 0; x < SN; x++) {
      const t = S.grid[y][x];
      if (t === 'W' || t === 'T' || t === 'D' || t === 'O' || Math.hypot(x - SC, y - SC) > ZONE_R * SCALE + 1.5) continue;
      spots.push([x, y]); T.set(y * SN + x, Infinity);
    }
    T.set(SC * SN + SC, 0);
    const res = spots.map((p) => shortActions(S, p, true).map((a) => { const r = shortShot(S, p, a, false); return [r.holed ? -1 : r.pos[1] * SN + r.pos[0], r.penalty]; }));
    for (let iter = 0; iter < 30; iter++) {
      let changed = false;
      spots.forEach((p, i) => {
        const k = p[1] * SN + p[0];
        if (k === SC * SN + SC) return;
        let best = T.get(k);
        for (const [to, pen] of res[i]) { const c = 1 + pen + (to < 0 ? 0 : T.has(to) ? T.get(to) : Infinity); if (c < best) best = c; }
        if (best < T.get(k)) { T.set(k, best); changed = true; }
      });
      if (!changed) break;
    }
    Object.defineProperty(S, 'T', { value: T, enumerable: false });
    return T;
  }
  const shortValue = (S, p) => { const T = shortTogo(S); const v = T.get(p[1] * SN + p[0]); return v == null ? Infinity : v; };
  // The best short-game stroke from a tile (ties: nearest the cup, then the softer putt).
  function bestShortAction(S, pos) {
    const T = shortTogo(S);
    let best = null;
    for (const a of shortActions(S, pos, true)) {
      const r = shortShot(S, pos, a, false);
      const c = 1 + r.penalty + (r.holed ? 0 : (T.get(r.pos[1] * SN + r.pos[0]) ?? Infinity));
      const near = r.holed ? 0 : Math.hypot(r.pos[0] - SC, r.pos[1] - SC);
      if (!best || c < best.c || (c === best.c && near < best.near - 1e-9)) best = { a, c, r, near };
    }
    return best;
  }
  // Why a putt or chip did or didn't drop, in plain words (from its closest pass to the cup).
  function explainShort(a, r) {
    if (r.holed) return 'Drops!';
    const n = r.near || {};
    if (r.events.includes('water')) return 'Finds the water: a drop beside it, +1.';
    if (r.events.includes('lip') || (n.d <= CUP_R && n.speed > CAPTURE)) return 'Lips out: it reaches the cup going too fast to drop. Try a softer pace.';
    if (n.d < 1.2 && Math.abs(n.ahead) < 0.6) return `Just misses: it passes ${n.d.toFixed(1)} tiles ${n.side > 0 ? 'right' : 'left'} of the cup${r.events.includes('debris') ? ' after kicking off debris' : ', the slope taking it'}. Aim a little ${n.side > 0 ? 'left' : 'right'} of the cup (click a spot beside it).`;
    const toCup = Math.hypot(r.pos[0] - SC, r.pos[1] - SC);
    if (n.ahead > 0.3 && n.d >= 0.3) return `Stops ${toCup.toFixed(1)} tiles short of the cup${n.d > 1.2 ? ', the slope pulling it off line' : ''}. Try a firmer pace.`;
    return `Misses by ${n.d.toFixed(1)} tiles and stops ${toCup.toFixed(1)} from the cup.`;
  }
  // The short game's swing meter: the same timing as the long game's (-1 early to 1 late), but it sets the stroke's
  // weight, not its line. Within TIMING.perfect it goes as selected; within TIMING.near one step off; beyond, two.
  // Early is softer (a putt's pace lower, a chip's carry one size shorter), late is firmer. Par, as in the long game,
  // is solved for perfect timing.
  function shortStruck(a, timing) {
    const t = Math.abs(timing || 0), k = Math.sign(timing || 0) * (t < TIMING.perfect ? 0 : t < TIMING.near ? 1 : 2);
    if (!k) return a;
    if (a.club === 'putter') return { ...a, pace: Math.max(1, Math.min(PUTT_MAX, a.pace + k)) };
    const i = Math.max(0, CHIP_CARRIES.indexOf(a.carry));
    return { ...a, carry: CHIP_CARRIES[Math.max(0, Math.min(CHIP_CARRIES.length - 1, i + k))] };
  }
  function describeShort(a, r, struck) {
    if (r.events.includes('tapin')) return 'Tapped in.';
    const what = a.club === 'putter' ? `Putt${a.dir === 'cup' ? ' at the cup' : ''}, pace ${a.pace}` : `Chip, carry ${a.carry}${a.spin === 'back' ? ', backspin' : a.spin === 'top' ? ', topspin' : ''}`;
    const off = !struck || (a.club === 'putter' ? struck.pace === a.pace : struck.carry === a.carry) ? ''
      : a.club === 'putter' ? ` (${struck.pace < a.pace ? 'early: struck softer' : 'late: struck firmer'}, pace ${struck.pace})` : ` (${struck.carry < a.carry ? 'early: flew short' : 'late: flew long'}, carry ${struck.carry})`;
    const bits = [];
    if (r.events.includes('lip')) bits.push('it lips out, too fast');
    if (r.events.includes('debris')) bits.push('it kicks off debris');
    if (r.events.includes('tree')) bits.push('it clips a tree');
    if (r.events.includes('sand')) bits.push('it finds the sand');
    if (r.events.includes('water')) bits.push('water: dropped beside it, +1');
    if (r.events.includes('edge')) bits.push('it runs off the short-game area');
    return `${what}${off}${bits.length ? `: ${bits.join(', ')}` : ''}${r.holed ? '. In the hole!' : '.'}`;
  }

  // ---------- the solver ----------
  // Strokes to hole out from every spot, by relaxation: from a spot, the best action costs 1 (+1 for water) plus the
  // strokes to go from where it lands. Exact for this deterministic model.
  const togoCache = new Map();
  function togoMap(L) {
    const ck = JSON.stringify([L.short ? `${L.short.sid}${L.short.estimate ? 'e' : ''}` : 0, L.grid, L.cup, L.wind, Object.values(L.over).map((f) => [f.x, f.y, f.kind, f.dir]), [...L.calm], L.gusts.map((g) => [[...g.tiles], g.step]), (L.bankSides || []).map((b) => b.side), [...(L.fbanks || [])]]);
    if (togoCache.has(ck)) return togoCache.get(ck);
    const T = {};
    const spots = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = L.grid[y][x];
      if (t === 'T' || t === 'W') continue;
      // A ball at rest in the short-game area moves to the short map: its strokes to go come from there.
      if (L.short && inZone(L, [x, y])) { T[key(x, y)] = zoneValue(L.short, L.cup, [x, y]); continue; }
      spots.push([x, y]); T[key(x, y)] = Infinity;
    }
    const results = spots.map((p) => actionsAt(L, p).map((a) => shot(L, p, a)));
    for (let iter = 0; iter < 40; iter++) {
      let changed = false;
      spots.forEach((p, i) => {
        let best = T[key(p[0], p[1])];
        for (const r of results[i]) {
          const c = 1 + r.penalty + (r.holed ? 0 : T[key(r.pos[0], r.pos[1])]);
          if (c < best) best = c;
        }
        if (best < T[key(p[0], p[1])]) { T[key(p[0], p[1])] = best; changed = true; }
      });
      if (!changed) break;
    }
    togoCache.set(ck, T);
    return T;
  }
  const parOf = (L) => togoMap(L)[key(L.tee[0], L.tee[1])];

  // ---------- how interesting a hole is ----------
  // Two things the solver can measure, on the bare hole (seed terrain and seed features):
  //   routes: distinct tee shots that still make par (landing spots at least 4 tiles apart), so there's a choice;
  //   risk: strokes an early or late swing loses along the best line (the average over a near and a bad miss each
  //         way, summed over its full shots), so hazards guard the ideal landings and reading them matters.
  // score = 0.5 × min(routes, 3) + 3 × risk: choice matters, but hazards that punish a miss matter most. The generator
  // redraws holes below MIN_INTEREST (keeping the most interesting of 40 playable draws).
  const MIN_INTEREST = 2.5;
  function interestOf(hole, features) {
    const L = layoutOf(hole, features || []), T = togoMap(L), par = T[key(L.tee[0], L.tee[1])];
    const cost = (r) => r.penalty + (r.holed ? 0 : T[key(r.pos[0], r.pos[1])]);
    const spots = [];
    for (const a of actionsAt(L, L.tee)) {
      const r = shot(L, L.tee, a);
      if (1 + cost(r) === par && !spots.some((p) => dist(p, r.pos) < 4)) spots.push(r.pos);
    }
    let risk = 0, pos = L.tee.slice();
    for (const a of parLine(L)) {
      const r0 = shot(L, pos, a);
      if (a.club !== 'putter') {
        let extra = 0;
        for (const t of [-0.8, -0.4, 0.4, 0.8]) extra += Math.max(0, cost(shot(L, pos, { ...a, timing: t })) - cost(r0));
        risk += extra / 4;
      }
      if (r0.holed) break;
      pos = r0.pos;
    }
    const routes = spots.length;
    return { routes, risk: Math.round(risk * 100) / 100, score: Math.round((0.5 * Math.min(routes, 3) + 3 * risk) * 100) / 100 };
  }
  // The best action from a spot (for the par line). Among equally good shots it picks as a golfer would: the one that
  // ends nearest the cup, then the shorter club (so a par 3 is played with the iron that reaches, not a driver).
  const CLUB_ORDER = Object.keys(CLUBS);
  function bestAction(L, pos) {
    const T = togoMap(L);
    let best = null;
    for (const a of actionsAt(L, pos)) {
      const r = shot(L, pos, a);
      const c = 1 + r.penalty + (r.holed ? 0 : T[key(r.pos[0], r.pos[1])]);
      const near = r.holed ? 0 : dist(r.pos, L.cup);
      const order = -CLUB_ORDER.indexOf(a.club);
      if (!best || c < best.c || (c === best.c && (near < best.near - 1e-9 || (Math.abs(near - best.near) < 1e-9 && order < best.order)))) best = { a, c, r, near, order };
    }
    return best;
  }
  function parLine(L) {
    const line = [];
    let pos = L.tee.slice();
    for (let i = 0; i < MAX_STROKES; i++) {
      const b = bestAction(L, pos);
      line.push(b.a);
      if (b.r.holed || (L.short && inZone(L, b.r.pos) && !b.r.events.includes('out'))) break;
      pos = b.r.pos;
    }
    return line;
  }

  // ---------- placing a feature ----------
  // Each golfer may leave one feature per hole. Every tile of it must be on terrain the feature allows (FEATURES.on:
  // no sand or water on the green; a hill may go anywhere, since golfers can scout it), never on the tee or the cup,
  // harm never within TEE_BOX tiles of the tee, never on another feature, and never so that the hole can't be
  // finished. `features` is everything already on the course (the chain plus this golfer's other picks).
  // quick: skip the finishability check (it runs the solver), for shading the map while the designer hovers.
  function placementError(course, features, f, quick) {
    const hole = course.holes[f.hole];
    const spec = FEATURES[f.kind];
    if (!spec) return 'Unknown feature.';
    const on = withSeed(hole, featuresOn(features, f.hole));
    if (spec.side) {
      if (!(f.side >= 0 && f.side < 8 && Number.isInteger(f.side))) return 'Pick a side of the green.';
      if (on.some((x) => x.kind === 'backstop' && x.side === f.side)) return 'That side already has a backstop.';
      return null;
    }
    if (hole.short && !spec.area && f.kind !== 'backstop' && (spec.area ? [[f.x, f.y]] : footprint(f)).some((p) => dist(p, hole.cup) <= ZONE_R)) {
      if (f.kind !== 'ramp') return 'That\'s the short-game area around the green: only backstops, wind, calm winds and ramps on the green go there.';
      if (!footprint(f).every((p) => inside(p[0], p[1]) && dist(p, hole.cup) <= ZONE_R && 'GF'.includes(hole.grid[p[1]][p[0]]))) return 'In the short-game area a ramp goes on the green or fringe, all of it.';
      if (footprint(f).some((p) => cheb(p, hole.cup) < RAMP_GAP)) return `A ramp on the green stays at least ${RAMP_GAP} tiles from the cup: it shapes the approach putt, not the last few feet.`;
    }
    if (spec.free4) {
      const ts = Array.isArray(f.tiles) ? f.tiles : [];
      if (ts.length !== 4 || new Set(ts.map((q) => key(q[0], q[1]))).size !== 4) return `${spec.label} take 4 tiles: pick 4 connected tiles of ${spec.on === 'RKS' ? 'rough or sand' : 'rough'}.`;
      const seen = new Set([key(ts[0][0], ts[0][1])]), queue = [ts[0]];
      while (queue.length) { const q = queue.pop(); for (const s of ts) if (!seen.has(key(s[0], s[1])) && cheb(q, s) === 1) { seen.add(key(s[0], s[1])); queue.push(s); } }
      if (seen.size !== 4) return 'The 4 tiles must join up (side by side or corner to corner).';
      if (f.kind === 'bank' && !ts.some((q) => [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].some(([dx, dy]) => inside(q[0] + dx, q[1] + dy) && hole.grid[q[1] + dy][q[0] + dx] === 'F'))) return 'A fairway bank starts at the fairway: at least one of its tiles must touch it.';
    }
    if (spec.shaped && !shapeOf(f)) return `Pick a ${spec.label.toLowerCase()} shape.`;
    const area = !!spec.area; // wind and calm cover an area; only their spot is checked, and they never block others
    const tiles = area ? [[f.x, f.y]] : footprint(f);
    const taken = new Set();
    for (const x of on) if (!FEATURES[x.kind].area) for (const [a, b] of footprint(x)) taken.add(key(a, b));
    for (const [x, y] of tiles) {
      if (!inside(x, y)) return 'Off the course.';
      if ((x === hole.tee[0] && y === hole.tee[1]) || (x === hole.cup[0] && y === hole.cup[1])) return 'Not on the tee or the cup.';
      const t = hole.grid[y][x];
      if (!spec.on.includes(t)) return `Can't put ${spec.label.toLowerCase()} on the ${TERRAIN[t].toLowerCase()}.`;
      if (spec.kind === 'harm' && cheb([x, y], hole.tee) <= TEE_BOX) return 'Too close to the tee.';
      if (!area && taken.has(key(x, y))) return 'Another feature is already there.';
    }
    if (quick) return null;
    if (!fairTee(hole, on.concat(f), true)) return 'That would leave no good tee shot: every club from the tee would end in trouble.';
    const L = layoutOf(hole, on.concat(f));
    if (!isFinite(parOf(L))) return 'That would leave no way to finish the hole.';
    return null;
  }

  // ---------- what a golfer can see ----------
  // The hole as the golfer sees it: hills hide the ground beyond them, and a ramp's or wind gate's direction is hidden,
  // until scouted (1 stroke) or, for hills, until the ball comes within 2 tiles of the hidden ground.
  function viewOf(hole, features, known, ball) {
    features = withSeed(hole, features);
    const L = layoutOf(hole, features, true);
    const grid = L.grid.map((r) => r.slice());
    const hidden = new Set();
    for (const f of features) {
      if (f.kind !== 'hill' || known.has(f.id)) continue;
      const tiles = hiddenBy(f);
      if (ball && tiles.some((t) => cheb(t, ball) <= 2)) continue;
      for (const [x, y] of tiles) { hidden.add(key(x, y)); grid[y][x] = '?'; }
    }
    return {
      grid: grid.map((r) => r.join('')), tee: hole.tee, cup: hole.cup, wind: hole.wind, hidden: [...hidden],
      features: features.map((f) => ({ id: f.id, kind: f.kind, shape: f.shape, side: f.side, tiles: f.tiles, x: f.x, y: f.y, owner: f.owner, dir: FEATURES[f.kind].hidden && !known.has(f.id) && !(f.kind === 'ramp' && hole.short && greenRamp(hole, f)) ? null : f.dir })),
    };
  }
  // The layout a golfer would predict from what they can see: hidden ground taken as rough, unknown ramps and wind
  // gates ignored. Used to preview shots; the real shot may differ.
  function believedLayout(hole, features, known, ball) {
    const v = viewOf(hole, features, known, ball);
    const L = layoutOf(hole, withSeed(hole, features).filter((f) => !(FEATURES[f.kind].hidden && !known.has(f.id)) || (f.kind === 'ramp' && hole.short && greenRamp(hole, f))), true);
    for (const k of v.hidden) { const [x, y] = k.split(',').map(Number); L.grid[y][x] = 'R'; }
    return L;
  }

  // ---------- a round ----------
  function newRound(courseId, features, golfer) {
    const course = getCourse(courseId);
    return { courseId, golfer, hole: 0, ball: course.holes[0].tee.slice(), phase: 'long', sball: null, strokes: [0, 0, 0], shots: [[], [], []], sshots: [[], [], []], scouts: [], known: [], done: false, log: [] };
  }
  const featuresOn = (features, h) => features.filter((f) => f.hole === h);
  // The hole is over (holed, or picked up at MAX_STROKES): on to the next tee.
  function finishHole(round, course, holed) {
    if (!holed) { round.strokes[round.hole] = MAX_STROKES; round.log.push({ hole: round.hole, text: `Picked up at ${MAX_STROKES}.` }); }
    round.hole += 1;
    round.phase = 'long'; round.sball = null;
    if (round.hole >= 3) round.done = true;
    else round.ball = course.holes[round.hole].tee.slice();
  }
  // A short-game stroke: { club: 'putter', dir, pace } on the green or fringe, { club: 'wedge', dir, carry } off it.
  function playShort(round, action, features) {
    const course = getCourse(round.courseId), hole = course.holes[round.hole], S = shortOf(hole, featuresOn(features || [], round.hole));
    if (!(action.dir === 'cup' || (action.dir >= 0 && action.dir < SDIR && Number.isInteger(action.dir)))) throw new Error('Pick a direction.');
    const legal = shortActions(S, round.sball);
    const a = action.club === 'putter' ? { club: 'putter', dir: action.dir, pace: Math.round(action.pace) } : { club: 'wedge', dir: action.dir, carry: action.carry, ...(action.spin ? { spin: action.spin } : {}) };
    if (a.spin && CHIP_SPIN[a.spin] == null) throw new Error('Spin is back or top.');
    if (!legal.some((x) => x.club === a.club && x.dir === a.dir && (a.club === 'putter' ? x.pace === a.pace : x.carry === a.carry && x.spin === a.spin))) throw new Error(a.club === 'putter' ? 'Putt from the green, fringe or light rough, at a pace of 1 to ' + PUTT_MAX + '.' : 'Chip from off the green.');
    if (action.timing != null) {
      if (!(Math.abs(action.timing) <= 1)) throw new Error('Timing runs from -1 to 1.');
      a.timing = Math.round(action.timing * 100) / 100;
    }
    const from = round.sball.slice(), struck = shortStruck(a, a.timing);
    const r = shortShot(S, from, struck, false);
    round.strokes[round.hole] += 1 + r.penalty;
    round.sshots[round.hole].push({ from, action: a, struck, result: r });
    round.log.push({ hole: round.hole, text: describeShort(a, r, struck) });
    if (!r.holed) round.sball = r.pos;
    if (r.holed || round.strokes[round.hole] >= MAX_STROKES) finishHole(round, course, r.holed);
    return r;
  }
  // The solver's choice for the round's next stroke (tests and agents).
  function autoAction(round, features) {
    const hole = getCourse(round.courseId).holes[round.hole];
    if (round.phase === 'short') return bestShortAction(shortOf(hole, featuresOn(features, round.hole)), round.sball).a;
    return bestAction(layoutOf(hole, featuresOn(features, round.hole)), round.ball).a;
  }
  function play(round, features, action) {
    if (round.done) throw new Error('The round is over.');
    if (round.phase === 'short') return playShort(round, action, features);
    const course = getCourse(round.courseId), hole = course.holes[round.hole];
    const L = layoutOf(hole, featuresOn(features, round.hole));
    const c = CLUBS[action.club];
    if (!c) throw new Error('Unknown club.');
    if (!(action.dir >= 0 && action.dir < NDIR)) throw new Error('Pick a direction.');
    if (action.shape && !(SHAPES_OF[action.shape] && CURVE[action.club])) throw new Error('Only the driver, wood and irons can be shaped (draw or fade).');
    const from = round.ball.slice();
    if (action.timing != null) {
      if (!(Math.abs(action.timing) <= 1)) throw new Error('Timing runs from -1 to 1.');
      action = { ...action, timing: Math.round(action.timing * 100) / 100 };
    }
    if (!clubAllowed(L, from, action.club)) throw new Error({ tee: 'The driver is for the tee shot only.', TF: 'The wood plays only from the tee or the fairway.', G: 'The putter is for the green; chip on with the wedge.' }[CLUBS[action.club].from]);
    if (action.toCup) action = { club: 'putter', toCup: true, dir: dirToCup(from, L.cup) };
    else if (!aimDirs(L, from).includes(action.dir)) throw new Error('Aim toward the hole (you can only play away from it from behind a tree).');
    const tr = {};
    const r = shot(L, from, action, tr);
    Object.defineProperty(r, 'trace', { value: tr, enumerable: false }); // for the page's animation (not saved)
    round.strokes[round.hole] += 1 + r.penalty;
    round.shots[round.hole].push({ from, action, result: r });
    // Ramps and wind gates the ball touched are no longer a secret.
    for (const f of withSeed(hole, featuresOn(features, round.hole))) if (r.events.includes(f.kind) && footprint(f).some((t) => cheb(t, r.pos) <= 2) && !round.known.includes(f.id)) round.known.push(f.id);
    round.log.push({ hole: round.hole, text: describeShot(action, r) });
    round.ball = r.pos;
    if (!r.holed && L.short && inZone(L, r.pos) && round.strokes[round.hole] < MAX_STROKES) {
      round.phase = 'short';
      round.sball = toShort(L.cup, r.pos);
      round.log.push({ hole: round.hole, text: 'Onto the short game.' });
    }
    if (r.holed || round.strokes[round.hole] >= MAX_STROKES) finishHole(round, course, r.holed);
    return r;
  }
  function scout(round, features, featureId) {
    const f = withSeed(getCourse(round.courseId).holes[round.hole], features).find((x) => x.id === featureId && x.hole === round.hole);
    if (!f) throw new Error('Nothing to scout there on this hole.');
    if (round.known.includes(f.id)) throw new Error('You already know what that is.');
    round.known.push(f.id);
    round.strokes[round.hole] += 1;
    round.scouts.push({ hole: round.hole, feature: f.id });
    round.log.push({ hole: round.hole, text: `Scouted the ${FEATURES[f.kind].label.toLowerCase()} (1 stroke).` });
    return f;
  }
  function describeShot(a, r) {
    const what = a.club === 'putter' ? (a.toCup ? 'Putt at the cup' : `Putt ${a.dist}`) : `${CLUBS[a.club].label}${a.swing === 'three' ? ' ¾' : ''}${a.shape && SHAPES_OF[a.shape] ? `, ${a.shape}` : ''}`;
    const bits = [];
    const off = r.events.find((e) => /^(pull|push)\d$/.test(e));
    if (r.events.includes('short')) bits.push('struck heavy, it comes up short');
    if (off) bits.push(`${off.startsWith('pull') ? 'pulled left' : 'pushed right'} ${off.slice(-1)} (${off.startsWith('pull') ? 'early' : 'late'} swing)`);
    if (r.events.includes('wind')) bits.push('the wind moves it');
    if (r.events.includes('tree')) bits.push('it clips a tree');
    if (r.events.includes('ramp')) bits.push('a ramp runs it on');
    if (r.events.includes('gust')) bits.push('it flies through a gust, which carries it on');
    if (r.events.includes('backstop')) bits.push('a backstop holds it on the green');
    if (r.events.includes('bank')) bits.push('a fairway bank holds it on the fairway');
    if (r.events.includes('water')) bits.push('water: dropped beside it, +1');
    if (r.events.includes('out')) bits.push('out of bounds: back where it was, +1');
    if (r.events.includes('sand')) bits.push('it plugs in sand');
    if (r.events.includes('undertree')) bits.push('it drops under the planted trees (punch out next)');
    if (r.events.includes('punch')) bits.push(`punched out from under the trees (${PUNCH} tiles at most)`);
    if (r.events.includes('lag')) bits.push(`it stops beside the cup (putts drop only from within ${TAP_IN} tiles)`);
    if (r.events.includes('hill')) bits.push('it stops on a hill');
    return `${what} ${ARROWS[Math.round(a.dir / (NDIR / 8)) % 8]}${bits.length ? `: ${bits.join(', ')}` : ''}${r.holed ? '. In the hole!' : '.'}`;
  }

  // ---------- credit for features ----------
  // What each feature did to one golfer on one hole, against the best line. For every shot, compare where it ended
  // with and without the feature, both priced by strokes to go on the course as it stood. Harm the best line takes
  // too (par with the feature minus par without) earns nothing; likewise help the best line also gets. Scouting a
  // feature pays its author the stroke spent.
  function credit(course, features, round) {
    const out = {};
    for (let h = 0; h < 3; h++) {
      const on = featuresOn(features, h);
      if (!on.length) continue;
      const hole = course.holes[h];
      const L = layoutOf(hole, on), T = togoMap(L);
      // Strokes to go after a shot, on the course as it stood. A spot that can't hold a ball there (the feature's own
      // water, say, where the ball would have stopped without it) is priced on the course without the feature.
      const cost = (r, Tw) => {
        if (r.holed) return r.penalty;
        const v = T[key(r.pos[0], r.pos[1])];
        return r.penalty + (v === undefined || !isFinite(v) ? Tw[key(r.pos[0], r.pos[1])] : v);
      };
      for (const f of on) {
        const without = layoutOf(hole, on.filter((x) => x.id !== f.id));
        const Tw = togoMap(without);
        let harm = 0, aid = 0;
        for (const s of round.shots[h]) {
          const dlt = cost(s.result, Tw) - cost(shot(without, s.from, s.action), Tw);
          if (dlt > 0) harm += dlt; else aid -= dlt;
        }
        // Short-game strokes (only a ramp on the green changes them): the stroke as struck, with and without it, both
        // priced on the short map as it stood.
        if (L.short && without.short && L.short !== without.short) {
          const Ts = shortTogo(L.short), Tso = shortTogo(without.short);
          const sc = (r) => { if (r.holed) return r.penalty; const i = r.pos[1] * SN + r.pos[0], v = Ts.get(i); return r.penalty + (v == null || !isFinite(v) ? (Tso.get(i) ?? 0) : v); };
          for (const s of round.sshots[h] || []) {
            const dlt = sc(s.result) - sc(shortShot(without.short, s.from, s.struck || s.action, false));
            if (dlt > 0) harm += dlt; else aid -= dlt;
          }
        }
        const parWith = parOf(L), parWithout = parOf(without);
        const unavoidable = Math.max(0, parWith - parWithout), parAid = Math.max(0, parWithout - parWith);
        const scouted = round.scouts.filter((x) => x.feature === f.id).length;
        const c = out[f.id] || (out[f.id] = { feature: f.id, owner: f.owner, kind: f.kind, hole: h, harm: 0, aid: 0, scouted: 0, unavoidable: 0 });
        c.harm += Math.max(0, harm - unavoidable);
        c.unavoidable += Math.min(harm, unavoidable);
        c.aid += Math.max(0, aid - parAid);
        c.scouted += scouted;
      }
    }
    return Object.values(out);
  }

  const api = {
    W, H, NDIR, PUNCH, explainShort, shortStruck, isTapIn, PUTT_LIES, CURVE, SHAPES_OF, CHIP_SPIN, shortOf, RAMP_G, RAMP_GAP, fairTee, LIGHT_W, ROUGH_LOSS, dropNear, bankTiles, BANK_ARC, genShort, ZONE_R, SCALE, SN, SC, SDIR, SDIRS, PUTT_MAX, CHIP_CARRIES, CUP_R, FRICTION, inZone, toShort, shortShot, shortActions, shortTogo, shortValue, bestShortAction, describeShort, slopeAt, autoAction, withSeed, aimTargets, interestOf, MIN_INTEREST, SWINGS, TIMING, missOf, SHAPES, shapeOf, carryOf, MAX_STROKES, AIM_CONE, tapInClear, TEE_BOX, WIND_R, GUST, gustPush, WATER_SHAPES, costOf, windCone, GREEN_R, PIN_GAP, TAP_IN, clubAllowed, TERRAIN, CLUBS, DIRS, ORIENT, ARROWS, FEATURES, ACTIONS,
    getCourse, layoutOf, shot, togoMap, parOf, parLine, bestAction, aimDirs, actionsAt, footprint, hiddenBy, placementError, viewOf, believedLayout,
    newRound, play, scout, credit, describeShot, featuresOn, key,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RelayGolf = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
