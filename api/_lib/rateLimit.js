// api/_lib/rateLimit.js
// Factory untuk bikin in-memory rate limiter per-IP + global, dipakai di
// beberapa endpoint (chat.js pakai versi sendiri yang sudah teruji; endpoint
// FITUR BARU yang 100% premium-only pakai factory ini biar konsisten).
//
// Catatan yang sama seperti di chat.js: ini in-memory, bukan pengganti hard
// spend limit di console.anthropic.com.

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function makeRateLimiter({ maxPerIpPerDay, maxGlobalPerDay }) {
  const usageStore = new Map();
  const globalUsageStore = new Map();

  return function check(req) {
    const day = todayKey();
    const ip = getClientIp(req);
    const ipKey = `${ip}|${day}`;

    const globalCount = globalUsageStore.get(day) || 0;
    if (globalCount >= maxGlobalPerDay) {
      return { allowed: false, reason: 'global' };
    }

    const ipCount = usageStore.get(ipKey) || 0;
    if (ipCount >= maxPerIpPerDay) {
      return { allowed: false, reason: 'ip' };
    }

    usageStore.set(ipKey, ipCount + 1);
    globalUsageStore.set(day, globalCount + 1);
    if (usageStore.size > 5000) usageStore.clear();

    return { allowed: true, remaining: maxPerIpPerDay - (ipCount + 1) };
  };
}

module.exports = { makeRateLimiter, getClientIp, todayKey };
