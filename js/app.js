// Flip Point: shows how fast you need to throw each disc in your TechDisc bag
// to hold hyzer, flip up to flat, or flip over, and grades live throws against it.
(() => {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'discElo.token';       // shared with Disc Elo, so one token works for both
  const STATE_KEY = 'flipPoint.state';
  const MAX_LOG = 60;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const round1 = (x) => Math.round(x * 10) / 10;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // Discs to try the app with before connecting.
  const DEMO_BAG = [
    { id: 'd-putt', name: 'Demo putter',         fn: { speed: 2, glide: 3, turn: 0, fade: 1 } },
    { id: 'd-mid',  name: 'Demo straight mid',   fn: { speed: 5, glide: 4, turn: -1, fade: 1 } },
    { id: 'd-umid', name: 'Demo understable mid', fn: { speed: 5, glide: 5, turn: -3, fade: 0 } },
    { id: 'd-omid', name: 'Demo overstable mid', fn: { speed: 5, glide: 3, turn: 0, fade: 3 } },
    { id: 'd-fair', name: 'Demo fairway',        fn: { speed: 7, glide: 5, turn: -1, fade: 2 } },
    { id: 'd-ufw',  name: 'Demo turnover fairway', fn: { speed: 9, glide: 5, turn: -3, fade: 1 } },
    { id: 'd-ofw',  name: 'Demo utility',        fn: { speed: 9, glide: 3, turn: 0, fade: 4 } },
    { id: 'd-dr',   name: 'Demo distance driver', fn: { speed: 12, glide: 5, turn: -1, fade: 3 } },
  ];

  // ---------- state ----------
  const defaults = () => ({
    style: 'RHBH', hyzer: 15, goal: 'any', discId: null,
    streak: 0, best: 0, log: [], speeds: [],
    calib: { spinPerMph: 20, spinSign: 1, measured: false },
  });
  let state;
  try { state = { ...defaults(), ...JSON.parse(localStorage.getItem(STATE_KEY)) }; } catch { state = defaults(); }
  const save = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* storage off */ } };
  const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
  const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage off */ } };

  let connected = false;     // token checked and bag loaded
  let listening = false;
  let abortCtl = null;
  let bag = DEMO_BAG.slice();
  const progress = new Map(); // disc id -> partial profile while mapping
  const errors = new Map();   // disc id -> error message
  let lastShot = null;        // { speed, tilt pts, zone, shot }
  let anim = null;

  const ctx = () => ({
    token: getToken(), demo: !connected, style: state.style, hyzer: state.hyzer,
    spinPerMph: state.calib.spinPerMph, spinSign: state.calib.spinSign,
  });
  const currentDisc = () => bag.find((d) => d.id === state.discId) || bag[0] || null;
  const profileOf = (d) => (d ? Flip.cached(d.fn, ctx()) : null);
  const liveProfileOf = (d) => profileOf(d) || progress.get(d?.id) || null;

  function setStatus(text, kind = '') {
    $('statusText').textContent = text;
    $('status').className = `status ${kind}`;
  }

  // ---------- disc helpers ----------
  const discLabel = (d) => d.name || [d.manufacturer, d.mold].filter(Boolean).join(' ') || 'Disc';
  const fmtFn = (fn) => (fn ? [fn.speed, fn.glide, fn.turn, fn.fade].map((x) => x ?? '?').join(' / ') : '');
  function stability(fn) {
    const s = (fn?.turn ?? 0) + (fn?.fade ?? 0);
    return s <= -1 ? ['under', 'Understable'] : s >= 2 ? ['over', 'Overstable'] : ['neutral', 'Stable'];
  }

  function fromApiDiscs(list) {
    return (list || []).filter((d) => d.flightNumbers).map((d) => ({ id: d.id, name: discLabel(d), fn: d.flightNumbers }));
  }

  // The disc a throw was made with, adding it to the list if it isn't in the bag.
  function discForShot(shot) {
    const byId = bag.find((d) => d.id === shot.discPresetId);
    if (byId) return byId;
    if (shot.flightNumbers) {
      const same = bag.find((d) => fmtFn(d.fn) === fmtFn(shot.flightNumbers));
      if (same) return same;
      const d = { id: `shot-${fmtFn(shot.flightNumbers)}`, name: `Recorded disc ${fmtFn(shot.flightNumbers)}`, fn: shot.flightNumbers };
      bag.push(d);
      return d;
    }
    return currentDisc();
  }

  // ---------- your speed ----------
  function speedStats() {
    const s = state.speeds.slice(-20).filter(Number.isFinite).sort((a, b) => a - b);
    if (s.length < 2) return null;
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
    return { lo: q(0.25), mid: q(0.5), hi: q(0.75), n: s.length };
  }

  // Spin per mph from your own throws keeps the reference sims honest to your release.
  function learnSpin(shot) {
    if (!(shot?.speedMph > 15) || !Number.isFinite(shot.spinRpm) || shot.spinRpm === 0) return;
    const ratio = Math.abs(shot.spinRpm) / shot.speedMph;
    if (ratio < 8 || ratio > 45) return;
    const c = state.calib;
    c.samples = [...(c.samples || []), ratio].slice(-15);
    const sorted = [...c.samples].sort((a, b) => a - b);
    // Rounded to 2 rpm/mph so saved flip points stay valid as you throw.
    c.spinPerMph = Math.round(sorted[Math.floor(sorted.length / 2)] / 2) * 2;
    c.spinSign = Math.sign(shot.spinRpm);
    c.measured = true;
    save();
  }

  // ---------- mapping ----------
  function mapDisc(d, { hi = false } = {}) {
    if (!d || profileOf(d) || Flip.mapping(d.fn, ctx())) return Flip.mapping(d?.fn, ctx())?.promise || Promise.resolve(profileOf(d));
    errors.delete(d.id);
    progress.set(d.id, { partial: true, done: 0, total: Flip.SPEEDS.length, points: [] });
    renderBag();
    const p = Flip.map(d.fn, ctx(), (partial) => { progress.set(d.id, partial); renderBag(); if (d === currentDisc()) renderGauge(); }, { hi })
      .then((prof) => { progress.delete(d.id); renderAll(); return prof; })
      .catch((e) => {
        progress.delete(d.id);
        if (!e.cancelled) {
          errors.set(d.id, e.message);
          if (e.status === 401) setStatus('Token rejected (401). Get a new play token.', 'err');
        }
        renderAll();
        return null;
      });
    return p;
  }

  function mapBag() {
    const todo = bag.filter((d) => !profileOf(d));
    if (!todo.length) return;
    if (connected) {
      const calls = todo.length * Flip.SPEEDS.length;
      const left = Flip.HOUR_CAP - Flip.callsThisHour();
      if (!confirm(`Map ${todo.length} disc${todo.length > 1 ? 's' : ''}? This uses up to ${calls} sims (about ${Math.ceil(calls * 1.2 / 60)} min). You have about ${left} left this hour.`)) return;
    }
    // Selected disc first.
    const cur = currentDisc();
    todo.sort((a, b) => (b === cur) - (a === cur));
    todo.forEach((d) => mapDisc(d));
  }

  // ---------- throws ----------
  async function handleThrow(shot, { demo = false } = {}) {
    const d = demo ? currentDisc() : discForShot(shot);
    if (!d) return;
    state.discId = d.id;
    const speed = shot.speedMph;
    if (Number.isFinite(speed)) state.speeds = [...state.speeds, round1(speed)].slice(-40);
    if (!demo) learnSpin(shot);
    save();
    fillDiscSelect();

    // Make sure the chart for this disc exists; live throws jump the queue.
    if (!profileOf(d)) mapDisc(d, { hi: true });

    lastShot = { speed, shot, pts: null, zone: null, disc: d, pending: true };
    renderAll();
    setNeedle(speed);
    showVerdictPending(d, speed);

    let pts = null;
    try {
      pts = await Flip.simulateThrow(shot, d.fn, { ...ctx(), demo: demo || !connected });
    } catch (e) {
      setStatus(`Sim failed: ${e.message}`, 'err');
    }
    const prof = profileOf(d);
    const predicted = prof ? Flip.zoneAt(prof, speed) : null;
    const zone = pts ? Flip.zoneOfTilt(Tilt.flattest(pts)) : predicted;
    lastShot = { speed, shot, pts, zone, predicted, disc: d, pending: false };

    const goal = state.goal;
    let hit = null;
    if (goal !== 'any' && zone) {
      hit = zone === goal;
      state.streak = hit ? state.streak + 1 : 0;
      state.best = Math.max(state.best, state.streak);
    }
    state.log = [{
      t: Date.now(), disc: discLabel(d), speed: round1(speed), hyzer: round1(shot.hyzerAngle ?? NaN),
      predicted, zone, goal, hit, demo,
    }, ...state.log].slice(0, MAX_LOG);
    save();

    renderAll();
    showVerdict();
    playTilt(pts);
    if (hit) celebrate(zone);
  }

  function demoThrow() {
    const d = currentDisc();
    const st = speedStats();
    const base = st ? st.mid : 48;
    const prof = profileOf(d);
    // Aim near the goal zone about half the time so the game is winnable.
    let speed = base + (Math.random() - 0.5) * 22;
    const band = state.goal !== 'any' && Flip.band(prof, state.goal);
    if (band && Math.random() < 0.55) speed = band[0] + Math.random() * (band[1] - band[0]);
    speed = round1(clamp(speed, 24, 80));
    const hyzerAngle = round1(state.hyzer + (Math.random() - 0.5) * 8);
    const shot = {
      speedMph: speed, spinRpm: Math.round(speed * state.calib.spinPerMph * (0.9 + Math.random() * 0.2)),
      hyzerAngle, noseAngle: round1((Math.random() - 0.5) * 6), launchAngle: round1(9 + Math.random() * 4), wobble: round1(Math.random() * 4),
    };
    return handleThrow(shot, { demo: true });
  }

  // ---------- connecting & listening ----------
  async function connect() {
    const t = $('token').value.trim().replace(/^Bearer\s+/i, '');
    if (t) setToken(t);
    if (!getToken()) { setStatus('Add your TechDisc token in Settings', 'err'); return; }
    setStatus('Connecting...');
    try {
      await TechDiscAPI.time(getToken());
      const discs = fromApiDiscs(await TechDiscAPI.discs(getToken()));
      connected = true;
      bag = discs.length ? discs : [];
      if (!bag.some((d) => d.id === state.discId)) state.discId = bag[0]?.id ?? null;
      try { learnSpin(await TechDiscAPI.latestThrow(getToken())); } catch { /* no throws yet */ }
      save();
      $('settings').close();
      setStatus(`Connected · ${bag.length} disc${bag.length === 1 ? '' : 's'}`, 'ok');
      renderAll();
      const cur = currentDisc();
      if (cur) mapDisc(cur, { hi: true });
      startListening();
    } catch (e) {
      connected = false;
      setStatus(e.status === 401 ? 'Token rejected (401). Get a new play token.' : `Could not connect: ${e.message}`, 'err');
    }
  }

  function useDemo() {
    stopListening('Demo mode');
    connected = false;
    setToken('');
    $('token').value = '';
    bag = DEMO_BAG.slice();
    if (!bag.some((d) => d.id === state.discId)) state.discId = bag[1].id;
    save();
    $('settings').close();
    renderAll();
    mapBag();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function startListening() {
    const token = getToken();
    if (!connected || !token || listening) return;
    listening = true;
    abortCtl = new AbortController();
    renderButtons();
    let cursor;
    const seen = new Set();
    try {
      const latest = await TechDiscAPI.latestThrow(token);
      if (latest?.id) { cursor = { id: latest.id }; seen.add(latest.id); }
      else cursor = { time: (await TechDiscAPI.time(token)).time };
    } catch (e) {
      return stopListening(e.status === 401 ? 'Token rejected (401). Get a new play token.' : e.message, 'err');
    }
    setStatus('Listening · throw a disc', 'live');
    while (listening) {
      try {
        const shot = await TechDiscAPI.waitForThrow(token, cursor, abortCtl.signal);
        if (!listening) break;
        if (shot?.id && !seen.has(shot.id)) {
          seen.add(shot.id);
          cursor = { id: shot.id };
          await handleThrow(shot);
          if (listening) setStatus('Listening · throw a disc', 'live');
        }
      } catch (e) {
        if (!listening || e.name === 'AbortError') break;
        if (e.status === 401) return stopListening('Token rejected (401). Get a new play token.', 'err');
        const waitS = e.retryAfter || (e.status === 429 ? 30 : 5);
        setStatus(`${e.message}. Retrying in ${waitS}s`, 'err');
        await sleep(waitS * 1000);
        if (listening) setStatus('Listening · throw a disc', 'live');
      }
    }
  }

  function stopListening(msg = 'Paused', kind = 'ok') {
    listening = false;
    abortCtl?.abort();
    renderButtons();
    setStatus(msg, kind);
  }

  async function scoreLatest() {
    try {
      const shot = await TechDiscAPI.latestThrow(getToken());
      if (!shot) return setStatus('No throws on this account yet', 'err');
      await handleThrow(shot);
    } catch (e) { setStatus(e.message, 'err'); }
  }

  // ---------- rendering ----------
  function renderAll() {
    renderButtons();
    renderDiscMeta();
    renderGoal();
    renderGauge();
    renderTargetNote();
    renderRelease();
    renderBag();
    renderLog();
    if (!lastShot) idleVerdict();
  }

  function renderButtons() {
    const lb = $('listenBtn');
    if (!connected) { lb.textContent = 'Connect TechDisc'; lb.classList.remove('stop'); }
    else { lb.textContent = listening ? 'Stop listening' : 'Start listening'; lb.classList.toggle('stop', listening); }
    $('throwBtn').textContent = connected ? 'Use latest throw' : 'Demo throw';
    const mapping = bag.some((d) => progress.has(d.id));
    $('stopMapBtn').classList.toggle('hidden', !mapping);
    $('mapBagBtn').disabled = mapping || !bag.some((d) => !profileOf(d));
    $('mapBagBtn').textContent = bag.every((d) => profileOf(d)) && bag.length ? 'Bag mapped' : 'Map whole bag';
  }

  function fillDiscSelect() {
    const sel = $('discSel');
    sel.innerHTML = bag.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('') || '<option value="">No discs with flight numbers</option>';
    const cur = currentDisc();
    if (cur) sel.value = cur.id;
  }

  function renderDiscMeta() {
    const d = currentDisc();
    if (!d) { $('discMeta').innerHTML = ''; return; }
    const [k, label] = stability(d.fn);
    $('discMeta').innerHTML = `<span class="fn" title="Speed / glide / turn / fade">${esc(fmtFn(d.fn))}</span><span class="stab ${k}">${label}</span>`;
  }

  function renderGoal() {
    document.querySelectorAll('[data-goal]').forEach((b) => b.classList.toggle('on', b.dataset.goal === state.goal));
    $('streak').innerHTML = state.goal === 'any' ? '' : `Streak <b>${state.streak}</b>${state.best ? ` · best ${state.best}` : ''}`;
  }

  // ---- gauge: a half dial from 20 mph (left) to 85 mph (right) ----
  const G = { cx: 200, cy: 196, r: 150 };
  const angOf = (v) => Math.PI * (1 - (clamp(v, Flip.MIN, Flip.MAX) - Flip.MIN) / (Flip.MAX - Flip.MIN));
  const pt = (a, r = G.r) => [G.cx + r * Math.cos(a), G.cy - r * Math.sin(a)];
  function arc(v0, v1, r = G.r) {
    const [x0, y0] = pt(angOf(v0), r), [x1, y1] = pt(angOf(v1), r);
    return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  function el(tag, attrs, parent, text) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    parent?.appendChild(n);
    return n;
  }

  function renderGauge() {
    const svg = $('gauge');
    const needleDeg = svg.dataset.needle || null;
    svg.innerHTML = '';
    el('path', { d: arc(Flip.MIN, Flip.MAX), class: 'g-track' }, svg);
    const d = currentDisc();
    const prof = liveProfileOf(d);
    if (prof && prof.flat != null && prof.points?.length >= 2) {
      for (const z of ['hyzer', 'flat', 'flip']) {
        const b = Flip.band(prof, z);
        if (!b) continue;
        // During mapping, only draw what the sweep has reached.
        const reach = prof.partial ? prof.points[prof.points.length - 1].v : Flip.MAX;
        const hi = Math.min(b[1], reach);
        if (hi <= b[0]) continue;
        const dim = state.goal !== 'any' && state.goal !== z;
        el('path', { d: arc(b[0], hi), class: `g-zone ${z}${dim ? ' dim' : ''}` }, svg);
      }
      for (const [k, v] of [['flat', prof.flat], ['flip', prof.flip]]) {
        if (!Number.isFinite(v)) continue;
        const a = angOf(v);
        const [x0, y0] = pt(a, G.r - 15), [x1, y1] = pt(a, G.r + 15), [lx, ly] = pt(a, G.r + 28);
        el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: 'g-mark' }, svg);
        el('text', { x: lx, y: ly + 4, class: `g-mlabel ${k}` }, svg, `${Math.round(v)}`);
      }
    }
    if (prof?.partial) el('text', { x: G.cx, y: G.cy - 92, class: 'g-pending' }, svg, `Mapping flip points ${prof.done}/${prof.total}`);
    else if (!prof && errors.has(d?.id)) el('text', { x: G.cx, y: G.cy - 92, class: 'g-pending' }, svg, 'Could not map this disc');
    else if (!prof && d) el('text', { x: G.cx, y: G.cy - 92, class: 'g-pending' }, svg, 'Not mapped yet');

    for (let v = 20; v <= 80; v += 10) {
      const a = angOf(v);
      const [x0, y0] = pt(a, G.r - 22), [x1, y1] = pt(a, G.r - 30), [tx, ty] = pt(a, G.r - 42);
      el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: 'g-tick' }, svg);
      el('text', { x: tx, y: ty + 4, class: 'g-num' }, svg, v);
    }
    // Your last few throws as dots just inside the dial.
    state.speeds.slice(-6, lastShot ? -1 : undefined).forEach((v) => {
      const [x, y] = pt(angOf(v), G.r - 19);
      el('circle', { cx: x, cy: y, r: 3, class: 'g-recent' }, svg);
    });
    const g = el('g', { class: 'g-needle', style: `transform-origin:${G.cx}px ${G.cy}px; transform: rotate(${needleDeg || -180}deg)` }, svg);
    el('line', { x1: G.cx, y1: G.cy, x2: G.cx + G.r - 8, y2: G.cy }, g);
    el('circle', { cx: G.cx, cy: G.cy, r: 8 }, g);
    if (lastShot && Number.isFinite(lastShot.speed)) $('speed').textContent = Math.round(lastShot.speed);
  }

  function setNeedle(v) {
    const svg = $('gauge');
    const deg = Number.isFinite(v) ? -(angOf(v) * 180 / Math.PI) : -180;
    svg.dataset.needle = deg;
    const g = svg.querySelector('.g-needle');
    if (!g) return;
    // Start from the left stop so the needle swings up to the speed.
    g.style.transition = 'none';
    g.style.transform = 'rotate(-180deg)';
    void g.getBoundingClientRect();
    g.style.transition = '';
    g.style.transform = `rotate(${deg}deg)`;
    countUp($('speed'), v);
  }

  function countUp(node, to) {
    if (!Number.isFinite(to)) { node.textContent = '--'; return; }
    if (reducedMotion()) { node.textContent = Math.round(to); return; }
    const t0 = performance.now(), dur = 800;
    const step = (now) => {
      const f = Math.min((now - t0) / dur, 1);
      node.textContent = Math.round(to * (1 - (1 - f) ** 3));
      if (f < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderTargetNote() {
    const d = currentDisc();
    const prof = profileOf(d);
    const note = $('targetNote');
    if (!d) { note.innerHTML = connected ? 'No discs with flight numbers in your TechDisc bag.' : ''; return; }
    if (!prof) { note.innerHTML = progress.has(d.id) ? 'Running the speed sweep through the simulator...' : ''; return; }
    const ref = `from a ${state.hyzer}° hyzer`;
    if (state.goal === 'any') {
      note.innerHTML = `Flips to flat at <b>${Flip.fmtMph(prof.flat)} mph</b> · flips over at <b>${Flip.fmtMph(prof.flip)} mph</b> <span class="fine">(${ref})</span>`;
      return;
    }
    const b = Flip.band(prof, state.goal);
    const aim = { hyzer: 'hold hyzer', flat: 'flip to flat', flip: 'flip over' }[state.goal];
    note.innerHTML = b
      ? `To ${aim}: throw <b>${Math.round(b[0])}–${Math.round(b[1])} mph</b> <span class="fine">(${ref})</span>`
      : `This disc won't ${aim} between ${Flip.MIN} and ${Flip.MAX} mph ${ref}. Try a different reference angle or disc.`;
  }

  function idleVerdict() {
    const v = $('verdict');
    v.className = 'verdict';
    v.innerHTML = connected
      ? `<h3>Ready</h3><p>Throw your TechDisc. The flip meter shows your arm speed against this disc's flip points.</p>`
      : `<h3>Try it</h3><p>Press <b>Demo throw</b> to see how it works, or connect your TechDisc in Settings to use your real bag.</p>`;
  }

  function showVerdictPending(d, speed) {
    const v = $('verdict');
    v.className = 'verdict';
    v.innerHTML = `<h3>${Math.round(speed)} mph…</h3><p>Simulating your ${esc(d.name)} with your exact release.</p>`;
  }

  function showVerdict() {
    const s = lastShot;
    const v = $('verdict');
    if (!s?.zone) {
      v.className = 'verdict';
      v.innerHTML = `<h3>${Number.isFinite(s?.speed) ? Math.round(s.speed) + ' mph' : 'No speed'}</h3><p>Couldn't read the disc's tilt from the simulator for this throw.</p>`;
      return;
    }
    const z = Flip.ZONES[s.zone];
    const prof = profileOf(s.disc);
    const lines = [];
    let tag = '';
    if (state.goal !== 'any') {
      const hit = s.zone === state.goal;
      tag = hit ? `<span class="tag hit">Goal hit${state.streak > 1 ? ` · ${state.streak} in a row` : ''}</span>` : '<span class="tag miss">Missed goal</span>';
      if (!hit) lines.push(coachTip(s, prof));
    }
    lines.push(z.blurb);
    if (prof) {
      const where = s.speed < prof.flat
        ? `${Math.round(prof.flat - s.speed)} mph short of where it flips to flat (${Flip.fmtMph(prof.flat)})`
        : s.speed < prof.flip
          ? `past the flat point (${Flip.fmtMph(prof.flat)}) and ${Math.round(prof.flip - s.speed)} mph under the flip-over point (${Flip.fmtMph(prof.flip)})`
          : `${Math.round(s.speed - prof.flip)} mph past the flip-over point (${Flip.fmtMph(prof.flip)})`;
      lines.push(`<b>${Math.round(s.speed)} mph</b> is ${where} for a ${state.hyzer}° hyzer.`);
      const rh = s.shot.hyzerAngle;
      if (Number.isFinite(rh) && Math.abs(rh - state.hyzer) >= 7 && s.predicted && s.predicted !== s.zone) {
        lines.push(`You released at <b>${Tilt.word(rh)}</b>, not ${state.hyzer}°, which is why the flight differs from the chart.`);
      }
    }
    v.className = `verdict ${s.zone}`;
    void v.offsetWidth;
    v.classList.add('pop');
    v.innerHTML = `${tag}<h3>${z.verb}!</h3><p>${lines.join(' ')}</p>`;
  }

  function coachTip(s, prof) {
    const goal = state.goal;
    const order = ['hyzer', 'flat', 'flip'];
    const b = Flip.band(prof, goal);
    const faster = order.indexOf(goal) > order.indexOf(s.zone);
    if (b) {
      const need = faster ? Math.ceil(b[0] - s.speed + 1) : Math.ceil(s.speed - b[1] + 1);
      return faster
        ? `<b>Throw about ${Math.max(need, 1)} mph harder</b> or release with less hyzer.`
        : `<b>Ease off about ${Math.max(need, 1)} mph</b> or add more hyzer.`;
    }
    return faster ? '<b>More speed or less hyzer.</b>' : '<b>Less speed or more hyzer.</b>';
  }

  function renderRelease() {
    const m = lastShot?.shot || {};
    const cell = (label, v, unit, digits = 0) =>
      `<div><small>${label}</small><b>${Number.isFinite(v) ? (digits ? round1(v) : Math.round(v)) : '-'}</b><em>${Number.isFinite(v) ? unit : ''}</em></div>`;
    $('release').innerHTML =
      cell('Speed', m.speedMph, 'mph', 1) +
      cell('Spin', Number.isFinite(m.spinRpm) ? Math.abs(m.spinRpm) : NaN, 'rpm') +
      cell('Hyzer', m.hyzerAngle, '°', 1) +
      cell('Nose', m.noseAngle, '°', 1);
  }

  // ---- behind view + tilt chart ----
  function drawBehind(deg, zone) {
    const svg = $('behind');
    svg.innerHTML = '';
    const side = Tilt.HYZER_SIDE[state.style] ?? -1;
    el('line', { x1: 10, y1: 56, x2: 190, y2: 56, class: 'b-horizon' }, svg);
    const ref = lastShot?.shot?.hyzerAngle;
    if (Number.isFinite(ref)) el('ellipse', { cx: 100, cy: 56, rx: 72, ry: 10, class: 'b-ghost', transform: `rotate(${side * ref} 100 56)` }, svg);
    const g = el('g', { transform: `rotate(${side * deg} 100 56)` }, svg);
    el('ellipse', { cx: 100, cy: 56, rx: 72, ry: 11, class: `b-disc ${zone || 'idle'}` }, g);
    el('path', { d: 'M40 54 Q100 34 160 54', class: 'b-dome' }, g);
    $('tiltNow').textContent = Number.isFinite(deg) ? Tilt.word(deg) : '-';
  }

  function drawTiltChart(pts, upto) {
    const svg = $('tiltChart');
    svg.innerHTML = '';
    const W = 240, H = 104, L = 26, R = 6, T = 6, B = 8;
    const lo = Math.min(-45, ...(pts || []).map((p) => p.d)), hi = Math.max(35, ...(pts || []).map((p) => p.d));
    const y = (d) => T + (hi - d) / (hi - lo) * (H - T - B);
    el('rect', { x: L, y: T, width: W - L - R, height: y(Flip.FLAT_LINE) - T, class: 'c-band hyzer' }, svg);
    el('rect', { x: L, y: y(Flip.FLAT_LINE), width: W - L - R, height: y(Flip.FLIP_LINE) - y(Flip.FLAT_LINE), class: 'c-band flat' }, svg);
    el('rect', { x: L, y: y(Flip.FLIP_LINE), width: W - L - R, height: H - B - y(Flip.FLIP_LINE), class: 'c-band flip' }, svg);
    el('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), class: 'c-zero' }, svg);
    el('text', { x: 2, y: T + 9, class: 'c-lab' }, svg, 'HYZ');
    el('text', { x: 2, y: y(0) + 3, class: 'c-lab' }, svg, 'FLAT');
    el('text', { x: 2, y: H - B, class: 'c-lab' }, svg, 'ANH');
    if (!pts?.length) return;
    const endT = pts[pts.length - 1].t || 1;
    const x = (t) => L + (t / endT) * (W - L - R);
    const shown = pts.filter((p) => p.t <= upto);
    if (shown.length < 2) return;
    el('path', { d: shown.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.d).toFixed(1)}`).join(' '), class: 'c-line' }, svg);
    const last = shown[shown.length - 1];
    el('circle', { cx: x(last.t), cy: y(last.d), r: 3.5, class: 'c-head' }, svg);
  }

  function playTilt(pts) {
    cancelAnimationFrame(anim);
    if (!pts?.length) { drawBehind(lastShot?.shot?.hyzerAngle ?? 0, null); drawTiltChart(null, 0); return; }
    const endT = pts[pts.length - 1].t;
    const zoneNow = (d) => (d >= Flip.FLAT_LINE ? 'hyzer' : d > Flip.FLIP_LINE ? 'flat' : 'flip');
    if (reducedMotion()) {
      const f = Tilt.flattest(pts);
      drawBehind(f, zoneNow(f)); drawTiltChart(pts, endT); return;
    }
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min((now - t0) / 1000, endT);
      const d = Tilt.at(pts, t);
      drawBehind(d, zoneNow(d));
      drawTiltChart(pts, t);
      if (t < endT) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  function celebrate(zone) {
    if (reducedMotion()) return;
    const box = $('burst');
    box.innerHTML = '';
    const color = getComputedStyle(document.documentElement).getPropertyValue(`--${zone}`);
    for (let i = 0; i < 16; i++) {
      const s = document.createElement('span');
      const a = Math.random() * Math.PI * 2, r = 80 + Math.random() * 110;
      s.style.setProperty('--x', `${Math.cos(a) * r}px`);
      s.style.setProperty('--y', `${Math.sin(a) * r - 40}px`);
      s.style.setProperty('--c', i % 3 ? color : 'var(--accent)');
      s.style.animationDelay = `${Math.random() * 120}ms`;
      box.appendChild(s);
    }
    setTimeout(() => { box.innerHTML = ''; }, 1400);
  }

  // ---- bag chart ----
  const pct = (v) => `${((clamp(v, Flip.MIN, Flip.MAX) - Flip.MIN) / (Flip.MAX - Flip.MIN) * 100).toFixed(2)}%`;

  function renderBag() {
    const box = $('bagChart');
    if (!bag.length) { box.innerHTML = `<div class="empty">${connected ? 'No discs with flight numbers in your TechDisc bag yet. Add discs in the TechDisc app, then reconnect.' : ''}</div>`; renderInsight(); return; }
    const cur = currentDisc();
    const st = speedStats();
    const rows = bag.map((d) => ({ d, prof: profileOf(d), live: progress.get(d.id) }));
    rows.sort((a, b) => {
      const fa = a.prof ? a.prof.flat : Infinity, fb = b.prof ? b.prof.flat : Infinity;
      if (fa !== fb) return (fa === Infinity ? 1e9 : fa === -Infinity ? -1e9 : fa) - (fb === Infinity ? 1e9 : fb === -Infinity ? -1e9 : fb);
      return a.d.name.localeCompare(b.d.name);
    });
    const ticks = [20, 30, 40, 50, 60, 70, 80].map((v) => `<span style="left:${pct(v)}">${v}</span>`).join('');
    const you = st ? `<div class="you-band" style="left:${pct(st.lo)};width:calc(${pct(st.hi)} - ${pct(st.lo)})"></div><div class="you-dot" style="left:${pct(st.mid)}"></div>` : '';

    box.innerHTML = `<div class="axis"><span class="kicker">mph</span><div class="scale">${ticks}</div></div>` + rows.map(({ d, prof, live }) => {
      const p = prof || (live?.points?.length >= 2 ? live : null);
      let inner = '', cls = 'bar';
      if (p && p.flat != null) {
        const reach = prof ? Flip.MAX : live.points[live.points.length - 1].v;
        for (const z of ['hyzer', 'flat', 'flip']) {
          const b = Flip.band(p, z);
          if (!b || b[0] >= reach) continue;
          const hi = Math.min(b[1], reach);
          inner += `<span class="seg ${z}" style="left:${pct(b[0])};width:calc(${pct(hi)} - ${pct(b[0])})"></span>`;
        }
        if (Number.isFinite(p.flat)) inner += `<span class="pt" style="left:calc(${pct(p.flat)} - 12px)">${Math.round(p.flat)}</span>`;
        if (Number.isFinite(p.flip)) inner += `<span class="pt" style="left:calc(${pct(p.flip)} - 12px)">${Math.round(p.flip)}</span>`;
        if (!prof) cls += ' loading';
      } else if (live) {
        cls += ' loading';
        inner = `<span class="msg">Simulating ${live.done}/${live.total}…</span>`;
      } else if (errors.has(d.id)) {
        cls += ' err';
        inner = `<span class="msg" title="${esc(errors.get(d.id))}">Sim error · <span class="link" data-map="${esc(d.id)}">retry</span></span>`;
      } else {
        inner = `<span class="msg"><span class="link" data-map="${esc(d.id)}">Map flip points</span></span>`;
      }
      return `<button type="button" class="bag-row${d === cur ? ' sel' : ''}" data-disc="${esc(d.id)}">
        <span class="name"><b>${esc(d.name)}</b><small>${esc(fmtFn(d.fn))}</small></span>
        <span class="${cls}">${inner}${you}</span>
      </button>`;
    }).join('');
    renderInsight();
    renderButtons();
    const used = Flip.callsThisHour();
    $('budget').textContent = connected
      ? `Sims this hour: ${used} of ${Flip.HOUR_CAP}${Flip.pending() ? ` · ${Flip.pending()} queued` : ''} · spin ${state.calib.spinPerMph} rpm per mph${state.calib.measured ? ' (from your throws)' : ' (default)'}`
      : 'Demo bag with a rough built-in flight model. Connect TechDisc for real simulator flip points.';
  }

  function renderInsight() {
    const st = speedStats();
    const mapped = bag.map((d) => ({ d, p: profileOf(d) })).filter((x) => x.p);
    if (!st || !mapped.length) {
      $('insight').innerHTML = st ? '' : 'Throw a few times and your usual speed shows up on every disc as a dashed band.';
      return;
    }
    const count = { hyzer: [], flat: [], flip: [] };
    mapped.forEach(({ d, p }) => count[Flip.zoneAt(p, st.mid)].push(d.name));
    const part = (z, word) => (count[z].length ? `<b>${count[z].length}</b> ${word}` : null);
    const bits = [part('hyzer', 'hold hyzer'), part('flat', 'flip to flat'), part('flip', 'flip over')].filter(Boolean);
    $('insight').innerHTML = `At your usual <b>${Math.round(st.mid)} mph</b>: ${bits.join(', ')}.` +
      (count.flat.length ? ` Your straightest discs right now: ${count.flat.slice(0, 3).map(esc).join(', ')}.` : '');
  }

  function renderLog() {
    const pill = (z) => (z ? `<span class="pill ${z}">${Flip.ZONES[z].label}</span>` : '<span class="no">-</span>');
    $('logBody').innerHTML = state.log.length
      ? state.log.map((h) => `<tr>
          <td>${new Date(h.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${h.demo ? ' <span class="no">demo</span>' : ''}</td>
          <td>${esc(h.disc)}</td>
          <td class="num">${Number.isFinite(h.speed) ? h.speed : '-'}</td>
          <td class="num">${Number.isFinite(h.hyzer) ? h.hyzer + '°' : '-'}</td>
          <td>${pill(h.predicted)}</td>
          <td>${pill(h.zone)}</td>
          <td>${h.goal === 'any' ? '<span class="no">free</span>' : h.hit ? `<span class="ok">✓ ${Flip.ZONES[h.goal].label}</span>` : `<span class="no">✗ ${Flip.ZONES[h.goal].label}</span>`}</td>
        </tr>`).join('')
      : '<tr><td colspan="7" class="no">No throws yet</td></tr>';
  }

  // ---------- events ----------
  $('discSel').addEventListener('change', (e) => selectDisc(e.target.value));
  function selectDisc(id) {
    state.discId = id;
    save();
    lastShot = null;
    $('speed').textContent = '--';
    $('gauge').dataset.needle = '';
    fillDiscSelect();
    renderAll();
    playTilt(null);
    const d = currentDisc();
    if (d && !profileOf(d)) mapDisc(d, { hi: true });
  }

  document.querySelectorAll('[data-goal]').forEach((b) => b.addEventListener('click', () => {
    state.goal = b.dataset.goal;
    state.streak = 0;
    save();
    renderGoal(); renderGauge(); renderTargetNote();
  }));

  $('bagChart').addEventListener('click', (e) => {
    const m = e.target.closest('[data-map]');
    if (m) { const d = bag.find((x) => x.id === m.dataset.map); errors.delete(d.id); mapDisc(d); return; }
    const row = e.target.closest('[data-disc]');
    if (row) selectDisc(row.dataset.disc);
  });

  const refOut = () => { $('refOut').textContent = state.hyzer ? `${state.hyzer}° hyzer` : 'flat'; };
  $('refHyzer').addEventListener('input', (e) => {
    state.hyzer = Number(e.target.value);
    refOut();
    save();
    Flip.cancelMapping();
    progress.clear();
    errors.clear();
    renderAll();
  });
  $('refHyzer').addEventListener('change', () => { const d = currentDisc(); if (d) mapDisc(d, { hi: true }); });

  $('mapBagBtn').addEventListener('click', mapBag);
  $('stopMapBtn').addEventListener('click', () => { Flip.cancelMapping(); });
  $('listenBtn').addEventListener('click', () => {
    if (!connected) return openSettings();
    listening ? stopListening() : startListening();
  });
  $('throwBtn').addEventListener('click', () => (connected ? scoreLatest() : demoThrow()));
  $('settingsBtn').addEventListener('click', openSettings);
  $('connectBtn').addEventListener('click', connect);
  $('forgetBtn').addEventListener('click', useDemo);
  $('styleSel').addEventListener('change', (e) => { state.style = e.target.value; save(); Flip.cancelMapping(); progress.clear(); renderAll(); });
  $('clearCacheBtn').addEventListener('click', () => {
    if (!confirm('Forget every saved flip point? Discs will need to be mapped again.')) return;
    Flip.cancelMapping(); Flip.clearCache(); progress.clear(); errors.clear(); renderAll();
  });
  $('clearLogBtn').addEventListener('click', () => { state.log = []; state.speeds = []; state.streak = 0; save(); renderAll(); });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea, dialog')) return;
    if (e.key === ' ' && !connected) { e.preventDefault(); demoThrow(); }
  });

  function openSettings() {
    $('token').value = getToken();
    $('styleSel').value = state.style;
    $('calibNote').textContent = state.calib.measured
      ? `Reference sims use your spin: about ${state.calib.spinPerMph} rpm per mph, measured from your throws.`
      : 'Reference sims use about 20 rpm of spin per mph until you throw with TechDisc connected.';
    $('settings').showModal();
  }

  Flip.onStatus((m) => {
    if (m.type === 'budget') setStatus(m.text, 'err');
    if (m.type === 'tick') { renderButtons(); }
  });

  // ---------- start ----------
  $('refHyzer').value = state.hyzer;
  refOut();
  if (!bag.some((d) => d.id === state.discId)) state.discId = bag[1].id;
  fillDiscSelect();
  renderAll();
  drawBehind(state.hyzer, null);
  drawTiltChart(null, 0);
  if (getToken()) connect();
  else { setStatus('Demo mode'); mapBag(); }
})();
