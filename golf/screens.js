// Relay Golf, stage 2: the screens around a round (designs 1a, 9, 10, 11 in design/golf/): home, the round result,
// the chain and its boards, and how to play. Plain HTML; the round itself plays in app.html.
//   home.html                          home (today's course)
//   home.html?view=result&course=N     the last round's card on course N
//   home.html?view=chain&course=N      the chain and boards (tabs: chain, scores, credit)
//   home.html?view=howto               how to play
(function () {
  'use strict';
  const G = window.RelayGolf, C = window.RelayChain;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const KIND_COL = { harm: '#E8604C', boon: '#4C9BE8', bluff: '#A66BD9', either: '#6F7F8C' };
  const qs = new URLSearchParams(location.search), view = qs.get('view') || 'home';
  const phone = $('phone');
  const playUrl = (n, extra = '') => `app.html?course=${n}&hole=1${extra}`;

  // A small picture of a hole from its grid: the tiles around the hole's own extent, in the game's colours.
  const TILE_COL = { K: '#4F9A4B', R: '#6DBB5B', F: '#93D66C', G: '#ABE683', S: '#F3D78E', W: '#5BB8E8', T: '#2F7D3C', P: '#2F7D3C', M: '#6DBB5B' };
  function drawThumb(canvas, hole, feats) {
    const L = G.layoutOf(hole, feats), xs = [hole.tee[0], hole.cup[0]], ys = [hole.tee[1], hole.cup[1]];
    for (let y = 0; y < G.H; y++) for (let x = 0; x < G.W; x++) if ('FGS'.includes(L.grid[y][x])) { xs.push(x); ys.push(y); }
    const x0 = Math.max(0, Math.min(...xs) - 2), x1 = Math.min(G.W - 1, Math.max(...xs) + 2), y0 = Math.max(0, Math.min(...ys) - 2), y1 = Math.min(G.H - 1, Math.max(...ys) + 2);
    const w = canvas.clientWidth || 100, h = canvas.clientHeight || 96, dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const g = canvas.getContext('2d'); g.scale(dpr, dpr);
    const s = Math.min(w / (x1 - x0 + 1), h / (y1 - y0 + 1)), ox = (w - s * (x1 - x0 + 1)) / 2, oy = (h - s * (y1 - y0 + 1)) / 2;
    g.fillStyle = TILE_COL.K; g.fillRect(0, 0, w, h);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const t = L.grid[y][x]; if (t === 'K') continue; g.fillStyle = TILE_COL[t] || TILE_COL.R; const r = t === 'T' || t === 'P' ? s * 0.42 : 0; if (r) { g.fillStyle = TILE_COL.R; g.fillRect(ox + (x - x0) * s, oy + (y - y0) * s, s + 0.5, s + 0.5); g.fillStyle = TILE_COL.T; g.beginPath(); g.arc(ox + (x - x0 + 0.5) * s, oy + (y - y0 + 0.5) * s, r, 0, 7); g.fill(); } else g.fillRect(ox + (x - x0) * s, oy + (y - y0) * s, s + 0.5, s + 0.5); }
    const cx = ox + (hole.cup[0] - x0 + 0.5) * s, cy = oy + (hole.cup[1] - y0 + 0.5) * s;
    g.fillStyle = '#1E2A24'; g.beginPath(); g.arc(cx, cy, Math.max(1.5, s * 0.3), 0, 7); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, cy - s * 1.6); g.stroke();
    g.fillStyle = '#E8604C'; g.fillRect(cx, cy - s * 1.6, s * 0.9, s * 0.55);
    g.fillStyle = '#fff'; g.beginPath(); g.arc(ox + (hole.tee[0] - x0 + 0.5) * s, oy + (hole.tee[1] - y0 + 0.5) * s, Math.max(1.5, s * 0.3), 0, 7); g.fill();
  }
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
  function devBar() {
    if (!C.isDev) return '';
    const shown = new Date(C.clockNow()).toISOString().slice(0, 16).replace('T', ' ');
    return `<div class="dev">DEV · day ${C.today()} · ${shown} UTC <button id="nextday">Next day</button><button id="realtime" ${C.devOffset() ? '' : 'disabled'}>Real time</button></div>`;
  }
  function wireDev() {
    if ($('nextday')) $('nextday').onclick = () => { C.nextDay(); location.reload(); };
    if ($('realtime')) $('realtime').onclick = () => { C.realTime(); location.reload(); };
  }

  // ---------- home ----------
  function home() {
    const n = C.today(), id = C.courseId(n), course = G.getCourse(id), c = C.loadChain(id), name = C.getName();
    const pars = course.holes.map((h, i) => G.parOf(G.layoutOf(h, G.featuresOn(c.features, i))));
    const inProgress = C.loadRound(id);
    const b = C.boards(c), last = c.golfers[c.golfers.length - 1];
    const prevId = C.courseId(n - 1), prev = n > 1 ? C.loadChain(prevId) : null;
    phone.innerHTML = `
      <div class="row between"><div><div class="muted">${greeting()}</div><div class="h2" id="whoami">${esc(name || 'New golfer')}</div></div><button class="avatar" id="avatar" title="Change name">${esc((name || '?').slice(0, 1).toUpperCase())}</button></div>
      <div id="namebox" style="display:${name ? 'none' : 'block'}"><input class="name" id="name" placeholder="Your name on the chain" value="${esc(name)}"></div>
      <div class="card">
        <div class="row between"><span class="label">Today · course ${n}</span><span class="chip">Par ${pars.reduce((a, x) => a + x, 0)}</span></div>
        <div class="title" style="margin-top:6px">${esc(C.courseName(id))}</div>
        <div class="thumbs">${course.holes.map((h, i) => `<div><canvas data-thumb="${i}"></canvas><div class="muted">Hole ${i + 1} · Par ${pars[i]}</div></div>`).join('')}</div>
        <div class="muted" style="margin-top:10px"><span class="dot"></span>Resets in ${C.fmtIn(C.resetIn())} · ${c.golfers.length} golfer${c.golfers.length === 1 ? '' : 's'} on the chain</div>
        <a class="primary" id="play" href="${playUrl(n)}">${inProgress ? `Carry on · hole ${Math.min(3, inProgress.round.hole + 1)}` : "Play today's course"}</a>
      </div>
      <div class="grid2">
        <a class="card" style="text-decoration:none;color:inherit" href="home.html?view=chain&course=${n}"><div class="label">Chain</div><div class="h2" style="font-size:17px;margin-top:4px">You're golfer ${c.golfers.length + 1}</div><div class="muted" style="font-size:13px;margin-top:4px">${last ? `${esc(last.name)} left ${esc(last.left)}` : 'Nobody yet: you set the course for the rest.'}</div></a>
        <a class="card" style="text-decoration:none;color:inherit" href="home.html?view=chain&course=${n}&tab=scores"><div class="label">Boards</div><div class="h2" style="font-size:17px;margin-top:4px">${b.leader ? `${esc(b.leader.name)} leads, ${C.fmtVs(b.leader.total - b.leader.par)}` : 'No leader yet'}</div><div class="muted" style="font-size:13px;margin-top:4px">${b.saboteur ? `Top saboteur: ${esc(b.saboteur.name)}` : b.benefactor ? `Top benefactor: ${esc(b.benefactor.name)}` : 'Credit counts until the reset'}</div></a>
      </div>
      ${prev ? `<a class="card row" style="text-decoration:none;color:inherit;background:#EFEBE2;box-shadow:none" href="${playUrl(n - 1, '&practice=1')}"><canvas data-prev="1" style="width:56px;height:56px;border-radius:12px;flex:none"></canvas><div style="flex:1"><div class="label">Practice · closed yesterday</div><div class="h2" style="font-size:17px">Course ${n - 1} · ${esc(C.courseName(prevId))}</div><div class="muted" style="font-size:13px">Every hidden thing revealed · not saved</div></div><span class="h2">›</span></a>` : ''}
      <a class="secondary" href="home.html?view=howto">How to play</a>
      ${devBar()}`;
    for (const cv of phone.querySelectorAll('[data-thumb]')) { const i = Number(cv.dataset.thumb); drawThumb(cv, course.holes[i], G.featuresOn(c.features, i)); }
    const pc = phone.querySelector('[data-prev]'); if (pc) drawThumb(pc, G.getCourse(prevId).holes[0], G.featuresOn(prev.features, 0));
    $('avatar').onclick = () => { $('namebox').style.display = 'block'; $('name').focus(); };
    $('name').oninput = () => { C.setName($('name').value.trim()); $('whoami').textContent = $('name').value.trim() || 'New golfer'; $('avatar').textContent = ($('name').value.trim() || '?').slice(0, 1).toUpperCase(); };
    $('play').onclick = (e) => { if (!C.getName()) { e.preventDefault(); $('namebox').style.display = 'block'; $('name').focus(); $('name').placeholder = 'Your name first, for the chain'; } };
    wireDev();
  }

  // ---------- the round result ----------
  function result() {
    const n = Number(qs.get('course')) || C.today(), id = C.courseId(n), r = C.lastResult(id), c = C.loadChain(id);
    if (!r) { phone.innerHTML = `<a class="back" href="home.html">‹ Home</a><div class="card">No round on this course yet.</div>`; return; }
    const vs = r.total - r.par, mine = c.features.filter((f) => f.owner === r.name);
    const harm = mine.reduce((a, f) => a + (f.harm || 0), 0), aid = mine.reduce((a, f) => a + (f.aid || 0), 0);
    const pickOn = (h) => r.picks.find((f) => f.hole === h);
    phone.innerHTML = `<a class="back" href="home.html">‹ Home</a>
      <div class="label" style="margin-top:14px">Course ${n} · ${esc(C.courseName(id))}${r.practice ? ' · practice' : ''}</div>
      <div class="row between" style="margin-top:6px"><div class="title">Your card</div><div style="text-align:right"><div class="big">${C.fmtVs(vs)}</div><div class="muted" style="font-size:12px">on the course you faced</div></div></div>
      <div class="card"><table><tr><th>Hole</th><th class="num">Par</th><th class="num">Strokes</th><th>Feature paid</th></tr>
        ${r.strokes.map((s, h) => { const p = pickOn(h); return `<tr><td>Hole ${h + 1}</td><td class="num">${r.pars[h]}</td><td class="num"><b>${s}</b> <span class="muted">${C.fmtVs(s - r.pars[h])}</span></td><td>${p ? `<span class="tag-dot" style="background:${KIND_COL[G.FEATURES[p.kind].kind]}"></span>${esc(G.FEATURES[p.kind].label)} · ${G.costOf(p)}` : '<span class="muted">Nothing left</span>'}</td></tr>`; }).join('')}
        <tr><td><b>Total</b></td><td class="num"><b>${r.par}</b></td><td class="num"><b>${r.total - r.cost}</b></td><td>Features · ${r.cost} stroke${r.cost === 1 ? '' : 's'}</td></tr></table></div>
      ${r.met.filter((q) => q.owner !== 'seed').length ? `<div class="card"><div class="label">What earlier golfers' features did to you</div>${r.met.filter((q) => q.owner !== 'seed').map((q) => `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line)"><span><span class="tag-dot" style="background:${KIND_COL[G.FEATURES[q.kind].kind]}"></span>${esc(q.owner)}'s ${esc(q.label.toLowerCase())} · hole ${q.hole + 1}</span><span class="muted">${q.harm ? `cost you ${q.harm}` : q.aid ? `saved you ${q.aid}` : 'no difference'}</span></div>`).join('')}</div>` : ''}
      ${r.practice ? '<div class="card muted">A practice round on a closed day: nothing was saved to the chain.</div>' : `<div class="card"><div class="label">Credit · from golfers after you</div>
        <div class="grid2" style="margin-top:4px"><div class="tile" style="background:rgba(232,96,76,.1)"><div class="label" style="color:#C24A37">Harm</div><div class="v">+${harm}</div><div class="muted" style="font-size:12px">strokes your harms cost later golfers beyond the best line</div></div><div class="tile" style="background:rgba(76,155,232,.1)"><div class="label" style="color:#2F79C2">Aid</div><div class="v">+${aid}</div><div class="muted" style="font-size:12px">strokes your boons saved them</div></div></div>
        <div class="muted" style="margin-top:8px;font-size:13px">Credit keeps counting until the daily reset in ${C.fmtIn(C.resetIn())}.</div></div>`}
      <button class="primary" id="share">Share card</button>
      <a class="secondary" href="home.html?view=chain&course=${n}">See the chain</a>
      <a class="secondary" href="home.html">Hand over to the next golfer</a>`;
    $('share').onclick = () => {
      const text = `Relay Golf · course ${n} ${C.courseName(id)}: ${r.total} (${C.fmtVs(vs)}) · ${r.strokes.map((s, h) => `${s}/${r.pars[h]}`).join(' ')}${r.cost ? ` · features ${r.cost}` : ''}`;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => { $('share').textContent = 'Copied to the clipboard'; }, () => { $('share').textContent = text; });
    };
  }

  // ---------- the chain and boards ----------
  function chain() {
    const n = Number(qs.get('course')) || C.today(), id = C.courseId(n), c = C.loadChain(id), b = C.boards(c);
    let tab = qs.get('tab') || 'chain';
    const name = C.getName();
    const render = () => {
      const rows = tab === 'scores' ? c.golfers.map((g, i) => ({ g, i })).sort((a, z) => a.g.total - a.g.par - (z.g.total - z.g.par) || a.i - z.i) : c.golfers.map((g, i) => ({ g, i }));
      const credit = Object.entries(c.credit || {}).sort((a, z) => z[1].harm + z[1].aid - a[1].harm - a[1].aid);
      const dots = (g) => (g.picks || []).map((p) => `<span class="tag-dot" style="background:${KIND_COL[G.FEATURES[p.kind].kind]}" title="${esc(G.FEATURES[p.kind].label)} on hole ${p.hole + 1}"></span>`).join('') || '<span class="muted">–</span>';
      phone.innerHTML = `<a class="back" href="home.html">‹ Home</a>
        <div class="label" style="margin-top:14px">Course ${n} · ${esc(C.courseName(id))}</div>
        <div class="title">Today's chain</div>
        <div class="tiles3">
          <div class="tile" style="background:var(--ink);color:#fff"><div class="label" style="color:#cfd6d1">Leader</div><div class="v">${b.leader ? esc(b.leader.name) : '–'}</div><div style="font:800 15px 'Baloo 2';color:var(--marigold)">${b.leader ? C.fmtVs(b.leader.total - b.leader.par) : ''}</div></div>
          <div class="tile" style="background:rgba(232,96,76,.12)"><div class="label" style="color:#C24A37">Top saboteur</div><div class="v">${b.saboteur ? esc(b.saboteur.name) : '–'}</div><div class="muted" style="font-size:12px">${b.saboteur ? `Harm +${b.saboteur.value}` : ''}</div></div>
          <div class="tile" style="background:rgba(76,155,232,.12)"><div class="label" style="color:#2F79C2">Top benefactor</div><div class="v">${b.benefactor ? esc(b.benefactor.name) : '–'}</div><div class="muted" style="font-size:12px">${b.benefactor ? `Aid +${b.benefactor.value}` : ''}</div></div>
        </div>
        <div class="tabs">${[['chain', 'Chain'], ['scores', 'Scores'], ['credit', 'Credit']].map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
        <div class="card">${tab === 'credit'
          ? (credit.length ? `<table><tr><th>Golfer</th><th class="num">Harm</th><th class="num">Aid</th></tr>${credit.map(([o, v]) => `<tr><td>${esc(o)}${o === name ? ' · you' : ''}</td><td class="num">+${v.harm}</td><td class="num">+${v.aid}</td></tr>`).join('')}</table>` : '<div class="muted">No credit yet: it comes when later golfers meet your features.</div>')
          : (rows.length ? `<table><tr><th>#</th><th>Golfer</th><th>Features left</th><th class="num">Score</th></tr>${rows.map(({ g, i }) => `<tr><td class="muted">${i + 1}</td><td><b>${esc(g.name)}</b>${g.name === name ? ' · you' : ''}</td><td>${dots(g)}</td><td class="num"><b>${C.fmtVs(g.total - g.par)}</b></td></tr>`).join('')}</table>` : '<div class="muted">Nobody on the chain yet.</div>')}</div>
        <div class="row muted" style="margin-top:12px;font-size:12px;gap:12px"><span><span class="tag-dot" style="background:${KIND_COL.harm}"></span>Harm</span><span><span class="tag-dot" style="background:${KIND_COL.boon}"></span>Boon</span><span><span class="tag-dot" style="background:${KIND_COL.bluff}"></span>Bluff</span><span><span class="tag-dot" style="background:${KIND_COL.either}"></span>Either</span><span style="flex:1;text-align:right">${c.golfers.length} golfer${c.golfers.length === 1 ? '' : 's'} · resets in ${C.fmtIn(C.resetIn())}</span></div>
        ${c.features.length ? `<div class="card"><div class="label">On the course now</div>${c.features.map((f) => `<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line)"><span><span class="tag-dot" style="background:${KIND_COL[G.FEATURES[f.kind].kind]}"></span>${esc(f.owner)}'s ${esc(C.featName(f).toLowerCase())} · hole ${f.hole + 1}</span><span class="muted" style="font-size:12px">${C.LIFETIME - (f.age || 0)} golfer${C.LIFETIME - (f.age || 0) === 1 ? '' : 's'} left</span></div>`).join('')}</div>` : ''}`;
      for (const el of phone.querySelectorAll('[data-tab]')) el.onclick = () => { tab = el.dataset.tab; render(); };
    };
    render();
  }

  // ---------- how to play ----------
  function howto() {
    const ill = {
      shot: `<svg viewBox="0 0 92 92"><rect width="92" height="92" fill="#93D66C"/><rect x="30" y="0" width="34" height="92" fill="#ABE683"/><circle cx="46" cy="80" r="5" fill="#fff" stroke="#1E2A24" stroke-width="1.5"/>${[[22, 30], [46, 22], [70, 32]].map(([x, y], i) => `<line x1="46" y1="80" x2="${x}" y2="${y}" stroke="${i === 1 ? '#F2B52E' : '#fff'}" stroke-width="${i === 1 ? 3 : 1.5}"/><circle cx="${x}" cy="${y}" r="${i === 1 ? 6 : 4.5}" fill="none" stroke="${i === 1 ? '#F2B52E' : '#fff'}" stroke-width="2"/>`).join('')}<line x1="46" y1="22" x2="30" y2="6" stroke="#fff" stroke-dasharray="3 3"/><line x1="46" y1="22" x2="60" y2="6" stroke="#fff" stroke-dasharray="3 3"/></svg>`,
      swing: `<svg viewBox="0 0 92 92"><rect width="92" height="92" fill="#F7F4EC"/><rect x="8" y="38" width="76" height="16" rx="8" fill="#E8604C"/><rect x="23" y="38" width="46" height="16" fill="#F2B52E"/><rect x="38" y="38" width="16" height="16" fill="#3FBF6F"/><rect x="44" y="32" width="4" height="28" rx="2" fill="#1E2A24"/><text x="12" y="76" font-size="10" font-family="Nunito" font-weight="800" fill="#6B7A72">early</text><text x="58" y="76" font-size="10" font-family="Nunito" font-weight="800" fill="#6B7A72">late</text></svg>`,
      short: `<svg viewBox="0 0 92 92"><rect width="92" height="92" fill="#ABE683"/><path d="M0 60 Q46 40 92 64" fill="none" stroke="#fff" stroke-opacity=".5"/><circle cx="20" cy="76" r="5" fill="#fff" stroke="#1E2A24" stroke-width="1.5"/><line x1="20" y1="76" x2="74" y2="20" stroke="#F2B52E" stroke-width="3"/><path d="M20 76 Q46 46 64 22" fill="none" stroke="#fff" stroke-width="2.5" stroke-dasharray="4 3"/><circle cx="64" cy="22" r="4" fill="#1E2A24"/><line x1="64" y1="22" x2="64" y2="6" stroke="#fff" stroke-width="1.5"/><rect x="64" y="6" width="10" height="6" fill="#E8604C"/></svg>`,
      shape: `<svg viewBox="0 0 92 92"><rect width="92" height="92" fill="#93D66C"/>${[[10, '#E8604C'], [34, '#4C9BE8'], [58, '#A66BD9']].map(([x, c]) => `<rect x="${x}" y="30" width="22" height="32" rx="6" fill="#fff"/><rect x="${x + 5}" y="35" width="12" height="12" rx="3" fill="${c}"/>`).join('')}<rect x="10" y="68" width="70" height="8" rx="4" fill="#F2B52E" opacity=".6"/></svg>`,
    };
    const lessons = [
      ['shot', '1 · The shot', 'Pick a club, tap a landing spot', 'Each club shows where it can land. Dashed lines show the shots you could play next from there. Draw or fade bends a full shot round trouble.'],
      ['swing', '2 · The swing', 'Tap in the green', 'Early pulls left, late pushes right, and a bad miss comes up short. Small crosses show where a miss would land.'],
      ['short', '3 · The short game', 'Aim, then set the pace', 'Gold is where you aim. White is where the ball really rolls on the slope; arrows and the height map show the break. Softer and Firmer set the pace; the stroke meter sets how well you hit it.'],
      ['shape', '4 · Leave a feature', 'Shape each hole for the next golfer', 'After each hole you may leave one feature, paid for in strokes on your card. Harms cost later golfers strokes; boons save them. You earn credit when they do, beyond what the best line also loses or gains.'],
    ];
    phone.innerHTML = `<div class="row between"><div class="title">How to play</div><a class="back" href="home.html">Done</a></div>
      <div class="muted" style="margin-top:6px">Everyone plays the same three holes each day. Your score is strokes against par on the course you faced, so a feature left before you never ruins your day.</div>
      ${lessons.map(([k, n, t, d]) => `<div class="card lesson">${ill[k]}<div><div class="label">${n}</div><div class="h2" style="font-size:18px">${t}</div><div class="muted" style="font-size:13px;margin-top:4px">${d}</div></div></div>`).join('')}
      <div class="card"><div class="label">Hidden things</div><div class="muted" style="font-size:13px;margin-top:4px">A "?" marks a suspicious hill (it hides the ground behind it, under mist) or a ramp (its direction is hidden). Tap one to see what it is, and scout it for a stroke, or get close and see for free.</div></div>
      <a class="primary" href="home.html">Got it</a>`;
  }

  ({ home, result, chain, howto }[view] || home)();
})();
