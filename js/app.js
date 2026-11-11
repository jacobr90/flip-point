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
    style: 'RHBH', hyzer: 15, nose: 2, goal: 'flat', discId: null,
    log: [], speeds: [],
    calib: { spinPerMph: 20, spinSign: 1, measured: false },
    lastRelease: null,
  });
  let state;
  try { state = { ...defaults(), ...JSON.parse(localStorage.getItem(STATE_KEY)) }; } catch { state = defaults(); }
  // Older saves had a "Free throw" goal and streaks.
  if (!Flip.ZONES[state.goal]) state.goal = 'flat';
  // Most players throw a little nose up, so the chart starts at +2° rather than level.
  if (!Number.isFinite(state.nose)) state.nose = 2;
  delete state.streak; delete state.best;
  const save = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* storage off */ } };
  const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
  const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage off */ } };

  let connected = false;     // token checked and bag loaded
  let listening = false;
  let abortCtl = null;
  let bag = DEMO_BAG.slice();
  const progress = new Map(); // disc id -> partial profile while mapping
  const errors = new Map();   // disc id -> error message
  let bagJob = null;          // { ids, started } while "Map whole bag" runs
  let lastShot = null;        // { speed, tilt pts, zone, shot }
  let anim = null;

  const ctx = () => ({
    token: getToken(), demo: !connected, style: state.style, hyzer: state.hyzer, nose: state.nose,
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
    progress.set(d.id, { partial: true, done: 0, total: Flip.MAX_CALLS, points: [] });
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
      const calls = todo.length * Flip.MAX_CALLS;
      const left = Flip.HOUR_CAP - Flip.callsThisHour();
      if (!confirm(`Map ${todo.length} disc${todo.length > 1 ? 's' : ''}? This uses up to ${calls} sims (about ${Math.ceil(calls * 1.2 / 60)} min). You have about ${left} left this hour.`)) return;
    }
    // Selected disc first.
    const cur = currentDisc();
    todo.sort((a, b) => (b === cur) - (a === cur));
    // One disc at a time, so each disc's row fills in completely before the next.
    const job = bagJob = { ids: todo.map((d) => d.id), started: Date.now() };
    renderBagProgress();
    (async () => {
      for (const d of todo) {
        if (bagJob !== job) return;   // stopped, or the release changed
        await mapDisc(d);
      }
    })();
  }

  // One bar for the whole bag: each disc counts by how many of its sims are done.
  let progressHide = null;
  function renderBagProgress() {
    const box = $('bagProgress');
    if (!bagJob) { if (!box.classList.contains('done')) box.classList.add('hidden'); return; }
    const discs = bagJob.ids.map((id) => bag.find((d) => d.id === id)).filter(Boolean);
    let frac = 0, finished = 0, callsLeft = 0, now = null;
    for (const d of discs) {
      const live = progress.get(d.id);
      if (profileOf(d) || errors.has(d.id)) { frac += 1; finished++; }
      else if (live) {
        frac += live.done / Math.max(live.total, 1);
        callsLeft += live.total - live.done;
        if (!now) now = d;
      } else callsLeft += Flip.MAX_CALLS;
    }
    const n = discs.length || 1;
    const pct = Math.round((frac / n) * 100);
    box.classList.remove('hidden', 'done');
    box.setAttribute('aria-valuenow', pct);
    $('bagProgFill').style.width = `${pct}%`;
    const failed = discs.filter((d) => errors.has(d.id)).length;
    if (finished >= discs.length) {
      clearTimeout(progressHide);
      box.classList.add('done');
      $('bagProgText').innerHTML = `<span><b>${discs.length - failed}</b> of ${discs.length} discs mapped${failed ? ` · ${failed} failed (retry from its row)` : ''}</span>`;
      bagJob = null;
      progressHide = setTimeout(() => { box.classList.add('hidden'); box.classList.remove('done'); }, 4000);
      return;
    }
    const secs = connected ? Math.ceil(callsLeft * 1.2) : Math.ceil(callsLeft * 0.1);
    const eta = secs >= 60 ? `about ${Math.ceil(secs / 60)} min left` : `about ${secs} s left`;
    $('bagProgText').innerHTML = `<span>Mapping <b>${Math.min(finished + 1, discs.length)}</b> of <b>${discs.length}</b>${now ? ` · ${esc(now.name)}` : ''}</span><span><b>${pct}%</b> · ${eta}</span>`;
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

    // Flip points are only mapped when you ask (or for free in demo mode).
    if (!profileOf(d) && !connected) mapDisc(d, { hi: true });

    lastShot = { speed, shot, pts: null, zone: null, disc: d, pending: true };
    renderAll();
    setNeedle(speed);
    showVerdictPending(d, speed);

    let pts = null, path = null;
    try {
      ({ pts, path } = await Flip.simulateThrow(shot, d.fn, { ...ctx(), demo: demo || !connected }));
    } catch (e) {
      setStatus(`Sim failed: ${e.message}`, 'err');
    }
    const prof = profileOf(d);
    const predicted = prof ? Flip.zoneAt(prof, speed) : null;
    const zone = pts ? Flip.zoneOfTilt(Tilt.flattest(pts)) : predicted;
    const { d: dist, x: side } = Flip.carry(path);
    lastShot = { speed, shot, pts, zone, predicted, disc: d, dist, side, pending: false };
    const pick = ['speedMph', 'spinRpm', 'hyzerAngle', 'noseAngle', 'launchAngle', 'wobble'];
    state.lastRelease = Object.fromEntries(pick.filter((k) => Number.isFinite(shot[k])).map((k) => [k, shot[k]]));
    state.lastRelease.real = !demo;
    WhatIf.setBase(state.lastRelease, { real: !demo });

    const goal = state.goal;
    const hit = zone ? zone === goal : null;
    state.log = [{
      t: Date.now(), disc: discLabel(d), discId: d.id, speed: round1(speed), hyzer: round1(shot.hyzerAngle ?? NaN),
      nose: round1(shot.noseAngle ?? NaN), dist: Number.isFinite(dist) ? Math.round(dist) : null, predicted, zone, goal, hit, demo,
    }, ...state.log].slice(0, MAX_LOG);
    save();

    renderAll();
    showVerdict();
    playTilt(pts);
  }

  function demoThrow() {
    const d = currentDisc();
    const st = speedStats();
    const base = st ? st.mid : 48;
    const prof = profileOf(d);
    // Land in the training target about half the time, like a player working on it.
    let speed = base + (Math.random() - 0.5) * 22;
    const band = Flip.band(prof, state.goal);
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
      WhatIf.setBase(null);
      renderAll();
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
    WhatIf.setBase(null);
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
        const dim = state.goal !== z;
        el('path', { d: arc(b[0], hi), class: `g-zone ${z}${dim ? ' dim' : ''}` }, svg);
        // Each band carries its name, so color is never the only cue.
        if (hi - b[0] >= 9) {
          const [lx, ly] = pt(angOf((b[0] + hi) / 2));
          el('text', { x: lx, y: ly + 3.5, class: `g-zlabel ${z}${dim ? ' dim' : ''}` }, svg, Flip.ZONES[z].label.toUpperCase());
        }
      }
      for (const [k, v] of [['flat', prof.flat], ['flip', prof.flip]]) {
        if (!Number.isFinite(v)) continue;
        const a = angOf(v);
        const [x0, y0] = pt(a, G.r - 15), [x1, y1] = pt(a, G.r + 15), [lx, ly] = pt(a, G.r + 28);
        el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: 'g-mark' }, svg);
        el('text', { x: lx, y: ly + 4, class: `g-mlabel ${k}` }, svg, `${Math.round(v)}`);
      }
      // Max distance: a diamond on the dial at that speed, and the carry in words.
      if (!prof.partial && prof.best) {
        const [mx, my] = pt(angOf(prof.best.v));
        el('rect', { x: mx - 7, y: my - 7, width: 14, height: 14, transform: `rotate(45 ${mx} ${my})`, class: 'g-max' }, svg);
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
    // A pointer on the outer ring only, so it never covers the speed readout.
    el('line', { x1: G.cx + G.r - 52, y1: G.cy, x2: G.cx + G.r + 4, y2: G.cy }, g);
    el('circle', { cx: G.cx + G.r - 52, cy: G.cy, r: 4 }, g);
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
    if (!prof) {
      if (progress.has(d.id)) { note.innerHTML = 'Running the speed sweep through the simulator...'; return; }
      note.innerHTML = `<div class="map-cta"><button type="button" class="plain small" data-map-current>Map flip points from ${refWord()}</button></div>` +
        `<span class="fine">${connected ? `About ${Flip.MAX_CALLS} API calls. ` : ''}Your throws are still simulated without it.</span>`;
      return;
    }
    const ref = `from ${refWord()}`;
    // The three numbers that matter most for this disc, as tiles under the meter.
    const tile = (cls, label, big, unit, sub) =>
      `<div class="stat ${cls}"><small>${label}</small><b>${big}<em>${unit}</em></b>${sub ? `<span>${sub}</span>` : ''}</div>`;
    const best = prof.best;
    const stats = `<div class="stats">` +
      tile('flat', 'Flips to flat', Flip.fmtMph(prof.flat), 'mph', '') +
      tile('flip', 'Flips over', Flip.fmtMph(prof.flip), 'mph', '') +
      (best ? tile('max', 'Max carry', ft5(best.d), 'ft', `at ${Math.round(best.v)} mph`) : '') +
      `</div>`;
    const b = Flip.band(prof, state.goal);
    const aim = AIM[state.goal];
    const db = Flip.distBand(prof, state.goal);
    note.innerHTML = stats + noseCompare(d, prof) + (b
      ? `To ${aim}: throw <b>${Math.round(b[0])}–${Math.round(b[1])} mph</b>${db ? ` · carries about <b>${ftRange(db)}</b>` : ''} <span class="fine">(${ref})</span>`
      : `This disc won't ${aim} between ${Flip.MIN} and ${Flip.MAX} mph ${ref}. Try a different release angle or disc.`);
  }
  // ---- nose check: the same disc mapped 3° more nose down, side by side ----
  // Teaching the cost of a nose-up release is the point of owning a TechDisc,
  // so the disc in hand can be mapped once more at a lower nose to compare.
  const cmpNose = () => (state.nose > -3 ? state.nose - 3 : state.nose + 3);
  const cmpCtx = () => ({ ...ctx(), nose: cmpNose() });
  function startCompare(d) {
    if (!d) return;
    Flip.map(d.fn, cmpCtx(), () => renderTargetNote(), { hi: true })
      .then(() => renderTargetNote())
      .catch((e) => { if (!e.cancelled) setStatus(`Nose comparison failed: ${e.message}`, 'err'); renderTargetNote(); });
    renderTargetNote();
  }
  function noseCompare(d, prof) {
    const n = cmpNose(), lower = n < state.nose;
    const head = `<h4>Nose check: ${noseWord(state.nose)} vs ${noseWord(n)}</h4>`;
    const cp = Flip.cached(d.fn, cmpCtx());
    if (!cp) {
      const running = Flip.mapping(d.fn, cmpCtx());
      if (running) return `<div class="nose-cmp">${head}<p>Mapping ${noseWord(n)}… ${running.done}/${running.total}</p></div>`;
      if (!connected) { setTimeout(() => startCompare(d), 0); return `<div class="nose-cmp">${head}<p>Mapping…</p></div>`; }
      return `<div class="nose-cmp">${head}<p>See what a ${lower ? 'lower' : 'higher'} nose does to this disc's carry and flip speeds. <button type="button" class="plain small" data-cmp>Compare (about ${Flip.MAX_CALLS} API calls)</button></p></div>`;
    }
    const chg = (a, b, unit, fmt) => {
      if (!Number.isFinite(a) || !Number.isFinite(b)) return `<b>${fmt(b)}</b>`;
      const dlt = Math.round(b - a);
      return `<b>${fmt(b)}</b><span class="chg">${dlt > 0 ? '+' : dlt < 0 ? '−' : '±'}${Math.abs(dlt)}${unit}</span>`;
    };
    const cell = (label, html) => `<div><small>${label}</small>${html}</div>`;
    const dCarry = prof.best && cp.best ? Math.round(cp.best.d - prof.best.d) : null;
    const dFlat = Number.isFinite(prof.flat) && Number.isFinite(cp.flat) ? Math.round(cp.flat - prof.flat) : null;
    let say = '';
    if (dCarry != null) say += `${lower ? '3° more nose down' : '3° more nose up'} ${dCarry >= 0 ? 'adds' : 'costs'} <b>about ${Math.abs(dCarry)} ft</b> of max carry with this disc`;
    if (dFlat) say += `${say ? ', and it' : 'It'} flips up <b>${Math.abs(dFlat)} mph ${dFlat < 0 ? 'sooner' : 'later'}</b>${dFlat < 0 ? ', so the same arm speed turns it more' : ''}`;
    return `<div class="nose-cmp">${head}<div class="cmp">` +
      cell(`Max carry, ${noseWord(n)}`, chg(prof.best?.d, cp.best?.d, ' ft', (x) => `${ft5(x)} ft`)) +
      cell('Flips to flat', chg(prof.flat, cp.flat, '', (x) => `${Flip.fmtMph(x)} mph`)) +
      cell('Flips over', chg(prof.flip, cp.flip, '', (x) => `${Flip.fmtMph(x)} mph`)) +
      `</div>${say ? `<p>${say}.</p>` : ''}</div>`;
  }

  // Carry ranges are estimates, so round to 5 ft.
  const ft5 = (x) => Math.round(x / 5) * 5;
  const ftRange = ([a, b]) => (ft5(b) - ft5(a) < 10 ? `${ft5((a + b) / 2)} ft` : `${ft5(a)}–${ft5(b)} ft`);
  const AIM = { hyzer: 'hold hyzer', flat: 'flip to flat', flip: 'flip over' };
  // The chart's release in words: hyzer angle and nose angle together.
  const hyzerWord = (h) => (h > 0 ? `${h}° hyzer` : h < 0 ? `${-h}° anhyzer` : 'flat release');
  const noseWord = (n) => (n > 0 ? `nose ${n}° up` : n < 0 ? `nose ${-n}° down` : 'nose level');
  const releaseWord = (h, n) => `${hyzerWord(h)}, ${noseWord(n)}`;
  const refWord = () => `a ${releaseWord(state.hyzer, state.nose)}`;

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
    const onTarget = s.zone === state.goal;
    const lines = [];
    const tag = onTarget
      ? `<span class="tag hit">On target · ${Flip.ZONES[state.goal].label}</span>`
      : `<span class="tag miss">Training for ${Flip.ZONES[state.goal].label.toLowerCase()}</span>`;
    const fix = onTarget ? null : correction(s, prof);
    if (fix) lines.push(fix.text);
    lines.push(z.blurb);
    if (prof) {
      const where = s.speed < prof.flat
        ? `${Math.round(prof.flat - s.speed)} mph short of where it flips to flat (${Flip.fmtMph(prof.flat)})`
        : s.speed < prof.flip
          ? `past the flat point (${Flip.fmtMph(prof.flat)}) and ${Math.round(prof.flip - s.speed)} mph under the flip-over point (${Flip.fmtMph(prof.flip)})`
          : `${Math.round(s.speed - prof.flip)} mph past the flip-over point (${Flip.fmtMph(prof.flip)})`;
      lines.push(`<b>${Math.round(s.speed)} mph</b> is ${where} from ${refWord()}.`);
      const rh = s.shot.hyzerAngle;
      if (Number.isFinite(rh) && Math.abs(rh - state.hyzer) >= 7 && s.predicted && s.predicted !== s.zone) {
        lines.push(`You released at <b>${Tilt.word(rh)}</b>, not ${state.hyzer}°, which is why the flight differs from the chart.`);
      }
    }
    const trend = recentTrend(s.disc);
    const distNote = distanceNote(s, prof);
    const carryBox = Number.isFinite(s.dist)
      ? `<div class="carry"><small>Est. carry</small><b>${Math.round(s.dist)}<em>ft</em></b><span>${sideWord(s.side)}</span></div>`
      : '';
    v.className = `verdict ${s.zone}`;
    void v.offsetWidth;
    v.classList.add('pop');
    v.innerHTML = `<div class="v-top"><div>${tag}<h3><i class="dot ${s.zone}"></i>${z.verb}</h3></div>${carryBox}</div>` +
      (distNote ? `<p class="dist-note">${distNote}</p>` : '') +
      `<p>${lines.join(' ')}</p>` +
      (trend ? `<p class="trend">${trend}</p>` : '') +
      (fix?.release ? `<div class="fix"><button type="button" class="plain small" id="tryFix">Try ${Math.round(fix.release.speedMph)} mph as a test flight</button><span class="fine">Loads it below. Nothing runs until you press Run test flight.</span></div>` : '');
    $('tryFix')?.addEventListener('click', () => {
      WhatIf.preset(fix.release);
      document.querySelector('.whatif').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    });
  }

  const sideWord = (x) => (!Number.isFinite(x) ? '' : Math.abs(x) < 5 ? 'on line' : `${Math.round(Math.abs(x))} ft ${x < 0 ? 'left' : 'right'}`);

  // How this throw's carry compares with the disc's longest flight, and why.
  // The max is from the speed sweep, so it's for the chart's release angle with a level nose.
  function distanceNote(s, prof) {
    const best = prof?.best;
    if (!best || !Number.isFinite(s.dist)) return '';
    const gap = Math.round(best.d - s.dist);
    const maxTxt = `<b>~${ft5(best.d)} ft at ${Math.round(best.v)} mph</b>`;
    const shape = Flip.ZONES[best.zone].verb.toLowerCase();
    if (gap < -10) return `Longer than this disc's mapped max carry (${maxTxt} from ${refWord()}). Your release angles added distance the chart doesn't include.`;
    if (gap <= 10) return `Right at this disc's max carry from ${refWord()}: ${maxTxt}, when it ${shape}.`;
    let why;
    if (s.zone === 'hyzer') why = best.zone === 'hyzer' ? 'More speed adds carry while it still holds its line.' : 'A held hyzer fades out early. Letting it flip up toward flat lets it glide longer.';
    else if (s.zone === 'flat') why = s.speed < best.v ? 'Same flat flight with more speed carries farther.' : 'It is flat but faster than its best speed, so it starts to roll and lose height.';
    else why = best.zone === 'flip' ? 'This disc goes farthest turning over, but it finishes well off the line.' : 'Turning over costs carry: the disc rolls off line and drops sooner.';
    return `${gap} ft short of this disc's max carry from ${refWord()} (${maxTxt}, when it ${shape}). ${why}`;
  }

  // What to change to get the training target: a speed from the chart when there is
  // one, plus the angle that pushes the same way.
  function correction(s, prof) {
    const order = ['hyzer', 'flat', 'flip'];
    const faster = order.indexOf(state.goal) > order.indexOf(s.zone);
    const angle = faster ? 'less hyzer' : 'more hyzer';
    const nose = faster ? '' : ' A slightly higher nose also slows the disc sooner.';
    const b = Flip.band(prof, state.goal);
    if (!b) return { text: `<b>${faster ? 'More speed' : 'Less speed'} or ${angle}.</b>${nose}` };
    // Aim a few mph inside the band, not on its edge.
    const inset = Math.min(3, (b[1] - b[0]) / 2);
    const speed = faster ? b[0] + inset : b[1] - inset;
    const diff = Math.max(1, Math.round(Math.abs(speed - s.speed)));
    return {
      text: `<b>${faster ? `About ${diff} mph more speed` : `About ${diff} mph less speed`}</b>, or ${angle} at the same speed.${nose}`,
      release: { speedMph: Math.round(speed) },
    };
  }

  // A short read on your last few throws with this disc: what you are actually doing.
  function recentTrend(d) {
    const recent = state.log.filter((h) => (h.discId ? h.discId === d.id : h.disc === d.name)).slice(0, 5);
    if (recent.length < 3) return '';
    const avg = (k) => { const xs = recent.map((h) => h[k]).filter(Number.isFinite); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
    const sp = avg('speed'), hz = avg('hyzer'), ns = avg('nose');
    const on = recent.filter((h) => h.zone === state.goal).length;
    const parts = [`${Math.round(sp)} mph`];
    if (hz != null) parts.push(Tilt.word(hz));
    if (ns != null) parts.push(`nose ${ns >= 0 ? '+' : '−'}${Math.abs(round1(ns))}°`);
    return `Your last ${recent.length} with this disc averaged <b>${parts.join(', ')}</b>. ${on} of ${recent.length} ${Flip.ZONES[state.goal].verb.toLowerCase()}.`;
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

    box.innerHTML = `<div class="axis"><span class="kicker">mph</span><div class="scale">${ticks}</div><span class="kicker carry-head">${st ? 'Carry at your speed' : 'Max carry'}</span></div>` + rows.map(({ d, prof, live }) => {
      const p = prof || (live?.points?.length >= 2 ? live : null);
      let inner = '', segs = '', marks = '', cls = 'bar';
      if (p && p.flat != null) {
        const reach = prof ? Flip.MAX : live.points[live.points.length - 1].v;
        for (const z of ['hyzer', 'flat', 'flip']) {
          const b = Flip.band(p, z);
          if (!b || b[0] >= reach) continue;
          const hi = Math.min(b[1], reach);
          segs += `<span class="seg ${z}" style="left:${pct(b[0])};width:calc(${pct(hi)} - ${pct(b[0])})"></span>`;
        }
        if (Number.isFinite(p.flat)) inner += `<span class="pt" style="left:calc(${pct(p.flat)} - 12px)">${Math.round(p.flat)}</span>`;
        if (Number.isFinite(p.flip)) inner += `<span class="pt" style="left:calc(${pct(p.flip)} - 12px)">${Math.round(p.flip)}</span>`;
        if (prof?.best) marks += `<span class="max" style="left:${pct(prof.best.v)}" title="Max carry ${Math.round(prof.best.d)} ft at ${Math.round(prof.best.v)} mph"></span>`;
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
      // Carry: at your usual speed when we know it, plus the disc's max.
      let carry = '<span class="carry-col"></span>';
      if (prof?.best) {
        const atYou = st ? Flip.distAt(prof, st.mid) : null;
        carry = `<span class="carry-col">${Number.isFinite(atYou) ? `<b>${ft5(atYou)}<em>ft</em></b><small>max ${ft5(prof.best.d)}</small>` : `<b>${ft5(prof.best.d)}<em>ft</em></b><small>max carry</small>`}</span>`;
      }
      return `<button type="button" class="bag-row${d === cur ? ' sel' : ''}" data-disc="${esc(d.id)}">
        <span class="name"><b>${esc(d.name)}</b><small>${esc(fmtFn(d.fn))}</small></span>
        <span class="${cls}"><span class="segs">${segs}${you}</span>${inner}${marks}</span>
        ${carry}
      </button>`;
    }).join('');
    renderInsight();
    renderButtons();
    refOut();
    renderBagProgress();
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
    // Longest carriers at your speed: the discs to reach for on a long hole.
    const longest = mapped.map(({ d, p }) => ({ d, ft: Flip.distAt(p, st.mid), z: Flip.zoneAt(p, st.mid) }))
      .filter((x) => Number.isFinite(x.ft)).sort((a, b) => b.ft - a.ft).slice(0, 3);
    $('insight').innerHTML = `At your usual <b>${Math.round(st.mid)} mph</b>: ${bits.join(', ')}.` +
      (longest.length ? `<br>Longest at that speed: ${longest.map((x) => `<b>${esc(x.d.name)}</b> ~${ft5(x.ft)} ft (${Flip.ZONES[x.z].verb.toLowerCase()})`).join(', ')}.` : '') +
      (count.flat.length ? `<br>Straightest right now: ${count.flat.slice(0, 3).map(esc).join(', ')}.` : '');
  }

  function renderLog() {
    const pill = (z) => (z ? `<span class="pill ${z}">${Flip.ZONES[z].label}</span>` : '<span class="no">-</span>');
    $('logBody').innerHTML = state.log.length
      ? state.log.map((h) => `<tr>
          <td>${new Date(h.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${h.demo ? ' <span class="no">demo</span>' : ''}</td>
          <td>${esc(h.disc)}</td>
          <td class="num">${Number.isFinite(h.speed) ? h.speed : '-'}</td>
          <td class="num">${Number.isFinite(h.hyzer) ? h.hyzer + '°' : '-'}</td>
          <td class="num">${Number.isFinite(h.dist) ? `<b>${h.dist}</b> ft` : '-'}</td>
          <td>${pill(h.predicted)}</td>
          <td>${pill(h.zone)}</td>
          <td>${!Flip.ZONES[h.goal] ? '<span class="no">-</span>' : h.hit ? `<span class="ok">${Flip.ZONES[h.goal].label} · on target</span>` : `<span class="no">${Flip.ZONES[h.goal].label}</span>`}</td>
        </tr>`).join('')
      : '<tr><td colspan="8" class="no">No throws yet</td></tr>';
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
    WhatIf.setBase(null);
    const d = currentDisc();
    if (d && !profileOf(d) && !connected) mapDisc(d, { hi: true });
  }

  document.querySelectorAll('[data-goal]').forEach((b) => b.addEventListener('click', () => {
    state.goal = b.dataset.goal;
    save();
    renderGoal(); renderGauge(); renderTargetNote();
    if (lastShot && !lastShot.pending) showVerdict();
  }));

  $('targetNote').addEventListener('click', (e) => {
    if (e.target.closest('[data-map-current]')) mapDisc(currentDisc(), { hi: true });
    if (e.target.closest('[data-cmp]')) startCompare(currentDisc());
  });

  $('bagChart').addEventListener('click', (e) => {
    const m = e.target.closest('[data-map]');
    if (m) { const d = bag.find((x) => x.id === m.dataset.map); errors.delete(d.id); mapDisc(d); return; }
    const row = e.target.closest('[data-disc]');
    if (row) selectDisc(row.dataset.disc);
  });

  // The release angle the chart is mapped from. Moving it never runs sims by
  // itself: angles already mapped show at once, others wait for a Map button.
  const refOut = () => {
    $('refOut').textContent = releaseWord(state.hyzer, state.nose);
    $('refHyzerOut').textContent = hyzerWord(state.hyzer).replace(' release', '');
    $('refNoseOut').textContent = state.nose > 0 ? `${state.nose}° up` : state.nose < 0 ? `${-state.nose}° down` : 'level';
    const missing = bag.filter((d) => !profileOf(d)).length;
    $('refHint').textContent = !connected || !missing ? ''
      : `${missing} disc${missing === 1 ? '' : 's'} not mapped from this release yet. Mapping takes about ${Flip.MAX_CALLS} API calls per disc and is saved for next time.`;
    // Offer the player's own average release, so the chart matches how they actually throw.
    const avg = avgRelease();
    const box = $('refAvg');
    if (!avg) { box.innerHTML = '<span>Throw a few times and you can match the chart to your own average release.</span>'; return; }
    const same = avg.hyzer === state.hyzer && avg.nose === state.nose;
    box.innerHTML = `<span>Your last ${avg.n} throws average <b>${releaseWord(avg.hyzer, avg.nose)}</b>.</span>` +
      (same ? '<span class="fine">The chart uses it.</span>' : '<button type="button" class="plain small" id="useAvg">Use my release</button>');
    $('useAvg')?.addEventListener('click', () => { setRef('hyzer', avg.hyzer, false); setRef('nose', avg.nose); if (!connected) mapBag(); });
  };
  // Average hyzer and nose of recent throws, rounded to whole degrees.
  function avgRelease() {
    const recent = state.log.filter((h) => (connected ? !h.demo : true) && Number.isFinite(h.hyzer) && Number.isFinite(h.nose)).slice(0, 10);
    if (recent.length < 3) return null;
    const mean = (k) => recent.reduce((a, h) => a + h[k], 0) / recent.length;
    return { n: recent.length, hyzer: clamp(Math.round(mean('hyzer')), -10, 30), nose: clamp(Math.round(mean('nose')), -5, 8) };
  }
  const REF_LIMITS = { hyzer: [-10, 30], nose: [-5, 8] };
  function setRef(kind, v, render = true) {
    v = clamp(Math.round(v), ...REF_LIMITS[kind]);
    if (v === state[kind]) return;
    state[kind] = v;
    $(kind === 'hyzer' ? 'refHyzer' : 'refNose').value = v;
    save();
    Flip.cancelMapping();
    bagJob = null;
    progress.clear();
    errors.clear();
    if (render) { renderAll(); refOut(); }
  }
  $('refHyzer').addEventListener('input', (e) => setRef('hyzer', Number(e.target.value)));
  $('refNose').addEventListener('input', (e) => setRef('nose', Number(e.target.value)));
  document.querySelectorAll('[data-ref]').forEach((b) => b.addEventListener('click', () => {
    const [kind, step] = b.dataset.ref.split(':');
    setRef(kind, state[kind] + Number(step));
    if (!connected) mapBag();
  }));
  // Demo mapping is free, so it follows the sliders when you let go.
  $('refHyzer').addEventListener('change', () => { if (!connected) mapBag(); });
  $('refNose').addEventListener('change', () => { if (!connected) mapBag(); });

  $('mapBagBtn').addEventListener('click', mapBag);
  $('stopMapBtn').addEventListener('click', () => { Flip.cancelMapping(); bagJob = null; renderBagProgress(); });
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
  $('clearLogBtn').addEventListener('click', () => { state.log = []; state.speeds = []; save(); renderAll(); });
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
  $('refNose').value = state.nose;
  refOut();
  if (!bag.some((d) => d.id === state.discId)) state.discId = bag[1].id;
  fillDiscSelect();
  renderAll();
  drawBehind(state.hyzer, null);
  drawTiltChart(null, 0);
  WhatIf.init({ getDisc: currentDisc, getCtx: ctx, calib: () => state.calib });
  if (state.lastRelease) WhatIf.setBase(state.lastRelease, { real: !!state.lastRelease.real });
  if (getToken()) connect();
  else { setStatus('Demo mode'); mapBag(); }
})();
