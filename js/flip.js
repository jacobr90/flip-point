// Flip points: for each disc, the arm speed where a hyzer release stops holding
// its hyzer and flips up to flat, and where it turns all the way over.
//
// A disc's profile comes from a speed sweep through the TechDisc simulator: the
// same release (your reference hyzer angle, nose 0, your spin-per-mph) thrown at
// 20-85 mph. Each flight gives one number, the most anhyzer the disc got before
// its late fade. That number falls smoothly as speed rises, so the flip points
// are where it crosses the zone lines, found by straight-line interpolation.
const Flip = (() => {
  const MIN = 20, MAX = 85;
  const SPEEDS = [20, 28, 36, 44, 52, 60, 68, 76, 85];
  const FLAT_LINE = 5;      // tilt at or above this through the turn: still hyzer
  const FLIP_LINE = -15;    // tilt at or below this: turned over
  const VERSION = 1;

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
    return { points: pts, flat: crossing(pts, FLAT_LINE), flip: crossing(pts, FLIP_LINE) };
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

  function cancelMapping() {
    const dropped = queue.lo.splice(0);
    dropped.forEach((j) => j.reject(Object.assign(new Error('cancelled'), { cancelled: true })));
  }

  // ---------- profiles ----------
  const CACHE_KEY = 'flipPoint.profiles';
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { cache = {}; }
  const saveCache = () => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* storage off */ } };
  const inFlight = new Map();

  function keyFor(fn, ctx) {
    const f = [fn.speed, fn.glide, fn.turn, fn.fade].map((x) => x ?? '-').join('/');
    return `v${VERSION}|${ctx.demo ? 'demo' : 'api'}|${f}|w${fn.weight ?? '-'}|H${ctx.hyzer}|s${ctx.spinPerMph.toFixed(1)}${ctx.spinSign < 0 ? '-' : '+'}|${ctx.style}`;
  }

  const cached = (fn, ctx) => cache[keyFor(fn, ctx)] || null;
  const mapping = (fn, ctx) => inFlight.get(keyFor(fn, ctx)) || null;

  function clearCache() { cache = {}; saveCache(); }

  // Sweep one disc. onPoint(profile) fires as each speed comes back.
  function map(fn, ctx, onPoint, { hi = false } = {}) {
    const key = keyFor(fn, ctx);
    if (cache[key]) return Promise.resolve(cache[key]);
    if (inFlight.has(key)) return inFlight.get(key).promise;

    const live = { points: [], total: SPEEDS.length, done: 0, promise: null };
    live.promise = (async () => {
      let lastErr = null;
      for (const v of SPEEDS) {
        let f = null;
        try {
          f = await schedule(() => sweepPoint(fn, ctx, v), { hi, free: ctx.demo });
        } catch (e) {
          if (e.cancelled || e.status === 401) throw e;
          lastErr = e;
        }
        live.done++;
        if (f != null) live.points.push({ v, f: Math.round(f * 10) / 10 });
        onPoint?.({ ...summarize(live.points), partial: true, done: live.done, total: live.total });
        // Once it has turned well over, faster throws only turn it more.
        if (f != null && f <= FLIP_LINE - 15) break;
      }
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
    if (ctx.demo) { await sleep(90); return Demo.flattest(fn, ctx.hyzer, v); }
    const flight = await TechDiscAPI.simulate(ctx.token, {
      speedMph: v,
      spinRpm: Math.round(ctx.spinSign * v * ctx.spinPerMph),
      launchAngle: 10,
      hyzerAngle: ctx.hyzer,
      noseAngle: 0,
      wobble: 0,
      flightNumbers: fn,
      maxVerticalDrop: 1.5,
    });
    const pts = Tilt.curve(flight, ctx.style, ctx.hyzer);
    return pts ? Tilt.flattest(pts) : null;
  }

  // Simulate a real measured throw (live mode).
  async function simulateThrow(shot, fn, ctx) {
    if (ctx.demo) return Demo.flight(fn, shot.hyzerAngle, shot.speedMph);
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
    return Tilt.curve(flight, ctx.style, shot.hyzerAngle);
  }

  // ---------- demo physics (no account needed) ----------
  // A rough stand-in for the simulator so the app can be tried without a token:
  // more turn and less speed rating means it flips at lower arm speed.
  const Demo = {
    flattest(fn, hyzer, v) {
      const turn = Math.max(0, -(fn.turn ?? 0));
      const fade = fn.fade ?? 1;
      const k = turn * 9 + 4;
      const vRef = 8 * Math.sqrt(Math.max(fn.speed ?? 7, 1)) + 20;
      return hyzer + fade * 2 - k * (v / vRef) ** 2 - (hyzer - 15) * 0.2;
    },
    flight(fn, hyzer, v) {
      const F = Math.min(this.flattest(fn, hyzer, v), hyzer);
      const fade = (fn.fade ?? 1) * 6;
      const T = 2 + v / 30, n = 60;
      const sm = (a, b, x) => { const u = Math.min(Math.max((x - a) / (b - a), 0), 1); return u * u * (3 - 2 * u); };
      return Array.from({ length: n + 1 }, (_, i) => {
        const s = i / n;
        return { t: s * T, d: hyzer + (F - hyzer) * sm(0, 0.55, s) + (F > -60 ? fade * sm(0.82, 1, s) : 0) };
      });
    },
  };

  return {
    MIN, MAX, SPEEDS, FLAT_LINE, FLIP_LINE, ZONES,
    zoneOfTilt, zoneAt, band, fmtMph, summarize,
    map, cached, mapping, clearCache, cancelMapping, simulateThrow, schedule,
    callsThisHour, pending, HOUR_CAP, onStatus: (fn) => listeners.add(fn),
  };
})();
