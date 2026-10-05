// Relay Moto, stage 0: the engine. A side-view motocross race across four lanes, simulated at a fixed 60 ticks a
// second in integer arithmetic only (no floats, no trig), so every browser and the server get exactly the same race
// from the same inputs. One player rider (index 0) and four AI riders; a seeded track; pieces riders leave behind;
// par by beam search over quarter-second beats; credit by replaying a rider's own inputs with and without a piece.
(function (root) {
  'use strict';

  // ---------- units and constants ----------
  // Distances in units of 0.1 mm (U per metre); speeds in units per tick; slopes and pitch in per-mille (rise per
  // 1000 run: 1000 is 45°, 577 is 30°, 176 is 10°). Heat 0..10000.
  const TICK = 60;                  // ticks per second
  const U = 10000;                  // units per metre
  // Speeds and gravity (4 October 2026: speeds ×1.3 for more top speed, gravity ×1.7 to match, so every jump keeps its
  // carry; was 2333 / 3000 and 27). Gravity is a game value, not Earth's.
  const G = 46;                     // gravity, units per tick² (about 16.6 m/s²)
  const TOP = 3033, TURBO_TOP = 3900; // 18.2 m/s (65 km/h) with the throttle, 23.4 m/s (84 km/h) with turbo
  const LANES = 4;
  const BIKE = 18000;               // a bike's length (1.8 m), for collisions
  const LANE_TICKS = 20;            // a lane change takes a third of a second
  const LEAN_RATE = 16;             // pitch change per tick in the air while leaning (was 12: flights are shorter now)
  const WHEELIE = { max: 500, up: 20, down: 30, hop: 300 }; // a wheelie's lift; `hop` clears a hurdle or whoops
  // Landing windows, pitch against the ground's slope: clean within 270 (about 15°), rough within 580 (30°), and with a
  // landing ramp clean within 450 (24°). (Until 4 October 2026: 180, 470 and 360, about 10°, 25° and 20°.)
  const LAND = { clean: 270, rough: 580, cleanRamp: 450 };
  const PITCH_MAX = 1700;           // about 60°
  const MIN_AIR = 9;                // a hop shorter than this (0.15 s) isn't judged as a landing
  const HEAT_MAX = 10000;
  // Heat: the throttle warms the engine only up to GAS_HEAT (50 %) and cools it slowly above that; turbo heats it fast
  // to the limit. So heat is a turbo budget. (Until 4 October 2026 the throttle heated without limit, every rider had
  // to coast about a quarter of the race, and par's search couldn't plan the heat well.)
  const HEAT = { gas: 5, gasAbove: -3, turbo: 22, coast: -12, air: -8, down: -15, cool: -40, coolant: -300 };
  const GAS_HEAT = 5000;
  const CRASH_TICKS = 150;          // 2.5 s to run back to the bike
  const OVERHEAT_TICKS = 180, OVERHEAT_RESET = 6000; // 3 s to cool, back to 60 %
  const BEAT = 15;                  // par and agents decide every quarter-second
  const LENGTH_M = 1150;            // a track's length in metres (about a minute; 900 before the speed-up)
  const MAX_TICKS = TICK * 240;
  // The throttle closes the gap to top speed by 1/ACCEL of it each tick (a time constant of ACCEL ticks): 0 to 60 km/h
  // in about 0.8 s on the throttle, 0.4 s on turbo. (Until 4 October 2026: 40, twice as slow.)
  const ACCEL = 20;
  // A boost strip: for BOOST_TICKS after riding over it, top speed is BOOST_PCT % and the engine doesn't heat.
  const BOOST_TICKS = 120, BOOST_PCT = 120;
  // Bumped whenever physics or the generator change what a race gives, so saved chains from older engines are
  // recognised (the page starts them afresh). 2: faster acceleration (4 October 2026).
  const ENGINE = 3; // 3: boost lasts 2 s; hurdles and coolant dearer (4 October 2026)

  // ---------- deterministic randomness ----------
  function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
  function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0); }; }
  // An integer 0..999 fixed by (seed, k): a rider's noise for one jump or one hazard never depends on what else
  // happened in the race, so a race with and without a piece differs only where the piece is.
  const noise = (seed, k) => { let h = Math.imul((seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16; return h % 1000; };
  const ri = (rng, lo, hi) => lo + (rng() % (hi - lo + 1)); // an integer lo..hi

  // ---------- pieces ----------
  // Zones on the track. Seed zones never age; riders' pieces cost seconds (ticks) on their own time.
  const PIECES = {
    // (4 October 2026: a boost lasted only a moment and earned about 0.25 s a rider, coolant 1 s or more for the same
    // price, and simulated benefactors only ever left coolant. Now a boost lasts BOOST_TICKS and coolant costs 2 s.)
    boost: { label: 'Boost strip', kind: 'boon', cost: 60, len: 3, desc: 'One lane, 3 m: 2 s of boost, top speed +20 % and no heat, even on turbo.' },
    coolant: { label: 'Coolant pad', kind: 'boon', cost: 120, len: 3, desc: 'One lane, 3 m: heat −40 %.' },
    landing: { label: 'Landing ramp', kind: 'boon', cost: 60, len: 10, desc: 'One lane of a jump\'s landing, 10 m: the clean-landing window doubles.' },
    oil: { label: 'Oil slick', kind: 'harm', cost: 60, len: 4, desc: 'One lane, 4 m: no throttle or lane change on it, and speed bleeds away.' },
    // (3 s since 4 October 2026, was 2: in a simulated week hurdles were nearly all the harm left.)
    hurdle: { label: 'Hurdle', kind: 'harm', cost: 180, len: 1, desc: 'A low barrier across one lane: wheelie over it (some speed lost) or crash.' },
    mud: { label: 'Mud patch', kind: 'harm', cost: 60, len: 6, desc: 'One lane, 6 m: slows hard.' },
    dust: { label: 'Dust cloud', kind: 'bluff', cost: 60, len: 15, lanes: 2, desc: 'Two lanes, 15 m: hides the ground beneath until you\'re close (a display effect; it may hide nothing).' },
  };
  const HARMFUL = new Set(['mud', 'oil', 'hurdle']); // zone kinds that count against the two-clear-lanes rule

  // ---------- the track ----------
  // Ground: contiguous segments { x0, x1, y0, s } (s in per-mille). Zones: { id, kind, x0, x1, mask } (mask: lanes).
  // Jumps: { x0, lip, land } (a lip, and the end of its landing area) for placement rules.
  // How far a bike leaving a lip at height h (units) on slope s, at speed v, flies before it meets level ground.
  function carry(h, s, v) {
    let y = h, vy = Math.floor((v * s) / 1000), d = 0;
    while (y > 0) { y += vy; vy -= G; d += v; }
    return d;
  }
  // A landing area runs LAND_PAD past where a bike at full turbo comes down; GAP is the open track between features (m).
  // (Until 4 October 2026: 10 m and 5-12 m, with taller jumps; jumps and their landings covered most of a track and
  // left too little room to build.)
  const LAND_PAD = 5 * U, GAP = [20, 40];
  const trackCache = new Map();
  function genTrack(id) {
    if (trackCache.has(id)) return trackCache.get(id);
    const rng = mulberry32(hashStr(id));
    const L = LENGTH_M * U;
    // Each lane has its own ground: a jump is built in the lanes of `mask` (all four, or two side by side), and the
    // other lanes stay flat beside it. `y` is the height of the jump's lanes.
    const segs = [[], [], [], []], zones = [], jumps = [];
    const ALL = (1 << LANES) - 1;
    let x = 0, y = 0, mask = ALL;
    const seg = (len, s) => { const x1 = x + len; for (let l = 0; l < LANES; l++) { const on = (mask >> l) & 1; segs[l].push({ x0: x, x1, y0: on ? y : 0, s: on ? s : 0 }); } y += Math.floor((s * len) / 1000); x = x1; };
    const flat = (len) => seg(len, 0);
    const zone = (kind, x0, len, mask) => zones.push({ id: `s${zones.length}`, kind, x0, x1: x0 + len, mask, seed: true });
    const lanesMask = (n) => { const a = ri(rng, 0, LANES - n); let m = 0; for (let k = 0; k < n; k++) m |= 1 << (a + k); return m; };
    flat(50 * U);
    // Jumps are most of a track (8 of every 12 picks). Each jump's landing area runs to where a bike at full turbo
    // would come down, plus LAND_PAD, and is kept flat; nothing else is generated inside it. Between features there are
    // GAP metres of open, flat track: room for riders' pieces.
    const kinds = ['ramp', 'ramp', 'ramp', 'ramp', 'tabletop', 'tabletop', 'double', 'double', 'whoops', 'mud', 'cool', 'grass'];
    // Beside a two-lane jump the other lanes are whoops from 10 m before it to where its landing area ends, so the jump
    // is the fast line and the pack funnels into its two lanes (where nobody can change lane beside the ramp).
    const beside = (x0) => { const j = jumps[jumps.length - 1]; if (mask !== ALL) zones.push({ id: `s${zones.length}`, kind: 'whoops', x0: x0 - 10 * U, x1: j.land, mask: ALL & ~mask, seed: true }); };
    const landing = (lip, h, s) => { const c = carry(h, s, TURBO_TOP), j = jumps[jumps.length - 1]; j.land = lip + c + LAND_PAD; j.end = x; return c; };
    while (x < L - 110 * U) {
      const k = kinds[ri(rng, 0, kinds.length - 1)];
      // Two jumps in five are built in two lanes side by side only, the other two lanes running flat beside them:
      // riders choose the jump or the flat, and bunch up getting there (no changing lanes beside a ramp).
      mask = ALL;
      if ((k === 'ramp' || k === 'tabletop' || k === 'double') && rng() % 5 < 2) mask = lanesMask(2);
      if (k === 'ramp') {
        // Small, medium, large: 1.1, 1.4 and 2.3 m tall, carrying about 28, 34 and 42 m at full turbo.
        const size = ri(rng, 0, 2), s = [380, 480, 580][size], len = [3, 3, 4][size] * U, x0 = x;
        seg(len, s);
        const lip = x, h = y, back = Math.ceil((y * 1000) / 1500);
        seg(back, -1500); y = 0; // (the back face ends a hair below 0; the next flat starts level)
        jumps.push({ x0, lip, land: 0, mask });
        flat(landing(lip, h, s) - back + LAND_PAD);
        beside(x0);
      } else if (k === 'tabletop') {
        // A 1.6 m table, 14-20 m long: with the throttle a bike lands on its down slope (a little faster); with turbo it
        // flies the whole table.
        const x0 = x;
        seg(3 * U, 550); const lip = x, h = y, top = ri(rng, 14, 20) * U; flat(top); seg(Math.ceil((y * 1000) / 450), -450); y = 0;
        jumps.push({ x0, lip, land: 0, mask });
        flat(Math.max(5 * U, landing(lip, h, 550) - (x - lip) + LAND_PAD));
        beside(x0);
      } else if (k === 'double') {
        // Two 1.5 m humps 10-13 m apart: clear both, or land between them.
        const x0 = x;
        seg(3 * U, 500); const lip = x, h = y; seg(3 * U, -500); y = 0; flat(ri(rng, 10, 13) * U); seg(3 * U, 500); seg(3 * U, -500); y = 0;
        jumps.push({ x0, lip, land: 0, mask });
        flat(Math.max(5 * U, landing(lip, h, 500) - (x - lip) + LAND_PAD));
        beside(x0);
      } else if (k === 'whoops') {
        const len = ri(rng, 15, 25) * U; zone('whoops', x, len, (1 << LANES) - 1); flat(len); flat(15 * U);
      } else if (k === 'mud') {
        const len = ri(rng, 12, 20) * U; zone('mud', x, len, lanesMask(ri(rng, 1, 2))); flat(len); flat(15 * U);
      } else if (k === 'cool') {
        const len = ri(rng, 10, 15) * U; zone('cool', x, len, lanesMask(ri(rng, 1, 2))); flat(len); flat(15 * U);
      } else {
        const len = ri(rng, 30, 50) * U; zone('grass', x, len, 1 << (LANES - 1)); flat(len); flat(10 * U);
      }
      mask = ALL;
      flat(ri(rng, GAP[0], GAP[1]) * U);
    }
    flat(L + 60 * U - x); // the finish straight, and run-off past the line
    // The four AI riders: a preferred lane, how hot they run, how far ahead they look, how well they land, and how
    // often they notice a hazard in time.
    // (A Fisher-Yates shuffle: sort() with a random comparator calls it a different number of times on different
    // JavaScript engines, which would draw different random numbers and change the track.)
    const prefs = [0, 1, 2, 3];
    for (let k = 3; k > 0; k--) { const j = rng() % (k + 1); [prefs[k], prefs[j]] = [prefs[j], prefs[k]]; }
    const ai = [0, 1, 2, 3].map((k) => ({ seed: rng(), pref: prefs[k], heatCap: ri(rng, 65, 90) * 100, look: ri(rng, 20, 50) * U, leanErr: ri(rng, 0, 200), notice: ri(rng, 800, 980) }));
    // Their pace: a spread of top speeds (86, 92, 98 and 104 % of a bike's, in a seeded order, ±2), so the four spread
    // out down the track and a rider at any speed tends to have one in view: over 8 tracks an AI rider was on screen
    // (12 m behind to 36 m ahead) for 90 % of a simulated rider's race, and 78 % of par's. Wider spreads left slow
    // and fast riders alone; tighter ones left par's pace alone half the race.
    const paces = [86, 92, 98, 104];
    for (let k = 3; k > 0; k--) { const j = rng() % (k + 1); [paces[k], paces[j]] = [paces[j], paces[k]]; }
    ai.forEach((p, k) => { p.pace = paces[k] + ri(rng, -2, 2); });
    const T = build({ id, length: L, segs, zones: zones.slice(), jumps, ai, pieces: [] });
    trackCache.set(id, T);
    return T;
  }
  // Lookups by metre: the segment at each metre's start, and the zones touching it.
  function build(T) {
    const n = Math.ceil(T.segs[0][T.segs[0].length - 1].x1 / U) + 2;
    const segAt = T.segs.map((S) => { const a = new Int32Array(n); let si = 0; for (let m = 0; m < n; m++) { while (si < S.length - 1 && S[si].x1 <= m * U) si++; a[m] = si; } return a; });
    const zoneAt = Array.from({ length: n }, () => []);
    for (const z of T.zones) for (let m = Math.floor(z.x0 / U); m <= Math.floor((z.x1 - 1) / U) && m < n; m++) zoneAt[m].push(z);
    // Each lane's zones in order of their start, for looking ahead.
    const laneZones = Array.from({ length: LANES }, (_, l) => T.zones.filter((z) => (z.mask >> l) & 1).sort((a, b) => a.x0 - b.x0));
    T.segAt = segAt; T.zoneAt = zoneAt; T.laneZones = laneZones; T.thirds = [0, Math.floor(T.length / 3), Math.floor((2 * T.length) / 3), T.length];
    return T;
  }
  // The track with riders' pieces on it (zones added; seed untouched).
  function trackWith(base, pieces) {
    if (!pieces.length) return base;
    const k = JSON.stringify(pieces.map((p) => [p.id, p.kind, p.x, p.lane]));
    if (!base.variants) Object.defineProperty(base, 'variants', { value: new Map(), enumerable: false });
    if (base.variants.has(k)) return base.variants.get(k);
    const zones = base.zones.concat(pieces.map(pieceZone));
    const T = build({ ...base, zones, pieces: pieces.slice() });
    base.variants.set(k, T);
    return T;
  }
  const pieceZone = (p) => { const spec = PIECES[p.kind]; let mask = 1 << p.lane; if (spec.lanes === 2) mask |= 1 << Math.min(LANES - 1, p.lane + 1); return { id: p.id, kind: p.kind, x0: p.x, x1: p.x + spec.len * U, mask, owner: p.owner }; };

  // The ground in a lane. groundY without a lane gives the highest of the four (for drawing a profile).
  const segOf = (T, x, l) => { const A = T.segAt[l], S = T.segs[l], m = Math.max(0, Math.min(A.length - 1, Math.floor(x / U))); let s = A[m]; while (s < S.length - 1 && S[s].x1 <= x) s++; return S[s]; };
  const groundY = (T, x, l) => {
    if (l === undefined) { let m = 0; for (let k = 0; k < LANES; k++) m = Math.max(m, groundY(T, x, k)); return m; }
    const g = segOf(T, x, l); return g.y0 + Math.floor((g.s * (x - g.x0)) / 1000);
  };
  const slopeAt = (T, x, l) => segOf(T, x, l).s;
  // Two lanes have the same ground over [x, x + span): a lane change is allowed only then, so nobody slides sideways
  // onto or off a ramp that's in one lane and not the other.
  function sameGround(T, x, a, b, span) {
    for (let q = x; q <= x + span; q += U / 2) if (groundY(T, q, a) !== groundY(T, q, b)) return false;
    return true;
  }
  const laneSpan = (r) => r.v * (LANE_TICKS + 10) + 3 * U;
  function zonesAt(T, x, lane) {
    const m = Math.max(0, Math.min(T.zoneAt.length - 1, Math.floor(x / U))), out = [];
    for (const z of T.zoneAt[m]) if (x >= z.x0 && x < z.x1 && (z.mask >> lane) & 1) out.push(z);
    return out;
  }
  // Zones in a lane over [x0, x1).
  function zonesAhead(T, x0, x1, lane) {
    const out = [];
    for (const z of T.laneZones[lane]) { if (z.x0 >= x1) break; if (z.x1 > x0) out.push(z); }
    return out;
  }

  // ---------- riders and the world ----------
  const newRider = (x, lane, pace = 100) => ({ pace, x, y: 0, vy: 0, v: 0, lane, laneTo: lane, laneT: 0, pitch: 0, wheel: 0, air: 0, airT: 0, heat: 0, down: 0, fin: -1, boost: 0, tgt: null, crashes: 0, overheats: 0, roughs: 0 });
  // The grid: the four AI riders on the front row (3 m ahead), the player behind in lane 2.
  // The grid: a staggered field, five places 4 m apart (1st at 16 m, 5th on the line) in lanes 1, 2, 3, 4, 1. The
  // player starts 2nd, in lane 2; the AI riders take 1st and 3rd-5th fastest first (by pace). Over 8 tracks that kept
  // an AI rider on screen for 73 % of a par-pace race (50 % with the slowest in front, 61 % in a random order); typical
  // riders had one 84-85 % of the race either way. (Until 4 October 2026 the four AI riders started side by side 3 m
  // ahead and the player behind them.)
  const GRID = [[16, 0], [12, 1], [8, 2], [4, 3], [0, 0]];
  const gridOrder = (T) => [0, 1, 2, 3].sort((a, b) => T.ai[b].pace - T.ai[a].pace || a - b);
  function startWorld(T) {
    const r = [newRider(GRID[1][0] * U, GRID[1][1])], places = [0, 2, 3, 4], order = gridOrder(T);
    for (let k = 0; k < 4; k++) r.push(null);
    order.forEach((ai, n) => { const [x, lane] = GRID[places[n]]; r[ai + 1] = newRider(x * U, lane, T.ai[ai].pace || 100); });
    return { t: 0, r, chain: null };
  }
  // While the player is out of reach of every AI rider (NEAR), the AI riders' next tick doesn't depend on the player,
  // so worlds share it: a world then holds a node of a shared AI timeline (`chain`, with its riders read-only) and
  // advances it once for every world on it. Sibling branches in the par search all start a beat on the same node,
  // so the AI riders are simulated once per beat instead of once per branch. Results are exactly the same.
  const cloneWorld = (w) => ({ t: w.t, r: w.chain ? [{ ...w.r[0] }].concat(w.r.slice(1)) : w.r.map((x) => ({ ...x })), chain: w.chain });
  const NEAR = 25 * U;
  const nearAny = (p, ais) => ais.some((o) => o.fin < 0 && Math.abs(o.x - p.x) < NEAR);
  const OUT = { fin: 0 }; // a player sitting the race out
  function advance(T, node) {
    if (!node.next) {
      const w = { t: node.t, r: [OUT].concat(node.ais.map((x) => ({ ...x }))), chain: null };
      step(T, w, NONE, null);
      node.next = { t: w.t, ais: w.r.slice(1), next: null };
    }
    return node.next;
  }

  // Inputs: { thr: 0 coast, 1 throttle, 2 turbo; lane: -1, 0, +1 (a request); lean: -1 forward, 0, +1 back }.
  const NONE = { thr: 0, lane: 0, lean: 0 };
  const encode = (a) => a.thr + 3 * (a.lane + 1) + 9 * (a.lean + 1);
  const decode = (c) => ({ thr: c % 3, lane: (Math.floor(c / 3) % 3) - 1, lean: Math.floor(c / 9) - 1 });

  const crash = (T, r, log, i, t, why) => { r.down = CRASH_TICKS; r.v = 0; r.wheel = 0; r.air = 0; r.y = groundY(T, r.x, r.lane); r.laneT = 0; r.laneTo = r.lane; r.crashes++; if (log) log.push({ t, i, e: 'crash', why, x: r.x }); };

  function moveRider(T, r, a, t, log, i) {
    if (r.fin >= 0) return;
    if (r.down > 0) { r.down--; r.v = 0; r.heat = Math.max(0, r.heat + HEAT.down); return; }
    const prevX = r.x;
    if (r.boost > 0) r.boost--;
    if (r.laneT > 0 && --r.laneT === 0) r.lane = r.laneTo;
    if (!r.air) {
      const zs = zonesAt(T, r.x, r.lane);
      let mud = false, grass = false, whoops = false, oil = false, boost = false, cool = false, coolant = false;
      for (const z of zs) { if (z.kind === 'mud') mud = true; else if (z.kind === 'grass') grass = true; else if (z.kind === 'whoops') whoops = true; else if (z.kind === 'oil') oil = true; else if (z.kind === 'boost') boost = true; else if (z.kind === 'cool') cool = true; else if (z.kind === 'coolant') coolant = true; }
      let pct = 100;
      if (mud) pct = 45; else if (grass) pct = 75;
      if (whoops && r.wheel < WHEELIE.hop) pct = Math.min(pct, 55);
      if (r.wheel > 0) pct = Math.min(pct, 92);
      if (boost) r.boost = BOOST_TICKS; // (riding over the strip starts, or restarts, the boost)
      const top = Math.floor(((a.thr === 2 ? TURBO_TOP : TOP) * pct * r.pace * (r.boost > 0 ? BOOST_PCT : 100)) / 1000000); // (pace: 100 for the player)
      if (oil) r.v -= Math.floor(r.v / 40);
      else if (a.thr > 0) { if (r.v < top) r.v += Math.max(1, Math.floor((top - r.v) / ACCEL)); else r.v -= Math.floor((r.v - top) / 20); }
      else r.v -= Math.floor(r.v / 150) + 1;
      const s = slopeAt(T, r.x, r.lane);
      r.v -= Math.floor((G * s) / 1000);
      if (r.v < 0) r.v = 0;
      r.heat += oil || a.thr === 0 ? HEAT.coast : r.boost > 0 ? 0 : a.thr === 2 ? HEAT.turbo : r.heat < GAS_HEAT ? Math.min(HEAT.gas, GAS_HEAT - r.heat) : HEAT.gasAbove;
      if (cool) r.heat += HEAT.cool;
      if (coolant) r.heat += HEAT.coolant;
      if (r.heat < 0) r.heat = 0;
      if (r.heat >= HEAT_MAX) { r.down = OVERHEAT_TICKS; r.v = 0; r.heat = OVERHEAT_RESET; r.overheats++; if (log) log.push({ t, i, e: 'overheat', x: r.x }); return; }
      r.wheel = a.lean > 0 ? Math.min(WHEELIE.max, r.wheel + WHEELIE.up) : Math.max(0, r.wheel - WHEELIE.down);
      // Move along the ground, or leave it where the ground falls away faster than the bike would drop (a lip).
      const nx = r.x + r.v, gy = groundY(T, nx, r.lane), vyG = Math.floor((r.v * s) / 1000), by = r.y + vyG - G;
      if (by > gy + 30 && r.v > 0) { r.air = 1; r.airT = 0; r.x = nx; r.y = by; r.vy = vyG - G; r.pitch = s + r.wheel; r.wheel = 0; }
      else { r.x = nx; r.y = gy; r.pitch = slopeAt(T, nx, r.lane) + r.wheel; }
    } else {
      r.airT++; r.x += r.v; r.y += r.vy; r.vy -= G;
      r.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, r.pitch + a.lean * LEAN_RATE));
      r.heat = Math.max(0, r.heat + HEAT.air);
      const gy = groundY(T, r.x, r.lane);
      if (r.y <= gy) {
        const s = slopeAt(T, r.x, r.lane);
        r.y = gy; r.air = 0; r.vy = 0;
        if (r.airT >= MIN_AIR) {
          const diff = Math.abs(r.pitch - s), ramp = zonesAt(T, r.x, r.lane).some((z) => z.kind === 'landing');
          if (diff <= (ramp ? LAND.cleanRamp : LAND.clean)) { if (s < 0) r.v += Math.floor((r.v * -s) / 10000); if (log) log.push({ t, i, e: 'clean', x: r.x, diff }); }
          else if (diff <= LAND.rough) { r.v = Math.floor((r.v * 3) / 4); r.roughs++; if (log) log.push({ t, i, e: 'rough', x: r.x, diff }); }
          else { crash(T, r, log, i, t, `landed ${diff > 0 ? 'off by' : ''} ${diff}`); return; }
        }
        r.pitch = s;
      }
    }
    // Hurdles crossed this tick: cleared in the air, hopped with a wheelie, or a crash.
    for (const z of zonesAhead(T, prevX + 1, r.x + 1, r.lane)) {
      if (z.kind !== 'hurdle' || !(z.x0 > prevX && z.x0 <= r.x)) continue;
      if (r.air && r.y - groundY(T, z.x0, r.lane) > 3000) continue;
      if (r.wheel >= WHEELIE.hop) { r.v = Math.floor((r.v * 4) / 5); if (log) log.push({ t, i, e: 'hop', x: r.x }); }
      else { crash(T, r, log, i, t, 'hurdle'); return; }
    }
    if (r.x >= T.length) { r.fin = t; if (log) log.push({ t, i, e: 'finish' }); }
  }

  const lanesOf = (r) => (r.laneT > 0 ? [r.lane, r.laneTo] : [r.lane]);
  // One tick for everyone: inputs (the player's given; the AI's from their policy), lane requests checked against
  // riders alongside, moves, then collisions.
  function step(T, w, a0, log) {
    if (w.chain) {
      const ais = w.chain.ais, p0 = w.r[0];
      if (nearAny(p0, ais)) { w.r = [p0].concat(ais.map((x) => ({ ...x }))); w.chain = null; }
      else {
        // The player alone (nobody within reach): a lane request needs only the lane to exist and no oil underfoot.
        if (a0.lane && !p0.air && p0.laneT === 0 && p0.down === 0 && p0.fin < 0) {
          const to = p0.lane + a0.lane;
          if (to >= 0 && to < LANES && !zonesAt(T, p0.x, p0.lane).some((z) => z.kind === 'oil') && sameGround(T, p0.x, p0.lane, to, laneSpan(p0))) { p0.laneTo = to; p0.laneT = LANE_TICKS; }
        }
        moveRider(T, p0, a0, w.t, log, 0);
        w.chain = advance(T, w.chain);
        w.t++;
        w.r = [p0].concat(w.chain.ais);
        return;
      }
    }
    const t = w.t, rs = w.r, acts = [a0];
    for (let i = 1; i < rs.length; i++) acts.push(aiInput(T, w, i, T.ai[i - 1]));
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i], a = acts[i];
      if (!a.lane || r.air || r.laneT > 0 || r.down > 0 || r.fin >= 0) continue;
      const to = r.lane + a.lane;
      if (to < 0 || to >= LANES) continue;
      if (zonesAt(T, r.x, r.lane).some((z) => z.kind === 'oil')) continue;
      if (!sameGround(T, r.x, r.lane, to, laneSpan(r))) continue;
      if (rs.some((o, j) => j !== i && o.fin < 0 && lanesOf(o).includes(to) && Math.abs(o.x - r.x) < BIKE + 2000)) continue;
      r.laneTo = to; r.laneT = LANE_TICKS;
    }
    for (let i = 0; i < rs.length; i++) moveRider(T, rs[i], acts[i], t, log, i);
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      if (a.fin >= 0 || b.fin >= 0 || Math.abs(a.x - b.x) >= BIKE || Math.abs(a.y - b.y) >= 5000) continue;
      if (!lanesOf(a).some((l) => lanesOf(b).includes(l))) continue;
      const [back, front, bi] = a.x < b.x || (a.x === b.x && i > j) ? [a, b, i] : [b, a, j];
      if (back.down > 0) continue;
      if ((front.down > 0 && back.v > 390) || back.v - front.v > 780) { if (front.down === 0) front.v = Math.max(0, front.v - 520); crash(T, back, log, bi, t, 'collision'); }
      else { back.v = Math.min(back.v, front.v); back.x = front.x - BIKE; if (!back.air) back.y = groundY(T, back.x, back.lane); }
    }
    w.t++;
    // Out of reach again: the AI riders start a new shared timeline (this world's riders become its read-only node).
    if (rs[0] !== OUT && rs[0].fin < 0 && !nearAny(rs[0], rs.slice(1))) w.chain = { t: w.t, ais: rs.slice(1), next: null };
  }

  // ---------- the AI policy ----------
  // Also drives simulated players (check.js) with their own parameters. Deterministic: every random-looking choice
  // comes from noise(seed, k) for a fixed k (a jump, a hazard), never from a running stream.
  function aiInput(T, w, i, p) {
    const r = w.r[i];
    if (r.down > 0 || r.fin >= 0) return NONE;
    if (r.air) {
      if (r.airT === 0 || r.tgt === null) r.tgt = landingSlope(T, r) + Math.floor(((noise(p.seed, Math.floor(r.x / (10 * U))) - 500) * p.leanErr) / 500);
      return { thr: 1, lane: 0, lean: r.pitch > r.tgt + 6 ? -1 : r.pitch < r.tgt - 6 ? 1 : 0 };
    }
    r.tgt = null;
    let thr = r.heat < p.heatCap ? 2 : r.heat > p.heatCap + 1200 ? 0 : 1;
    const noticed = (z) => z.seed && z.kind !== 'oil' && z.kind !== 'hurdle' ? true : noise(p.seed, hashStr(z.id)) < p.notice;
    const bad = (z) => (z.kind === 'mud' || z.kind === 'oil' || z.kind === 'hurdle' || z.kind === 'whoops') && noticed(z); // (whoops: only left for a lane without them)
    const ahead = zonesAhead(T, r.x, r.x + 8 * U, r.lane);
    const lean = ahead.some((z) => (z.kind === 'whoops' || z.kind === 'hurdle') && noticed(z)) ? 1 : 0;
    if (zonesAt(T, r.x + 5 * U, r.lane).some((z) => z.kind === 'mud')) thr = Math.min(thr, 1);
    let lane = 0;
    if (r.laneT === 0) {
      const blocked = (ln) => zonesAhead(T, r.x, r.x + p.look, ln).some(bad)
        || w.r.some((o, j) => j !== i && o.fin < 0 && lanesOf(o).includes(ln) && o.x > r.x - BIKE && o.x < r.x + 12 * U && (o.down > 0 || o.v + 200 < r.v));
      if (blocked(r.lane)) {
        // Head for the nearest clear lane, one lane at a time (ties: toward the preferred lane). A rider in the whoops
        // beside a two-lane jump crosses two lanes to reach it.
        const opts = [0, 1, 2, 3].filter((ln) => ln !== r.lane && !blocked(ln)).sort((a, b) => Math.abs(a - r.lane) - Math.abs(b - r.lane) || Math.abs(a - p.pref) - Math.abs(b - p.pref));
        if (opts.length) lane = Math.sign(opts[0] - r.lane);
      } else if (r.lane !== p.pref) {
        const ln = r.lane + Math.sign(p.pref - r.lane);
        if (!blocked(ln)) lane = ln - r.lane;
      }
    }
    return { thr, lane, lean };
  }
  // Where a bike in the air comes down: fly it on until it meets the ground; the slope there.
  function landingSlope(T, r) {
    let x = r.x, y = r.y, vy = r.vy;
    const l = r.laneT > 0 ? r.laneTo : r.lane;
    for (let k = 0; k < 600; k++) { x += r.v; y += vy; vy -= G; if (y <= groundY(T, x, l)) return slopeAt(T, x, l); }
    return 0;
  }

  // ---------- racing ----------
  // A race with the player driven by ctrl(T, w) -> input each tick. Returns the finish tick (or MAX_TICKS), the
  // player's inputs (one code per tick) and, with log, what happened.
  function race(T, ctrl, opts = {}) {
    const w = startWorld(T), inputs = [], log = opts.log ? [] : null;
    while (w.r[0].fin < 0 && w.t < MAX_TICKS) { const a = ctrl(T, w); inputs.push(encode(a)); step(T, w, a, log); }
    return { time: w.r[0].fin < 0 ? MAX_TICKS : w.r[0].fin + 1, inputs, log, world: w };
  }
  // Replay a player's inputs (codes per tick) on a track; with untilX, the tick the player first reaches it.
  function replay(T, inputs, opts = {}) {
    const w = startWorld(T), log = opts.log ? [] : null;
    for (let k = 0; w.r[0].fin < 0 && w.t < MAX_TICKS; k++) {
      if (opts.untilX != null && w.r[0].x >= opts.untilX) return { time: w.t, world: w, log, at: true };
      step(T, w, k < inputs.length ? decode(inputs[k]) : { thr: 1, lane: 0, lean: 0 }, log);
    }
    return { time: w.r[0].fin < 0 ? MAX_TICKS : w.r[0].fin + 1, world: w, log };
  }
  // A simulated rider: the AI policy with a rider's own parameters, driving the player's bike.
  const policyRider = (p) => (T, w) => aiInput(T, w, 0, p);

  // ---------- par ----------
  // Beam search over beats: on each beat the solver picks throttle, turbo or coast, a lane change or none, and, on the
  // ground where a wheelie can matter (whoops or a hurdle within 25 m), a lean; it holds them for BEAT ticks (a lane
  // change is requested on the beat's first tick). In the air it doesn't choose: every tick it leans toward the slope
  // the bike will land on (where it comes down doesn't depend on the lean, so this lands as cleanly as any lean can),
  // which is what a perfect rider does and costs the search no branches. (Until 4 October 2026 par chose a lean per
  // beat in the air too; steps of a quarter-second were too coarse for the long flights, and riders beat it.)
  // States are bucketed so the beam stays diverse; the first beat in which any state crosses the line gives par.
  // A state's heat counts against it, at HEAT_WORTH units of track a heat point: without it the beam filled with hot
  // turbo lines that overheated later and par lost 0.4-2.8 s a track (turbo's extra speed costs about 39 units a heat
  // point at break-even; 20 searched best over 8 tracks, 26 after the speed-up).
  const HEAT_WORTH = 26; // (20 before the speed-up: turbo now buys more track a heat point)
  const airLean = (r, tgt) => (r.pitch > tgt + 6 ? -1 : r.pitch < tgt - 6 ? 1 : 0);
  function par(T, opts = {}) {
    const B = opts.beam || 200, thrs = opts.thrs || [0, 1, 2];
    let nodes = [{ w: startWorld(T), parent: null, codes: null }];
    for (let beat = 0; beat * BEAT < MAX_TICKS; beat++) {
      const kids = new Map();
      let best = null;
      for (const n of nodes) {
        const r = n.w.r[0];
        const lanes = r.air || r.laneT > 0 || r.down > 0 ? [0] : [-1, 0, 1].filter((d) => r.lane + d >= 0 && r.lane + d < LANES);
        const wheelie = (ln) => zonesAhead(T, r.x, r.x + 25 * U, ln).some((z) => z.kind === 'whoops' || z.kind === 'hurdle');
        const leans = !r.air && (wheelie(r.lane) || (r.laneT > 0 && wheelie(r.laneTo))) ? [-1, 0, 1] : [0];
        const ts = r.down > 0 ? [0] : r.air ? [1] : thrs;
        for (const thr of ts) for (const lane of lanes) for (const lean of leans) {
          const w = cloneWorld(n.w), codes = [];
          let tgt = w.r[0].air ? landingSlope(T, w.r[0]) : null;
          for (let k = 0; k < BEAT && w.r[0].fin < 0; k++) {
            const q = w.r[0];
            let a;
            if (q.air) { if (tgt === null) tgt = landingSlope(T, q); a = { thr: 1, lane: 0, lean: airLean(q, tgt) }; }
            else { tgt = null; a = { thr, lane: k === 0 ? lane : 0, lean }; }
            codes.push(encode(a));
            step(T, w, a, null);
          }
          const q = w.r[0], kid = { w, parent: n, codes };
          if (q.fin >= 0) { if (!best || q.fin < best.w.r[0].fin) best = kid; continue; }
          const key = `${q.lane}${q.laneTo}${q.laneT > 0 ? 1 : 0}${q.air}${q.down > 0 ? 1 : 0}|${Math.floor(q.x / 2500)}|${Math.floor(q.v / 60)}|${Math.floor(q.heat / 400)}|${Math.floor(q.pitch / 60)}`;
          kid.score = q.x + q.v * 25 - q.heat * HEAT_WORTH - (q.heat > 8000 ? (q.heat - 8000) * 4 : 0) - q.down * TOP;
          const old = kids.get(key);
          if (!old || kid.score > old.score) kids.set(key, kid);
        }
      }
      if (best) {
        const parts = [];
        for (let n = best; n.parent; n = n.parent) parts.push(n.codes);
        const inputs = [].concat(...parts.reverse());
        const rp = replay(T, inputs, { log: true });
        return { time: rp.time, inputs, log: rp.log.filter((e) => e.i === 0) };
      }
      nodes = [...kids.values()].sort((a, b) => b.score - a.score).slice(0, B);
      if (!nodes.length) break;
    }
    return { time: MAX_TICKS, inputs: [], log: [] };
  }

  // ---------- placing pieces ----------
  // p: { id, owner, kind, x (units), lane, run (optional: which race of the owner's placed it) }.
  function placementError(base, pieces, p, opts = {}) {
    const spec = PIECES[p.kind];
    if (!spec) return 'Unknown piece.';
    if (!(Number.isInteger(p.lane) && p.lane >= 0 && p.lane < LANES - (spec.lanes === 2 ? 1 : 0))) return 'Pick a lane.';
    const x0 = p.x, x1 = p.x + spec.len * U;
    if (x0 < 50 * U || x1 > base.length - 50 * U) return 'Not within 50 m of the start or the finish.';
    const third = (x) => (x < base.thirds[1] ? 0 : x < base.thirds[2] ? 1 : 2);
    if (third(x0) !== third(x1 - 1)) return 'A piece sits within one third of the track.';
    if (pieces.some((q) => q.owner === p.owner && (q.run ?? null) === (p.run ?? null) && third(q.x) === third(x0))) return 'One piece per third of the track.'; // (per race: `run` tags a race's pieces)
    // Jumps (4 October 2026): no piece on a jump's ramps (from 5 m before it to where its ramps end), and no hurdle
    // in its landing area either (a rider in the air can't avoid one). Other pieces may sit in a landing: a rider picks
    // the lane before take-off. A landing ramp goes in a landing area, 5 m or more past the lip.
    // (A jump in two lanes bars only those lanes: the flat lanes beside it are open.)
    const pm = pieceZone(p).mask, jl = (j) => (j.mask ?? (1 << LANES) - 1) & pm;
    if (p.kind === 'landing') { if (!base.jumps.some((j) => jl(j) === pm && x0 >= j.lip + 5 * U && x1 <= j.land)) return 'A landing ramp goes in a jump\'s landing area, in the jump\'s lanes.'; }
    else if (base.jumps.some((j) => jl(j) && x0 < (j.end ?? j.lip) && x1 > j.x0 - 5 * U)) return 'Not on a jump\'s ramps.';
    else if (p.kind === 'hurdle' && base.jumps.some((j) => jl(j) && x0 < j.land && x1 > j.x0 - 5 * U)) return 'Hurdles stay out of jumps and their landing areas.';
    const mine = pieceZone(p);
    const all = base.zones.concat(pieces.map(pieceZone));
    if (all.some((z) => !z.seed && z.x0 < x1 && z.x1 > x0 && (z.mask & mine.mask))) return 'Another piece is already there.';
    if (HARMFUL.has(p.kind)) {
      for (let x = x0; x < x1; x += U) {
        let m = mine.mask;
        for (const z of all) if (HARMFUL.has(z.kind) && x >= z.x0 && x < z.x1) m |= z.mask;
        let n = 0; for (let l = 0; l < LANES; l++) if ((m >> l) & 1) n++;
        if (n > 2) return 'At least two lanes stay clear of mud, oil and hurdles everywhere.';
      }
    }
    if (opts.quick) return null;
    const pr = par(trackWith(base, pieces.concat(p)), { beam: opts.beam });
    if (pr.time >= MAX_TICKS || pr.log.some((e) => e.e === 'crash')) return 'That would leave no clean line.';
    return null;
  }
  const costOf = (p) => PIECES[p.kind].cost;

  // ---------- credit ----------
  // What each piece did to one race. Replaying a rider's inputs far past a piece doesn't work: they reacted to it
  // (a turbo held on oil does nothing; replayed without the oil it overheats the bike), so only the piece itself is
  // replayed. From the moment the rider reaches 2 m before it (the world as it really was), the rider's own inputs
  // are run on with and without the piece until 2 m past its end, and the two arrivals are compared in time:
  //   ticks taken, plus the time to win back a speed difference (the throttle closes a gap with a time constant of
  //   RECOVER ticks, so a speed deficit dv costs about dv × RECOVER / v ticks), plus heat (HEAT_TICKS heat units are
  //   worth a tick: what turbo's extra speed costs in heat).
  // Harm or aid beyond what par itself loses or gains to the piece (pars: { with, without: { [pieceId]: ticks } }) is
  // credited. A rider who never rides over the piece gets 0 from it.
  const RECOVER = ACCEL, HEAT_TICKS = 60;
  function credit(base, pieces, run, pars) {
    const T = trackWith(base, pieces), out = [];
    for (const f of pieces) {
      if (f.owner === run.runner) continue;
      const without = trackWith(base, pieces.filter((q) => q.id !== f.id)), z = pieceZone(f);
      const entry = Math.max(0, z.x0 - 2 * U), exit = z.x1 + 2 * U;
      // The world as the rider reached the entry.
      const w = startWorld(T);
      let k = 0;
      while (w.r[0].fin < 0 && w.r[0].x < entry && k < run.inputs.length) step(T, w, decode(run.inputs[k++]), null);
      let d = 0;
      if (w.r[0].x >= entry && w.r[0].x < exit) {
        // (A boost's effect lasts after the strip: the with-piece run goes on until its boost wears off, and both runs
        // are timed to where that happens.)
        let end = exit;
        const go = (TT, follow) => {
          const v = cloneWorld(w);
          let n = 0;
          while (v.r[0].fin < 0 && (v.r[0].x < end || (follow && v.r[0].boost > 0)) && n < 900) step(TT, v, decode(run.inputs[k + n] ?? encode({ thr: 1, lane: 0, lean: 0 })), null), n++;
          if (follow) end = Math.max(end, v.r[0].x);
          return { n, v: v.r[0].v, heat: v.r[0].heat, lane: v.r[0].lane };
        };
        const a = go(T, f.kind === 'boost'), b = go(without, false), ref = Math.max(b.v, 1000);
        d = a.n - b.n + Math.floor(((b.v - a.v) * RECOVER) / ref) + Math.floor((a.heat - b.heat) / HEAT_TICKS);
      }
      const parD = pars ? pars.with - pars.without[f.id] : 0;
      out.push({ piece: f.id, owner: f.owner, kind: f.kind, harm: Math.max(0, d - Math.max(0, parD)), aid: Math.max(0, -d - Math.max(0, -parD)), raw: d, parD });
    }
    return out;
  }

  // ---------- for the page ----------
  // Where each AI rider would ride if nobody got in the way: its lane every 5 m (the faint traces on the track strip).
  function aiLines(T) {
    if (T.aiLines) return T.aiLines;
    const w = startWorld(T), lines = [[], [], [], []];
    w.r[0] = { ...w.r[0], fin: 0 };
    while (w.t < MAX_TICKS && w.r.slice(1).some((x) => x.fin < 0)) {
      step(T, w, NONE, null);
      for (let k = 0; k < 4; k++) { const r = w.r[k + 1], m = Math.floor(r.x / (5 * U)); if (lines[k][m] === undefined) lines[k][m] = r.laneT > 0 ? r.laneTo : r.lane; }
    }
    Object.defineProperty(T, 'aiLines', { value: lines, enumerable: false });
    return lines;
  }
  // A rider's place among the five: riders finished first (by tick), then by distance.
  const placeOf = (w, i) => 1 + w.r.filter((o, j) => j !== i && (o.fin >= 0 ? w.r[i].fin < 0 || o.fin < w.r[i].fin : w.r[i].fin < 0 && o.x > w.r[i].x)).length;

  // ---------- text view ----------
  // The track as text, 5 m a character: a profile row and four lane rows (top row is lane 4, the outside).
  function strip(T, opts = {}) {
    const step = 5 * U, n = Math.ceil(T.length / step);
    const prof = [], rows = Array.from({ length: LANES }, () => []);
    const CH = { mud: 'm', cool: 'c', whoops: 'w', grass: 'g', oil: 'O', boost: 'B', coolant: 'C', landing: 'L', hurdle: 'H', mud_p: 'M', dust: 'd' };
    for (let k = 0; k < n; k++) {
      const x = k * step + Math.floor(step / 2);
      let mx = 0; for (let q = k * step; q < (k + 1) * step; q += U) mx = Math.max(mx, groundY(T, q));
      prof.push(mx > 15000 ? '^' : mx > 0 ? '-' : '_');
      for (let l = 0; l < LANES; l++) {
        const zs = zonesAt(T, x, l);
        const z = zs.find((q) => !q.seed) || zs[0];
        rows[l].push(z ? (z.seed ? CH[z.kind] : z.kind === 'mud' ? 'M' : CH[z.kind]) : groundY(T, x, l) > 0 ? '^' : '.');
      }
    }
    if (opts.line) for (const [k, l] of opts.line) if (k < n && rows[l][k] === '.') rows[l][k] = '*';
    const marks = []; for (let k = 0; k < n; k++) marks.push(T.thirds.slice(1, 3).some((x) => Math.floor(x / step) === k) ? '|' : ' ');
    return ['   ' + marks.join(''), '   ' + prof.join(''), ...rows.map((r, l) => `${l + 1}  ${r.join('')}`).reverse()].join('\n');
  }

  const api = {
    ENGINE, ACCEL, sameGround, TICK, U, G, TOP, TURBO_TOP, LANES, BIKE, BEAT, LAND, HEAT, HEAT_MAX, WHEELIE, PIECES, MAX_TICKS, LENGTH_M, LANE_TICKS, CRASH_TICKS, OVERHEAT_TICKS, HARMFUL,
    aiLines, placeOf, pieceZone,
    genTrack, trackWith, groundY, slopeAt, zonesAt, zonesAhead, startWorld, cloneWorld, step, race, replay, par,
    aiInput, policyRider, placementError, costOf, credit, strip, encode, decode, noise, hashStr, mulberry32,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RelayMoto = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
