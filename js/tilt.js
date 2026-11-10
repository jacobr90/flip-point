// Disc tilt over a simulated flight, read from the simulator's orientation quaternions.
// Tilt is in "hyzer degrees": positive is hyzer, negative anhyzer.
const Tilt = (() => {
  const HYZER_SIDE = { RHBH: -1, LHFH: -1, RHFH: 1, LHBH: 1 };

  // One sample's quaternion as [w, x, y, z], whichever layout the API sent.
  function quatAt(f, i) {
    if (Array.isArray(f.qw)) return [f.qw[i], f.qx?.[i], f.qy?.[i], f.qz?.[i]];
    const q = f.q?.[i] ?? f.quaternions?.[i] ?? f.orientation?.[i];
    if (Array.isArray(q) && q.length === 4) return q;
    if (q && typeof q === 'object') return [q.w ?? q.qw, q.x ?? q.qx, q.y ?? q.qy, q.z ?? q.qz];
    return null;
  }

  // Horizontal heading at sample i, from the velocity or else the path.
  function headingAt(f, i) {
    const v = f.v?.[i];
    let dn, dw;
    if (Array.isArray(v) && Number.isFinite(v[0])) [dn, dw] = v;
    else {
      const a = f.p[Math.max(i - 1, 0)], b = f.p[Math.min(i + 1, f.p.length - 1)];
      dn = b[0] - a[0]; dw = b[1] - a[1];
    }
    const len = Math.hypot(dn, dw);
    return len > 1e-6 ? [dn / len, dw / len] : [1, 0];
  }

  // Tilt per sample of a sim flight, or null when the flight has no orientation.
  // releaseHyzer (the release angle sent to the sim) fixes the sign if the frames disagree.
  function fromFlight(flight, style, releaseHyzer) {
    if (!flight?.p?.length || !quatAt(flight, 0)) return null;
    const side = HYZER_SIDE[style] ?? -1;
    const out = [];
    let prev = null;
    for (let i = 0; i < flight.p.length; i++) {
      const q = quatAt(flight, i);
      if (!q || !q.every(Number.isFinite)) { out.push(prev); continue; }
      const [w, x, y, z] = q;
      // Disc-local +Z (top of the flight plate) in north-west-up.
      const nN = 2 * (x * z + w * y), nW = 2 * (y * z - w * x), nU = 1 - 2 * (x * x + y * y);
      const [hn, hw] = headingAt(flight, i);
      const towardLeft = nN * -hw + nW * hn;
      const bankLeft = Math.atan2(towardLeft, nU) * 180 / Math.PI;
      let deg = side === -1 ? bankLeft : -bankLeft;
      if (prev != null) { while (deg - prev > 180) deg -= 360; while (deg - prev < -180) deg += 360; }
      out.push(deg);
      prev = deg;
    }
    const first = out.find(Number.isFinite);
    if (first == null) return null;
    if (Number.isFinite(releaseHyzer) && Math.abs(releaseHyzer) >= 4 && Math.abs(first) >= 4 && Math.sign(first) !== Math.sign(releaseHyzer)) {
      return out.map((d) => (d == null ? d : -d));
    }
    return out;
  }

  // Sim flight -> [{t, d}] tilt samples, cut at first ground contact.
  function curve(flight, style, releaseHyzer) {
    const tilt = fromFlight(flight, style, releaseHyzer);
    if (!tilt) return null;
    const p = flight.p, t = flight.t || p.map((_, i) => i * 0.01);
    let end = p.length;
    for (let i = 1; i < p.length; i++) if (p[i][2] <= 0 && p[i - 1][2] > 0) { end = i + 1; break; }
    const out = [];
    for (let i = 0; i < end; i++) if (Number.isFinite(tilt[i])) out.push({ t: t[i], d: tilt[i] });
    return out.length >= 3 ? out : null;
  }

  // The most anhyzer the disc got before the late fade: the "turn" of the flight.
  function flattest(pts) {
    const endT = pts[pts.length - 1].t || 1;
    const early = pts.filter((x) => x.t <= endT * 0.8);
    return Math.min(...(early.length ? early : pts).map((x) => x.d));
  }

  function at(pts, t) {
    if (!pts?.length) return 0;
    if (t <= pts[0].t) return pts[0].d;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t >= t) {
        const a = pts[i - 1], b = pts[i];
        return a.d + (b.d - a.d) * ((t - a.t) / Math.max(b.t - a.t, 1e-6));
      }
    }
    return pts[pts.length - 1].d;
  }

  function word(d) {
    if (d >= 4.5) return `${Math.round(d)}° hyzer`;
    if (d <= -4.5) return `${Math.round(-d)}° anhyzer`;
    return 'flat';
  }

  return { HYZER_SIDE, fromFlight, curve, flattest, at, word };
})();
