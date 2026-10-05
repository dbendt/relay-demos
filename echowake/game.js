// The authoritative game core (Stage 1). Runs live on the server: a client claims a run, sends actions one at a
// time and gets back only the runner view. Layouts never leave the server until the rules allow it.
//
// Chains are timelines, not trees. A chain is a base layout (the seed's own traps, or stand-in openers) plus a
// sequence of saves in save order. Claiming a run pins a snapshot: the chain's layout at that moment. When the run
// ends it is saved onto the chain as it stands then: every trap and mark ages one save, and an escaped run's drops,
// rewires and marks are merged in (the later save wins a room or a switch). Up to SLOTS runs can be open on one
// chain at once; nobody's save is refused for being second.
//
// Storage is JSON files under data/ (TRAP_DATA overrides it): data/chains/<id>.json and data/runs/<id>.json.
// Ids are random, so a link names a chain or a run without naming anything readable.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Sim = require('./sim.js');
const Par = require('./parpool.js');

const DATA = process.env.TRAP_DATA || path.join(__dirname, 'data');
const OPENERS = 3; // the first three runs of a chain are unranked opening runs (a stand-in base counts as all three)
const SLOTS = 3; // runs that can be open on one chain at once
const IDLE_MS = 20 * 60e3; // an open run untouched this long is abandoned: it counts as the attempt, scored as a timeout
const LIFETIME_MIN = 3; // ranked runs before a runner's handicap counts
const PAIR_CAP = 8; // most saboteur (or benefactor) points one runner can give one author per period

// ---------- time: the daily reset and periods ----------

// The game's day turns over at one global moment, 08:00 UTC (midnight Pacific, 3 am Eastern, 9 am London). Seeds
// close, periods end and intermission begins on this boundary.
const RESET_HOUR_UTC = 8;
const gameTime = (ms) => ms - RESET_HOUR_UTC * 3600e3;
const dayOf = (ms) => new Date(gameTime(ms)).toISOString().slice(0, 10);
// The dev clock: a server started with --dev can move the game forward (to the next daily reset) to test seeds
// closing, results unsealing and new seeds opening. The offset lives in the store (dev-clock.json), so the server and
// the CLI read the same time; every function here that defaults its `now` uses clockNow(). Without the file it is 0.
const CLOCK_FILE = path.join(DATA, 'dev-clock.json');
let clockCache = null;
function devOffset() {
  try {
    const st = fs.statSync(CLOCK_FILE);
    if (!clockCache || clockCache.mtime !== st.mtimeMs) clockCache = { mtime: st.mtimeMs, offset: Number(JSON.parse(fs.readFileSync(CLOCK_FILE, 'utf8')).offsetMs) || 0 };
    return clockCache.offset;
  } catch (e) { return 0; }
}
const clockNow = () => Date.now() + devOffset();
// The first daily reset after ms.
function nextResetAfter(ms) {
  const d = new Date(ms);
  let r = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), RESET_HOUR_UTC);
  if (r <= ms) r += 864e5;
  return r;
}
function devClock() {
  const now = clockNow();
  return { now: new Date(now).toISOString(), offsetMs: devOffset(), day: dayOf(now), period: periodOf(now), nextReset: new Date(nextResetAfter(now)).toISOString() };
}
// Jump to one minute past the next reset: today's seeds close, the next ones open.
function devNextDay() {
  const target = nextResetAfter(clockNow()) + 60e3;
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CLOCK_FILE, JSON.stringify({ offsetMs: target - Date.now(), note: 'Dev clock offset (serve.js --dev). Delete this file to return to real time.' }, null, 2));
  clockCache = null;
  return devClock();
}
function devResetClock() {
  try { fs.unlinkSync(CLOCK_FILE); } catch (e) { /* already real time */ }
  clockCache = null;
  return devClock();
}

// A period is one calendar week (ISO week of the game day), matching the weekly map.
function periodOf(ms) {
  const d = new Date(gameTime(ms));
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // the Thursday of this week decides its year
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(week).padStart(2, '0')}`;
}

// ---------- storage ----------

const dirOf = (kind) => path.join(DATA, kind);
const newId = () => crypto.randomBytes(8).toString('hex');
const clone = (o) => JSON.parse(JSON.stringify(o));
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}
const validId = (id) => /^[0-9a-f]{16}$/.test(String(id || ''));
function loadChain(id) {
  if (!validId(id)) throw new Error('No such chain.');
  try { return readJSON(path.join(dirOf('chains'), `${id}.json`)); } catch (e) { throw new Error('No such chain.'); }
}
function loadRun(id) {
  if (!validId(id)) throw new Error('No such run.');
  try { return readJSON(path.join(dirOf('runs'), `${id}.json`)); } catch (e) { throw new Error('No such run.'); }
}
const saveChain = (c) => writeJSON(path.join(dirOf('chains'), `${c.id}.json`), c);
const saveRun = (r) => writeJSON(path.join(dirOf('runs'), `${r.id}.json`), r);
function all(kind) {
  const d = dirOf(kind);
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(readJSON(path.join(d, f))); } catch (e) { /* skip unreadable */ }
  }
  return out;
}

// ---------- layouts ----------

// The seed's own starting layout, with trap ids.
function seedBase(seedId) {
  const o = Sim.getSeed(seedId).opening;
  return { traps: o.traps.map((t) => Object.assign(clone(t), { id: `seed:${t.room}` })), wiring: clone(o.wiring), marks: [] };
}

// Apply one save to a layout: everything ages a save (the seed's own traps never age, from rules 9), then an escaped
// run's changes are merged in. The later save wins a room or a switch; a dormant trap left with nothing to wake it
// drops out; a wire whose trap has gone (or changed hands) goes with it.
function applySave(layout, save) {
  const life = Sim.lifetimeFor(save.rules);
  const ages = (x) => !(x.owner === Sim.SEED && save.rules >= 9);
  let traps = layout.traps.filter((t) => { if (!ages(t)) return true; t.age = (t.age || 0) + 1; return t.age < life; });
  let wiring = layout.wiring;
  let marks = (layout.marks || []).filter((m) => { m.age = (m.age || 0) + 1; return m.age < life; });
  if (save.ops) {
    for (const d of save.ops.drops) {
      traps = traps.filter((t) => t.room !== d.room);
      traps.push(Object.assign(clone(d), { age: 0, id: `${save.run}:${d.room}` }));
      wiring = wiring.filter((w) => w.target !== d.room);
    }
    for (const w of save.ops.rewires) {
      wiring = wiring.filter((x) => x.switch !== w.switch);
      if (w.effect !== 'none') wiring.push({ switch: w.switch, effect: w.effect, target: w.target, owner: save.runner });
    }
    for (const m of save.ops.marks) {
      marks = marks.filter((x) => x.at !== m.at);
      marks.push(Object.assign(clone(m), { age: 0 }));
    }
  }
  const byRoom = {};
  for (const t of traps) byRoom[t.room] = t;
  wiring = wiring.filter((w) => byRoom[w.target] && byRoom[w.target].owner === w.owner);
  for (const room of Sim.inertRooms(byRoom, wiring, false)) delete byRoom[room];
  return { traps: Object.values(byRoom), wiring: wiring.filter((w) => byRoom[w.target]), marks };
}

// A chain's layout after its first `upTo` saves (all of them by default), in the handoff format sim.js reads.
function layoutOf(chain, upTo) {
  let layout = clone(chain.base);
  const saves = chain.saves.slice(0, upTo === undefined ? chain.saves.length : upTo);
  for (const s of saves) layout = applySave(layout, s);
  const last = saves[saves.length - 1];
  const from = last ? last.runner : chain.opening === 'stand-in' ? Sim.STANDIN : Sim.SEED;
  return Object.assign({ from, faction: last ? last.faction : null, seed: chain.seed, ledger: ledgerOf(chain, saves.length) }, layout);
}

// Designer credit carried down a chain: the sum of what each saved run credited, up to `upTo` saves.
function ledgerOf(chain, upTo) {
  const led = {};
  for (const s of chain.saves.slice(0, upTo)) {
    for (const [who, i] of Object.entries(s.credited || {})) {
      const e = led[who] || (led[who] = { dealt: 0, drawn: 0, given: 0 });
      e.dealt += i.dealt; e.drawn += i.drawn; e.given += i.given;
    }
  }
  return led;
}

// What an escaped run changed: its drops, rewires and runner marks.
function opsOf(s) {
  const drops = Object.entries(s.traps).filter(([, t]) => t.fresh)
    .map(([room, t]) => ({ room, kind: t.kind, armed: t.armed, then: t.then, owner: t.owner, faction: t.faction }));
  const rewires = Object.entries(s.switches).filter(([, sw]) => sw.wiring.owner === s.runner)
    .map(([id, sw]) => ({ switch: id, effect: sw.wiring.effect, target: sw.wiring.target }));
  const marks = Object.entries(s.scratches || {}).filter(([, m]) => m.fresh)
    .map(([at, m]) => ({ at, target: m.target, glyph: m.glyph, owner: m.owner, faction: m.faction }));
  return drops.length + rewires.length + marks.length ? { drops, rewires, marks } : null;
}

// ---------- stand-in openers ----------

// A new chain opens with stand-ins when there is placement data for this map, version and tier: random earlier
// runners' drops and wires from saves on other seeds, laid over the seed's own traps, owned by the stand-in (no
// credit). Without data the chain opens on the bare seed and its first three runs are unranked openers.
function standInBase(seedId, chains) {
  const { mapId, version, tier } = Sim.parseSeedId(seedId);
  const seed = Sim.getSeed(seedId);
  const pool = {};
  for (const c of chains) {
    if (c.seed === seedId) continue;
    const p = Sim.parseSeedId(c.seed);
    if (p.mapId !== mapId || p.version !== version || p.tier !== tier) continue;
    for (const s of c.saves) {
      if (!s.ops || !s.ops.drops.length) continue;
      const mine = s.ops.drops.filter((d) => d.room !== seed.start && d.room !== seed.exit);
      if (mine.length) (pool[s.runner] = pool[s.runner] || []).push({ drops: mine, rewires: s.ops.rewires });
    }
  }
  const names = Object.keys(pool).sort(() => Math.random() - 0.5).slice(0, OPENERS);
  if (!names.length) return null;
  const base = seedBase(seedId);
  const byRoom = {};
  for (const t of base.traps) byRoom[t.room] = t;
  let wiring = base.wiring;
  for (const name of names) {
    const pick = pool[name][Math.floor(Math.random() * pool[name].length)];
    for (const d of pick.drops) {
      byRoom[d.room] = { room: d.room, kind: d.kind, armed: d.armed, then: d.then, owner: Sim.STANDIN, faction: null, age: 0, id: `standin:${d.room}` };
      wiring = wiring.filter((w) => w.target !== d.room);
    }
    for (const w of pick.rewires) {
      if (!byRoom[w.target] || byRoom[w.target].owner !== Sim.STANDIN || w.effect === 'none') continue;
      wiring = wiring.filter((x) => x.switch !== w.switch);
      wiring.push({ switch: w.switch, effect: w.effect, target: w.target, owner: Sim.STANDIN });
    }
  }
  for (const room of Sim.inertRooms(byRoom, wiring, false)) delete byRoom[room];
  return { base: { traps: Object.values(byRoom), wiring: wiring.filter((w) => byRoom[w.target]), marks: [] }, from: names };
}

// ---------- seeds: open, closed ----------

// A seed's chains close at the daily reset after its first chain opened. Runs started after that are practice.
function seedOpenedDay(seedId, chains) {
  let first = null;
  for (const c of chains || all('chains')) if (c.seed === seedId) { const t = Date.parse(c.opened); if (first === null || t < first) first = t; }
  return first === null ? null : dayOf(first);
}
const seedClosed = (seedId, now, chains) => { const d = seedOpenedDay(seedId, chains); return !!d && d < dayOf(now || clockNow()); };

// ---------- runners and factions ----------

const RESERVED = [Sim.SEED, Sim.STANDIN, 'history'];
function runnerName(raw) {
  const runner = String(raw || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,24}$/.test(runner)) throw new Error('Runner names are 1–24 letters, digits, - or _.');
  if (RESERVED.includes(runner)) throw new Error(`"${runner}" is reserved.`);
  return runner;
}
// Factions lock per period: a runner's faction is the one from their first saved run in the period.
function factionLock(runner, now, runs) {
  runner = String(runner || '').toLowerCase();
  const period = periodOf(now || clockNow());
  let first = null;
  for (const r of runs || all('runs')) {
    if (r.runner !== runner || !r.savedAt || !r.faction) continue;
    const t = Date.parse(r.savedAt);
    if (periodOf(t) === period && (!first || t < first.t)) first = { faction: r.faction, t };
  }
  return first ? { faction: first.faction, period } : null;
}

// ---------- runs ----------

const trackOf = (channel) => (channel === 'web' ? 'human' : 'agent');
const stateOf = (run) => Sim.replay(run.seed, run.residueIn, run.runner, run.faction, run.actions, run.practice, run.rules);

// Open runs untouched for IDLE_MS are abandoned: the attempt is used up, scored as a timeout, and saved onto the
// chain like any other failed run (everything ages a save; nothing is merged).
function expireIdle(now, runs, chains) {
  const byId = {};
  for (const c of chains) byId[c.id] = c;
  for (const r of runs) {
    if (r.status !== 'open' || now - Date.parse(r.lastAt) < IDLE_MS) continue;
    r.status = 'abandoned';
    r.savedAt = new Date(now).toISOString();
    r.score = { total: 0, outcome: 'abandoned' };
    r.outcome = 'abandoned';
    const c = byId[r.chain];
    if (c) {
      c.saves.push({ run: r.id, runner: r.runner, faction: r.faction, rules: r.rules, at: r.savedAt, outcome: 'abandoned', ops: null, credited: {} });
      saveChain(c);
    }
    saveRun(r);
  }
}

// What a client gets back about a claimed run: the run id, the honest view, and the chain facts a runner may know
// (position, whether it's ranked, and the faction briefing: who set the traps, counts only).
function describe(run) {
  const s = stateOf(run);
  return {
    run: run.id, chain: run.status === 'practice' ? null : run.chain, seed: run.seed, faction: run.faction, practice: run.practice || null,
    position: run.position, ranked: run.ranked, openers: OPENERS, track: run.track,
    briefing: Sim.factionMix(run.residueIn), view: Sim.runnerView(s),
    result: s.over ? result(run.id) : null,
    // Time left before an untouched open run is abandoned (the run page counts it down from here).
    idleLeftMs: run.status === 'open' ? Math.max(0, IDLE_MS - (clockNow() - Date.parse(run.lastAt))) : null,
    idleMs: IDLE_MS,
  };
}

// Claim a run on a seed. The server chooses the chain (the longest chain with a free slot on the runner's track, so
// chains build up history and new ones open only when every chain is full), unless the runner was invited to a specific chain. A runner who has an open
// run on this seed gets it back. One attempt per seed: after that, only practice, and only once the seed has closed.
function claim({ seed, runner, faction, channel, chain: chainId }, now) {
  now = now || clockNow();
  runner = runnerName(runner);
  const { mapId } = Sim.parseSeedId(seed);
  const map = Sim.MAPS[mapId];
  if (!map) throw new Error('No such map.');
  if (faction && !Sim.FACTIONS[faction]) throw new Error('No such faction.');
  const chains = all('chains'), runs = all('runs');
  expireIdle(now, runs, chains);
  const lock = factionLock(runner, now, runs);
  if (lock) faction = lock.faction;
  faction = faction || 'wardens';
  const open = runs.find((r) => r.seed === seed && r.runner === runner && r.status === 'open');
  if (open) return describe(open);
  const closed = seedClosed(seed, now, chains);
  const attempted = runs.some((r) => r.seed === seed && r.runner === runner && r.status !== 'practice');
  const base = { id: newId(), seed, runner, faction, rules: Sim.RULES_VERSION, channel: channel || 'api', track: trackOf(channel), claimedAt: new Date(now).toISOString(), lastAt: new Date(now).toISOString(), actions: [] };
  if (closed || attempted) {
    if (!closed) throw new Error("You've made your one attempt at this seed. Practice on it opens when its chains close at the daily reset (08:00 UTC).");
    // Practice faces a closed chain's final layout: the invited one, or the seed's longest.
    const pc = chainId ? loadChain(chainId) : chains.filter((c) => c.seed === seed).sort((a, b) => b.saves.length - a.saves.length)[0];
    if (pc && pc.seed !== seed) throw new Error('That chain is on another seed.');
    const run = Object.assign(base, {
      chain: pc ? pc.id : null, status: 'practice', practice: "this seed's chains closed at the daily reset (08:00 UTC)",
      position: null, ranked: false, residueIn: pc ? layoutOf(pc) : Object.assign({ from: Sim.SEED, seed, ledger: {} }, seedBase(seed)),
    });
    Sim.createRun(run.seed, run.residueIn, run.runner, run.faction, run.practice, run.rules); // validates
    saveRun(run);
    return describe(run);
  }
  if (map.status === 'retired') throw new Error(`${map.name} is retired and resting, so it has no live seeds.`);
  const openOn = (c) => runs.filter((r) => r.chain === c.id && r.status === 'open').length;
  let chain;
  if (chainId) {
    chain = loadChain(chainId);
    if (chain.seed !== seed) throw new Error('That chain is on another seed.');
    if (openOn(chain) >= SLOTS) throw new Error(`That chain already has ${SLOTS} runs in progress. Try again when one finishes.`);
  } else {
    chain = chains.filter((c) => c.seed === seed && c.track === base.track && openOn(c) < SLOTS)
      .sort((a, b) => b.saves.length - a.saves.length || openOn(a) - openOn(b))[0];
  }
  if (!chain) {
    const si = standInBase(seed, chains);
    chain = { id: newId(), seed, track: base.track, opened: new Date(now).toISOString(), opening: si ? 'stand-in' : 'seed', standIn: si ? si.from : null, base: si ? si.base : seedBase(seed), saves: [] };
    saveChain(chain);
  }
  const position = (chain.opening === 'stand-in' ? OPENERS : 0) + chain.saves.length + 1;
  const run = Object.assign(base, { chain: chain.id, status: 'open', practice: null, position, ranked: position > OPENERS, snapshotAt: chain.saves.length, residueIn: layoutOf(chain) });
  Sim.createRun(run.seed, run.residueIn, run.runner, run.faction, null, run.rules); // validates
  saveRun(run);
  return describe(run);
}

// One thing at a time per key: actions on one run, saves onto one chain. Par searches run in a worker and take
// time, so without this two runs finishing together could merge onto a chain out of order.
const locks = new Map();
function withLock(key, fn) {
  const next = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

// Apply one action. Illegal actions throw and change nothing. When the run ends it is saved onto its chain at once:
// finishing is the save, so nobody can play a layout and then decline to hand it on. Returns a promise.
function act(runId, action, now) {
  return withLock(`run:${runId}`, async () => {
    now = now || clockNow();
    const run = loadRun(runId);
    if (run.status !== 'open' && run.status !== 'practice') throw new Error('This run is over.');
    if (run.status === 'open' && now - Date.parse(run.lastAt) >= IDLE_MS) {
      expireIdle(now, [run], all('chains'));
      throw new Error('This run was abandoned after 20 minutes without an action; it counts as your attempt.');
    }
    let s = stateOf(run);
    if (s.over) throw new Error('This run is over.');
    s = Sim.step(s, action);
    run.actions = s.actions;
    run.lastAt = new Date(now).toISOString();
    if (s.over) await finish(run, s, now);
    else saveRun(run);
    return describe(run);
  });
}

// Save a finished run onto its chain as the chain stands now. Credit counts only avoidable harm, judged against par
// on the snapshot the runner faced. Paradox collapse: if the merged layout would leave the next runner no way out,
// the run's changes are not merged (its score stands). Par is searched in a worker; the result keeps it (run.parInfo),
// so showing a result never searches again.
async function finish(run, s, now) {
  run.savedAt = new Date(now).toISOString();
  run.score = Sim.score(s);
  run.outcome = s.outcome;
  const info = await Par.finish(run.seed, run.residueIn, run.rules, run.faction);
  run.parInfo = info.par;
  if (run.status === 'practice') { run.status = 'practiced'; saveRun(run); return; }
  run.par = info.detail ? info.detail.score : null;
  run.credited = Sim.creditImpact(s.impact, info.detail, run.rules);
  await withLock(`chain:${run.chain}`, async () => {
    const chain = loadChain(run.chain);
    const ops = s.outcome === 'escaped' ? opsOf(s) : null;
    const save = { run: run.id, runner: run.runner, faction: run.faction, rules: run.rules, at: run.savedAt, outcome: s.outcome, ops, credited: run.credited };
    if (ops) {
      const next = applySave(layoutOf(chain), save);
      if (!(await Par.escapable(run.seed, Object.assign({ seed: run.seed }, next), run.rules))) {
        save.ops = null; save.collapsed = true; run.collapsed = true;
      }
      // The chain may have gained saves while par was searching; merge onto it as it stands now.
      const fresh = loadChain(run.chain);
      fresh.saves.push(save);
      run.status = 'saved';
      saveChain(fresh);
    } else {
      chain.saves.push(save);
      run.status = 'saved';
      saveChain(chain);
    }
    saveRun(run);
  });
}

// A claimed run's current state, for resuming after a reload.
function view(runId) { return describe(loadRun(runId)); }

// ---------- results, reveal and replays ----------

// The end-of-run result. Until the seed's chains close, the traps a runner faced are still waiting for others, so
// the full reveal, the par line, the glyph key and replays stay sealed; the runner sees what they met.
function result(runId, now) {
  const run = loadRun(runId);
  if (run.status === 'open') throw new Error('This run is not over yet.');
  const s = run.status === 'abandoned' ? null : stateOf(run);
  const chains = all('chains');
  const unsealed = run.status === 'practiced' || run.status === 'practice' || seedClosed(run.seed, now, chains);
  const out = {
    run: run.id, seed: run.seed, runner: run.runner, faction: run.faction, status: run.status, outcome: run.outcome,
    score: run.score, position: run.position, ranked: run.ranked, openers: OPENERS, chain: run.chain, collapsed: !!run.collapsed, sealed: !unsealed,
  };
  if (!s) return out;
  const p = run.parInfo !== undefined ? run.parInfo : Sim.parFor(s);
  out.par = p ? { score: p.score, layout: p.layout, upset: p.upset, line: unsealed ? p.line : undefined } : null;
  out.credited = run.credited || Sim.creditImpact(s.impact, Sim.parDetail(run.seed, run.residueIn, run.rules), run.rules);
  const chain = run.chain ? chains.find((c) => c.id === run.chain) : null;
  if (chain && run.status === 'saved') {
    const k = chain.saves.findIndex((x) => x.run === run.id);
    out.ledger = Sim.standings(ledgerOf(chain, k + 1));
  }
  // The traps this runner left, whether each sits on a room every route crosses (the best line meets it too, so it
  // earns nothing), and what later runners on the chain have met of this runner's traps so far. Totals only, no names:
  // the seed may still be open, and their routes are theirs.
  const rv0 = Sim.runnerView(s);
  const forced = Sim.forcedRooms(Sim.getSeed(run.seed));
  out.myTraps = rv0.myTrapRooms.map((room) => ({ room, text: rv0.myTraps.find((x) => x.startsWith(`${room}:`)) || room, forced: forced.includes(room) }));
  out.handedOn = run.status === 'saved' && run.outcome === 'escaped' && !run.collapsed;
  if (chain && run.status === 'saved') {
    const k = chain.saves.findIndex((x) => x.run === run.id);
    const later = chain.saves.slice(k + 1).filter((x) => x.outcome !== 'abandoned');
    const tot = { runs: later.length, dealt: 0, drawn: 0, unavoidable: 0, gave: 0, given: 0, fuseBonus: 0, aidBonus: 0 };
    for (const x of later) {
      const i = (x.credited || {})[run.runner];
      if (i) for (const f of Object.keys(tot)) if (f !== 'runs') tot[f] += i[f] || 0;
    }
    out.later = tot;
  }
  out.log = unsealed ? Sim.reveal(s).fullLog : Sim.runnerView(s).log;
  if (unsealed) {
    const rv = Sim.reveal(s);
    out.reveal = { traps: rv.inheritedTraps, wiring: rv.inheritedWiring, marks: rv.inheritedMarks, glyphKey: rv.glyphKey };
    // The saves that shaped this run's snapshot, newest first: the runs that can now be watched.
    if (chain) out.predecessors = chain.saves.slice(0, run.snapshotAt).slice(-4).reverse().filter((x) => x.outcome !== 'abandoned').map((x) => ({ run: x.run, runner: x.runner }));
  }
  return out;
}

// Step-by-step frames of a finished run, for watching. Only once the seed's chains have closed. redact hides the
// watched runner's own drops and rewires.
function watch(runId, redact, now) {
  const run = loadRun(runId);
  if (!['saved', 'practiced'].includes(run.status)) throw new Error('Only finished runs can be watched.');
  if (run.status === 'saved' && !seedClosed(run.seed, now)) throw new Error("Replays of this seed unlock when its chains close at the daily reset (08:00 UTC); its traps are still waiting for later runners.");
  const rec = { seed: run.seed, residueIn: run.residueIn, runner: run.runner, faction: run.faction, rules: run.rules, actions: run.actions };
  return { runner: run.runner, seed: run.seed, frames: Sim.frames(rec, !!redact).map((f) => {
    const st = clone(f.state); delete st.residueIn; delete st.ledgerIn;
    return { action: f.action, events: f.events, state: st };
  }) };
}

// Replay every finished run under its own rules and compare with the score saved for it. After changing sim.js,
// every line should say ok: saved runs must keep their results.
function verify() {
  return all('runs').filter((r) => r.status === 'saved' || r.status === 'practiced').map((r) => {
    const total = Sim.score(stateOf(r)).total;
    return { run: r.id, runner: r.runner, seed: r.seed, saved: r.score.total, replayed: total, ok: total === r.score.total };
  });
}

// ---------- the index: boards and titles (names, scores and counts only, never layouts) ----------

function hashName(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function index(now, opts) {
  now = now || clockNow();
  const period = periodOf(now);
  const chains = all('chains'), runs = all('runs');
  expireIdle(now, runs, chains);
  const chainById = {};
  for (const c of chains) chainById[c.id] = c;
  // A seed closes at the daily reset after its first chain opened.
  const today = dayOf(now);
  const openedOn = {};
  for (const c of chains) { const d = dayOf(Date.parse(c.opened)); if (!openedOn[c.seed] || d < openedOn[c.seed]) openedOn[c.seed] = d; }
  const sealedCheck = (sid) => !!openedOn[sid] && openedOn[sid] < today;
  const rows = [];
  const credit = {}; // period/tier -> designer credit earned from runs made in that period
  const pairUsed = {};
  for (const r of runs.filter((x) => x.status === 'saved' || x.status === 'abandoned')) {
    const { mapId, version, tier, n } = Sim.parseSeedId(r.seed);
    const saved = Date.parse(r.savedAt);
    const p = periodOf(saved);
    const pc = credit[`${p}/${tier}`] || (credit[`${p}/${tier}`] = {});
    for (const [who, i] of Object.entries(r.credited || {})) {
      const used = pairUsed[`${p}/${tier}/${r.runner}/${who}`] || (pairUsed[`${p}/${tier}/${r.runner}/${who}`] = { sab: 0, ben: 0 });
      let room = Math.max(0, PAIR_CAP - used.sab);
      const dealt = Math.min(i.dealt, room); room -= dealt;
      const drawn = Math.min(i.drawn, room);
      const given = Math.min(i.given, Math.max(0, PAIR_CAP - used.ben));
      used.sab += dealt + drawn; used.ben += given;
      const c = pc[who] || (pc[who] = { dealt: 0, drawn: 0, given: 0, runs: 0 });
      c.dealt += dealt; c.drawn += drawn; c.given += given; c.runs += 1;
    }
    const chain = chainById[r.chain];
    const k = chain ? chain.saves.findIndex((x) => x.run === r.id) : -1;
    const save = k >= 0 ? chain.saves[k] : null;
    const upset = (r.score && r.score.breakdown && r.score.breakdown.upset) || 0;
    const row = {
      id: r.id, seed: r.seed, map: mapId, version, tier, n, runner: r.runner, faction: r.faction, chain: r.chain, track: r.track,
      position: r.position, ranked: r.ranked && r.status === 'saved', score: r.score ? r.score.total : 0, upset, outcome: r.outcome,
      saved, period: p, par: r.par === undefined ? null : r.par,
      drops: save && save.ops ? save.ops.drops.length : 0,
      continued: !!chain && chain.saves.length > k + 1,
    };
    row.vsPar = row.ranked && row.par !== null ? Math.round((row.score - row.par - upset) * 10) / 10 : null;
    // Par is sealed while the seed is open: it says how much harm the best line can't avoid (a −4 step after some
    // position is a Spike on a forced room), which is intelligence for runners still to come. Each runner sees
    // their own par on their result; everyone else (boards, handicaps, faction standings) waits for the reset.
    if (!sealedCheck(r.seed)) { row.par = null; row.vsPar = null; }
    rows.push(row);
  }

  const seeds = {};
  for (const r of rows) (seeds[r.seed] = seeds[r.seed] || []).push(r);
  for (const list of Object.values(seeds)) list.sort((a, b) => b.score - a.score || a.saved - b.saved);

  // Handicap, golf-style: lifetime average points below par over ranked runs, once a runner has LIFETIME_MIN.
  const lifetime = {};
  for (const r of rows.filter((x) => x.ranked && x.vsPar !== null)) {
    const l = lifetime[r.runner] || (lifetime[r.runner] = { sum: 0, n: 0 });
    l.sum += r.vsPar; l.n += 1;
  }
  const lifetimeOf = (name) => { const l = lifetime[name]; return l && l.n >= LIFETIME_MIN ? Math.round((l.sum / l.n) * 10) / 10 : null; };
  const lifeKey = (name) => (lifetimeOf(name) === null ? -Infinity : lifetimeOf(name));
  const periods = {};
  for (const p of new Set([period, ...rows.map((r) => r.period)])) {
    periods[p] = {};
    const periodSeed = rows.filter((r) => r.period === p).map((r) => `${r.id}:${r.score}`).sort().join('|');
    for (const tier of Object.keys(Sim.TIERS).map(Number)) {
      const inP = rows.filter((r) => r.period === p && r.tier === tier && r.ranked);
      const draw = (name) => hashName(`${periodSeed}/${tier}/${name}`);
      const bestOf = {};
      for (const r of inP.filter((x) => x.outcome === 'escaped')) if (!bestOf[r.runner] || r.score > bestOf[r.runner].score) bestOf[r.runner] = r;
      const ranked = Object.values(bestOf).sort((a, b) => b.score - a.score || lifeKey(b.runner) - lifeKey(a.runner) || draw(a.runner) - draw(b.runner));
      const top = ranked[0] || null;
      const leaders = top ? ranked.filter((r) => r.score === top.score && lifeKey(r.runner) === lifeKey(top.runner)) : [];
      // An opportunity is one of your saved runs that somebody else's run came after on its chain.
      const opportunities = {};
      for (const r of rows) if (r.period === p && r.tier === tier && r.continued) opportunities[r.runner] = (opportunities[r.runner] || 0) + 1;
      const rate = (d, pts) => pts / Math.max(1, opportunities[d.name] || 0);
      const { saboteurs, benefactors } = Sim.standings(credit[`${p}/${tier}`] || {});
      for (const d of saboteurs.concat(benefactors)) d.opportunities = opportunities[d.name] || 0;
      saboteurs.sort((a, b) => b.saboteur - a.saboteur || rate(b, b.saboteur) - rate(a, a.saboteur) || draw(a.name) - draw(b.name));
      benefactors.sort((a, b) => b.benefactor - a.benefactor || rate(b, b.benefactor) - rate(a, a.benefactor) || draw(a.name) - draw(b.name));
      const tiedWith = (list, key) => (list.length ? list.filter((d) => d[key] === list[0][key] && rate(d, d[key]) === rate(list[0], list[0][key])) : []);
      periods[p][tier] = {
        runCount: inP.length, leader: top, leaders,
        topSaboteur: saboteurs[0] || null, topSaboteurs: tiedWith(saboteurs, 'saboteur'),
        topBenefactor: benefactors[0] || null, topBenefactors: tiedWith(benefactors, 'benefactor'),
        saboteurs, benefactors, factions: factionStandings(inP),
      };
    }
  }

  // Seeds: a seed closes at the daily reset after its first chain opened. The current seed per map and tier is
  // the newest one still open (or the next number once it has closed).
  const closed = sealedCheck;
  const nextSeed = {};
  for (const map of Object.keys(Sim.MAPS)) {
    nextSeed[map] = {};
    for (const tier of Object.keys(Sim.TIERS).map(Number)) {
      const ns = Object.keys(openedOn).map((sid) => Sim.parseSeedId(sid)).filter((x) => x.mapId === map && x.version === Sim.versionOf(map) && x.tier === tier).map((x) => x.n);
      const top = ns.length ? Math.max(...ns) : 0;
      nextSeed[map][tier] = top && closed(Sim.seedIdOf(map, tier, top))
        ? { current: Sim.seedIdOf(map, tier, top + 1), next: null }
        : { current: Sim.seedIdOf(map, tier, top || 1), next: top ? Sim.seedIdOf(map, tier, top + 1) : null };
    }
  }
  const mapPicker = (() => {
    for (const tier of Object.keys(Sim.TIERS).map(Number).sort((a, b) => b - a)) {
      const t = periods[period][tier];
      if (t.leader) return { tier, runner: t.leader.runner, shared: t.leaders.map((l) => l.runner) };
    }
    return null;
  })();
  const handicaps = {};
  for (const [name, l] of Object.entries(lifetime)) {
    const avg = lifetimeOf(name);
    handicaps[name] = { runs: l.n, value: avg === null ? null : Math.round(Math.max(0, -avg) * 10) / 10 };
  }
  // A runner's own state, if asked: their open runs (to resume) and the seeds they've already played.
  let me = null;
  if (opts && opts.runner) {
    const name = String(opts.runner).toLowerCase();
    me = {
      open: runs.filter((r) => r.runner === name && r.status === 'open').map((r) => ({ run: r.id, seed: r.seed })),
      played: [...new Set(runs.filter((r) => r.runner === name && r.status !== 'practice' && r.status !== 'practiced').map((r) => r.seed))],
      lock: factionLock(name, now, runs),
    };
  }
  return { now: new Date(now).toISOString(), period, tiers: periods[period], periods, runs: rows, seeds, nextSeed, mapPicker, closedSeeds: Object.keys(openedOn).filter(closed), handicaps, handicapMin: LIFETIME_MIN, openers: OPENERS, me };
}

// Faction standings, ranked by the mean of each member's best score minus par.
function factionStandings(rows) {
  const mean = (v) => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null);
  const best = {}, bestVs = {};
  for (const r of rows) {
    if (!r.faction) continue;
    const k = `${r.faction}/${r.runner}`;
    if (!(k in best) || r.score > best[k]) best[k] = r.score;
    if (r.vsPar !== null && (!(k in bestVs) || r.vsPar > bestVs[k])) bestVs[k] = r.vsPar;
  }
  const group = (o) => { const g = {}; for (const [k, v] of Object.entries(o)) (g[k.split('/')[0]] = g[k.split('/')[0]] || []).push(v); return g; };
  const raw = group(best), vs = group(bestVs);
  return Object.keys(Sim.FACTIONS).map((f) => ({ faction: f, runners: (raw[f] || []).length, vsPar: mean(vs[f] || []), mean: mean(raw[f] || []) }))
    .sort((a, b) => (b.vsPar ?? -1e9) - (a.vsPar ?? -1e9));
}

module.exports = {
  clockNow, devClock, devNextDay, devResetClock,
  claim, act, view, result, watch, index, verify, factionLock, seedClosed, seedOpenedDay, periodOf, layoutOf, applySave,
  loadChain, loadRun, OPENERS, SLOTS, IDLE_MS, RESET_HOUR_UTC, DATA,
};
