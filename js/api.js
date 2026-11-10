// Thin client for the TechDisc v2 API (https://api.techdisc.com/v2/docs/).
// Same request shapes as the Disc Elo app next door.
const TechDiscAPI = (() => {
  const BASE = 'https://api.techdisc.com';

  async function request(path, { token, method = 'GET', body, signal } = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });

    if (res.status === 204) return null;
    if (res.status === 202) return { pending: true };
    if (!res.ok) {
      let message = res.statusText;
      try {
        const j = await res.json();
        message = j.error || j.message || message;
      } catch { /* non-JSON error body */ }
      const err = new Error(`${res.status}: ${message}`);
      err.status = res.status;
      err.retryAfter = Number(res.headers.get('Retry-After')) || null;
      throw err;
    }
    return res.json();
  }

  return {
    time: (token) => request('/v2/time', { token }),
    latestThrow: (token) => request('/v2/throws/latest', { token }),
    // Long poll: resolves with the next throw, or null after ~60 s with nothing new.
    waitForThrow: (token, cursor, signal) => {
      const q = cursor.id
        ? `after_id=${encodeURIComponent(cursor.id)}`
        : `after_time=${Math.floor(cursor.time)}`;
      return request(`/v2/throws/latest/wait?${q}`, { token, signal });
    },
    discs: (token) => request('/v2/discs', { token }),
    simulate: (token, body) => request('/v2/flights', { token, method: 'POST', body }),
  };
})();
