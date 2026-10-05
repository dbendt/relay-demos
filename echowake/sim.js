// Trap Relay — Stage 0 prototype simulation.
// Runners enter a SEED (a daily layout on a weekly MAP), gather loot, and drop traps
// for the next runner in the chain. Pure rules engine: no rendering, no I/O.
// Used by play.html (browser global `TrapSim`), cli.js and relay.js (CommonJS).
// A run is fully determined by seed + incoming residue + runner + faction + action list.
(function (root) {
  'use strict';

  // Rules versions. Each saved run records the version it was played under and always replays under it, so a rule
  // change never rewrites a saved result. 1: HP capped at 10. 2: no HP cap (a Salve always heals its full +3;
  // HP above 10 only absorbs later damage and adds nothing to score), Spike and Salve credit measured in score
  // moved (a Spike credits only HP lost below 10; a Salve credits healing below 10 at once, and its buffer above
  // 10 is credited to its giver when it absorbs damage), and boons that cost more than they give (COST_CHANGES).
  // 3: sprung traps rearm for the next runner (a trap springs at most once per run) instead of being spent; trap
  // lifetime 3 runners instead of 4; benefactor points worth 2 per point given.
  // 4: harm a runner knowingly accepted (they scouted the room this run, then walked in) earns its author no damage
  // credit; replacing a trap costs at least the replaced trap's price.
  // 5: the upset bonus counts only harmful traps (Spike, Snare, Leech) from a faction that beats yours that actually
  // spring on you, if you escape; Decoys, boons and traps you never meet don't count.
  // 6: rewiring a switch away from a live trap that isn't yours costs at least that trap's price, the same as
  // overwriting it (cutting its wire drops a dormant trap that nothing else can wake).
  // 7: a Snare costs 4 turns instead of 2 (2 score points for 2 loot, level with a Leech), seeded or dropped.
  // 8: runner marks. A runner may scratch a mark (a room letter plus one of the seed's own glyphs) for supplies.
  // 9: seed marks stay trustworthy. The seed's own traps never age out (they rearm for every runner), and a carved
  // mark fades once it would lie: a trap mark when its seed trap is gone, a switch's verb and wire when the switch
  // no longer runs to its seed trap as carved.
  // 10: a run's score never goes below 0. Par could already be negative on a heavy layout (-3.5 in one playtest), so
  // even the best play could post a negative score; an escape now scores at least 0, the same as dying or timing out.
  // 11: the scale shifts up instead of clamping: score = loot + supplies + HP left (up to 10) + turns left ÷ 2 + upset.
  // That is the old sum plus 10 + turn cap ÷ 2, so the worst possible escape (1 HP, the last turn, nothing carried)
  // scores 1 and any escape beats dying (0). Gaps to par, handicaps and designer credit are unchanged.
  // 12: timing bonuses for designers, in bands of the map's turn cap. A late fuse: harm from a trap whose timer has
  // fired earns x1.25 if the fuse turn is in the middle third, x1.5 in the last third (the bonus goes through the
  // same avoidable-harm rule). Early aid: every boon earns x1.5 if the runner receives it in the first third of their
  // run, x1.25 in the middle third; the bonus counts only for aid the par line doesn't also collect.
  const RULES_VERSION = 13;
  const lifetimeFor = (rules) => (rules >= 3 ? 3 : 4); // runners a trap lasts
  const benefactorWeight = (rules) => (rules >= 3 ? 2 : 1); // benefactor points per point given

  const RULES = {
    hp: 10,
    supplies: 8,
    // Timed traps may change on any turn up to the map's turn cap (1 October 2026; was 8 for every map). Only widens
    // what a drop may choose, so saved runs replay unchanged and it isn't a rules version.
    peekCost: 1,
    inspectCost: 3,
    inspectSwitchCost: 2,
    disarmCost: 2, // rules 13: plus 1 turn, on an adjacent room this run's peek or inspect found something in
    disarmByMark: false, // rules 13 prototype (option B): a readable carved mark counts as detection, no peek needed
    trapLifetime: 4, // a trap survives this many runners unless sprung
  };

  // Every trap has one fixed timed partner (`then`): harmful traps turn into boons (rewarding patience),
  // boons and the decoy turn harmful (rewarding speed). The designer only chooses whether, and on which turn.
  const KINDS = {
    spike: { cost: 3, boon: false, label: 'Spike', desc: '4 damage', then: 'salve' },
    snare: { cost: 2, boon: false, label: 'Snare', desc: 'lose 4 turns', then: 'stash' },
    leech: { cost: 2, boon: false, label: 'Leech', desc: 'drain 2 loot (or 2 supplies if no loot)', then: 'cache' },
    decoy: { cost: 1, boon: false, label: 'Decoy', desc: 'nothing; reads as "something" to a peek', then: 'spike' },
    cache: { cost: 2, boon: true, label: 'Cache', desc: '+2 loot', then: 'leech' },
    salve: { cost: 2, boon: true, label: 'Salve', desc: '+3 HP (no maximum; HP above 10 absorbs later damage, not scored)', then: 'spike' },
    stash: { cost: 2, boon: true, label: 'Stash', desc: '+2 supplies', then: 'snare' },
  };
  // Older names still parse: the Decoy was the Husk, and the shelved time-travel reskin had its own names.
  const KIND_ALIASES = { husk: 'decoy', rift: 'spike', loop: 'snare', decay: 'leech', echo: 'decoy', relic: 'cache', mend: 'salve', cell: 'stash' };
  const kindOf = (k) => KIND_ALIASES[k] || k;

  const FACTIONS = {
    wardens: { label: 'Wardens', motto: 'Preserve what was.' },
    unravelers: { label: 'Unravelers', motto: 'Let it all come apart.' },
    mirrors: { label: 'Mirrors', motto: 'Nothing is only what it seems.' },
  };
  // The faction cycle: each faction beats the one it maps to. Data only, so names and order can change.
  // Matchups don't change trap effects (yet); they only drive the upset bonus.
  const BEATS = { mirrors: 'wardens', wardens: 'unravelers', unravelers: 'mirrors' };
  const UPSET_BONUS = 1; // per trap in your layout set by a faction that beats yours, paid only if you escape
  const beats = (a, b) => !!a && !!b && BEATS[a] === b;
  const factionLabel = (f) => (f && FACTIONS[f] ? FACTIONS[f].label : null);

  const EFFECTS = ['arm', 'disarm', 'invert', 'none'];
  const WAKING = ['arm', 'invert'];

  // Difficulty tiers. Each tier has its own seeds, chains and leaderboards.
  // Difficulty tiers. Each tier has its own seeds, chains and leaderboards, and its own glyph alphabet:
  // 4 glyphs on Plain, 6 on Glyphs, 8 on Deep. `nouns` and `verbs` are the meanings a tier's marks use;
  // `glyphs` are the symbols, which are dealt out to those meanings afresh every seed.
  const TIERS = {
    1: { label: 'Plain', desc: 'Switch signs in plain words, with 4 glyphs alongside to learn from.', signs: true, turnCap: 14,
      nouns: ['door', 'cache', 'spike', 'decoy'], verbs: [], glyphs: { noun: ['○', '△', '□', '◇'], verb: [] } },
    2: { label: 'Glyphs', desc: 'No plain switch signs: 6 glyphs to read. Two seeded traps.', signs: false, turnCap: 14,
      traps: 2, kinds: ['spike', 'decoy'], effects: ['arm', 'disarm'],
      nouns: ['door', 'cache', 'spike', 'decoy'], verbs: ['arm', 'disarm'], glyphs: { noun: ['○', '△', '□', '◇'], verb: ['─', '│'] } },
    3: { label: 'Deep', desc: 'No plain switch signs: 8 glyphs to read, on a larger map with three switches (one may be a blank) and three seeded traps.',
      signs: false, turnCap: 18, traps: 3, kinds: ['spike', 'snare', 'decoy'], effects: ['arm', 'disarm', 'invert'], deep: true,
      nouns: ['door', 'cache', 'spike', 'snare', 'decoy'], verbs: ['arm', 'disarm', 'invert'],
      glyphs: { noun: ['○', '△', '□', '◇', '☆'], verb: ['─', '│', '╱'] } },
  };

  // Glyph marks. The grammar is stable: shapes are NOUNS (what a thing is), strokes are VERBS (what a switch
  // does to the trap it is wired to), and a shared link letter means a switch is wired to that trap.
  // A trap's mark is its noun alone; its state follows from its switch's verb. A switch's mark is its payoff's
  // noun (none for a blank) plus its verb if it is wired; the Plain tier shows nouns only.
  // Which glyph means what is reshuffled every seed. Marks are carved when the seed is made:
  // later runners' drops and rewires can make them lie.
  const NOUNS = {
    door: 'Door: the switch that opens the exit door', cache: 'Cache: a switch that releases loot',
    spike: 'Spike', snare: 'Snare', leech: 'Leech', decoy: 'Decoy',
  };
  const VERBS = { arm: 'arm: flipping arms its trap, so the trap is dormant now', disarm: 'disarm: flipping disarms its trap, so the trap is armed now', invert: 'invert: flipping toggles its trap' };
  const LINKS = ['a', 'b', 'c'];
  // Runner marks (rules 8): scratched by runners, in a different style from the seed's carved marks, so seed marks
  // stay trustworthy and runner marks are a social read. A mark is a room letter and one glyph from the seed's own
  // alphabet: a noun (shape) or a verb (stroke). Nobody checks them: they can warn, guide, bluff or say nothing.
  const SCRATCH = { cost: 1, perRun: 2 }; // supplies per mark; marks per run
  const GLYPH_NAMES = { circle: '○', triangle: '△', square: '□', diamond: '◇', star: '☆', dash: '─', bar: '│', slash: '╱' };
  // How players see the glyphs (2 October 2026, the Astral set): display only. Seeds, marks, logs and saved runs keep
  // the characters above, so replays never change; clients draw these (console.js has them as SVG).
  const GLYPH_DISPLAY = { '○': '☉', '△': '☽', '□': '♄', '◇': '♃', '☆': '⊕', '─': '⫽', '│': '≀', '╱': '∿' };
  const GLYPH_DISPLAY_NAMES = { '○': 'sun', '△': 'moon', '□': 'saturn', '◇': 'jupiter', '☆': 'earth', '─': 'twin', '│': 'wreath', '╱': 'wave' };
  const glyphText = (s) => String(s).replace(/[○△□◇☆─│╱]/g, (c) => GLYPH_DISPLAY[c]);
  // A scratch may name its glyph by shape name, display name, or either character.
  const glyphFrom = (w) => GLYPH_NAMES[w] || Object.keys(GLYPH_DISPLAY).find((c) => GLYPH_DISPLAY[c] === w || GLYPH_DISPLAY_NAMES[c] === w) || w;
  const PAYOFF_NOUN = { open: 'door', cache: 'cache', none: null };
  const SEED = 'seed'; // owner of a seed's starting traps; earns no designer credit
  const OLD_SEED_OWNER = 'history'; // what saved runs from before the rename call it
  const STANDIN = 'stand-in'; // owner of stand-in openers' traps (earlier runners' placements, reused); earns no credit

  // Prices that changed in later rules versions. Rules 2: boons cost more than they give, so passing gifts along a
  // chain loses value instead of minting free benefactor credit (Cache and Stash 3 for +2; the Salve stays 2,
  // since its credit already depends on someone actually being hurt).
  const COST_CHANGES = { 2: { cache: 3, stash: 3 } };
  const costOf = (kind, rules) => {
    let c = KINDS[kind].cost;
    for (const [v, table] of Object.entries(COST_CHANGES)) if ((rules || RULES_VERSION) >= Number(v) && kind in table) c = table[kind];
    return c;
  };

  // A timed trap costs both stages minus 1. A boon as the second stage is free:
  // a trap that expires into a gift is weaker, so it is cheaper.
  function trapCost(kind, then, rules) {
    const first = costOf(kind, rules);
    if (!then) return first;
    const second = KINDS[then.kind].boon ? 0 : costOf(then.kind, rules);
    return Math.max(1, first + second - 1);
  }

  // ---------- maps: weekly geometry ----------
  // status: 'live' maps are in the pool the leader picks from; 'retired' maps rest. (Planned: new maps debut in the
  // unranked intermission between periods before going live; see the brief. Not built: the prototype has no period clock.)
  // The designer promotes a map to 'live', which puts it in the pool the leader picks from. A 'retired' map rests:
  // no new runs are saved on it, but its history and stand-in data stay.

  // Map economy (optional, per map): `turnCap: { <tier>: n }` overrides the tier's turn cap, `supplies` the starting
  // supplies; `loot` and `lootRooms` (and the deep block's) set how much loot there is and where it can land.
  // Tune a map's economy rather than the rules when one map shape misbehaves; ship it as a new map version.
  const MAPS = {
    alexandria: {
      name: 'Library of Alexandria', year: '48 BC', status: 'retired', version: 1, shape: 'Two lanes, one chokepoint before the exit',
      blurb: 'Two routes round the stacks. Every run must pass the atrium to reach the exit.',
      start: 'A', exit: 'X', door: ['F', 'X'],
      rooms: {
        A: { x: 70, y: 170, label: 'Quay' }, B: { x: 220, y: 70, label: 'Stacks' }, C: { x: 220, y: 270, label: 'Scriptorium' },
        D: { x: 430, y: 70, label: 'Reading Room' }, E: { x: 430, y: 270, label: 'Copyists' }, F: { x: 580, y: 170, label: 'Atrium' },
        X: { x: 720, y: 170, label: 'Exit' },
      },
      edges: [['A', 'B'], ['A', 'C'], ['B', 'C'], ['B', 'D'], ['C', 'E'], ['D', 'F'], ['E', 'F'], ['F', 'X']],
      switchRooms: ['B', 'E'], lootRooms: ['B', 'C', 'D', 'E'], loot: 5, seedTrapRooms: ['C', 'D', 'E'],
      // Added on the Deep tier.
      deep: {
        rooms: { G: { x: 325, y: 170, label: 'Catalogue' }, H: { x: 580, y: 300, label: 'Lamp Room' }, I: { x: 580, y: 40, label: 'Roof Terrace' } },
        edges: [['B', 'G'], ['C', 'G'], ['G', 'D'], ['G', 'E'], ['E', 'H'], ['H', 'F'], ['D', 'I'], ['I', 'F']],
        switchRoom: 'G', lootRooms: ['G', 'H', 'I'], loot: 3, seedTrapRooms: ['H', 'I'],
      },
    },
    silkroad: {
      name: 'The Silk Road', year: '1271', status: 'live', version: 3,
      // Version 3 (2 October 2026): same geometry and economy as version 2; seeds come from the server's secret.
      secretSeeds: true,
      // Version 2 (1 October 2026): longer turn caps. On a corridor most rooms are forced, so a Snare there ate the slack
      // for side trips and cost greedy runners about 2 points beyond its own, uncredited. 19 and 21 turns cut that to 0.4.
      // Also: no harmful seeded trap on a forced room (avoidableSeedTraps), which was most of the luck between seeds.
      turnCap: { 1: 19, 2: 19, 3: 21 },
      // Seeded Spikes and Snares only where a runner can route around them (see getSeed). Most of this map is forced.
      avoidableSeedTraps: true,
      shape: 'One long road with dead-end pockets',
      blurb: 'A single caravan road. Every room on it is a chokepoint, and the switches hide up side paths.',
      start: 'A', exit: 'X', door: ['F', 'X'],
      rooms: {
        A: { x: 60, y: 230, label: 'Kashgar Gate' }, B: { x: 170, y: 230, label: 'Caravanserai' }, C: { x: 280, y: 230, label: 'Dune Pass' },
        D: { x: 390, y: 230, label: 'Oasis' }, E: { x: 500, y: 230, label: 'Salt Flats' }, F: { x: 610, y: 230, label: 'Watchtower' },
        X: { x: 720, y: 230, label: 'Exit' }, G: { x: 170, y: 80, label: 'Silk Store' }, H: { x: 390, y: 80, label: 'Temple' },
        I: { x: 560, y: 80, label: 'Spice Cache' },
      },
      edges: [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'F'], ['F', 'X'], ['B', 'G'], ['D', 'H'], ['E', 'I']],
      switchRooms: ['G', 'H'], lootRooms: ['C', 'D', 'E', 'G', 'H', 'I'], loot: 6, seedTrapRooms: ['C', 'D', 'E', 'I'],
      deep: {
        rooms: { J: { x: 280, y: 80, label: 'Bazaar' }, K: { x: 720, y: 80, label: 'Caves' } },
        edges: [['C', 'J'], ['G', 'J'], ['F', 'K'], ['I', 'K']],
        switchRoom: 'J', lootRooms: ['J', 'K'], loot: 3, seedTrapRooms: ['K', 'F'],
      },
    },
    paris: {
      name: 'Paris Exposition', year: '1889', status: 'live', version: 2, shape: 'A hub with a ring of pavilions',
      // Version 2 (2 October 2026): same geometry as version 1; seeds come from the server's secret.
      secretSeeds: true,
      blurb: 'Everything radiates from the tower base. Many routes, one hub, and the exit behind the machine hall.',
      start: 'A', exit: 'X', door: ['D', 'X'],
      rooms: {
        A: { x: 70, y: 170, label: 'Gare' }, B: { x: 210, y: 170, label: 'Esplanade' }, H: { x: 380, y: 170, label: 'Tower Base' },
        C: { x: 380, y: 50, label: 'Gallery' }, G: { x: 380, y: 295, label: 'Pavilion' }, D: { x: 560, y: 80, label: 'Machine Hall' },
        E: { x: 560, y: 270, label: 'Fountains' }, X: { x: 720, y: 80, label: 'Exit' },
      },
      edges: [['A', 'B'], ['B', 'H'], ['H', 'C'], ['H', 'G'], ['H', 'D'], ['H', 'E'], ['C', 'D'], ['E', 'G'], ['D', 'X']],
      switchRooms: ['C', 'G'], lootRooms: ['C', 'D', 'E', 'G', 'H'], loot: 6, seedTrapRooms: ['C', 'E', 'G', 'H'],
      deep: {
        rooms: { I: { x: 210, y: 50, label: 'Dome' }, J: { x: 210, y: 295, label: 'Gardens' }, K: { x: 720, y: 270, label: 'Annex' } },
        edges: [['B', 'I'], ['I', 'C'], ['B', 'J'], ['J', 'G'], ['E', 'K'], ['K', 'D']],
        switchRoom: 'J', lootRooms: ['I', 'J', 'K'], loot: 3, seedTrapRooms: ['I', 'K'],
      },
    },
    venice: {
      name: 'Venice', year: '1500', status: 'live', version: 2, shape: 'Two canals and one bridge',
      // Version 2 (2 October 2026): same geometry as version 1; seeds come from the server's secret.
      secretSeeds: true,
      blurb: 'Two canals run side by side to the customs house. The Rialto is the only way across, and the switches sit at opposite corners.',
      start: 'A', exit: 'X', door: ['H', 'X'],
      rooms: {
        A: { x: 60, y: 170, label: 'Arsenale' }, B: { x: 190, y: 70, label: 'Fondaco' }, C: { x: 190, y: 270, label: 'Squero' },
        D: { x: 370, y: 70, label: 'Rialto' }, E: { x: 370, y: 270, label: 'Campo' }, F: { x: 550, y: 70, label: "Doge's Palace" },
        G: { x: 550, y: 270, label: 'Salt Stores' }, H: { x: 620, y: 170, label: 'Dogana' }, X: { x: 730, y: 170, label: 'Exit' },
      },
      edges: [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'E'], ['D', 'E'], ['D', 'F'], ['E', 'G'], ['F', 'H'], ['G', 'H'], ['H', 'X']],
      switchRooms: ['B', 'G'], lootRooms: ['B', 'C', 'D', 'E', 'F', 'G'], loot: 6, seedTrapRooms: ['C', 'D', 'E', 'F'],
      deep: {
        rooms: { J: { x: 275, y: 170, label: 'Ghetto' }, K: { x: 460, y: 170, label: 'Murano Dock' }, L: { x: 730, y: 300, label: 'Lido' } },
        edges: [['C', 'J'], ['J', 'B'], ['D', 'K'], ['K', 'G'], ['G', 'L'], ['L', 'H']],
        switchRoom: 'K', lootRooms: ['J', 'K', 'L'], loot: 3, seedTrapRooms: ['J', 'L', 'H'],
      },
    },
  };

  // ---------- seeds: daily, generated deterministically from map + number ----------

  function hashStr(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The seed secret. Map versions marked `secretSeeds` draw every random choice of a seed (loot, switch payoffs, traps,
  // wiring, glyphs) from HMAC-SHA256(secret, seed id), so the published code can't rebuild a layout and the stream can't
  // be worked back from what a runner sees (32-bit mulberry seeds could be brute-forced from the loot alone).
  // The secret is TRAP_SEED_SECRET, or <store>/seed-secret (created on first use; back it up: lose it and the secret
  // seeds can't be rebuilt). Browsers never have it: they adopt seeds the server sends (/api/seed/<id>, adoptSeed).
  let secretCache = null;
  const inNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node) && typeof require === 'function';
  function seedSecret() {
    if (secretCache || !inNode) return secretCache;
    if (process.env.TRAP_SEED_SECRET) return (secretCache = process.env.TRAP_SEED_SECRET);
    const fs = require('fs'), path = require('path');
    const dir = process.env.TRAP_DATA || path.join(__dirname, 'data');
    const file = path.join(dir, 'seed-secret');
    try { secretCache = fs.readFileSync(file, 'utf8').trim(); } catch (e) { /* first use */ }
    if (!secretCache) {
      fs.mkdirSync(dir, { recursive: true });
      try { fs.writeFileSync(file, require('crypto').randomBytes(32).toString('hex'), { flag: 'wx' }); } catch (e) { /* another process won */ }
      secretCache = fs.readFileSync(file, 'utf8').trim();
    }
    return secretCache;
  }
  function secretRng(label) {
    const secret = seedSecret();
    if (!secret) throw new Error(`The layout of ${label.split('/')[0]} is held by the server.`);
    const crypto = require('crypto');
    let block = 0, buf = null, pos = 32;
    return function () {
      if (pos >= 32) { buf = crypto.createHmac('sha256', secret).update(`${label}#${block++}`).digest(); pos = 0; }
      const v = buf.readUInt32BE(pos);
      pos += 4;
      return v / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }

  // Map versions. Changing a map's geometry would break every saved run played on it, so a changed map gets a new
  // version: MAPS holds the current version, and MAP_HISTORY keeps each earlier version's definition so saved runs
  // replay on the geometry they were played on.
  const MAP_HISTORY = { // mapId -> { version: definition }
    silkroad: {
      1: {
        name: 'The Silk Road', year: '1271', status: 'live', version: 1, shape: 'One long road with dead-end pockets',
        blurb: 'A single caravan road. Every room on it is a chokepoint, and the switches hide up side paths.',
        start: 'A', exit: 'X', door: ['F', 'X'],
        rooms: {
          A: { x: 60, y: 230, label: 'Kashgar Gate' }, B: { x: 170, y: 230, label: 'Caravanserai' }, C: { x: 280, y: 230, label: 'Dune Pass' },
          D: { x: 390, y: 230, label: 'Oasis' }, E: { x: 500, y: 230, label: 'Salt Flats' }, F: { x: 610, y: 230, label: 'Watchtower' },
          X: { x: 720, y: 230, label: 'Exit' }, G: { x: 170, y: 80, label: 'Silk Store' }, H: { x: 390, y: 80, label: 'Temple' },
          I: { x: 560, y: 80, label: 'Spice Cache' },
        },
        edges: [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'F'], ['F', 'X'], ['B', 'G'], ['D', 'H'], ['E', 'I']],
        switchRooms: ['G', 'H'], lootRooms: ['C', 'D', 'E', 'G', 'H', 'I'], loot: 6, seedTrapRooms: ['C', 'D', 'E', 'I'],
        deep: {
          rooms: { J: { x: 280, y: 80, label: 'Bazaar' }, K: { x: 720, y: 80, label: 'Caves' } },
          edges: [['C', 'J'], ['G', 'J'], ['F', 'K'], ['I', 'K']],
          switchRoom: 'J', lootRooms: ['J', 'K'], loot: 3, seedTrapRooms: ['K', 'F'],
        },
      },
      2: {
        name: 'The Silk Road', year: '1271', status: 'live', version: 2,
        // Version 2 (1 October 2026): longer turn caps. On a corridor most rooms are forced, so a Snare there ate the slack
        // for side trips and cost greedy runners about 2 points beyond its own, uncredited. 19 and 21 turns cut that to 0.4.
        // Also: no harmful seeded trap on a forced room (avoidableSeedTraps), which was most of the luck between seeds.
        turnCap: { 1: 19, 2: 19, 3: 21 },
        // Seeded Spikes and Snares only where a runner can route around them (see getSeed). Most of this map is forced.
        avoidableSeedTraps: true,
        shape: 'One long road with dead-end pockets',
        blurb: 'A single caravan road. Every room on it is a chokepoint, and the switches hide up side paths.',
        start: 'A', exit: 'X', door: ['F', 'X'],
        rooms: {
          A: { x: 60, y: 230, label: 'Kashgar Gate' }, B: { x: 170, y: 230, label: 'Caravanserai' }, C: { x: 280, y: 230, label: 'Dune Pass' },
          D: { x: 390, y: 230, label: 'Oasis' }, E: { x: 500, y: 230, label: 'Salt Flats' }, F: { x: 610, y: 230, label: 'Watchtower' },
          X: { x: 720, y: 230, label: 'Exit' }, G: { x: 170, y: 80, label: 'Silk Store' }, H: { x: 390, y: 80, label: 'Temple' },
          I: { x: 560, y: 80, label: 'Spice Cache' },
        },
        edges: [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'F'], ['F', 'X'], ['B', 'G'], ['D', 'H'], ['E', 'I']],
        switchRooms: ['G', 'H'], lootRooms: ['C', 'D', 'E', 'G', 'H', 'I'], loot: 6, seedTrapRooms: ['C', 'D', 'E', 'I'],
        deep: {
          rooms: { J: { x: 280, y: 80, label: 'Bazaar' }, K: { x: 720, y: 80, label: 'Caves' } },
          edges: [['C', 'J'], ['G', 'J'], ['F', 'K'], ['I', 'K']],
          switchRoom: 'J', lootRooms: ['J', 'K'], loot: 3, seedTrapRooms: ['K', 'F'],
        },
      },
    },
    paris: {
      1: {
        name: 'Paris Exposition', year: '1889', status: 'live', version: 1, shape: 'A hub with a ring of pavilions',
        blurb: 'Everything radiates from the tower base. Many routes, one hub, and the exit behind the machine hall.',
        start: 'A', exit: 'X', door: ['D', 'X'],
        rooms: {
          A: { x: 70, y: 170, label: 'Gare' }, B: { x: 210, y: 170, label: 'Esplanade' }, H: { x: 380, y: 170, label: 'Tower Base' },
          C: { x: 380, y: 50, label: 'Gallery' }, G: { x: 380, y: 295, label: 'Pavilion' }, D: { x: 560, y: 80, label: 'Machine Hall' },
          E: { x: 560, y: 270, label: 'Fountains' }, X: { x: 720, y: 80, label: 'Exit' },
        },
        edges: [['A', 'B'], ['B', 'H'], ['H', 'C'], ['H', 'G'], ['H', 'D'], ['H', 'E'], ['C', 'D'], ['E', 'G'], ['D', 'X']],
        switchRooms: ['C', 'G'], lootRooms: ['C', 'D', 'E', 'G', 'H'], loot: 6, seedTrapRooms: ['C', 'E', 'G', 'H'],
        deep: {
          rooms: { I: { x: 210, y: 50, label: 'Dome' }, J: { x: 210, y: 295, label: 'Gardens' }, K: { x: 720, y: 270, label: 'Annex' } },
          edges: [['B', 'I'], ['I', 'C'], ['B', 'J'], ['J', 'G'], ['E', 'K'], ['K', 'D']],
          switchRoom: 'J', lootRooms: ['I', 'J', 'K'], loot: 3, seedTrapRooms: ['I', 'K'],
        },
      },
    },
    venice: {
      1: {
        name: 'Venice', year: '1500', status: 'live', version: 1, shape: 'Two canals and one bridge',
        blurb: 'Two canals run side by side to the customs house. The Rialto is the only way across, and the switches sit at opposite corners.',
        start: 'A', exit: 'X', door: ['H', 'X'],
        rooms: {
          A: { x: 60, y: 170, label: 'Arsenale' }, B: { x: 190, y: 70, label: 'Fondaco' }, C: { x: 190, y: 270, label: 'Squero' },
          D: { x: 370, y: 70, label: 'Rialto' }, E: { x: 370, y: 270, label: 'Campo' }, F: { x: 550, y: 70, label: "Doge's Palace" },
          G: { x: 550, y: 270, label: 'Salt Stores' }, H: { x: 620, y: 170, label: 'Dogana' }, X: { x: 730, y: 170, label: 'Exit' },
        },
        edges: [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'E'], ['D', 'E'], ['D', 'F'], ['E', 'G'], ['F', 'H'], ['G', 'H'], ['H', 'X']],
        switchRooms: ['B', 'G'], lootRooms: ['B', 'C', 'D', 'E', 'F', 'G'], loot: 6, seedTrapRooms: ['C', 'D', 'E', 'F'],
        deep: {
          rooms: { J: { x: 275, y: 170, label: 'Ghetto' }, K: { x: 460, y: 170, label: 'Murano Dock' }, L: { x: 730, y: 300, label: 'Lido' } },
          edges: [['C', 'J'], ['J', 'B'], ['D', 'K'], ['K', 'G'], ['G', 'L'], ['L', 'H']],
          switchRoom: 'K', lootRooms: ['J', 'K', 'L'], loot: 3, seedTrapRooms: ['J', 'L', 'H'],
        },
      },
    },
  };
  const versionOf = (mapId) => MAPS[mapId].version || 1;
  function mapDef(mapId, version) {
    if (version === versionOf(mapId)) return MAPS[mapId];
    const old = (MAP_HISTORY[mapId] || {})[version];
    if (!old) throw new Error(`${MAPS[mapId].name} has no version ${version}.`);
    return old;
  }

  // Seed ids: <map>#<n> on the Plain tier, <map>.<tier>#<n> above it (alexandria#4, alexandria.3#4). A map's
  // later versions carry their version: <map>@<version>#<n> (venice@2#4, venice@2.3#4), so they never reuse seeds.
  function parseSeedId(id) {
    const m = /^([a-z]+)(?:@(\d+))?(?:\.(\d+))?#(\d+)$/.exec(id || '');
    if (!m || !MAPS[m[1]] || m[2] === '1' || (m[3] && (!TIERS[m[3]] || m[3] === '1'))) {
      throw new Error(`Unknown seed "${id}". Use <map>#<n> for the Plain tier or <map>.<tier>#<n> (tier 2 or 3), e.g. alexandria#1 or alexandria.3#1; a later map version adds @<version>, e.g. venice@2#1.`);
    }
    return { mapId: m[1], version: Number(m[2] || 1), tier: Number(m[3] || 1), n: Number(m[4]) };
  }
  const seedIdOf = (mapId, tier, n, version) => {
    const v = version || versionOf(mapId);
    const prefix = v > 1 ? `${mapId}@${v}` : mapId;
    return Number(tier) > 1 ? `${prefix}.${tier}#${n}` : `${prefix}#${n}`;
  };

  // The Deep tier adds rooms, a third switch room, loot and trap rooms to the base map.
  function deepMap(base) {
    const d = base.deep;
    return Object.assign({}, base, {
      rooms: Object.assign({}, base.rooms, d.rooms), edges: base.edges.concat(d.edges),
      switchRooms: base.switchRooms.concat(d.switchRoom), lootRooms: base.lootRooms.concat(d.lootRooms),
      loot: base.loot + d.loot, seedTrapRooms: base.seedTrapRooms.concat(d.seedTrapRooms),
    });
  }

  const SIGNS = { open: 'Opens the exit door.', cache: 'Releases a cache (+3 loot).', none: 'Does nothing you can see.' };

  const seedCache = {};
  function getSeed(id) {
    if (seedCache[id]) return seedCache[id];
    const { mapId, version, tier, n } = parseSeedId(id);
    const T = TIERS[tier];
    const base = mapDef(mapId, version);
    const map = T.deep ? deepMap(base) : base;
    const rng = map.secretSeeds ? secretRng(id) : mulberry32(hashStr(id));
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];

    const rooms = {};
    for (const [rid, r] of Object.entries(map.rooms)) rooms[rid] = { x: r.x, y: r.y, label: r.label, loot: 0 };
    for (let i = 0; i < map.loot; i++) rooms[pick(map.lootRooms)].loot += 1;

    const doorKey = edgeKey(map.door[0], map.door[1]);
    const switches = {};
    const opening = { from: SEED, seed: id, traps: [], wiring: [] };
    const seedTrap = (room, kind, armed) => ({ room, kind, armed, then: null, owner: SEED, faction: null, age: 0 });
    const payoffOf = (type) => (type === 'open' ? { type, door: doorKey } : type === 'cache' ? { type, loot: 3 } : { type });

    if (tier === 1) {
      // The Plain tier keeps the original generator exactly, so its saved runs replay.
      // Which switch opens the exit door changes daily; the other releases a cache.
      const order = rng() < 0.5 ? [0, 1] : [1, 0];
      const openId = `S${order[0] + 1}`, cacheId = `S${order[1] + 1}`;
      switches[openId] = { room: map.switchRooms[order[0]], sign: SIGNS.open, payoff: payoffOf('open') };
      switches[cacheId] = { room: map.switchRooms[order[1]], sign: SIGNS.cache, payoff: payoffOf('cache') };
      // One starting trap: either a decoy, or a dormant spike the cache switch inverts (the Layout 01 bluff).
      const hRoom = pick(map.seedTrapRooms.filter((r) => r !== switches[cacheId].room));
      if (rng() < 0.5) {
        opening.traps.push(seedTrap(hRoom, 'decoy', true));
      } else {
        opening.traps.push(seedTrap(hRoom, 'spike', false));
        opening.wiring.push({ switch: cacheId, effect: 'invert', target: hRoom, owner: SEED });
      }
    } else {
      // Switch payoffs shuffle daily: the door, a cache, and on the Deep tier a blank.
      const types = shuffle(['open', 'cache', 'none'].slice(0, map.switchRooms.length), rng);
      map.switchRooms.forEach((room, i) => { switches[`S${i + 1}`] = { room, sign: SIGNS[types[i]], payoff: payoffOf(types[i]) }; });
      // Seeded traps never share a room with a switch, and at most two can be Spikes, so the seed alone can't kill.
      const trapRooms = shuffle(map.seedTrapRooms.filter((r) => !map.switchRooms.includes(r)), rng).slice(0, T.traps);
      let spikes = 0;
      // Map setting `avoidableSeedTraps` (Silk Road v2 on): a harmful seeded trap never sits on a forced room, one
      // every route from the start through the door switch to the exit must cross. There it would be a tax the whole
      // day pays, not a choice, and it was the main source of luck between seeds. A harmful kind rolled for a forced
      // room becomes a Decoy, which still bluffs a peek.
      const doorRoom = Object.values(switches).find((x) => x.payoff.type === 'open').room;
      const reaches = (from, to, avoid, open) => {
        const seen = new Set([from]), q = [from];
        while (q.length) {
          const c = q.shift();
          if (c === to) return true;
          for (const [a, b] of map.edges) {
            const nb = a === c ? b : b === c ? a : null;
            if (!nb || nb === avoid || seen.has(nb) || (nb === map.exit && !open && nb !== to)) continue;
            seen.add(nb); q.push(nb);
          }
        }
        return false;
      };
      const forcedRoom = (r) => r === doorRoom || !reaches(map.start, doorRoom, r, false) || !reaches(doorRoom, map.exit, r, true);
      for (const room of trapRooms) {
        let kind = pick(T.kinds);
        if (kind === 'spike' && ++spikes > 2) kind = 'snare';
        if (map.avoidableSeedTraps && kind !== 'decoy' && forcedRoom(room)) kind = 'decoy';
        opening.traps.push(seedTrap(room, kind, true));
      }
      // Most switches are wired to a seeded trap. The wiring decides the trap's starting state, so nothing is dead.
      const targets = shuffle(opening.traps.slice(), rng);
      for (const sid of Object.keys(switches)) {
        if (!targets.length || rng() < 0.3) continue;
        const t = targets.pop();
        const effect = pick(T.effects);
        t.armed = effect === 'arm' ? false : effect === 'disarm' ? true : rng() < 0.5;
        opening.wiring.push({ switch: sid, effect, target: t.room, owner: SEED });
      }
    }
    for (const [sid, sw] of Object.entries(switches)) rooms[sw.room].switch = sid;

    const seed = {
      id, mapId, mapVersion: version, map, tier, n, name: `${map.name}${version > 1 ? ` (v${version})` : ''}, ${map.year} · ${T.label} · seed ${n}`, turnCap: (map.turnCap && map.turnCap[tier]) || T.turnCap, signs: T.signs,
      // Per-map economy (optional): a map can set its own turn cap per tier and starting supplies. Changing either
      // ships as a new map version, so saved runs replay on the economy they were played under.
      supplies: map.supplies != null ? map.supplies : RULES.supplies,
      start: map.start, exit: map.exit, rooms, edges: map.edges, doors: { [doorKey]: { closed: true } }, switches, opening,
    };
    seed.marks = carveMarks(seed);
    seedCache[id] = seed;
    return seed;
  }

  // What a runner may see of a seed before the first move: geometry, loot, doors, which rooms hold switches (and their
  // signs where the tier shows them; the door switch is named in every run's log), and the carved marks without
  // their key. No traps, payoffs, wiring or glyph key. The server sends this for open seeds (/api/seed/<id>).
  function publicSeed(seed) {
    const doorId = Object.keys(seed.switches).find((k) => seed.switches[k].payoff.type === 'open');
    const m = seed.map;
    const switches = {};
    for (const [k, sw] of Object.entries(seed.switches)) switches[k] = { room: sw.room, sign: seed.signs || k === doorId ? sw.sign : null };
    return {
      public: true, id: seed.id, mapId: seed.mapId, mapVersion: seed.mapVersion, tier: seed.tier, n: seed.n, name: seed.name,
      turnCap: seed.turnCap, signs: seed.signs, supplies: seed.supplies, start: seed.start, exit: seed.exit,
      map: { name: m.name, year: m.year, shape: m.shape, blurb: m.blurb, status: m.status, version: m.version },
      rooms: clone(seed.rooms), edges: seed.edges, doors: clone(seed.doors), switches,
      marks: { door: seed.marks.door, switches: clone(seed.marks.switches), rooms: clone(seed.marks.rooms) },
      doorSwitch: { id: doorId, room: seed.switches[doorId].room },
    };
  }
  // Rooms every route crosses: the door switch's room, and any room without which the start can't reach the door
  // switch or the door switch can't reach the exit. The best line meets whatever waits there, so a trap or boon left on
  // one earns no credit. Public geometry only, so it works on a public seed too.
  function forcedRooms(seed) {
    const doorRoom = seed.doorSwitch ? seed.doorSwitch.room : Object.values(seed.switches).find((w) => w.payoff && w.payoff.type === 'open').room;
    const reaches = (from, to, avoid, open) => {
      const seen = new Set([from]), q = [from];
      while (q.length) {
        const c = q.shift();
        if (c === to) return true;
        for (const [a, b] of seed.edges) {
          const nb = a === c ? b : b === c ? a : null;
          if (!nb || nb === avoid || seen.has(nb) || (nb === seed.exit && !open && nb !== to)) continue;
          seen.add(nb); q.push(nb);
        }
      }
      return false;
    };
    return Object.keys(seed.rooms).filter((r) => r !== seed.start && r !== seed.exit
      && (r === doorRoom || !reaches(seed.start, doorRoom, r, false) || !reaches(doorRoom, seed.exit, r, true)));
  }

  // A browser keeps the seeds the server sends, so drawing code can call getSeed as before. A public seed never
  // replaces a full one.
  function adoptSeed(seed) {
    if (seed && seed.id && !(seedCache[seed.id] && !seedCache[seed.id].public)) seedCache[seed.id] = seed;
    return seed;
  }
  // A seed's name, and a map's turn cap, supplies and room count on a tier, without generating the seed.
  function seedName(id) {
    const { mapId, version, tier, n } = parseSeedId(id);
    const map = mapDef(mapId, version);
    return `${map.name}${version > 1 ? ` (v${version})` : ''}, ${map.year} · ${TIERS[tier].label} · seed ${n}`;
  }
  function economy(mapId, tier, version) {
    const base = mapDef(mapId, version || versionOf(mapId));
    const map = TIERS[tier].deep ? deepMap(base) : base;
    return { turnCap: (map.turnCap && map.turnCap[tier]) || TIERS[tier].turnCap, supplies: map.supplies != null ? map.supplies : RULES.supplies, rooms: Object.keys(map.rooms).length };
  }

  // Marks are carved from the seed as generated, using their own RNG stream so they never disturb the layout.
  // The exit door shows the Door noun: a switch whose shape matches it opens the door.
  function carveMarks(seed) {
    const T = TIERS[seed.tier];
    const grng = seed.map.secretSeeds ? secretRng(`${seed.id}/glyphs`) : mulberry32(hashStr(`${seed.id}/glyphs`));
    const nounG = shuffle(T.glyphs.noun.slice(), grng), verbG = shuffle(T.glyphs.verb.slice(), grng);
    const glyph = { noun: {}, verb: {} };
    T.nouns.forEach((k, i) => { glyph.noun[k] = nounG[i]; });
    T.verbs.forEach((k, i) => { glyph.verb[k] = verbG[i]; });
    const link = {};
    seed.opening.wiring.forEach((w, i) => { link[w.switch] = LINKS[i]; link[w.target] = LINKS[i]; });
    const marks = { door: glyph.noun.door, switches: {}, rooms: {}, key: glyph };
    for (const [sid, sw] of Object.entries(seed.switches)) {
      const w = seed.opening.wiring.find((x) => x.switch === sid);
      const noun = PAYOFF_NOUN[sw.payoff.type];
      marks.switches[sid] = { glyphs: (noun ? glyph.noun[noun] : '') + (w && glyph.verb[w.effect] ? glyph.verb[w.effect] : ''), link: link[sid] || null };
    }
    for (const t of seed.opening.traps) marks.rooms[t.room] = { glyphs: glyph.noun[t.kind], link: link[t.room] || null };
    return marks;
  }

  // ---------- helpers ----------

  const clone = (o) => JSON.parse(JSON.stringify(o));
  function edgeKey(a, b) { return [a, b].sort().join('-'); }

  function neighbors(seed, room) {
    const out = [];
    for (const [a, b] of seed.edges) {
      if (a === room) out.push(b);
      else if (b === room) out.push(a);
    }
    return out;
  }

  function log(s, text, opts) {
    s.log.push(Object.assign({ turn: s.turn, text, visible: true }, opts || {}));
  }

  // Designer credit, in score points. Nobody earns from their own traps, and seed traps earn nothing.
  //   dealt: damage, drain and lost turns   drawn: supplies spent scouting their work   given: boons handed out
  function impact(s, owner, key, n) {
    if (!owner || !n || owner === s.runner || owner === SEED || owner === STANDIN) return;
    s.impact[owner] = s.impact[owner] || { dealt: 0, drawn: 0, given: 0 };
    s.impact[owner][key] += n;
    // Rules 12: a timing bonus, recorded separately (dealtBonus, givenBonus) so creditImpact can judge it.
    const m = key === 'drawn' ? 1 : s.bonusMult || 1;
    if (m !== 1) { const k = key === 'dealt' ? 'dealtBonus' : 'givenBonus'; s.impact[owner][k] = (s.impact[owner][k] || 0) + n * (m - 1); }
  }
  // Rules 12 bands, by fraction of the map's turn cap: late fuses pay more for harm, early arrivals pay more for aid.
  function timingMult(s, t) {
    if (s.rules < 12 || !t || !KINDS[t.kind]) return 1;
    const cap = getSeed(s.seedId).turnCap;
    if (KINDS[t.kind].boon) { const f = s.turn / cap; return f <= 1 / 3 ? 1.5 : f <= 2 / 3 ? 1.25 : 1; }
    if (!t.fuse) return 1;
    const f = t.fuse / cap;
    return f <= 1 / 3 ? 1 : f <= 2 / 3 ? 1.25 : 1.5;
  }

  function signature(t) {
    if (t.owner === SEED) return 'part of the seed';
    if (t.owner === STANDIN) return 'stand-in opener';
    return t.faction ? `${FACTIONS[t.faction].label} signature` : 'unsigned';
  }

  function describeTrap(t, withSig) {
    let d = `${KINDS[t.kind].label} (${t.armed ? 'armed' : 'dormant'})`;
    if (t.then) d += `, becomes ${KINDS[t.then.kind].label} on turn ${t.then.at}`;
    if (withSig) d += ` — ${signature(t)}`;
    return d;
  }

  // Rooms holding a dormant trap that no switch can wake. Such traps are dead loot.
  function inertRooms(traps, wirings, onlyFresh) {
    const woken = new Set();
    for (const w of wirings) if (w && w.target && WAKING.includes(w.effect)) woken.add(w.target);
    return Object.entries(traps)
      .filter(([room, t]) => !t.armed && !woken.has(room) && (!onlyFresh || t.fresh))
      .map(([room]) => room);
  }

  // You cannot re-enter a seed you have changed. Returns a reason, or null for a scored run.
  function practiceReason(residue, runner) {
    if (!residue) return null;
    if (residue.from === runner) return 'you handed this seed on yourself';
    if ((residue.traps || []).some((t) => t.owner === runner)) return 'your own traps are still in this seed';
    return null;
  }

  // ---------- run lifecycle ----------

  // Handoffs saved before the plain-name rename say `moment` for the seed and `history` for its owner.
  const ownerOf = (o) => (o === OLD_SEED_OWNER ? SEED : o);
  function stripResidue(r) {
    if (!r) return null;
    return {
      from: ownerOf(r.from), seed: r.seed || r.moment,
      traps: clone(r.traps || []).map((t) => Object.assign(t, { owner: ownerOf(t.owner) })),
      wiring: clone(r.wiring || []).map((w) => Object.assign(w, { owner: ownerOf(w.owner) })),
      marks: clone(r.marks || []),
    };
  }

  // residue null = first runner of a chain, who faces the seed's starting traps.
  // practice (optional) forces a practice run, e.g. when the server knows this runner already made their attempt.
  // rules (optional) is the rules version to play under; new runs use the current one.
  function createRun(seedId, residue, runner, faction, practice, rules) {
    const seed = getSeed(seedId);
    runner = String(runner || 'runner').toLowerCase();
    if (runner === SEED || runner === OLD_SEED_OWNER || runner === STANDIN) throw new Error(`"${runner}" is reserved.`);
    if (faction && !FACTIONS[faction]) throw new Error(`Faction must be one of ${Object.keys(FACTIONS).join(', ')}.`);
    const ledgerIn = clone((residue && residue.ledger) || {});
    const incoming = stripResidue(residue || seed.opening);
    if (incoming.seed && incoming.seed !== seedId) throw new Error(`That handoff is from ${incoming.seed}, not ${seedId}.`);
    const s = {
      seedId,
      rules: rules || RULES_VERSION,
      runner,
      faction: faction || null,
      practice: practice || practiceReason(incoming, runner),
      residueIn: incoming,
      ledgerIn,
      room: seed.start,
      turn: 0,
      hp: RULES.hp,
      supplies: seed.supplies,
      loot: 0,
      over: false,
      outcome: null,
      visited: [seed.start],
      lootLeft: {},
      doors: clone(seed.doors),
      switches: {},
      traps: {},
      knowledge: { rooms: {}, switches: {}, glyphs: {} },
      scratches: {}, // rules 8: runner marks by the room they are scratched in
      buffer: [], // rules 2: HP above 10 from Salves, as { owner, hp }, oldest first
      upsetFaced: 0, // rules 5: harmful traps from a faction that beats yours that sprang on this runner
      log: [],
      actions: [],
      impact: {},
    };
    for (const [id, r] of Object.entries(seed.rooms)) s.lootLeft[id] = r.loot;
    for (const id of Object.keys(seed.switches)) {
      s.switches[id] = { flipped: false, wiring: { effect: 'none', target: null, owner: null }, inherited: null };
    }
    for (const t of incoming.traps) {
      s.traps[t.room] = {
        kind: kindOf(t.kind), armed: t.armed, then: t.then ? { kind: kindOf(t.then.kind), at: t.then.at } : null,
        owner: t.owner, faction: t.faction || null, age: t.age || 0, fresh: false, causes: [], origin: clone(t),
      };
    }
    for (const m of incoming.marks) {
      s.scratches[m.at] = { target: m.target, glyph: m.glyph, owner: m.owner, faction: m.faction || null, age: m.age || 0, fresh: false, origin: clone(m) };
    }
    for (const w of incoming.wiring) {
      const sid = String(w.switch || w.pivot).replace(/^P/, 'S');
      if (!s.switches[sid]) continue;
      s.switches[sid].wiring = { effect: w.effect, target: w.target, owner: w.owner };
      s.switches[sid].inherited = { switch: sid, effect: w.effect, target: w.target, owner: w.owner };
    }
    // Rules 13 (option B): the rooms whose carved mark is readable for this run, worked out once, because searches drop
    // residueIn (which decides fading) from the states they copy.
    if (s.rules >= 13) s.readableMarks = Object.entries(carvedMarks(s, seed).rooms).filter(([, mk]) => mk.glyphs).map(([r]) => r);
    log(s, `${s.runner} enters ${seed.name}, at ${seed.start} (${seed.rooms[seed.start].label}).`);
    if (s.practice) log(s, `Practice run: ${s.practice}. It will not be scored or handed on.`);
    // The faction briefing: who has been rewriting this timeline (counts only), and what escaping is worth.
    const mix = factionMix(incoming);
    if (Object.keys(mix).length) {
      const parts = Object.entries(mix).map(([f, n]) => `${factionLabel(f)} ×${n}${beats(f, s.faction) ? ' (they beat your faction)' : ''}`);
      const up = s.rules >= 5 ? incoming.traps.filter((t) => ['spike', 'snare', 'leech'].includes(kindOf(t.kind)) && beats(t.faction, s.faction)).length * UPSET_BONUS : upsetTraps(incoming, s.faction) * UPSET_BONUS;
      log(s, `Traps in this timeline were set by: ${parts.join(', ')}.${up ? ` ${s.rules >= 5 ? `Each of their harmful traps that springs on you is worth +${UPSET_BONUS} if you escape (up to +${up}).` : `Escape alive for a +${up} upset bonus.`}` : ''}`, { kind: 'rule' });
    }
    // The route is spelled out for everyone: reading glyphs is an edge, never a requirement.
    const doorId = Object.keys(seed.switches).find((id) => seed.switches[id].payoff.type === 'open');
    const [d1, d2] = Object.keys(seed.doors)[0].split('-');
    s.knowledge.glyphs[seed.marks.door] = 'door';
    log(s, `The exit door between ${d1} and ${d2} is closed. Its shape ${seed.marks.door} matches switch ${doorId} in ${seed.switches[doorId].room}: flip ${doorId} to open it.`, { kind: 'rule' });
    if (seed.signs) {
      for (const sw of Object.values(seed.switches)) {
        const g = nounGlyph(seed, seed.marks.switches[Object.keys(seed.switches).find((k) => seed.switches[k] === sw)]);
        if (g && PAYOFF_NOUN[sw.payoff.type]) s.knowledge.glyphs[g] = PAYOFF_NOUN[sw.payoff.type];
      }
    }
    return s;
  }

  // ---------- carved marks as this runner sees them ----------
  // Rules 9: a carved mark fades once it would lie, judged on the layout the runner inherited (nothing changes
  // mid-run). A trap mark fades when its seed trap is gone; a switch keeps its payoff shape, but its verb and wire
  // fade when it no longer runs to its seed trap as carved. A mark you can read is therefore always true.
  // Returns { rooms: { id: mark }, switches: { id: mark } }; a faded mark keeps its glyphs in `faded`.
  function carvedMarks(s, seed) {
    const m = seed.marks;
    if (s.rules < 9 || !s.residueIn) return { rooms: m.rooms, switches: m.switches };
    const inTraps = s.residueIn.traps || [], inWiring = s.residueIn.wiring || [];
    const seedTrapAt = (room) => inTraps.some((x) => x.room === room && x.owner === SEED);
    const rooms = {}, switches = {};
    for (const [room, mk] of Object.entries(m.rooms)) {
      rooms[room] = seedTrapAt(room) ? mk : { glyphs: '', link: null, faded: mk.glyphs };
    }
    for (const [sid, mk] of Object.entries(m.switches)) {
      const carved = seed.opening.wiring.find((w) => w.switch === sid);
      const holds = !carved || (seedTrapAt(carved.target)
        && inWiring.some((w) => String(w.switch || w.pivot).replace(/^P/, 'S') === sid && w.owner === SEED && w.effect === carved.effect && w.target === carved.target));
      if (holds) { switches[sid] = mk; continue; }
      const noun = nounGlyph(seed, mk), verb = verbGlyph(seed, mk);
      switches[sid] = { glyphs: noun || '', link: null, faded: verb || '' };
    }
    return { rooms, switches };
  }

  // A log entry as the runner's feed shows it: the text, its kind, and the safe details for that kind.
  const FEED_FIELDS = { pickup: ['room', 'loot'], spring: ['room', 'trap', 'source'], peek: ['room', 'result', 'cost'], inspect: ['room', 'result', 'cost'], inspectSwitch: ['switch', 'cost'], disarm: ['room', 'trap', 'cost'], flip: ['switch', 'room', 'payoff', 'loot'] };
  function feedEntry(e) {
    const out = { turn: e.turn, text: e.text, kind: e.kind || null };
    for (const f of FEED_FIELDS[e.kind] || []) out[f] = e[f];
    if (e.kind === 'spring') out.sign = e.faction && FACTIONS[e.faction] ? FACTIONS[e.faction].label : null;
    return out;
  }

  // ---------- glyph lessons ----------
  // Plain feedback confirms what a glyph means: a flip's payoff, a spring, an inspect. Only seeded things
  // can confirm a mark, and only while they are as carved (not replaced or rewired by a runner).
  const nounGlyph = (seed, mk) => (mk ? Array.from(mk.glyphs).find((g) => TIERS[seed.tier].glyphs.noun.includes(g)) || null : null);
  const verbGlyph = (seed, mk) => (mk ? Array.from(mk.glyphs).find((g) => TIERS[seed.tier].glyphs.verb.includes(g)) || null : null);
  const meaningLabel = (m) => m[0].toUpperCase() + m.slice(1);
  function learn(s, glyph, meaning, because) {
    if (!glyph || !meaning || s.knowledge.glyphs[glyph]) return;
    s.knowledge.glyphs[glyph] = meaning;
    log(s, `${because} So ${glyph} means ${meaningLabel(meaning)} on this seed.`, { kind: 'glyph' });
  }
  // A seeded trap still in its own room confirms that room's mark.
  function seededTrapGlyph(s, seed, room) {
    const t = s.traps[room];
    return t && !t.fresh && t.owner === SEED ? nounGlyph(seed, seed.marks.rooms[room]) : null;
  }

  function tick(s, n) {
    for (let i = 0; i < n; i++) {
      s.turn += 1;
      for (const [room, t] of Object.entries(s.traps)) {
        if (t.fresh || !t.then || s.turn < t.then.at) continue;
        const from = KINDS[t.kind].label;
        t.kind = t.then.kind;
        t.fuse = t.then.at; // rules 12: the late-fuse bonus is banded by this turn
        t.then = null;
        t.causes.push(`became ${KINDS[t.kind].label} on turn ${s.turn} (timer, was ${from})`);
        log(s, `The ${from} in ${room} turns into a ${KINDS[t.kind].label}.`, { visible: false });
      }
    }
  }

  function spring(s, room) {
    s.bonusMult = timingMult(s, s.traps[room]);
    try { return springTrap(s, room); } finally { delete s.bonusMult; }
  }
  function springTrap(s, room) {
    const t = s.traps[room];
    if (!t || t.fresh || t.spent) return; // rules 3: a sprung trap is inactive for the rest of this run
    if (!t.armed) {
      log(s, `Walked over a dormant ${KINDS[t.kind].label} in ${room}.`, { visible: false });
      return;
    }
    if (t.kind === 'decoy') {
      log(s, `Walked over a Decoy in ${room}.`, { visible: false });
      return;
    }
    const cause = t.causes.length ? ` Cause: ${t.causes.join('; then ')}.` : ' It was placed armed.';
    const by = t.owner === SEED ? 'Part of the seed' : t.owner === STANDIN ? 'Placed by a stand-in opener' : `Placed by ${t.owner}${t.faction ? ` (${FACTIONS[t.faction].label})` : ''}`;
    // owner stays server-side (it names the author); the runner's feed gets only the trap's source and faction sign.
    const tag = { kind: 'spring', room, owner: t.owner, trap: t.kind, source: t.owner === SEED ? 'seed' : t.owner === STANDIN ? 'stand-in' : 'runner', faction: t.faction || null };
    let text;
    switch (t.kind) {
      case 'spike': {
        const before = s.hp;
        s.hp -= 4;
        if (s.rules >= 2) {
          // Credit only the score the Spike moved: HP lost below 10. Buffer HP above 10 that it ate is credited
          // to whoever gave that buffer, as damage their Salve prevented.
          impact(s, t.owner, 'dealt', harmCredit(s, room, hpScoreLost(before, s.hp)));
          absorbBuffer(s, before, s.hp);
        } else impact(s, t.owner, 'dealt', 4);
        text = `A Spike springs in ${room}: −4 HP.`;
        break;
      }
      case 'snare': {
        // Rules 7: a Snare costs 4 turns (2 score points, level with a Leech) and makes the turn cap a real threat.
        const lost = s.rules >= 7 ? 4 : 2;
        impact(s, t.owner, 'dealt', harmCredit(s, room, lost / 2)); // 2 turns = 1 score point
        text = `A Snare catches you in ${room}: −${lost} turns.`;
        tick(s, lost);
        break;
      }
      case 'leech': {
        let took;
        if (s.loot > 0) { took = Math.min(2, s.loot); s.loot -= took; text = `A Leech in ${room} drains ${took} loot.`; }
        else { took = Math.min(2, s.supplies); s.supplies -= took; text = `A Leech in ${room} drains ${took} supplies.`; }
        impact(s, t.owner, 'dealt', harmCredit(s, room, took));
        break;
      }
      case 'cache':
        s.loot += 2; impact(s, t.owner, 'given', 2);
        text = `A Cache opens in ${room}: +2 loot.`;
        break;
      case 'salve': {
        if (s.rules >= 2) {
          // No HP cap: the full +3 always lands. Healing below 10 moves score now and is credited now; HP above
          // 10 becomes a buffer tagged with the giver, credited only if it later absorbs damage.
          const before = s.hp;
          s.hp += 3;
          const healed = hpScoreLost(s.hp, before); // score regained below 10
          impact(s, t.owner, 'given', healed);
          if (3 - healed > 0) s.buffer.push({ owner: t.owner, hp: 3 - healed, mult: s.bonusMult || 1 });
          text = `A Salve in ${room}: +3 HP.`;
        } else {
          const gain = Math.min(3, RULES.hp - s.hp); // rules 1 capped HP at 10
          s.hp += gain; impact(s, t.owner, 'given', gain);
          text = `A Salve in ${room}: +${gain} HP.`;
        }
        break;
      }
      case 'stash':
        s.supplies += 2; impact(s, t.owner, 'given', 2);
        text = `A Stash in ${room}: +2 supplies.`;
        break;
    }
    if (s.rules >= 5 && ['spike', 'snare', 'leech'].includes(t.kind) && beats(t.faction, s.faction)) s.upsetFaced += 1;
    log(s, text, Object.assign(tag, { reveal: `${text} ${by}.${cause}` }));
    const seed = getSeed(s.seedId);
    learn(s, seededTrapGlyph(s, seed, room), t.kind, `That was the trap marked ${seed.marks.rooms[room] ? seed.marks.rooms[room].glyphs : ''}.`);
    // Rules 3: a sprung trap rearms for the next runner, until its lifetime ends. Earlier rules spent it.
    if (s.rules >= 3) t.spent = true; else delete s.traps[room];
    if (s.hp <= 0) { s.over = true; s.outcome = 'dead'; log(s, 'You die.'); }
  }

  // Damage credit for harm the runner suffered. Rules 4: if they scouted this room earlier in the run and walked in
  // anyway, they knowingly accepted it, so it earns the author nothing (scouting credit still counts).
  const harmCredit = (s, room, n) => (s.rules >= 4 && s.knowledge.rooms[room] ? 0 : n);

  // The loot a drop costs here. Rules 4: replacing a trap costs at least the replaced trap's price (as it was
  // handed on), so erasing other runners' work is never cheaper than building it.
  function dropCost(s, kind, then) {
    const own = trapCost(kind, then, s.rules);
    const existing = s.traps[s.room];
    if (s.rules < 4 || !existing || existing.fresh || !existing.origin) return own;
    const o = existing.origin;
    return Math.max(own, trapCost(kindOf(o.kind), o.then ? { kind: kindOf(o.then.kind), at: o.then.at } : null, s.rules));
  }

  // Rules 6: the loot it costs to rewire switch `id`: if it is wired to a live trap that isn't yours, at least that
  // trap's price (as handed on). Rewiring your own wire, or an unwired switch, is free.
  function rewirePrice(s, id) {
    if (s.rules < 6) return 0;
    const w = s.switches[id] && s.switches[id].wiring;
    if (!w || !w.target || w.owner === s.runner) return 0;
    const t = s.traps[w.target];
    if (!t || t.fresh || !t.origin) return 0;
    const o = t.origin;
    return trapCost(kindOf(o.kind), o.then ? { kind: kindOf(o.then.kind), at: o.then.at } : null, s.rules);
  }

  // Score points lost when HP falls from `before` to `after`: only HP below the starting 10 counts in score.
  // (Called the other way round, it gives score regained by healing.)
  const hpScoreLost = (before, after) => Math.max(0, RULES.hp - after) - Math.max(0, RULES.hp - before);

  // When damage eats into buffer HP above 10, credit the Salves that provided it (oldest buffer first), as
  // damage prevented. Their givers earn benefactor points for exactly the score the buffer saved.
  function absorbBuffer(s, before, after) {
    let absorbed = Math.max(0, before - Math.max(after, RULES.hp));
    while (absorbed > 0 && s.buffer.length) {
      const b = s.buffer[0];
      const take = Math.min(absorbed, b.hp);
      const keep = s.bonusMult; s.bonusMult = b.mult || 1; impact(s, b.owner, 'given', take); s.bonusMult = keep;
      b.hp -= take; absorbed -= take;
      if (!b.hp) s.buffer.shift();
    }
  }

  // Apply a wiring change, refusing any that would leave one of your dormant traps unwakeable.
  function setWiring(s, id, effect, target) {
    if (!s.switches[id]) throw new Error(`No switch ${id}.`);
    if (!(id in s.knowledge.switches)) throw new Error(`Inspect ${id} this run before wiring it.`);
    if (!EFFECTS.includes(effect)) throw new Error(`Effect must be one of ${EFFECTS.join(', ')}.`);
    const t = s.traps[target];
    if (!t || !t.fresh) throw new Error('You can only wire to a trap you placed this run.');
    const proposed = Object.entries(s.switches).map(([k, sw]) => (k === id ? { effect, target } : sw.wiring));
    const dead = inertRooms(s.traps, proposed, true);
    if (dead.length) throw new Error(`That would leave your dormant trap in ${dead.join(', ')} with nothing to wake it.`);
    s.switches[id].wiring = { effect, target, owner: s.runner };
    s.knowledge.switches[id] = effect === 'none' ? 'not wired' : `${effect} → ${target}`;
  }

  // ---------- actions ----------

  function parseAction(str) {
    const w = String(str).trim().split(/\s+/).map((x) => x.toLowerCase());
    const up = (x) => (x || '').toUpperCase();
    const sid = (x) => up(x).replace(/^P(\d+)$/, 'S$1');
    const isSwitch = (x) => /^[sp]\d+$/.test(x || '');
    switch (w[0]) {
      case 'move': case 'go': return { type: 'move', room: up(w[1]) };
      case 'peek': case 'glimpse': return { type: 'peek', room: up(w[1]) };
      case 'inspect': case 'trace':
        if (isSwitch(w[1])) return { type: 'examine', switch: sid(w[1]) };
        return { type: 'inspect', room: up(w[1]) };
      case 'flip': case 'shift': return { type: 'flip' };
      case 'wait': return { type: 'wait' };
      case 'disarm': case 'defuse': return { type: 'disarm', room: up(w[1]) };
      case 'drop': case 'plant': {
        // drop <kind> <armed|dormant> [at <turn>] [wire <S#> <effect>]
        // "at <turn>" sets the trap's fixed timer; "then <kind> at <turn>" is still accepted if <kind> is its partner.
        const a = { type: 'drop', kind: kindOf(w[1]), armed: w[2] !== 'dormant', then: null, wire: null };
        const at = w.indexOf('at');
        if (at !== -1) {
          const i = w.indexOf('then');
          a.then = { kind: i !== -1 ? kindOf(w[i + 1]) : (KINDS[a.kind] ? KINDS[a.kind].then : null), at: parseInt(w[at + 1], 10) };
        }
        const j = w.indexOf('wire');
        if (j !== -1) a.wire = { switch: sid(w[j + 1]), effect: w[j + 2] };
        return a;
      }
      case 'wire': return { type: 'wire', switch: sid(w[1]), effect: w[2], target: up(w[3]) };
      case 'scratch': return { type: 'scratch', target: up(w[1]), glyph: glyphFrom(w[2]) === w[2] ? glyphFrom(String(str).trim().split(/\s+/)[2]) : glyphFrom(w[2]) };
      default: throw new Error(`Unknown action "${str}"`);
    }
  }

  function formatAction(a) {
    switch (a.type) {
      case 'move': case 'peek': case 'inspect': case 'disarm': return `${a.type} ${a.room}`;
      case 'examine': return `inspect ${a.switch}`;
      case 'drop': return `drop ${a.kind} ${a.armed ? 'armed' : 'dormant'}`
        + (a.then ? ` then ${a.then.kind} at ${a.then.at}` : '')
        + (a.wire ? ` wire ${a.wire.switch} ${a.wire.effect}` : '');
      case 'wire': return `wire ${a.switch} ${a.effect} ${a.target}`;
      case 'scratch': return `scratch ${a.target} ${a.glyph}`;
      default: return a.type;
    }
  }

  // Returns a new state; throws on an illegal action and leaves the input untouched.
  function step(state, action) {
    if (state.over) throw new Error('The run is over.');
    const a = typeof action === 'string' ? parseAction(action) : action;
    const s = clone(state);
    const seed = getSeed(s.seedId);
    const here = seed.rooms[s.room];
    const adj = neighbors(seed, s.room);

    switch (a.type) {
      case 'move': {
        if (!adj.includes(a.room)) throw new Error(`${a.room} is not adjacent to ${s.room}.`);
        const door = s.doors[edgeKey(s.room, a.room)];
        if (door && door.closed) throw new Error(`The door to ${a.room} is closed.`);
        tick(s, 1);
        s.room = a.room;
        if (!s.visited.includes(a.room)) s.visited.push(a.room);
        log(s, `Moved to ${a.room} (${seed.rooms[a.room].label}).`);
        if (a.room === seed.exit) { s.over = true; s.outcome = 'escaped'; log(s, 'You reach the exit.'); break; }
        if (s.lootLeft[a.room] > 0) { s.loot += s.lootLeft[a.room]; log(s, `Picked up ${s.lootLeft[a.room]} loot.`, { kind: 'pickup', room: a.room, loot: s.lootLeft[a.room] }); s.lootLeft[a.room] = 0; }
        spring(s, a.room);
        break;
      }
      case 'disarm': {
        // Rules 13: neutralise what a peek or inspect found next door, for this run only (the next runner meets it
        // again). You can't disarm what you haven't detected. It costs 2 supplies and a turn, tells you what it was,
        // and pays its author the supplies as scouting credit unless it was a boon (a gift thrown away earns nothing).
        if (s.rules < 13) throw new Error('Disarming arrived in rules 13.');
        if (!adj.includes(a.room)) throw new Error('You can only disarm an adjacent room.');
        const seen = s.knowledge.rooms[a.room];
        const marked = RULES.disarmByMark && (s.readableMarks || []).includes(a.room);
        if (!marked && (!seen || seen.result === 'empty')) throw new Error(`Peek or inspect ${a.room} first: you can't disarm what you haven't detected.`);
        const t = s.traps[a.room];
        if (!t || t.fresh) throw new Error(`There is nothing of anyone else's to disarm in ${a.room}.`);
        if (t.spent) throw new Error(`What was in ${a.room} has already sprung for you.`);
        if (s.supplies < RULES.disarmCost) throw new Error('Not enough supplies.');
        s.supplies -= RULES.disarmCost;
        if (!KINDS[t.kind].boon) impact(s, t.owner, 'drawn', RULES.disarmCost);
        t.spent = true;
        t.then = null;
        t.causes.push(`disarmed by the runner on turn ${s.turn + 1}`);
        s.knowledge.rooms[a.room] = { turn: s.turn + 1, how: 'disarm', result: `disarmed ${KINDS[t.kind].label}` };
        log(s, `Disarmed the ${KINDS[t.kind].label} in ${a.room}.`, { kind: 'disarm', room: a.room, trap: t.kind, cost: RULES.disarmCost });
        learn(s, seededTrapGlyph(s, seed, a.room), t.kind, `${a.room} held a ${KINDS[t.kind].label}.`);
        tick(s, 1);
        break;
      }
      case 'peek': case 'inspect': {
        if (!adj.includes(a.room)) throw new Error(`You can only ${a.type} an adjacent room.`);
        const cost = a.type === 'peek' ? RULES.peekCost : RULES.inspectCost;
        if (s.supplies < cost) throw new Error('Not enough supplies.');
        s.supplies -= cost;
        const t = s.traps[a.room];
        // Scouting only earns saboteur credit when it was caution about something harmful, not a boon.
        if (t && !t.fresh && !KINDS[t.kind].boon) impact(s, t.owner, 'drawn', cost);
        let result;
        // A peek shows that a room will change (⏱) but not how: public timers, hidden contents. It also shows the
        // sign on whatever is there: the author's faction, or none for the seed's own and stand-in traps.
        if (a.type === 'peek') {
          const sign = t ? (factionLabel(t.faction) ? `${factionLabel(t.faction)} sign` : 'no faction sign') : '';
          // The turn a timed trap changes is shown too, so waiting it out is something a runner can actually know.
          result = t ? `something here, ${sign}${t.then ? ` ⏱ turn ${t.then.at}` : ', no timer left'}` : 'empty';
        }
        else result = t ? `${describeTrap(t, true)}${t.then ? '' : ', no timer left'}` : 'empty';
        s.knowledge.rooms[a.room] = { turn: s.turn, how: a.type, result };
        log(s, `${a.type === 'peek' ? 'Peeked at' : 'Inspected'} ${a.room}: ${result}.`, { kind: a.type, room: a.room, result, cost });
        if (a.type === 'inspect' && t) learn(s, seededTrapGlyph(s, seed, a.room), t.kind, `${a.room} holds a ${KINDS[t.kind].label}.`);
        break;
      }
      case 'examine': {
        if (here.switch !== a.switch) throw new Error(`${a.switch} is not in this room.`);
        if (s.supplies < RULES.inspectSwitchCost) throw new Error('Not enough supplies.');
        s.supplies -= RULES.inspectSwitchCost;
        const w = s.switches[a.switch].wiring;
        const wt = w.target && s.traps[w.target];
        if (wt && !wt.fresh && !KINDS[wt.kind].boon) impact(s, w.owner, 'drawn', RULES.inspectSwitchCost);
        // An inspect shows the switch's true wiring, effect and target, and says when the carved wire is out of date.
        const wired = w.effect !== 'none' && w.target;
        s.knowledge.switches[a.switch] = wired ? `${w.effect} → ${w.target}` : 'not wired';
        const carved = seed.opening.wiring.find((x) => x.switch === a.switch);
        let stale = '';
        // Say why the carved wire is wrong. A missing wire means its trap is gone: aged out, or replaced by another
        // runner's drop (which cuts any wire into that room). A different wire means someone rewired the switch.
        if (carved && !wired) stale = ' The wire on the map is out of date: the trap it ran to is gone (aged out, or replaced by another runner, which cuts the wire).';
        else if (carved && (carved.target !== w.target || carved.effect !== w.effect)) stale = ' The wire on the map is out of date: a runner has rewired this switch since the seed was made.';
        else if (!carved && wired) stale = ' Its mark shows no wire: a runner has wired it since the seed was made.';
        log(s, `Inspected ${a.switch}: ${wired ? `it will ${w.effect} the trap in ${w.target}` : 'it is not wired to any trap'}.${stale}`, { kind: 'inspectSwitch', switch: a.switch, cost: RULES.inspectSwitchCost });
        if (w.owner === SEED) learn(s, verbGlyph(seed, seed.marks.switches[a.switch]), w.effect, `${a.switch}'s wiring is "${w.effect}".`);
        break;
      }
      case 'flip': {
        const id = here.switch;
        if (!id) throw new Error('There is no switch here.');
        const sw = s.switches[id];
        if (sw.flipped) throw new Error(`${id} has already been flipped.`);
        sw.flipped = true;
        tick(s, 1);
        const p = seed.switches[id].payoff;
        const flipTag = { kind: 'flip', switch: id, room: s.room, payoff: p.type, loot: p.type === 'cache' ? p.loot : 0 };
        if (p.type === 'open') { s.doors[p.door].closed = false; log(s, `Flipped ${id}: the exit door opens.`, flipTag); }
        if (p.type === 'cache') { s.loot += p.loot; log(s, `Flipped ${id}: a cache releases ${p.loot} loot.`, flipTag); }
        if (p.type === 'none') log(s, `Flipped ${id}: nothing you can see happens.`, flipTag);
        const w = sw.wiring;
        const t = w.target && s.traps[w.target];
        if (w.effect !== 'none' && t && !t.fresh) {
          const before = t.armed;
          if (w.effect === 'arm') t.armed = true;
          if (w.effect === 'disarm') t.armed = false;
          if (w.effect === 'invert') t.armed = !t.armed;
          const verb = t.armed ? 'armed' : 'disarmed';
          t.causes.push(`${verb} by ${id} (${w.effect}), flipped on turn ${s.turn}`);
          log(s, `${id} ${w.effect}s the ${KINDS[t.kind].label} in ${w.target} (${before ? 'armed' : 'dormant'} → ${verb}).`, { visible: false });
        }
        if (!seed.signs) learn(s, nounGlyph(seed, seed.marks.switches[id]), PAYOFF_NOUN[p.type], `${id} ${p.type === 'cache' ? 'released a cache' : 'opened the door'}.`);
        // Explain the wire the map shows (as carved), without revealing what the flip actually did.
        const mk = carvedMarks(s, seed).switches[id];
        if (mk.faded && seed.marks.switches[id].link) log(s, `${id}'s carved wire has faded: it no longer runs to the seed's trap as carved, so the map can't tell you what this flip did.`, { kind: 'rule' });
        if (mk.link) {
          const room = Object.keys(seed.marks.rooms).find((r) => seed.marks.rooms[r].link === mk.link);
          const vg = verbGlyph(seed, mk);
          const how = s.knowledge.switches[id] ? `you inspected it: ${s.knowledge.switches[id]}`
            : vg ? (s.knowledge.glyphs[vg] ? `its stroke ${vg} means ${s.knowledge.glyphs[vg]}` : `its stroke ${vg} says how`) : `inspect ${id} to learn how`;
          log(s, `${id}'s wire on the map runs to the trap in ${room}, so your flip may have changed that trap (${how}).`, { kind: 'rule' });
        }
        break;
      }
      case 'wait':
        tick(s, 1);
        log(s, 'Waited.');
        break;
      case 'drop': {
        if (!KINDS[a.kind]) throw new Error(`Unknown trap kind "${a.kind}".`);
        if (a.then) {
          const partner = KINDS[a.kind].then;
          if (a.then.kind !== partner) throw new Error(`A timed ${KINDS[a.kind].label} always becomes a ${KINDS[partner].label}.`);
          if (!(a.then.at >= 1 && a.then.at <= seed.turnCap)) throw new Error(`Timer turn must be 1–${seed.turnCap} (this map's turn cap).`);
        }
        if (!a.armed && !(a.wire && WAKING.includes(a.wire.effect))) {
          throw new Error('A dormant trap needs a switch to wake it: add "wire <S#> arm" or "wire <S#> invert" (inspect the switch first).');
        }
        if (s.room === seed.start || s.room === seed.exit) throw new Error('No traps in the start or exit room.');
        const existing = s.traps[s.room];
        if (existing && existing.fresh) throw new Error('You already placed a trap here.');
        const cost = dropCost(s, a.kind, a.then);
        if (s.loot < cost) throw new Error(`That costs ${cost} loot${cost > trapCost(a.kind, a.then, s.rules) ? " (replacing the trap here costs at least its price)" : ""}; you carry ${s.loot}.`);
        // Validate on a scratch copy so a refused wiring leaves no half-placed trap.
        const trial = clone(s);
        // Remember what this replaces: if the runner never reaches the exit, the old trap comes back.
        const replaced = existing && existing.origin ? existing.origin : null;
        trial.traps[s.room] = { kind: a.kind, armed: a.armed, then: a.then, owner: s.runner, faction: s.faction, age: 0, fresh: true, causes: [], replaced };
        for (const sw of Object.values(trial.switches)) {
          if (sw.wiring.target === s.room && sw.wiring.owner !== s.runner) sw.wiring = { effect: 'none', target: null, owner: null };
        }
        const wirePrice = a.wire ? rewirePrice(trial, a.wire.switch) : 0;
        if (s.loot < cost + wirePrice) throw new Error(`That costs ${cost + wirePrice} loot (${wirePrice} of it to rewire ${a.wire.switch} away from another runner's trap); you carry ${s.loot}.`);
        if (a.wire) setWiring(trial, a.wire.switch, a.wire.effect, s.room);
        const dead = inertRooms(trial.traps, Object.values(trial.switches).map((sw) => sw.wiring), true);
        if (dead.length) throw new Error(`That would leave your dormant trap in ${dead.join(', ')} with nothing to wake it.`);
        Object.assign(s, trial);
        s.loot -= cost + wirePrice;
        log(s, `Dropped ${describeTrap(s.traps[s.room])} in ${s.room} for ${cost + wirePrice} loot`
          + (a.wire ? `, wired to ${a.wire.switch} (${a.wire.effect}).` : '.'), { design: true });
        break;
      }
      case 'wire': {
        const price = rewirePrice(s, a.switch);
        if (s.loot < price) throw new Error(`Rewiring ${a.switch} away from another runner's trap costs ${price} loot; you carry ${s.loot}.`);
        setWiring(s, a.switch, a.effect, a.target);
        s.loot -= price;
        log(s, `Rewired ${a.switch}: ${a.effect} → your trap in ${a.target}${price ? ` for ${price} loot` : ''}.`, { design: true });
        break;
      }
      case 'scratch': {
        if (s.rules < 8) throw new Error('Runner marks arrive in rules 8.');
        const T = TIERS[seed.tier];
        const alphabet = [...T.glyphs.noun, ...T.glyphs.verb];
        if (!alphabet.includes(a.glyph)) throw new Error(`Scratch one of this tier's glyphs: ${alphabet.join(' ')}.`);
        if (!seed.rooms[a.target]) throw new Error(`There is no room ${a.target}.`);
        const mine = Object.values(s.scratches).filter((m) => m.fresh).length;
        if (mine >= SCRATCH.perRun) throw new Error(`You can scratch ${SCRATCH.perRun} marks per run.`);
        const old = s.scratches[s.room];
        if (old && old.fresh) throw new Error('You already scratched a mark here.');
        if (s.supplies < SCRATCH.cost) throw new Error('Not enough supplies.');
        s.supplies -= SCRATCH.cost;
        // Scratching over another runner's mark replaces it; if you don't reach the exit, theirs comes back.
        s.scratches[s.room] = { target: a.target, glyph: a.glyph, owner: s.runner, faction: s.faction, age: 0, fresh: true, replaced: old ? old.origin : null };
        log(s, `Scratched a mark in ${s.room}: ${a.target} ${a.glyph}${old ? `, over ${old.owner}'s mark` : ''} (${SCRATCH.cost} supply). It carries forward if you reach the exit.`);
        break;
      }
      default:
        throw new Error(`Unknown action type ${a.type}.`);
    }

    s.actions.push(formatAction(a));
    if (!s.over && s.turn >= seed.turnCap) { s.over = true; s.outcome = 'timeout'; log(s, 'Out of turns.'); }
    if (s.over && s.outcome !== 'escaped') {
      const lost = Object.values(s.traps).filter((t) => t.fresh).length;
      if (lost) log(s, `Your ${lost} trap${lost === 1 ? ' is' : 's are'} lost: traps only carry forward if you reach the exit.`);
    }
    return s;
  }

  // ---------- outputs ----------

  // Traps in the layout a runner faced, counted by the faction that set them. Counts only, never positions.
  function factionMix(residueIn) {
    const mix = {};
    for (const t of (residueIn && residueIn.traps) || []) if (t.faction) mix[t.faction] = (mix[t.faction] || 0) + 1;
    return mix;
  }
  // Traps set by a faction that beats the runner's: each pays the upset bonus if the runner escapes.
  function upsetTraps(residueIn, faction) {
    return ((residueIn && residueIn.traps) || []).filter((t) => beats(t.faction, faction)).length;
  }

  function score(s) {
    const b = { loot: s.loot, supplies: s.supplies, damage: RULES.hp - s.hp, turns: s.turn / 2 };
    b.upset = s.outcome === 'escaped' ? (s.rules >= 5 ? s.upsetFaced : upsetTraps(s.residueIn, s.faction)) * UPSET_BONUS : 0;
    const raw = b.loot + b.supplies - Math.max(0, b.damage) - b.turns + b.upset;
    if (s.rules >= 11) {
      const cap = getSeed(s.seedId).turnCap;
      b.hpLeft = Math.min(RULES.hp, s.hp);
      b.turnsLeft = (cap - s.turn) / 2;
    }
    const total = s.outcome !== 'escaped' ? 0
      : s.rules >= 11 ? b.loot + b.supplies + b.hpLeft + b.turnsLeft + b.upset
      : s.rules >= 10 ? Math.max(0, raw) : raw;
    return { total, breakdown: b, outcome: s.outcome, practice: s.practice };
  }

  // Par, plus the harm each trap author's traps do to the par line itself. The best possible run takes that harm,
  // whether it can't be avoided or is worth taking (say, a Spike guarding loot, or a detour that times a Salve),
  // so it cost the runner nothing against perfect play. Returns { score, line, unavoidable: { owner: dealt } },
  // or null if no escape exists.
  const parDetailCache = {};
  function parDetail(seedId, residueIn, rules) {
    rules = rules || RULES_VERSION;
    const ck = JSON.stringify([seedId, rules, residueIn ? { t: residueIn.traps, w: residueIn.wiring } : null]);
    if (ck in parDetailCache) return parDetailCache[ck];
    const p = par(seedId, residueIn, rules);
    let out = null;
    if (p) {
      let s = createRun(seedId, residueIn, '_par', null, null, rules);
      for (const a of p.line) s = step(s, a);
      const unavoidable = {};
      const unavoidableBonus = {}, parAid = {};
      for (const [owner, i] of Object.entries(s.impact)) { unavoidable[owner] = i.dealt; unavoidableBonus[owner] = i.dealtBonus || 0; parAid[owner] = i.givenBonus || 0; }
      out = { score: p.score, line: p.line, unavoidable, unavoidableBonus, parAid };
    }
    parDetailCache[ck] = out;
    return out;
  }

  // Saboteur credit counts only avoidable harm: what an author's traps cost this runner beyond what they cost
  // the par line. A layout with no escape earns no damage credit at all. Scouting drawn and boons given are
  // unchanged (par never scouts). Boons given are weighted by the run's rules version (rules 3: ×2), keeping the
  // raw amount in `gave`. Takes the run's raw impact, a parDetail result and the rules version.
  function creditImpact(impactIn, detail, rules) {
    const out = clone(impactIn || {});
    for (const [owner, i] of Object.entries(out)) {
      const free = detail ? detail.unavoidable[owner] || 0 : Infinity;
      i.unavoidable = Math.min(i.dealt, free);
      i.dealt = Math.max(0, i.dealt - free);
      // Rules 12 bonuses. Harm: only the bonus beyond what par would also take. Aid: only beyond what par collects.
      const db = i.dealtBonus || 0, gb = i.givenBonus || 0;
      i.fuseBonus = Math.max(0, db - (detail ? (detail.unavoidableBonus || {})[owner] || 0 : Infinity));
      i.aidBonus = Math.max(0, gb - (detail ? (detail.parAid || {})[owner] || 0 : Infinity));
      delete i.dealtBonus; delete i.givenBonus;
      i.dealt += i.fuseBonus;
      i.gave = i.given;
      i.given = (i.given + i.aidBonus) * benefactorWeight(rules || 1);
    }
    return out;
  }

  // Par for this runner: the layout's par plus the upset bonus they would earn by escaping.
  function parFor(s) {
    const p = par(s.seedId, s.residueIn, s.rules);
    if (!p) return null;
    // Rules 5: the bonus the par line itself earns, played as this runner's faction.
    let upset;
    if (s.rules >= 5) {
      let ps = createRun(s.seedId, s.residueIn, '_par', s.faction, null, s.rules);
      for (const a of p.line) ps = step(ps, a);
      upset = ps.upsetFaced * UPSET_BONUS;
    } else upset = upsetTraps(s.residueIn, s.faction) * UPSET_BONUS;
    return { score: p.score + upset, layout: p.score, upset, line: p.line };
  }

  // Two separate designer scores, never netted against each other:
  //   saboteur points  = the avoidable part of what your traps cost later runners (damage, drain, turns ÷ 2; see
  //                      creditImpact) + supplies they spent scouting your work
  //   benefactor points = what your boons gave later runners, weighted by rules version (see creditImpact)
  const saboteurPoints = (i) => i.dealt + i.drawn;
  const benefactorPoints = (i) => i.given;

  // Running designer totals, carried down the relay: the inherited ledger plus this run's impact.
  // `impact` overrides the run's raw impact, e.g. with the credited (avoidable-only) version.
  function ledger(s, impact) {
    const out = clone(s.ledgerIn);
    for (const [who, i] of Object.entries(impact || s.impact)) {
      const l = out[who] || (out[who] = { dealt: 0, drawn: 0, given: 0, runs: 0 });
      l.dealt += i.dealt; l.drawn += i.drawn; l.given += i.given; l.runs += 1;
    }
    return out;
  }

  // Ledger entries as two boards. Takes { name: { dealt, drawn, given, runs } }.
  function standings(led) {
    const rows = Object.entries(led || {}).map(([name, l]) => Object.assign({ name, saboteur: saboteurPoints(l), benefactor: benefactorPoints(l) }, l));
    return {
      saboteurs: rows.filter((r) => r.saboteur > 0).sort((a, b) => b.saboteur - a.saboteur),
      benefactors: rows.filter((r) => r.benefactor > 0).sort((a, b) => b.benefactor - a.benefactor),
    };
  }

  // What the next runner inherits. Switches and trap states reset; sprung traps are gone;
  // dormant traps nothing can wake are dropped. Also carries the designer ledger and this run's record.
  // Your own traps and rewires only carry forward if you reach the exit. Otherwise it is as if you
  // never changed the seed: anything you overwrote comes back.
  // opts.discardOwn hands the layout on as if this runner had changed nothing (a paradox collapse: their changes
  // would have left no way out). Their score stands; only their drops and rewires are dropped.
  function residue(s, opts) {
    const anchored = s.outcome === 'escaped' && !(opts && opts.discardOwn);
    // Rules 9: the seed's own traps never age out. They rearm for every runner until a runner replaces them.
    const carryOld = (origin) => (origin && s.rules >= 9 && ownerOf(origin.owner) === SEED
      ? Object.assign(clone(origin), { kind: kindOf(origin.kind), age: 0 })
      : origin && (origin.age || 0) + 1 < lifetimeFor(s.rules)
        ? Object.assign(clone(origin), { kind: kindOf(origin.kind), age: (origin.age || 0) + 1 }) : null);
    const traps = {};
    for (const [room, t] of Object.entries(s.traps)) {
      if (t.fresh && anchored) traps[room] = { room, kind: t.kind, armed: t.armed, then: t.then, owner: t.owner, faction: t.faction, age: 0 };
      else if (t.fresh) { const old = carryOld(t.replaced); if (old) traps[room] = old; }
      else { const old = carryOld(t.origin); if (old) traps[room] = old; }
    }
    const wiring = [];
    for (const [id, sw] of Object.entries(s.switches)) {
      const w = sw.wiring;
      if (w.owner === s.runner && anchored) wiring.push({ switch: id, effect: w.effect, target: w.target, owner: w.owner });
      else if (sw.inherited && traps[sw.inherited.target] && traps[sw.inherited.target].owner === sw.inherited.owner) wiring.push(clone(sw.inherited));
    }
    for (const room of inertRooms(traps, wiring, false)) delete traps[room];
    // Runner marks follow the same rules as traps: yours carry forward only if you escape, and every mark ages out.
    const marks = [];
    for (const [at, m] of Object.entries(s.scratches || {})) {
      if (m.fresh && anchored) marks.push({ at, target: m.target, glyph: m.glyph, owner: m.owner, faction: m.faction, age: 0 });
      else { const old = carryOld(m.fresh ? m.replaced : m.origin); if (old) marks.push(old); }
    }
    return {
      from: s.runner,
      faction: s.faction,
      seed: s.seedId,
      traps: Object.values(traps),
      wiring: wiring.filter((w) => traps[w.target]),
      ...(marks.length ? { marks } : {}),
      ledger: ledger(s, opts && opts.impact),
      run: { runner: s.runner, faction: s.faction, seed: s.seedId, rules: s.rules, residueIn: s.residueIn, actions: s.actions.slice() },
    };
  }

  // The seed id of a saved handoff or run record (older files say `moment`).
  const seedOf = (r) => (r ? r.seed || r.moment : null);

  // Everything an honest runner (human or AI agent) is allowed to know.
  function runnerView(s) {
    const seed = getSeed(s.seedId);
    const carved = carvedMarks(s, seed);
    const rooms = {};
    for (const [id, mr] of Object.entries(seed.rooms)) {
      const r = { label: mr.label, loot: s.lootLeft[id], neighbors: neighbors(seed, id).map((n) => {
        const d = s.doors[edgeKey(id, n)];
        return d ? `${n} (door ${d.closed ? 'closed' : 'open'})` : n;
      }) };
      // A switch's plain sign shows whenever the runner knows its payoff: on the Plain tier, once it is flipped,
      // or once its shape is known (the door switch's shape matches the door from the start).
      if (mr.switch) {
        const flipped = s.switches[mr.switch].flipped;
        const mk = carved.switches[mr.switch];
        const shapeKnown = !!s.knowledge.glyphs[nounGlyph(seed, mk)];
        r.switch = { id: mr.switch, sign: seed.signs || flipped || shapeKnown ? seed.switches[mr.switch].sign : null, flipped, mark: mk };
      }
      // Every mark is visible from the start: nothing appears mid-run.
      if (carved.rooms[id]) r.mark = carved.rooms[id];
      if (s.knowledge.rooms[id]) r.intel = s.knowledge.rooms[id];
      // A runner mark is signed: who scratched it, and their faction. Whether it is true is for the reader to judge.
      const sc = (s.scratches || {})[id];
      if (sc) r.scratch = { target: sc.target, glyph: sc.glyph, by: sc.owner, faction: sc.faction, mine: !!sc.fresh };
      rooms[id] = r;
    }
    const doors = Object.entries(s.doors).map(([between, d]) => ({ between, closed: d.closed, mark: seed.marks.door }));
    const mine = Object.entries(s.traps).filter(([, t]) => t.fresh).map(([room, t]) => `${room}: ${describeTrap(t)}`);
    const myWiring = Object.entries(s.switches).filter(([, sw]) => sw.wiring.owner === s.runner)
      .map(([id, sw]) => `${id}: ${sw.wiring.effect} → ${sw.wiring.target}`);
    // Prices for what the runner can do here, so a client can show costs without holding the run's hidden state.
    // Replacing a trap costs at least its price; that rule is public, so the price itself is fair to show.
    const prices = { drop: {}, rewire: {} };
    if (!s.over && s.room !== seed.start && s.room !== seed.exit && !(s.traps[s.room] && s.traps[s.room].fresh)) {
      for (const kind of Object.keys(KINDS)) {
        prices.drop[kind] = dropCost(s, kind, null);
        prices.drop[`${kind}@timed`] = dropCost(s, kind, { kind: KINDS[kind].then });
      }
    }
    if (!s.over) for (const id of Object.keys(s.knowledge.switches)) prices.rewire[id] = rewirePrice(s, id);
    return {
      seed: seed.name, seedId: s.seedId, tier: seed.tier, runner: s.runner, faction: s.faction, practice: s.practice, rules: s.rules,
      room: s.room, turn: s.turn, turnCap: seed.turnCap, visited: s.visited.slice(),
      hp: s.hp, supplies: s.supplies, loot: s.loot, over: s.over, outcome: s.outcome,
      exit: seed.exit, rooms, doors, switchIntel: s.knowledge.switches, glyphs: s.knowledge.glyphs, myTraps: mine, myWiring,
      myTrapRooms: Object.entries(s.traps).filter(([, t]) => t.fresh).map(([room]) => room), prices,
      // The door switch is public: the log names it at the start of every run.
      doorSwitch: (() => { const id = Object.keys(seed.switches).find((k) => seed.switches[k].payoff.type === 'open'); return { id, room: seed.switches[id].room }; })(),
      log: s.log.filter((e) => e.visible).map((e) => `[t${e.turn}] ${e.text}`),
      // The same visible lines with their event kind, for clients that animate events (run.html). Only what the text
      // already says, plus a sprung trap's faction sign (as a peek shows); never who placed it.
      feed: s.log.filter((e) => e.visible).map((e) => feedEntry(e)),
    };
  }

  // Post-run reveal: the full layout and the chain of causes behind every spring.
  function reveal(s) {
    const r = s.residueIn || { traps: [], wiring: [] };
    return {
      inheritedTraps: r.traps.map((t) => `${t.room}: ${describeTrap(Object.assign({}, t, { kind: kindOf(t.kind) }), true)}${t.owner === SEED ? '' : ` — ${t.owner}`}`),
      inheritedMarks: (r.marks || []).map((m) => {
        const t = r.traps.find((x) => x.room === m.target);
        const sw = Object.values(getSeed(s.seedId).switches).find((x) => x.room === m.target);
        return `${m.at}: "${m.target} ${m.glyph}" by ${m.owner}. ${m.target} held ${t ? describeTrap(Object.assign({}, t, { kind: kindOf(t.kind) })) : 'no trap'}${sw ? ' and a switch' : ''}.`;
      }),
      inheritedWiring: r.wiring.map((w) => `${w.switch || w.pivot}: ${w.effect} → ${w.target} — ${w.owner === SEED ? 'part of the seed' : w.owner}`),
      fullLog: s.log.map((e) => `[t${e.turn}] ${e.reveal || e.text}${e.visible ? '' : '  (hidden)'}`),
      thisRunImpact: s.impact,
      glyphKey: glyphKey(getSeed(s.seedId)),
    };
  }

  // This seed's vocabulary, for after the run: glyph → meaning.
  function glyphKey(seed) {
    const k = seed.marks.key;
    return [
      ...Object.keys(k.noun).map((n) => `${k.noun[n]}  ${NOUNS[n]}`),
      ...Object.keys(k.verb).map((v) => `${k.verb[v]}  ${VERBS[v]}`),
    ];
  }

  const GRAMMAR = [
    'Glyphs are optional: the log spells out the route, so you can play without them. Reading them is an edge.',
    'Shapes are NOUNS: what a thing is. Strokes are VERBS: what a switch does to the trap it is wired to.',
    'A trap\'s mark is its noun. A switch\'s mark is its payoff\'s noun (none for a blank switch) plus a verb',
    'if it is wired; the Plain tier shows nouns only. A wire on the map (a shared link letter in text) joins a',
    'switch to its trap, and the verb tells you the trap\'s state: arm means it is dormant now, disarm means armed now.',
    'The exit door shows the Door shape: the switch whose shape matches it opens the door.',
    'Glyphs per tier: 4 on Plain, 6 on Glyphs, 8 on Deep. Which glyph means what changes every seed.',
    'Every mark is visible from the start. When a flip, spring or inspect confirms a glyph, the log says so.',
    'Marks are carved when the seed is made: flipping a switch does not redraw them, and traps that players',
    'drop carry no mark. A carved mark fades once it would lie: a trap mark when the seed\'s trap there is gone,',
    'a switch\'s stroke and wire when a runner has rewired it. A mark you can still read is true.',
    'The seed\'s own traps never age out: they rearm for every runner until someone replaces them.',
    `Runner marks look scratched, not carved: a room letter and one glyph, left by an earlier runner for ${SCRATCH.cost} supply.`,
    'They are signed but never checked. They may warn, guide or lie.',
  ];

  // Par: the best score possible on the layout a runner faced, with full knowledge. Searches moves and flips
  // (and waits, when a timed trap makes waiting matter); with full knowledge, scouting is never worth it.
  // Returns { score, line } or null if no escape exists.
  const parCache = {};
  function par(seedId, residueIn, rules) {
    rules = rules || RULES_VERSION;
    const ck = JSON.stringify([seedId, rules, residueIn ? { t: residueIn.traps, w: residueIn.wiring } : null]);
    if (ck in parCache) return parCache[ck];
    const seed = getSeed(seedId);
    const start = createRun(seedId, residueIn, '_par', null, null, rules);
    const lean = (s) => { s.log = []; s.actions = []; s.residueIn = null; s.ledgerIn = {}; return s; }; // step() copies the whole state
    lean(start);
    const timed = Object.values(start.traps).some((t) => t.then);
    const seen = new Map();
    let best = null;
    // The turn matters to the state only while a timer is still pending. A trap that has sprung (or a boon already
    // collected) and a Salve's buffer are part of the state too: without them, a better route could be thrown away.
    const pending = (s) => timed && Object.values(s.traps).some((t) => t.then);
    const key = (s) => [s.room, pending(s) ? s.turn : '',
      Object.entries(s.switches).map(([k, w]) => (w.flipped ? k : '')).join(''),
      Object.entries(s.lootLeft).map(([k, n]) => (n ? k : '')).join(''),
      Object.entries(s.traps).map(([k, t]) => k + t.kind + (t.armed ? '+' : '-') + (t.spent ? 's' : '')).join(''), s.buffer.map((b) => b.hp).join(',')].join('|');
    (function dfs(s, line) {
      if (s.over) {
        const sc = score(s).total;
        if (s.outcome === 'escaped' && (!best || sc > best.score)) best = { score: sc, line: line.slice() };
        return;
      }
      // Best this branch could still score: all remaining loot, unflipped caches and boons (now or after a timer),
      // and at least one more turn. It never undercounts, so the search stays exact.
      let more = 0;
      for (const n of Object.values(s.lootLeft)) more += n;
      for (const t of Object.values(s.traps)) if (KINDS[t.kind].boon || (t.then && KINDS[t.then.kind].boon)) more += 3;
      for (const [id, w] of Object.entries(s.switches)) if (!w.flipped && seed.switches[id].payoff.type === 'cache') more += seed.switches[id].payoff.loot;
      // Rules 11 scores sit 10 + turn cap ÷ 2 above the old sum, so the bound shifts with them.
      const shift = rules >= 11 ? RULES.hp + seed.turnCap / 2 : 0;
      if (best && s.loot + more + s.supplies - (RULES.hp - s.hp) - (s.turn + 1) / 2 + shift <= best.score) return;
      const k = key(s), v = s.loot + s.supplies + s.hp - s.turn / 2;
      // A state is ruled out only by one at least as good that is no later (later states have less time left).
      const prev = seen.get(k) || [];
      if (prev.some(([turn, val]) => turn <= s.turn && val >= v)) return;
      seen.set(k, prev.filter(([turn, val]) => !(turn >= s.turn && val <= v)).concat([[s.turn, v]]));
      const acts = neighbors(seed, s.room).map((r) => `move ${r}`);
      if (seed.rooms[s.room].switch && !s.switches[seed.rooms[s.room].switch].flipped) acts.push('flip');
      if (pending(s)) acts.push('wait');
      // Rules 13: knowing the layout, the best line may still pay to peek and disarm a harmful trap next door.
      if (rules >= 13 && s.supplies >= RULES.peekCost + RULES.disarmCost) {
        for (const r of neighbors(seed, s.room)) {
          const t = s.traps[r];
          if (t && !t.fresh && !t.spent && !KINDS[t.kind].boon && t.kind !== 'decoy') {
            acts.push(`peek ${r}|disarm ${r}`);
            if (RULES.disarmByMark && (s.readableMarks || []).includes(r)) acts.push(`disarm ${r}`);
          }
        }
      }
      for (const a of acts) {
        let n;
        try { n = s; for (const part of a.split('|')) n = lean(step(n, part)); } catch (e) { continue; }
        line.push(...a.split('|')); dfs(n, line); line.length -= a.split('|').length;
      }
    })(start, []);
    parCache[ck] = best;
    return best;
  }

  function replay(seedId, residueIn, runner, faction, actions, practice, rules) {
    let s = createRun(seedId, residueIn, runner, faction, practice, rules);
    for (const a of actions) s = step(s, a);
    return s;
  }

  // The rules version a saved run record was played under. Runs saved before versions existed are version 1.
  const rulesOf = (run) => (run && run.rules) || 1;

  // Step-by-step frames of a recorded run (residue.run), for watching.
  // redact drops the watched runner's own drops and rewires: those form the NEXT layout.
  function frames(run, redact) {
    let s = createRun(seedOf(run), run.residueIn, run.runner, run.faction, null, rulesOf(run));
    const out = [{ action: 'start', state: s, events: s.log.slice() }];
    for (const a of run.actions) {
      const before = s.log.length;
      s = step(s, a);
      // Redacted design actions produce no frame at all, so a pause in one room gives nothing away.
      if (redact && /^(drop|wire)\b/.test(a)) continue;
      out.push({ action: a, state: s, events: s.log.slice(before) });
    }
    return out;
  }

  const api = {
    RULES, RULES_VERSION, SCRATCH, GLYPH_NAMES, GLYPH_DISPLAY, GLYPH_DISPLAY_NAMES, glyphText, rulesOf, MAP_HISTORY, versionOf, mapDef, lifetimeFor, benefactorWeight, KINDS, FACTIONS, EFFECTS, MAPS, TIERS, SEED, STANDIN, GRAMMAR, NOUNS, VERBS, inertRooms,
    trapCost, dropCost, rewirePrice, getSeed, publicSeed, adoptSeed, seedName, economy, forcedRooms, parseSeedId, seedIdOf, seedOf, glyphKey, neighbors, edgeKey, createRun, step, parseAction, formatAction, practiceReason,
    BEATS, UPSET_BONUS, beats, factionMix, upsetTraps, parFor, parDetail, creditImpact,
    score, par, residue, runnerView, reveal, replay, frames, ledger, standings, saboteurPoints, benefactorPoints, describeTrap, kindOf,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TrapSim = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
