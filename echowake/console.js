// Shared code for the console pages (lobby, run, result). They are thin clients over the Stage 1 API: the server
// holds the run, and these pages draw only the runner view it returns. Needs sim.js (map geometry and labels).
(function (root) {
  'use strict';
  const Sim = root.TrapSim;

  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked: fine */ } },
  };
  async function api(url, body) {
    const r = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `${url} failed`);
    return j;
  }
  // Faction symbols (design/factions/final): a small icon beside every faction name, and the emblem for show.
  const facIcon = (f, size) => (f && Sim.FACTIONS[f] ? `<img class="facicon" src="assets/faction-${f}-icon.webp" width="${size || 16}" height="${size || 16}" alt="" title="${esc(Sim.FACTIONS[f].label)}">` : '');
  const facEmblem = (f) => `assets/faction-${f}.webp`;
  // Seeds come from the server (secret seeds can't be built in a browser). loadSeed fetches one and adopts it, so
  // Sim.getSeed(id) works afterwards: the public seed while it's open, the whole seed once it has closed.
  const seedLoads = {};
  const loadSeed = (id) => seedLoads[id] || (seedLoads[id] = api(`api/seed/${encodeURIComponent(id)}`).then(Sim.adoptSeed));
  // The Astral glyphs as SVG (24-unit box, stroked in currentColor). Keys are the engine's characters.
  const GLYPH_PATHS = {
    '○': '<circle cx="12" cy="12" r="8.5"/><circle class="f" cx="12" cy="12" r="2.1"/>', // sun
    '△': '<path d="M14.5 3.9A8.5 8.5 0 1 0 14.5 20.1A9 9 0 0 1 14.5 3.9Z"/>', // moon
    '□': '<path d="M8.5 3V15.5M5.5 6.5H11.5M8.5 11C9.5 8.8 16.5 8.5 16.5 13.2C16.5 16.5 12.5 17 13.8 21"/>', // saturn
    '◇': '<path d="M5 16H18.5M15.5 4V20.5M5 16C9 13.5 11.5 11 11.5 8.2C11.5 5.8 9.8 4.6 8 4.6C6.4 4.6 5.4 5.7 5.2 6.8"/>', // jupiter
    '☆': '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5V20.5M3.5 12H20.5"/>', // earth
    '─': '<path d="M7 20L13 4M11.5 20L17.5 4"/>', // twin
    '│': '<path d="M12 3.5C8 6.5 8 9.5 12 12C16 14.5 16 17.5 12 20.5"/>', // wreath
    '╱': '<path d="M3 12C5 7.5 8 7.5 9.5 12S14 16.5 15.5 12S19.5 7.5 21 12"/>', // wave
  };
  const isGlyph = (c) => c in GLYPH_PATHS;
  // A glyph inside an SVG (map marks), and inline in HTML text.
  const glyphSVG = (c, x, y, size, cls) => `<svg class="glyph ${cls || ''}" x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-label="${Sim.GLYPH_DISPLAY[c]}">${GLYPH_PATHS[c]}</svg>`;
  const glyphInline = (c) => `<svg class="glyph glyph-i" viewBox="0 0 24 24" role="img" aria-label="${Sim.GLYPH_DISPLAY[c]}">${GLYPH_PATHS[c]}</svg>`;
  // Escape text and draw any glyph characters in it (engine or Astral) as inline SVG.
  const DISPLAY_TO_GLYPH = Object.fromEntries(Object.entries(Sim.GLYPH_DISPLAY).map(([k, d]) => [d, k]));
  const glyphify = (text) => Array.from(String(text)).map((c) => (isGlyph(c) ? glyphInline(c) : DISPLAY_TO_GLYPH[c] ? glyphInline(DISPLAY_TO_GLYPH[c]) : esc(c))).join('');
  const fac = (f) => (f && Sim.FACTIONS[f] ? `<span class="fac ${f}">${facIcon(f)}${esc(Sim.FACTIONS[f].label)}</span>` : '');

  // Scene art per map: a gate (arrival) scene for the lobby and result, a room (trap) scene for the run.
  // A map without its own art (Alexandria) borrows the Silk Road's.
  const ART_MAPS = ['silkroad', 'paris', 'venice'];
  const ART = (mapId, kind) => `assets/${ART_MAPS.includes(mapId) ? mapId : 'silkroad'}-${kind}.jpg`;

  // ---------- routes from public information only ----------

  const doorClosedBetween = (view, a, b) => {
    const d = (view ? view.doors : []).find((x) => x.between === Sim.edgeKey(a, b));
    return !!(d && d.closed);
  };
  function path(seed, view, from, to, doorOpen) {
    const prev = { [from]: null }, q = [from];
    while (q.length) {
      const c = q.shift();
      if (c === to) break;
      for (const n of Sim.neighbors(seed, c)) {
        if (n in prev) continue;
        const closed = view ? doorClosedBetween(view, c, n) : !!seed.doors[Sim.edgeKey(c, n)];
        if (closed && !doorOpen) continue;
        prev[n] = c; q.push(n);
      }
    }
    if (!(to in prev)) return null;
    const out = []; let c = to;
    while (c && c !== from) { out.unshift(c); c = prev[c]; }
    return out;
  }

  // The view a runner has before the first move (the briefing has no run yet): every room unvisited, every switch
  // unflipped, the exit door closed. The door switch is public: the log names it at the start of every run.
  function startView(seed) {
    const rooms = {};
    for (const [id, r] of Object.entries(seed.rooms)) rooms[id] = { loot: r.loot, switch: r.switch ? { id: r.switch, flipped: false } : null };
    const door = seed.doorSwitch || (() => { const id = Object.keys(seed.switches).find((k) => seed.switches[k].payoff.type === 'open'); return { id, room: seed.switches[id].room }; })();
    return {
      room: seed.start, exit: seed.exit, over: false, turn: 0, turnCap: seed.turnCap, rooms,
      doors: Object.keys(seed.doors).map((k) => ({ between: k, closed: true })),
      doorSwitch: door,
    };
  }

  // The suggested strategies (the mockup's first four). Each turns into a planned route the run screen shows.
  const STRATEGIES = [
    { id: 'direct', title: 'Direct route', desc: 'Door switch, then the exit. Fewest turns.', icon: 'M4 24 H30 M22 17 l8 7 -8 7' },
    { id: 'collect', title: 'Collect loot', desc: 'Sweep the loot you can see, if the turns allow.', icon: 'M17 4 L30 17 L17 30 L4 17 Z M17 12 v10 M12 17 h10' },
    { id: 'traps', title: 'Leave traps', desc: 'The direct route, dropping traps for the runners after you.', icon: 'M17 5 a12 12 0 1 0 0.01 0 M17 10 v7 l5 3' },
    { id: 'self', title: 'Plan it myself', desc: 'No suggested route: open the map and chart your own.', icon: 'M5 8 l8 -3 l8 3 l8 -3 v21 l-8 3 l-8 -3 l-8 3 Z M13 5 v21 M21 8 v21' },
  ];

  // A planned route from where the runner stands: the rooms to walk, in order, and the turns it takes.
  // Returns { rooms: [...], turns, next } or null for "plan it myself".
  function plan(seed, view, strategy) {
    if (strategy === 'self' || !view || view.over) return null;
    const doorRoom = view.doorSwitch.room;
    const doorFlipped = view.rooms[doorRoom].switch && view.rooms[doorRoom].switch.flipped;
    const finish = (from) => {
      if (doorFlipped) return path(seed, view, from, view.exit, true) || [];
      const a = path(seed, view, from, doorRoom, false) || [];
      const b = path(seed, view, doorRoom, view.exit, true) || [];
      return [...a, '⚙', ...b];
    };
    const turnsOf = (steps) => steps.length; // each move or flip is one turn
    let steps;
    if (strategy === 'collect') {
      // Which visible loot is worth the walk, and in what order: a small search over the loot rooms (plus a Cache
      // switch whose payoff is known, and the door switch, which can be flipped whenever the route passes it) that
      // maximises loot minus turns ÷ 2 and still reaches the exit in time.
      const worth = {};
      for (const [id, r] of Object.entries(view.rooms)) {
        if (id === view.room) continue;
        let w = r.loot || 0;
        if (r.switch && !r.switch.flipped && /cache/i.test(r.switch.sign || '')) w += 3;
        if (w > 0) worth[id] = w;
      }
      const targets = Object.keys(worth).slice(0, 9);
      const distCache = new Map();
      const dist = (x, y, open) => {
        const k = `${x}|${y}|${open ? 1 : 0}`;
        if (!distCache.has(k)) { const p = path(seed, view, x, y, open); distCache.set(k, p ? p.length : Infinity); }
        return distCache.get(k);
      };
      const cacheFlip = (id) => (view.rooms[id].switch && !view.rooms[id].switch.flipped && /cache/i.test(view.rooms[id].switch.sign || '') ? 1 : 0);
      const toExit = (from, done) => (done ? dist(from, view.exit, true) : dist(from, doorRoom, false) + 1 + dist(doorRoom, view.exit, true));
      const budget = view.turnCap - view.turn - 1;
      let best = { value: -Infinity, order: [] };
      (function search(cur, used, turns, value, order, done) {
        const total = turns + toExit(cur, done);
        if (total <= budget && value - total / 2 > best.value) best = { value: value - total / 2, order: order.slice(), done };
        const options = targets.filter((id) => !used.has(id));
        if (!done) options.push('⚙door');
        for (const opt of options) {
          const id = opt === '⚙door' ? doorRoom : opt;
          const d = dist(cur, id, done) + (opt === '⚙door' ? 1 : cacheFlip(id));
          if (!isFinite(d) || turns + d > budget) continue;
          if (opt !== '⚙door') used.add(id);
          order.push(opt);
          search(id, used, turns + d, value + (opt === '⚙door' ? 0 : worth[id]), order, done || opt === '⚙door');
          if (opt !== '⚙door') used.delete(id);
          order.pop();
        }
      })(view.room, new Set(), 0, 0, [], doorFlipped);
      steps = [];
      let cur = view.room, done = doorFlipped;
      for (const opt of best.order) {
        const id = opt === '⚙door' ? doorRoom : opt;
        steps.push(...(path(seed, view, cur, id, done) || []));
        if (opt === '⚙door') { steps.push('⚙'); done = true; } else if (cacheFlip(id)) steps.push('⚙');
        cur = id;
      }
      steps.push(...(done ? path(seed, view, cur, view.exit, true) || [] : finish(cur)));
    } else {
      steps = finish(view.room);
    }
    const rooms = [view.room, ...steps.filter((x) => x !== '⚙')];
    const first = steps[0];
    // A flip first means the switch in this room (the door's, or a cache's on the way).
    const here = view.rooms[view.room].switch;
    const next = first === '⚙' ? `Flip ${here ? here.id : view.doorSwitch.id}` : first ? `Move to ${first}` : 'Leave';
    return { rooms, steps, turns: turnsOf(steps), next };
  }

  // ---------- the projected map ----------

  // Draws the map as an SVG string. view may be null (a preview from the seed's public geometry and carved marks).
  // opts: { sel, route (plan), next (the suggested next room, outlined), onlyGeometry }. Wrap it in .hide-switches / .hide-glyphs to hide those layers (console.css).
  function mapSVG(seed, view, opts) {
    opts = opts || {};
    const R = seed.rooms;
    let links = '', marks = '', nodes = '', top = '';
    const ends = {};
    // A carved mark: its glyphs drawn as SVG in a box; faded strokes dimmed and struck through.
    const markBox = (x, y, glyphs, faded, link, cls) => {
      const items = Array.from(glyphs || '').map((c) => [c, false]).concat(Array.from(faded || '').map((c) => [c, true]));
      const n = Math.max(1, items.length), G = 15, w = 8 + n * G;
      const x0 = x - w / 2 + 4;
      const inner = items.map(([c, f], i) => {
        const gx = x0 + i * G;
        const g = isGlyph(c) ? glyphSVG(c, gx, y - 7.5, 15, f ? 'faded' : '') : `<text x="${gx + 3}" y="${y}" class="${f ? 'faded' : ''}">${esc(c)}</text>`;
        return g + (f ? `<line class="strike" x1="${gx}" y1="${y}" x2="${gx + G}" y2="${y}"/>` : '');
      }).join('');
      return { svg: `<g class="mark ${link ? `l${link}` : ''} ${cls || ''}"><rect x="${x - w / 2}" y="${y - 11}" width="${w}" height="22" rx="4"/>${inner}</g>`, cx: x, cy: y };
    };
    for (const [a, b] of seed.edges) {
      links += `<line class="link" x1="${R[a].x}" y1="${R[a].y}" x2="${R[b].x}" y2="${R[b].y}"/>`;
      const key = Sim.edgeKey(a, b);
      if (seed.doors[key]) {
        const closed = view ? doorClosedBetween(view, a, b) : true;
        const mx = (R[a].x + R[b].x) / 2, my = (R[a].y + R[b].y) / 2;
        links += `<line class="${closed ? 'door-closed' : 'door-open'}" x1="${mx}" y1="${my - 16}" x2="${mx}" y2="${my + 16}"/>`;
        marks += markBox(mx, my - 34, seed.marks.door, '', null, 'door').svg;
      }
    }
    if (opts.route && opts.route.rooms.length > 1) {
      top += `<polyline class="route" points="${opts.route.rooms.map((id) => `${R[id].x},${R[id].y}`).join(' ')}"/>`;
    }
    for (const [id, r] of Object.entries(R)) {
      const vr = view ? view.rooms[id] : null;
      const here = view ? view.room === id : id === seed.start;
      const cls = ['room', here ? 'here' : '', id === seed.exit ? 'exit' : '', view && view.visited.includes(id) ? 'seen' : '', opts.sel === id ? 'sel' : ''].join(' ');
      const big = here || id === seed.exit;
      const loot = vr ? vr.loot : seed.rooms[id].loot;
      const tags = [];
      if (loot) tags.push(`<tspan>◆${loot}</tspan>`);
      const swId = vr ? vr.switch && vr.switch.id : seed.rooms[id].switch;
      if (swId) {
        const flipped = vr && vr.switch.flipped;
        tags.push(`<tspan class="sw">⚙${esc(swId)}${flipped ? '↓' : ''}</tspan>`);
      }
      if (view && view.myTrapRooms.includes(id)) tags.push('<tspan>★</tspan>');
      nodes += `<g class="${cls}" data-room="${id}"><circle class="node" cx="${r.x}" cy="${r.y}" r="${big ? 19 : 16}"/>`
        + `<text class="id" x="${r.x}" y="${r.y}">${id}</text>`
        + `<text class="name" x="${r.x}" y="${r.y + 32}">${esc(r.label)}</text>`
        + `<text class="tag" x="${r.x}" y="${r.y + 46}">${tags.join(' ')}</text>`;
      if (here) nodes += `<circle class="pulse" cx="${r.x}" cy="${r.y}" r="19"/>`;
      if (opts.next === id) nodes += `<circle class="nextring" cx="${r.x}" cy="${r.y}" r="${big ? 26 : 23}"/>`;
      // Intel the runner gathered: ✓ empty, ? something (peek), ! inspected.
      if (vr && vr.intel) {
        const empty = vr.intel.result === 'empty';
        nodes += `<text class="intel ${empty ? 'empty' : 'something'}" x="${r.x + 24}" y="${r.y + 4}">${empty ? '✓' : vr.intel.how === 'peek' ? '?' : '!'}</text>`;
      }
      nodes += '</g>';
      // Carved marks: the switch's (left) and the trap's (right), above the room.
      const swMark = vr ? vr.switch && vr.switch.mark : seed.rooms[id].switch && seed.marks.switches[seed.rooms[id].switch];
      if (swMark && (swMark.glyphs || swMark.faded || swMark.link)) {
        const m = markBox(r.x - 20, r.y - 36, swMark.glyphs || (swMark.faded ? '' : '·'), swMark.faded, swMark.link, 'swmark');
        marks += m.svg;
        if (swMark.link) ends[swMark.link] = Object.assign(ends[swMark.link] || {}, { sw: m, flipped: vr && vr.switch.flipped });
      }
      const tMark = vr ? vr.mark : seed.marks.rooms[id];
      if (tMark && (tMark.glyphs || tMark.faded)) {
        const m = markBox(r.x + 20, r.y - 36, tMark.glyphs, tMark.faded, tMark.link, tMark.faded && !tMark.glyphs ? 'gone' : '');
        marks += m.svg;
        if (tMark.link) ends[tMark.link] = Object.assign(ends[tMark.link] || {}, { trap: m });
      }
      // A runner mark, scratched: below the room, dashed amber.
      if (vr && vr.scratch) {
        const g = vr.scratch.glyph;
        marks += `<g class="scratch"><rect x="${r.x - 46}" y="${r.y + 52}" width="38" height="20" rx="3"/><text x="${r.x - 41}" y="${r.y + 62}">${esc(vr.scratch.target)}</text>`
          + (isGlyph(g) ? glyphSVG(g, r.x - 30, r.y + 55, 14, '') : `<text x="${r.x - 30}" y="${r.y + 62}">${esc(g)}</text>`) + '</g>';
      }
    }
    let wires = '';
    for (const [link, e] of Object.entries(ends)) {
      if (!e.sw || !e.trap) continue;
      const mx = (e.sw.cx + e.trap.cx) / 2, my = Math.min(e.sw.cy, e.trap.cy) - 40;
      wires += `<path class="wire l${link}${e.flipped ? ' done' : ''}" d="M${e.sw.cx},${e.sw.cy - 11} Q${mx},${my} ${e.trap.cx},${e.trap.cy - 11}"/>`;
    }
    return `<svg class="map-svg" viewBox="-40 -70 870 470" role="img" aria-label="Map of ${esc(seed.name)}">${links}${top}${wires}${nodes}${marks}</svg>`;
  }

  // Show switches / Show glyphs: checkboxes in box that toggle those map layers on wrap. Remembered per browser.
  function layerToggles(box, wrap) {
    const on = (k) => store.get(`trap-relay-show-${k}`) !== '0';
    const apply = () => { wrap.classList.toggle('hide-switches', !on('switches')); wrap.classList.toggle('hide-glyphs', !on('glyphs')); };
    box.innerHTML = [['switches', 'Show switches'], ['glyphs', 'Show glyphs']]
      .map(([k, l]) => `<label><input type="checkbox" data-layer="${k}" ${on(k) ? 'checked' : ''}>${l}</label>`).join('');
    for (const c of box.querySelectorAll('[data-layer]')) c.onchange = () => { store.set(`trap-relay-show-${c.dataset.layer}`, c.checked ? '1' : '0'); apply(); };
    apply();
  }

  // A mark in words, for the room panel: what the runner can read of it.
  function markWords(mk, view) {
    if (!mk) return '';
    if (mk.faded && !mk.glyphs) return `${mk.faded}, faded: the seed's trap here is gone`;
    const known = (g) => (view.glyphs[g] ? ` (${view.glyphs[g]})` : '');
    const parts = Array.from(mk.glyphs || '').map((g) => `${g}${known(g)}`);
    return `${parts.join(' ') || 'no glyphs'}${mk.faded ? `; stroke ${mk.faded} faded` : ''}${mk.link ? '; wired' : ''}`;
  }

  // ---------- small motion pieces ----------

  // The turn clock: a ring filled to turn / turn cap, with a tick per turn and a slow sweeping hand.
  function turnClock(turn, cap, size) {
    size = size || 56;
    const c = size / 2, r = c - 4, circ = 2 * Math.PI * r;
    const ticks = Array.from({ length: cap }, (_, i) => `<line x1="${c}" y1="5" x2="${c}" y2="8" stroke="rgba(242,237,227,.35)" stroke-width="1" transform="rotate(${(i * 360) / cap} ${c} ${c})"/>`).join('');
    const danger = turn / cap > 0.75;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-label="Turn ${turn} of ${cap}">
      <circle cx="${c}" cy="${c}" r="${c - 1}" fill="rgba(0,0,0,.5)" stroke="rgba(255,255,255,.25)"/>
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${danger ? 'var(--amber)' : 'var(--teal)'}" stroke-width="2" stroke-dasharray="${((circ * turn) / cap).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${c} ${c})"/>
      ${ticks}
      <g style="transform-origin:${c}px ${c}px;animation:tt-spin ${cap}s linear infinite"><line x1="${c}" y1="${c}" x2="${c}" y2="9" stroke="#f2ede3" stroke-width="1.5" stroke-linecap="round"/></g>
      <circle cx="${c}" cy="${c}" r="2" fill="#f2ede3"/></svg>`;
  }

  // Drifting dust over a scene.
  function dust(n) {
    return Array.from({ length: n || 14 }, (_, i) => `<span style="position:absolute;left:${(i * 73) % 96 + 2}%;top:${(i * 137) % 80 + 8}%;width:${i % 3 ? 2 : 3}px;height:${i % 3 ? 2 : 3}px;border-radius:50%;background:rgba(242,237,227,.55);animation:tt-drift ${9 + (i % 5) * 2}s linear ${-i * 1.3}s infinite, tt-flicker ${2 + (i % 3)}s ease-in-out infinite"></span>`).join('');
  }

  // Count a number up from 0 to target over ms, calling set(value) each frame (halves, like scores).
  function countUp(target, ms, set) {
    // A hidden tab never gets animation frames, and reduced motion asks for none: show the final value at once.
    if (document.hidden || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) { set(target); return; }
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - p, 3);
      set(Math.round(target * e * 2) / 2);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  root.Console = { Sim, esc, $, store, api, loadSeed, glyphify, fac, facIcon, facEmblem, ART, STRATEGIES, startView, plan, path, mapSVG, layerToggles, markWords, turnClock, dust, countUp };
})(typeof globalThis !== 'undefined' ? globalThis : this);
