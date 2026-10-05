// Relay Golf, stage 2: what the app's pages share. The day (course N is day N, turning over at 08:00 UTC from
// 1 October 2026, with play.html's DEV clock offset), the hot-seat chain on this browser (the same key and format as
// play.html, so both pages relay the same course), the round in progress (kept between hole pages), finishing a round
// (credit to the authors of the features it met, the chain ages, this golfer's picks join it), and the boards.
(function (root) {
  'use strict';
  const G = root.RelayGolf;
  const LIFETIME = 6;                       // a feature lasts this many golfers
  const DAY_MS = 86400000, DAY_ONE = Date.UTC(2026, 9, 1, 8);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* */ } },
  };
  // ---------- the day ----------
  const devOffset = () => Number(store.get('relay-golf:dev-offset')) || 0;
  const clockNow = () => Date.now() + devOffset();
  const today = () => Math.max(1, Math.floor((clockNow() - DAY_ONE) / DAY_MS) + 1);
  const resetIn = () => DAY_ONE + today() * DAY_MS - clockNow(); // ms until the next reset
  const isDev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  function nextDay() { const now = clockNow(), next = DAY_ONE + Math.ceil((now - DAY_ONE + 1) / DAY_MS) * DAY_MS + 60000; store.set('relay-golf:dev-offset', String(devOffset() + (next - now))); }
  const realTime = () => store.del('relay-golf:dev-offset');
  const courseId = (n) => `links#${n}`;
  // A seeded course name (display only).
  function courseName(id) {
    let h = 2166136261; for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    const A = ['Heron', 'Salt', 'Willow', 'Pine', 'Cedar', 'Fox', 'Lark', 'Tide', 'Bramble', 'Mill', 'Kestrel', 'Juniper', 'Otter', 'Wren', 'Thistle', 'Copper'];
    const B = ['Bend', 'Marsh', 'Hollow', 'Links', 'Ridge', 'Dunes', 'Brook', 'Point', 'Meadow', 'Glen', 'Shore', 'Heath'];
    return `${A[h % A.length]} ${B[(h >>> 8) % B.length]}`;
  }
  // ---------- the golfer ----------
  const getName = () => store.get('relay-golf:name') || '';
  const setName = (n) => store.set('relay-golf:name', n);
  // ---------- the chain ----------
  const chainKey = (id) => `relay-golf:chain:${id}`;
  function loadChain(id) {
    let c = null;
    try { c = JSON.parse(store.get(chainKey(id))); } catch (e) { /* */ }
    c = c || { features: [], golfers: [], next: 1 };
    c.features = (c.features || []).filter((f) => G.FEATURES[f.kind] && !(f.kind === 'backstop' && f.side == null));
    c.golfers = c.golfers || []; c.credit = c.credit || {};
    return c;
  }
  const saveChain = (id, c) => store.set(chainKey(id), JSON.stringify(c));
  // ---------- the round in progress ----------
  // { round (the engine's), faced (the chain's features when it began), picks [feature|null x 3], practice }
  const roundKey = (id) => `relay-golf:round:${id}`;
  function loadRound(id) { try { return JSON.parse(store.get(roundKey(id))); } catch (e) { return null; } }
  const saveRound = (id, s) => store.set(roundKey(id), JSON.stringify(s));
  const clearRound = (id) => store.del(roundKey(id));
  function startRound(id, practice) {
    const c = loadChain(id), round = G.newRound(id, c.features, getName() || `Golfer ${c.golfers.length + 1}`);
    // Practice on a closed day: nothing hidden, nothing saved.
    if (practice) for (const h of G.getCourse(id).holes) for (const f of G.withSeed(h, G.featuresOn(c.features, G.getCourse(id).holes.indexOf(h)))) if (!round.known.includes(f.id)) round.known.push(f.id);
    const s = { round, faced: c.features.map((f) => ({ ...f })), picks: [null, null, null], practice: !!practice };
    saveRound(id, s);
    return s;
  }
  // ---------- finishing a round ----------
  const featName = (f) => (G.shapeOf(f) ? `${G.FEATURES[f.kind].label} (${G.shapeOf(f).label.toLowerCase()})` : G.FEATURES[f.kind].label);
  function finishRound(id, s) {
    const course = G.getCourse(id), c = loadChain(id), round = s.round, picks = s.picks.filter(Boolean);
    const pars = course.holes.map((h, i) => G.parOf(G.layoutOf(h, G.featuresOn(s.faced, i))));
    const cost = picks.reduce((a, f) => a + G.costOf(f), 0), strokes = round.strokes.slice(), total = strokes.reduce((a, b) => a + b, 0) + cost;
    // What the features this golfer met did to the round: credit to their authors (on the feature, as play.html keeps
    // it, and in the chain's running total by author, which outlives the features).
    const credit = G.credit(course, s.faced, round);
    const result = { courseId: id, name: round.golfer, strokes, pars, cost, total, par: pars.reduce((a, b) => a + b, 0), picks, practice: s.practice, met: credit.map((q) => ({ ...q, label: featName(s.faced.find((f) => f.id === q.feature) || { kind: q.kind }) })) };
    if (!s.practice) {
      for (const q of credit) {
        const f = c.features.find((x) => x.id === q.feature);
        if (f) { f.harm = (f.harm || 0) + q.harm + q.scouted; f.aid = (f.aid || 0) + q.aid; }
        if (q.owner && q.owner !== 'seed') { const k = c.credit[q.owner] || (c.credit[q.owner] = { harm: 0, aid: 0 }); k.harm += q.harm + q.scouted; k.aid += q.aid; }
      }
      for (const f of c.features) f.age = (f.age || 0) + 1;
      c.features = c.features.filter((f) => f.age < LIFETIME);
      let next = c.next;
      for (const f of picks) c.features.push({ ...f, id: `f${next++}`, owner: round.golfer, age: 0 });
      c.next = next + 3;
      c.golfers.push({ name: round.golfer, strokes, cost, total, par: result.par, left: picks.length ? picks.map((f) => `${featName(f)} on hole ${f.hole + 1}`).join(', ') : 'nothing', picks: picks.map((f) => ({ kind: f.kind, hole: f.hole })) });
      saveChain(id, c);
    }
    store.set(`relay-golf:last:${id}`, JSON.stringify(result));
    clearRound(id);
    return result;
  }
  const lastResult = (id) => { try { return JSON.parse(store.get(`relay-golf:last:${id}`)); } catch (e) { return null; } };
  // ---------- the boards ----------
  // Leader: the best card against par (ties: earliest). Saboteur and benefactor: the most harm and aid credit by author.
  function boards(c) {
    const vs = (g) => g.total - g.par;
    const leader = c.golfers.length ? c.golfers.reduce((b, g) => (vs(g) < vs(b) ? g : b)) : null;
    const owners = Object.entries(c.credit || {});
    const top = (k) => { const o = owners.filter(([, v]) => v[k] > 0).sort((a, b) => b[1][k] - a[1][k])[0]; return o ? { name: o[0], value: o[1][k] } : null; };
    return { leader, saboteur: top('harm'), benefactor: top('aid') };
  }
  const fmtVs = (n) => (n === 0 ? 'E' : n > 0 ? `+${n}` : `−${-n}`);
  const fmtIn = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return `${Math.floor(m / 60)} h ${m % 60} m`; };

  root.RelayChain = { LIFETIME, today, resetIn, clockNow, isDev, nextDay, realTime, devOffset, courseId, courseName, getName, setName, loadChain, saveChain, loadRound, saveRound, clearRound, startRound, finishRound, lastResult, boards, featName, fmtVs, fmtIn };
})(typeof globalThis !== 'undefined' ? globalThis : this);
