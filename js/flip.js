// Flip points: for each disc, the arm speed where a hyzer release stops holding
// its hyzer and flips up to flat, and where it turns all the way over.
//
// A disc's profile comes from a speed sweep through the TechDisc simulator: the
// same release (your chart hyzer and nose angles, your spin-per-mph) thrown at
// 20-85 mph. Each flight gives one number, the most anhyzer the disc got before
// its late fade. That number falls smoothly as speed rises, so the flip points
// are where it crosses the zone lines, found by straight-line interpolation.
//
// To save API calls the sweep is adaptive: 4 coarse speeds, then one extra speed
// halfway inside each gap where a flip point falls. At most 6 calls per disc.
const Flip = (() => {
  const MIN = 20, MAX = 85;
  const COARSE = [20, 42, 64, 85];
  const MAX_CALLS = COARSE.length + 2;
  const FLAT_LINE = 5;      // tilt at or above this through the turn: still hyzer
  const FLIP_LINE = -15;    // tilt at or below this: turned over
  const VERSION = 2;   // 2: sweep points carry distance

  const ZONES = {
    hyzer: { key: 'hyzer', label: 'Hyzer', verb: 'Held hyzer', blurb: 'Too slow to flip. The disc held its hyzer and faded out.' },
    flat:  { key: 'flat',  label: 'Flat',  verb: 'Flipped to flat', blurb: 'Speed flipped the disc up off its hyzer to flat. The sweet spot for a straight line.' },
    flip:  { key: 'flip',  label: 'Flip',  verb: 'Flipped over', blurb: 'So much speed the disc turned past flat onto anhyzer.' },
  };

  const zoneOfTilt = (f) => (f >= FLAT_LINE ? 'hyzer' : f > FLIP_LINE ? 'flat' : 'flip');

  // Speed where the sweep first drops to thr: -Infinity if already below at
  // the slowest speed, Infinity if it never gets there.
  function crossing(points, thr) {
    if (!points.length) return null;
    if (points[0].f <= thr) return -Infinity;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (b.f <= thr) return a.v + (b.v - a.v) * ((a.f - thr) / Math.max(a.f - b.f, 1e-6));
    }
    return Infinity;
  }

  function summarize(points) {
    const pts = [...points].sort((a, b) => a.v - b.v);
    // The longest carry in the sweep, and which flight shape produced it.
    const withD = pts.filter((p) => Number.isFinite(p.d));
    const top = withD.length ? withD.reduce((a, b) => (b.d > a.d ? b : a)) : null;
    return {
      points: pts, flat: crossing(pts, FLAT_LINE), flip: crossing(pts, FLIP_LINE),
      best: top ? { v: top.v, d: top.d, x: top.x, zone: zoneOfTilt(top.f) } : null,
    };
  }

  // Estimated carry (ft) at any speed, read between the sweep's speeds.
  function distAt(p, v) {
    const pts = p?.points?.filter((q) => Number.isFinite(q.d));
    if (!pts?.length) return null;
    if (v <= pts[0].v) return pts[0].d * (v / pts[0].v);
    for (let i = 1; i < pts.length; i++) {
      if (v <= pts[i].v) {
        const a = pts[i - 1], b = pts[i];
        return a.d + (b.d - a.d) * ((v - a.v) / (b.v - a.v));
      }
    }
    return pts[pts.length - 1].d;
  }

  // Carry range across a zone's speed band.
  function distBand(p, zone) {
    const b = band(p, zone);
    if (!b) return null;
    const ds = [b[0], ...(p.points || []).map((q) => q.v).filter((v) => v > b[0] && v < b[1]), b[1]].map((v) => distAt(p, v)).filter(Number.isFinite);
    return ds.length ? [Math.min(...ds), Math.max(...ds)] : null;
  }

  // Which zone a speed lands in for a mapped disc.
  function zoneAt(p, v) {
    if (!p || p.flat == null) return null;
    if (v < p.flat) return 'hyzer';
    if (v < p.flip) return 'flat';
    return 'flip';
  }

  // The speed band for a zone, clipped to the sweep range.
  function band(p, zone) {
    if (!p) return null;
    const lo = { hyzer: MIN, flat: p.flat, flip: p.flip }[zone];
    const hi = { hyzer: p.flat, flat: p.flip, flip: MAX }[zone];
    const a = Math.max(MIN, Math.min(MAX, lo)), b = Math.max(MIN, Math.min(MAX, hi));
    return b > a ? [a, b] : null;
  }

  const fmtMph = (x) => (x === -Infinity ? `<${MIN}` : x === Infinity ? `${MAX}+` : `${Math.round(x)}`);

  // ---------- request pacing ----------
  // The API allows 60 requests a minute and 1,000 an hour per account, with the
  // throw long-poll counting too. Sims go out one at a time, at most ~50 a minute,
  // and live throws jump ahead of bag mapping.
  const GAP_MS = 1200;
  const HOUR_CAP = 900;
  const CALLS_KEY = 'flipPoint.calls';
  const queue = { hi: [], lo: [] };
  let pumping = false, lastAt = 0;
  const listeners = new Set();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function callLog() {
    try {
      const cut = Date.now() - 3600e3;
      return (JSON.parse(localStorage.getItem(CALLS_KEY)) || []).filter((t) => t > cut);
    } catch { return []; }
  }
  function noteCall() {
    const log = callLog(); log.push(Date.now());
    try { localStorage.setItem(CALLS_KEY, JSON.stringify(log)); } catch { /* storage off */ }
  }
  const callsThisHour = () => callLog().length;
  const pending = () => queue.hi.length + queue.lo.length;
  const emit = (msg) => listeners.forEach((fn) => fn(msg));

  function schedule(fn, { hi = false, free = false } = {}) {
    return new Promise((resolve, reject) => {
      (hi ? queue.hi : queue.lo).push({ fn, resolve, reject, free });
      pump();
    });
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.hi.length || queue.lo.length) {
      const job = queue.hi.length ? queue.hi.shift() : queue.lo.shift();
      if (!job.free) {
        const wait = lastAt + GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        while (callsThisHour() >= HOUR_CAP) {
          emit({ type: 'budget', text: 'Hourly sim budget used. Waiting for it to free up.' });
          await sleep(30e3);
        }
        lastAt = Date.now();
        noteCall();
      }
      try {
        job.resolve(await job.fn());
      } catch (e) {
        if (e.status === 429) {
          const s = e.retryAfter || 30;
          emit({ type: 'budget', text: `Rate limited. Retrying in ${s}s.` });
          queue.hi.unshift(job);
          await sleep(s * 1000);
        } else job.reject(e);
      }
      emit({ type: 'tick' });
    }
    pumping = false;
  }

  // Stop all mapping: drop queued sweep sims, and tell running sweeps to quit
  // before their next sim (a sim already sent still finishes).
  let generation = 0;
  const cancelled = () => Object.assign(new Error('cancelled'), { cancelled: true });
  function cancelMapping() {
    generation++;
    const dropped = queue.lo.splice(0);
    dropped.forEach((j) => j.reject(cancelled()));
  }

  // ---------- profiles ----------
  const CACHE_KEY = 'flipPoint.profiles';
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { cache = {}; }
  const saveCache = () => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* storage off */ } };
  const inFlight = new Map();

  function keyFor(fn, ctx) {
    const f = [fn.speed, fn.glide, fn.turn, fn.fade].map((x) => x ?? '-').join('/');
    return `v${VERSION}|${ctx.demo ? 'demo' : 'api'}|${f}|w${fn.weight ?? '-'}|H${ctx.hyzer}|N${ctx.nose ?? 0}|s${ctx.spinPerMph.toFixed(1)}${ctx.spinSign < 0 ? '-' : '+'}|${ctx.style}`;
  }

  // JSON turns Infinity ("never flips in range") into null, so rebuild the flip
  // points from the saved sweep when reading a profile back.
  function cached(fn, ctx) {
    const p = cache[keyFor(fn, ctx)];
    if (!p?.points?.length) return null;
    if (p.flat == null || p.flip == null) Object.assign(p, summarize(p.points));
    return p;
  }
  const mapping = (fn, ctx) => inFlight.get(keyFor(fn, ctx)) || null;

  function clearCache() { cache = {}; saveCache(); }

  // Sweep one disc. onPoint(profile) fires as each speed comes back.
  function map(fn, ctx, onPoint, { hi = false } = {}) {
    const key = keyFor(fn, ctx);
    if (cache[key]) return Promise.resolve(cache[key]);
    if (inFlight.has(key)) return inFlight.get(key).promise;

    const live = { points: [], total: MAX_CALLS, done: 0, promise: null };
    live.promise = (async () => {
      let lastErr = null;
      const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
      const gen = generation;
      const sample = async (v) => {
        if (gen !== generation) throw cancelled();
        let s = null;
        try {
          s = await schedule(() => sweepPoint(fn, ctx, v), { hi, free: ctx.demo });
        } catch (e) {
          if (e.cancelled || e.status === 401) throw e;
          lastErr = e;
        }
        live.done++;
        const f = s?.f ?? null;
        if (f != null) live.points.push({ v, f: r1(f), d: r1(s.d), x: r1(s.x) });
        onPoint?.({ ...summarize(live.points), partial: true, done: live.done, total: live.total });
        return f;
      };
      let coarse = 0;
      for (const v of COARSE) {
        coarse++;
        const f = await sample(v);
        // Once it has turned well over, faster throws only turn it more.
        if (f != null && f <= FLIP_LINE - 15) break;
      }
      // Refine: one more speed inside each gap that holds a flip point.
      const sorted = () => [...live.points].sort((a, b) => a.v - b.v);
      const refine = [];
      for (const thr of [FLAT_LINE, FLIP_LINE]) {
        const pts = sorted();
        for (let i = 1; i < pts.length; i++) {
          if (pts[i - 1].f > thr && pts[i].f <= thr && pts[i].v - pts[i - 1].v > 8) {
            const mid = Math.round((pts[i - 1].v + pts[i].v) / 2);
            if (!refine.includes(mid)) refine.push(mid);
            break;
          }
        }
      }
      live.total = coarse + refine.length;
      for (const v of refine) await sample(v);
      if (!live.points.length) throw lastErr || new Error('The sim returned no disc orientation, so tilt could not be read.');
      const prof = { ...summarize(live.points), at: Date.now() };
      cache[key] = prof;
      saveCache();
      return prof;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, live);
    return live.promise;
  }

  async function sweepPoint(fn, ctx, v) {
    if (ctx.demo) {
      await sleep(90);
      const pts = Demo.flight(fn, ctx.hyzer, v, ctx.nose ?? 0);
      return { f: Tilt.flattest(pts), ...carry(Demo.path(fn, pts, { speedMph: v, noseAngle: ctx.nose ?? 0, launchAngle: 10 }, ctx.style)) };
    }
    const flight = await TechDiscAPI.simulate(ctx.token, {
      speedMph: v,
      spinRpm: Math.round(ctx.spinSign * v * ctx.spinPerMph),
      launchAngle: 10,
      hyzerAngle: ctx.hyzer,
      noseAngle: ctx.nose ?? 0,
      wobble: 0,
      flightNumbers: fn,
      maxVerticalDrop: 1.5,
    });
    const pts = Tilt.curve(flight, ctx.style, ctx.hyzer);
    return pts ? { f: Tilt.flattest(pts), ...carry(pathFeet(flight)) } : null;
  }

  // Where a flight lands: straight-line carry from the tee and its left/right finish (ft).
  function carry(path) {
    const end = path?.[path.length - 1];
    return end ? { d: Math.hypot(end.n, end.x), x: end.x } : { d: null, x: null };
  }

  // Simulate a real measured throw (live mode). Returns { pts, path }.
  async function simulateThrow(shot, fn, ctx) {
    if (ctx.demo) {
      const pts = Demo.flight(fn, shot.hyzerAngle, shot.speedMph, shot.noseAngle || 0);
      return { pts, path: Demo.path(fn, pts, shot, ctx.style) };
    }
    const body = {
      speedMph: shot.speedMph,
      spinRpm: shot.spinRpm,
      launchAngle: shot.launchAngle,
      ...(shot.releaseState
        ? { releaseState: shot.releaseState }
        : { hyzerAngle: shot.hyzerAngle, noseAngle: shot.noseAngle, wobble: shot.wobble ?? 0 }),
      ...(typeof shot.upsideDown === 'boolean' ? { upsideDown: shot.upsideDown } : {}),
      flightNumbers: fn,
      maxVerticalDrop: 1.5,
    };
    const flight = await schedule(() => TechDiscAPI.simulate(ctx.token, body), { hi: true });
    return { pts: Tilt.curve(flight, ctx.style, shot.hyzerAngle), path: pathFeet(flight) };
  }

  // Simulate a release built from plain numbers (the What if explorer).
  // Always sends explicit angles, never releaseState, so every input is the one shown.
  // Returns { pts: tilt curve, path: [{t, n, x, h}] in feet (x is right of the throw line) }.
  const FT = 3.28084;
  async function simulateRelease(r, fn, ctx) {
    if (ctx.demo) {
      const pts = Demo.flight(fn, r.hyzerAngle, r.speedMph, r.noseAngle);
      return { pts, path: Demo.path(fn, pts, r, ctx.style) };
    }
    const body = {
      speedMph: r.speedMph,
      spinRpm: r.spinRpm,
      launchAngle: r.launchAngle,
      hyzerAngle: r.hyzerAngle,
      noseAngle: r.noseAngle,
      wobble: r.wobble ?? 0,
      flightNumbers: fn,
      maxVerticalDrop: 1.5,
    };
    const flight = await schedule(() => TechDiscAPI.simulate(ctx.token, body), { hi: true });
    return { pts: Tilt.curve(flight, ctx.style, r.hyzerAngle), path: pathFeet(flight) };
  }

  // Sim samples (metres, north-west-up) to feet, cut where the disc reaches the ground.
  function pathFeet(flight) {
    const p = flight?.p || [], t = flight?.t || p.map((_, i) => i * 0.01);
    const out = [];
    for (let i = 0; i < p.length; i++) {
      const [n, w, u] = p[i];
      if (i > 0 && u <= 0 && p[i - 1][2] > 0) {
        const [n0, w0, u0] = p[i - 1];
        const f = u0 / (u0 - u);
        out.push({ t: t[i - 1] + f * (t[i] - t[i - 1]), n: (n0 + f * (n - n0)) * FT, x: -(w0 + f * (w - w0)) * FT, h: 0 });
        break;
      }
      out.push({ t: t[i], n: n * FT, x: -w * FT, h: Math.max(u, 0) * FT });
    }
    return out;
  }

  // ---------- demo physics (no account needed) ----------
  // A rough stand-in for the simulator so the app can be tried without a token:
  // more turn and less speed rating means it flips at lower arm speed; nose up
  // adds drag, so the disc turns less, fades harder and lands shorter.
  const Demo = {
    flattest(fn, hyzer, v, nose = 0) {
      const turn = Math.max(0, -(fn.turn ?? 0));
      const fade = fn.fade ?? 1;
      const k = turn * 9 + 4;
      const vRef = 8 * Math.sqrt(Math.max(fn.speed ?? 7, 1)) + 20;
      return hyzer + fade * 2 - k * (v / vRef) ** 2 - (hyzer - 15) * 0.2 + nose * 1.2;
    },
    path(fn, pts, r, style) {
      const v = r.speedMph, nose = r.noseAngle || 0;
      const side = Tilt.HYZER_SIDE[style] ?? -1;
      const noseF = 1 - 0.045 * Math.max(nose, 0) + 0.015 * Math.min(-nose, 4) - 0.04 * Math.max(-nose - 4, 0);
      const F = Tilt.flattest(pts);
      // Turning over costs carry (it rolls and drops); a held hyzer fades out a bit short.
      const shape = F < FLIP_LINE ? Math.max(0.55, 1 - (FLIP_LINE - F) * 0.014) : F >= FLAT_LINE ? 0.93 - Math.min(F - FLAT_LINE, 20) * 0.004 : 1;
      // Past its speed rating a disc gains little: a putter thrown at 70 mph is not a driver.
      const vMax = 30 + 5 * (fn.speed ?? 7);
      const vEff = v <= vMax ? v : vMax + (v - vMax) * 0.25;
      const D = (4.3 * vEff + (fn.glide ?? 4) * 9) * Math.max(noseF, 0.5) * shape;
      const H = 8 + 0.22 * v + 1.5 * nose + 0.3 * (r.launchAngle ?? 10);
      const T = pts[pts.length - 1].t || 1;
      let lat = 0, vel = 0;
      return pts.map((p, i) => {
        const s = p.t / T;
        if (i) { vel += side * p.d * 0.0006 * D / pts.length; lat += vel; }
        return { t: p.t, n: D * (1 - (1 - s) ** 1.5), x: lat, h: Math.max(0, 5 + H * Math.sin(Math.PI * Math.min(s * 1.1, 1)) - 5 * s) };
      });
    },
    flight(fn, hyzer, v, nose = 0) {
      const F = Math.min(this.flattest(fn, hyzer, v, nose), hyzer);
      const fade = (fn.fade ?? 1) * 6 * (1 + 0.08 * Math.max(nose, -5));
      const T = 2 + v / 30, n = 60;
      const sm = (a, b, x) => { const u = Math.min(Math.max((x - a) / (b - a), 0), 1); return u * u * (3 - 2 * u); };
      return Array.from({ length: n + 1 }, (_, i) => {
        const s = i / n;
        return { t: s * T, d: hyzer + (F - hyzer) * sm(0, 0.55, s) + (F > -60 ? fade * sm(0.82, 1, s) : 0) };
      });
    },
  };

  return {
    MIN, MAX, MAX_CALLS, FLAT_LINE, FLIP_LINE, ZONES,
    zoneOfTilt, zoneAt, band, fmtMph, summarize, distAt, distBand, carry,
    map, cached, mapping, clearCache, cancelMapping, simulateThrow, simulateRelease, schedule,
    callsThisHour, pending, HOUR_CAP, onStatus: (fn) => listeners.add(fn),
  };
})();
