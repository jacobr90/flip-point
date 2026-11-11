// What if: start from your last release, change speed, hyzer or nose angle,
// and fly both through the simulator to see what that one change does.
const WhatIf = (() => {
  const $ = (id) => document.getElementById(id);
  const SVGNS = 'http://www.w3.org/2000/svg';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const r1 = (x) => Math.round(x * 10) / 10;
  const sign = (x, digits = 0) => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(digits ? r1(x) : Math.round(x));

  const DEFAULT = { speedMph: 50, hyzerAngle: 10, noseAngle: 0, launchAngle: 10, wobble: 0 };
  let deps = null;          // { getDisc, getCtx, spinPerMph }
  let base = null;          // { release, disc, real }
  let baseRun = null;       // sim of the base release
  let run = null;           // { release, result } of the last What if
  let busy = false;

  function el(tag, attrs, parent, text) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    parent?.appendChild(n);
    return n;
  }

  function normalize(r) {
    const out = { ...DEFAULT };
    for (const k of Object.keys(DEFAULT)) if (Number.isFinite(r?.[k])) out[k] = r[k];
    const c = deps.calib();
    out.spinRpm = Number.isFinite(r?.spinRpm) && r.spinRpm !== 0 ? r.spinRpm : Math.round(c.spinSign * c.spinPerMph * out.speedMph);
    return out;
  }

  // The release the sliders describe. Spin keeps your spin-per-mph as speed changes.
  function current() {
    const b = base.release;
    const speedMph = Number($('wiSpeed').value);
    return {
      ...b,
      speedMph,
      hyzerAngle: Number($('wiHyzer').value),
      noseAngle: Number($('wiNose').value),
      spinRpm: Math.round(b.spinRpm / b.speedMph * speedMph),
    };
  }
  // Releases rounded to the sliders' steps, so an untouched slider reads as "no change".
  const snap = (r) => ({ ...r, speedMph: Math.round(r.speedMph), hyzerAngle: Math.round(r.hyzerAngle), noseAngle: Math.round(r.noseAngle * 2) / 2 });
  const same = (a, b) => {
    if (!a || !b) return false;
    const x = snap(a), y = snap(b);
    return ['speedMph', 'hyzerAngle', 'noseAngle'].every((k) => x[k] === y[k]);
  };

  function setSliders(r) {
    $('wiSpeed').value = Math.round(r.speedMph);
    $('wiHyzer').value = Math.round(r.hyzerAngle);
    $('wiNose').value = Math.round(r.noseAngle * 2) / 2;
  }

  // ---------- public ----------
  function init(d) {
    deps = d;
    ['wiSpeed', 'wiHyzer', 'wiNose'].forEach((id) => $(id).addEventListener('input', renderControls));
    document.querySelectorAll('[data-nudge]').forEach((b) => b.addEventListener('click', () => {
      const [id, step] = b.dataset.nudge.split(':');
      const input = $(id);
      input.value = Number(input.value) + Number(step);
      renderControls();
    }));
    $('wiFly').addEventListener('click', fly);
    $('wiReset').addEventListener('click', () => { setSliders(base.release); renderControls(); });
    setBase(null);
  }

  // A new starting point: your latest release (real or demo) on the disc in hand.
  function setBase(release, { real = false } = {}) {
    const disc = deps.getDisc();
    const keep = !release && base ? base : null;
    base = {
      release: normalize(release || keep?.release),
      disc,
      real: release ? real : keep?.real ?? false,
      fresh: release ? false : keep ? keep.fresh : true,
    };
    baseRun = null;
    run = null;
    setSliders(base.release);
    render();
  }

  // ---------- flying ----------
  async function fly() {
    if (busy || !base?.disc) return;
    busy = true;
    renderControls();
    const ctx = deps.getCtx();
    const fn = base.disc.fn;
    try {
      if (!baseRun) baseRun = summarize(await Flip.simulateRelease(base.release, fn, ctx));
      const r = current();
      const result = same(r, base.release) ? baseRun : summarize(await Flip.simulateRelease(r, fn, ctx));
      run = { release: r, result };
      $('wiError').textContent = '';
    } catch (e) {
      $('wiError').textContent = e.status === 401 ? 'Token rejected (401). Reconnect in Settings.' : `Sim failed: ${e.message}`;
    }
    busy = false;
    render();
  }

  function summarize({ pts, path }) {
    const end = path?.[path.length - 1];
    return {
      pts, path,
      zone: pts ? Flip.zoneOfTilt(Tilt.flattest(pts)) : null,
      turn: pts ? Tilt.flattest(pts) : null,
      dist: end ? Math.hypot(end.n, end.x) : null,
      side: end ? end.x : null,
      apex: path?.length ? Math.max(...path.map((p) => p.h)) : null,
    };
  }

  // ---------- explaining ----------
  // Plain cause and effect for each input you changed, biggest change first.
  function why(b, r) {
    const ds = r.speedMph - b.speedMph, dh = r.hyzerAngle - b.hyzerAngle, dn = r.noseAngle - b.noseAngle;
    const items = [];
    if (Math.abs(ds) >= 1) items.push({ w: Math.abs(ds) / 5, text: ds > 0
      ? `<b>${Math.round(ds)} mph faster</b>: more speed gives the disc's turn more time to work, so it rolls further toward anhyzer.`
      : `<b>${Math.round(-ds)} mph slower</b>: the turn has less time to work, so the disc holds its angle and fades sooner.` });
    if (Math.abs(dh) >= 1) items.push({ w: Math.abs(dh) / 5, text: dh > 0
      ? `<b>${Math.round(dh)}° more hyzer</b>: the disc starts tipped further, so it has further to flip before it reaches flat.`
      : `<b>${Math.round(-dh)}° less hyzer</b>: the disc starts closer to flat, so the same turn carries it further over.` });
    if (Math.abs(dn) >= 0.5) items.push({ w: Math.abs(dn) / 2, text: dn > 0
      ? `<b>Nose ${r1(dn)}° higher</b>: the disc meets the air tilted up, which adds drag. It slows sooner, climbs and fades earlier, and usually lands shorter.`
      : `<b>Nose ${r1(-dn)}° lower</b>: the disc slices through the air with less drag. It keeps its speed longer and usually carries farther.` });
    return items.sort((a, b2) => b2.w - a.w).map((x) => x.text);
  }

  // ---------- rendering ----------
  function render() {
    renderBase();
    renderControls();
    renderResult();
    drawPath();
    drawTilt();
  }

  function renderBase() {
    const d = base?.disc;
    const b = base?.release;
    if (!d) { $('wiBase').innerHTML = 'Pick a disc to start.'; return; }
    const from = base.fresh ? 'A sample release' : base.real ? 'Your last throw' : 'Your last demo throw';
    $('wiBase').innerHTML = `${from} with the <b>${esc(d.name)}</b>: <b>${Math.round(b.speedMph)} mph</b>, <b>${Tilt.word(b.hyzerAngle)}</b>, nose <b>${sign(b.noseAngle, 1)}°</b>. Change one thing and run a test flight.`;
  }

  function renderControls() {
    if (!base) return;
    const b = snap(base.release), r = current();
    const delta = (id, v, unit, digits = 0) => {
      const n = $(id);
      const dv = digits ? r1(v) : Math.round(v);
      n.textContent = dv ? `${sign(v, digits)}${unit}` : '';
      n.className = `delta${dv ? ' on' : ''}`;
    };
    $('wiSpeedOut').textContent = `${Math.round(r.speedMph)} mph`;
    $('wiHyzerOut').textContent = r.hyzerAngle === 0 ? 'flat' : r.hyzerAngle > 0 ? `${Math.round(r.hyzerAngle)}° hyzer` : `${Math.round(-r.hyzerAngle)}° anhyzer`;
    $('wiNoseOut').textContent = r.noseAngle === 0 ? 'level' : `${Math.abs(r.noseAngle)}° ${r.noseAngle > 0 ? 'up' : 'down'}`;
    delta('wiSpeedD', r.speedMph - b.speedMph, ' mph');
    delta('wiHyzerD', r.hyzerAngle - b.hyzerAngle, '°');
    delta('wiNoseD', r.noseAngle - b.noseAngle, '°', 1);
    const fly = $('wiFly');
    fly.disabled = busy || !base.disc;
    fly.textContent = busy ? 'Running test flight…' : 'Run test flight';
    const ctx = deps.getCtx();
    $('wiCost').textContent = ctx.demo ? 'Demo flight model' : `Uses ${baseRun ? 1 : 2} API call${baseRun ? '' : 's'}`;
    $('wiResult').classList.toggle('stale', !!run && !same(r, run.release));
  }

  function zonePill(z) {
    return z ? `<span class="pill ${z}">${Flip.ZONES[z].verb}</span>` : '<span class="no">-</span>';
  }
  const ft = (x) => (Number.isFinite(x) ? `${Math.round(x)} ft` : '-');
  const sideTxt = (x) => (!Number.isFinite(x) ? '-' : Math.abs(x) < 3 ? 'on line' : `${Math.round(Math.abs(x))} ft ${x < 0 ? 'left' : 'right'}`);

  function renderResult() {
    const box = $('wiResult');
    if (!run || !baseRun) {
      box.innerHTML = `<p class="wi-empty">Set speed, hyzer and nose, then press <b>Run test flight</b> to compare it with your throw. Nothing runs until you press it.</p>`;
      return;
    }
    const b = baseRun, w = run.result, br = base.release, r = run.release;
    const changed = !same(r, br);
    let head;
    if (!changed) head = `<h3>${w.zone ? Flip.ZONES[w.zone].verb : 'Your throw'}</h3><p>This is your release as thrown. Move a slider to compare.</p>`;
    else {
      const moved = b.zone && w.zone && b.zone !== w.zone;
      const dd = w.dist - b.dist;
      head = `<h3 class="${w.zone || ''}">${moved ? `Now it ${Flip.ZONES[w.zone].verb.toLowerCase()}` : w.zone ? `Still ${Flip.ZONES[w.zone].verb.toLowerCase()}` : 'Test flight'}</h3>` +
        `<p>${Number.isFinite(dd) ? `<b>${sign(dd)} ft</b> of distance` : ''}${Number.isFinite(w.side) && Number.isFinite(b.side) && Math.abs(w.side - b.side) >= 3 ? `, finishing <b>${Math.round(Math.abs(w.side - b.side))} ft further ${w.side - b.side < 0 ? 'left' : 'right'}</b>` : ''}.</p>`;
    }
    const reasons = changed ? why(snap(br), r) : [];
    const row = (label, a, c) => `<tr><th>${label}</th><td>${a}</td><td>${c}</td></tr>`;
    box.innerHTML = `<div class="wi-head">${head}</div>` +
      (reasons.length ? `<ul class="wi-why">${reasons.map((t) => `<li>${t}</li>`).join('')}</ul>` : '') +
      `<table class="wi-table"><thead><tr><th></th><th>Your throw</th><th>What if</th></tr></thead><tbody>
        ${row('Speed', `${Math.round(br.speedMph)} mph`, `${Math.round(r.speedMph)} mph`)}
        ${row('Hyzer', Tilt.word(br.hyzerAngle), Tilt.word(r.hyzerAngle))}
        ${row('Nose', `${sign(br.noseAngle, 1)}°`, `${sign(r.noseAngle, 1)}°`)}
        ${row('Flight', zonePill(b.zone), zonePill(w.zone))}
        ${row('Distance', ft(b.dist), ft(w.dist))}
        ${row('Finish', sideTxt(b.side), sideTxt(w.side))}
      </tbody></table>`;
  }

  // Top-down: your throw dashed, the What if coloured by what it did.
  function drawPath() {
    const svg = $('wiPath');
    svg.innerHTML = '';
    const W = 220, H = 300, top = 14, bottom = 284, cx = W / 2;
    const paths = [baseRun?.path, run?.result?.path].filter((p) => p?.length);
    const maxN = Math.max(150, ...paths.flat().map((p) => p.n));
    const maxX = Math.max(30, ...paths.flat().map((p) => Math.abs(p.x)));
    const s = Math.min((bottom - top) / maxN, (W / 2 - 14) / maxX);
    const X = (x) => cx + x * s, Y = (n) => bottom - n * s;
    const step = maxN > 450 ? 100 : 50;
    for (let n = step; n <= maxN; n += step) {
      el('line', { x1: 8, x2: W - 8, y1: Y(n), y2: Y(n), class: 'p-grid' }, svg);
      el('text', { x: 10, y: Y(n) - 3, class: 'p-lab' }, svg, `${n} ft`);
    }
    el('line', { x1: cx, x2: cx, y1: bottom, y2: top, class: 'p-aim' }, svg);
    el('circle', { cx, cy: bottom, r: 4, class: 'p-tee' }, svg);
    const line = (path, cls) => el('path', { d: path.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)} ${Y(p.n).toFixed(1)}`).join(' '), class: cls }, svg);
    if (baseRun?.path?.length) {
      line(baseRun.path, 'p-base');
      const e = baseRun.path[baseRun.path.length - 1];
      el('circle', { cx: X(e.x), cy: Y(e.n), r: 4, class: 'p-base-end' }, svg);
    }
    if (run && run.result !== baseRun && run.result.path?.length) {
      line(run.result.path, `p-if ${run.result.zone || ''}`);
      const e = run.result.path[run.result.path.length - 1];
      el('circle', { cx: X(e.x), cy: Y(e.n), r: 5, class: `p-if-end ${run.result.zone || ''}` }, svg);
    }
    if (!paths.length) el('text', { x: cx, y: H / 2, class: 'p-empty' }, svg, 'Flights show here');
  }

  function drawTilt() {
    const svg = $('wiTilt');
    svg.innerHTML = '';
    const W = 240, H = 120, L = 30, R = 6, T = 6, B = 16;
    const curves = [baseRun?.pts, run?.result !== baseRun ? run?.result?.pts : null].filter(Boolean);
    const all = curves.flat().map((p) => p.d);
    const lo = Math.min(-40, ...all), hi = Math.max(30, ...all);
    const y = (d) => T + (hi - d) / (hi - lo) * (H - T - B);
    el('rect', { x: L, y: T, width: W - L - R, height: y(Flip.FLAT_LINE) - T, class: 'c-band hyzer' }, svg);
    el('rect', { x: L, y: y(Flip.FLAT_LINE), width: W - L - R, height: y(Flip.FLIP_LINE) - y(Flip.FLAT_LINE), class: 'c-band flat' }, svg);
    el('rect', { x: L, y: y(Flip.FLIP_LINE), width: W - L - R, height: H - B - y(Flip.FLIP_LINE), class: 'c-band flip' }, svg);
    el('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), class: 'c-zero' }, svg);
    el('text', { x: 2, y: T + 9, class: 'c-lab' }, svg, 'HYZ');
    el('text', { x: 2, y: y(0) + 3, class: 'c-lab' }, svg, 'FLAT');
    el('text', { x: 2, y: H - B, class: 'c-lab' }, svg, 'ANH');
    el('text', { x: L, y: H - 3, class: 'c-lab' }, svg, 'release');
    el('text', { x: W - R, y: H - 3, class: 'c-lab', 'text-anchor': 'end' }, svg, 'landing');
    const draw = (pts, cls) => {
      const endT = pts[pts.length - 1].t || 1;
      const x = (t) => L + (t / endT) * (W - L - R);
      el('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.d).toFixed(1)}`).join(' '), class: cls }, svg);
    };
    if (baseRun?.pts) draw(baseRun.pts, 't-base');
    if (run && run.result !== baseRun && run.result.pts) draw(run.result.pts, 't-if');
  }

  // Load suggested values into the sliders without running anything.
  function preset(r) {
    if (!base) return;
    if (Number.isFinite(r.speedMph)) $("wiSpeed").value = Math.round(r.speedMph);
    if (Number.isFinite(r.hyzerAngle)) $("wiHyzer").value = Math.round(r.hyzerAngle);
    if (Number.isFinite(r.noseAngle)) $("wiNose").value = Math.round(r.noseAngle * 2) / 2;
    renderControls();
  }

  return { init, setBase, preset };
})();
