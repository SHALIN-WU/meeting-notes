const WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;
const MAX_FAILS = 5;

const memory = new Map();
let memoryChain = Promise.resolve();

export async function registerAttempt(env, ip, passwordMatched) {
  const key = `login:${ip || 'unknown'}`;
  if (env?.RATE_LIMIT) return updateKv(env.RATE_LIMIT, key, passwordMatched);
  const run = memoryChain.then(() => updateMemory(key, passwordMatched), () => updateMemory(key, passwordMatched));
  memoryChain = run.then(() => undefined, () => undefined);
  return run;
}

function decide(current, passwordMatched, now) {
  const active = normalize(current, now);
  if (active?.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSec: Math.ceil((active.lockedUntil - now) / 1000),
      remaining: 0,
      next: active
    };
  }
  if (passwordMatched) {
    return { locked: false, retryAfterSec: 0, remaining: MAX_FAILS, next: null };
  }
  const fails = (active?.fails || 0) + 1;
  const windowStart = active?.windowStart || now;
  if (fails >= MAX_FAILS) {
    const lockedUntil = now + LOCK_MS;
    return {
      locked: true,
      retryAfterSec: Math.ceil(LOCK_MS / 1000),
      remaining: 0,
      next: { fails, lockedUntil, windowStart }
    };
  }
  return {
    locked: false,
    retryAfterSec: 0,
    remaining: MAX_FAILS - fails,
    next: { fails, lockedUntil: 0, windowStart }
  };
}

function normalize(record, now) {
  if (!record || typeof record !== 'object') return null;
  const lockedUntil = Number(record.lockedUntil) || 0;
  if (lockedUntil > now) {
    return {
      fails: MAX_FAILS,
      lockedUntil,
      windowStart: Number(record.windowStart) || now
    };
  }
  const windowStart = Number(record.windowStart) || 0;
  const fails = Number(record.fails) || 0;
  if (!windowStart || now - windowStart > WINDOW_MS || fails <= 0) return null;
  return { fails, lockedUntil: 0, windowStart };
}

function updateMemory(key, passwordMatched) {
  const outcome = decide(memory.get(key), passwordMatched, Date.now());
  if (outcome.next) memory.set(key, outcome.next);
  else memory.delete(key);
  return outcome;
}

async function updateKv(kv, key, passwordMatched) {
  const now = Date.now();
  const outcome = decide(await kv.get(key, 'json'), passwordMatched, now);
  if (!outcome.next) {
    await kv.delete(key);
    return outcome;
  }
  const ttl = outcome.next.lockedUntil > now
    ? Math.max(60, Math.ceil((outcome.next.lockedUntil - now) / 1000) + 60)
    : Math.max(60, Math.ceil(WINDOW_MS / 1000));
  await kv.put(key, JSON.stringify(outcome.next), { expirationTtl: ttl });
  return outcome;
}
