// Echowake demo (GitHub Pages): the Stage 1 server, in the browser. The pages call `api/...` as they do on serve.js;
// this file answers those calls by running the real game.js and sim.js in the page, over a small file system kept in
// localStorage. Each browser is its own store: its own chains, runs and seed secret (so a demo's seeds are not
// secret from a curious visitor, which is fine for a demo). Par runs on the page's thread when a run ends.
// The dev clock is on (Next day in the lobby), so a visitor can close a seed and see results unseal.
(function () {
  'use strict';
  const realFetch = window.fetch.bind(window);
  const FS = 'echowake-demo:fs:';

  // ---------- a file system in localStorage ----------
  const ls = {
    get(k) { try { return localStorage.getItem(FS + k); } catch (e) { return null; } },
    set(k, v) { localStorage.setItem(FS + k, v); },
    del(k) { try { localStorage.removeItem(FS + k); } catch (e) { /* */ } },
    keys() { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(FS)) out.push(k.slice(FS.length)); } } catch (e) { /* */ } return out; },
  };
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  const noent = (f) => { const e = new Error(`ENOENT: ${f}`); e.code = 'ENOENT'; return e; };
  const fs = {
    readFileSync(f) { const v = ls.get(norm(f)); if (v === null) throw noent(f); return v; },
    writeFileSync(f, d, o) {
      f = norm(f);
      if (o && o.flag === 'wx' && ls.get(f) !== null) { const e = new Error(`EEXIST: ${f}`); e.code = 'EEXIST'; throw e; }
      ls.set(f, String(d));
    },
    renameSync(a, b) { const v = ls.get(norm(a)); if (v === null) throw noent(a); ls.set(norm(b), v); ls.del(norm(a)); },
    unlinkSync(f) { if (ls.get(norm(f)) === null) throw noent(f); ls.del(norm(f)); },
    mkdirSync() { /* directories are implied */ },
    existsSync(p) { p = norm(p); return ls.get(p) !== null || ls.keys().some((k) => k.startsWith(`${p}/`)); },
    readdirSync(d) { d = `${norm(d)}/`; return ls.keys().filter((k) => k.startsWith(d) && !k.slice(d.length).includes('/')).map((k) => k.slice(d.length)); },
    statSync(f) { if (ls.get(norm(f)) === null) throw noent(f); return { mtimeMs: Date.now() }; },
  };
  const path = {
    join: (...a) => norm(a.filter((x) => x !== '' && x != null).join('/')),
    dirname: (p) => { p = norm(p); const i = p.lastIndexOf('/'); return i < 0 ? '.' : p.slice(0, i); },
    extname: (p) => { const m = /\.[^./]*$/.exec(p); return m ? m[0] : ''; },
  };

  // ---------- crypto: random ids and HMAC-SHA256 (synchronous, as sim.js needs it) ----------
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(bytes) {
    const n = bytes.length, total = ((n + 9 + 63) >> 6) << 6, m = new Uint8Array(total);
    m.set(bytes); m[n] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(total - 4, (n * 8) >>> 0); dv.setUint32(total - 8, Math.floor(n / 0x20000000));
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64), r = (x, k) => (x >>> k) | (x << (32 - k));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    const out = new Uint8Array(32), ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
    return out;
  }
  const utf8 = (s) => new TextEncoder().encode(String(s));
  function hmac(key, msg) {
    let k = utf8(key);
    if (k.length > 64) k = sha256(k);
    const ipad = new Uint8Array(64 + msg.length), opad = new Uint8Array(64 + 32);
    for (let i = 0; i < 64; i++) { ipad[i] = (k[i] || 0) ^ 0x36; opad[i] = (k[i] || 0) ^ 0x5c; }
    ipad.set(msg, 64); opad.set(sha256(ipad), 64);
    return sha256(opad);
  }
  const asBuffer = (u8) => Object.assign(u8, {
    readUInt32BE(pos) { return new DataView(u8.buffer).getUint32(pos); },
    toString(enc) { return enc === 'hex' ? Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('') : new TextDecoder().decode(u8); },
  });
  const crypto = {
    randomBytes(n) { const u = new Uint8Array(n); window.crypto.getRandomValues(u); return asBuffer(u); },
    createHmac(alg, key) {
      if (alg !== 'sha256') throw new Error(`demo: no ${alg}`);
      let msg = '';
      const h = { update(s) { msg += s; return h; }, digest() { return asBuffer(hmac(key, utf8(msg))); } };
      return h;
    },
  };

  // ---------- load sim.js and game.js as CommonJS modules ----------
  let loaded = null;
  function load() {
    if (loaded) return loaded;
    loaded = (async () => {
      const [simSrc, gameSrc] = await Promise.all(['sim.js', 'game.js'].map((u) => realFetch(u).then((r) => { if (!r.ok) throw new Error(`Could not load ${u}.`); return r.text(); })));
      const proc = { env: { TRAP_DATA: 'data' }, versions: { node: 'demo' }, pid: 1, argv: [] };
      const mods = { fs, path, crypto };
      const req = (name) => { if (!(name in mods)) throw new Error(`demo: no module ${name}`); return mods[name]; };
      const run = (src, file) => {
        const module = { exports: {} };
        new Function('require', 'module', 'exports', 'process', '__dirname', '__filename', src)(req, module, module.exports, proc, '.', file);
        return module.exports;
      };
      const Sim = run(simSrc, 'sim.js');
      mods['./sim.js'] = Sim;
      // parpool.js without workers: par on this thread, after a pause so the page can draw first.
      const pause = () => new Promise((r) => setTimeout(r, 30));
      mods['./parpool.js'] = {
        async finish(seed, residueIn, rules, faction) {
          await pause();
          const detail = Sim.parDetail(seed, residueIn, rules);
          const p = Sim.parFor(Sim.createRun(seed, residueIn, '_par', faction, null, rules));
          return { detail, par: p ? { score: p.score, layout: p.layout, upset: p.upset, line: p.line } : null };
        },
        async escapable(seed, layout, rules) { await pause(); return !!Sim.par(seed, layout, rules); },
      };
      const Game = run(gameSrc, 'game.js');
      return { Sim, Game };
    })();
    return loaded;
  }

  // ---------- the API (serve.js's routes) ----------
  async function route(url, method, body) {
    const { Sim, Game } = await load();
    const q = url.searchParams, p = url.pathname.slice(url.pathname.indexOf('/api/'));
    if (p === '/api/index') return Game.index(undefined, { runner: q.get('runner') });
    if (p === '/api/dev/clock') return Object.assign({ dev: true, data: 'this browser' }, Game.devClock());
    if (p === '/api/dev/next-day' && method === 'POST') return Object.assign({ dev: true }, Game.devNextDay());
    if (p === '/api/dev/real-time' && method === 'POST') return Object.assign({ dev: true }, Game.devResetClock());
    if (p === '/api/faction') return { lock: Game.factionLock(q.get('runner')) };
    if (p === '/api/claim' && method === 'POST') return Game.claim({ seed: body.seed, runner: body.runner, faction: body.faction, chain: body.chain, channel: body.channel === 'web' ? 'web' : 'api' });
    let m = /^\/api\/run\/([0-9a-f]{16})(\/(act|result|watch))?$/.exec(p);
    if (m) {
      const id = m[1], what = m[3];
      if (!what) return Game.view(id);
      if (what === 'act' && method === 'POST') return Game.act(id, body.action);
      if (what === 'result') return Object.assign(Game.result(id), { now: new Date(Game.clockNow()).toISOString() });
      if (what === 'watch') return Game.watch(id, q.get('redact') === '1');
    }
    m = /^\/api\/chain\/([0-9a-f]{16})$/.exec(p);
    if (m) {
      const c = Game.loadChain(m[1]);
      return { id: c.id, seed: c.seed, track: c.track, saves: c.saves.length, opening: c.opening, closed: Game.seedClosed(c.seed) };
    }
    m = /^\/api\/seed\/([^/]+)$/.exec(p);
    if (m) {
      const id = decodeURIComponent(m[1]), seed = Sim.getSeed(id);
      return Game.seedClosed(id) ? seed : Sim.publicSeed(seed);
    }
    const e = new Error('No such endpoint.'); e.status = 404; throw e;
  }
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async function (input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.includes('/api/')) return realFetch(input, init);
    const method = ((init && init.method) || 'GET').toUpperCase();
    let body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) { return json(400, { error: 'Bad JSON.' }); }
    try { return json(200, await route(url, method, body)); } catch (e) { return json(e.status || 400, { error: e.message }); }
  };
  window.EchowakeDemo = { load, reset() { for (const k of ls.keys()) ls.del(k); } };
})();
