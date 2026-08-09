// Mirrors the per-name retry gate in src/App.jsx (headshotRetryDelay +
// resolveHeadshots' filter/stamp/recordOutcome) so the backoff schedule can be
// exercised without a browser or the network.
const HEADSHOT_RETRY_MS = 60 * 1000;
const HEADSHOT_MAX_RETRY_MS = 30 * 60 * 1000;
const headshotRetryDelay = (misses = 0) =>
  Math.min(HEADSHOT_RETRY_MS * 2 ** Math.max(0, misses - 1), HEADSHOT_MAX_RETRY_MS);

// Simulated client: `resolvable` is the set the API can answer for.
function makeClient(resolvable) {
  const attempts = new Map();
  let requests = 0;
  return {
    get requests() { return requests; },
    delayFor: (n) => headshotRetryDelay(attempts.get(n)?.misses),
    // Returns true if a request went out at time `now`.
    resolve(names, now) {
      const toFetch = names.filter(n => {
        const prev = attempts.get(n);
        if (!prev) return true;
        return (now - prev.at) >= headshotRetryDelay(prev.misses);
      });
      if (!toFetch.length) return false;
      toFetch.forEach(n => attempts.set(n, { at: now, misses: attempts.get(n)?.misses ?? 0 }));
      requests++;
      const resolved = new Set(toFetch.filter(n => resolvable.has(n)));
      toFetch.forEach(n => {
        const prev = attempts.get(n);
        attempts.set(n, { at: prev.at, misses: resolved.has(n) ? 0 : prev.misses + 1 });
      });
      return true;
    },
  };
}

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name + ' ' + extra));
};

// ── Schedule ──────────────────────────────────────────────────────────────
check('0 misses -> 60s (base window preserved for self-heal)', headshotRetryDelay(0) === 60_000);
check('1 miss  -> 60s',  headshotRetryDelay(1) === 60_000);
check('2 misses -> 2m',  headshotRetryDelay(2) === 120_000);
check('3 misses -> 4m',  headshotRetryDelay(3) === 240_000);
check('5 misses -> 16m', headshotRetryDelay(5) === 960_000);
check('6 misses -> capped at 30m', headshotRetryDelay(6) === 1_800_000);
check('50 misses -> still 30m (no runaway)', headshotRetryDelay(50) === 1_800_000);

// ── The bug this fixes: an unresolvable player polled forever ─────────────
// Sweep ticks every 60s for 4 hours against a player nobody can resolve.
const ghost = makeClient(new Set());
let now = 0;
for (let tick = 0; tick < 240; tick++) { ghost.resolve(['Ghost Player'], now); now += 60_000; }
// Schedule: t=0, 1m, 3m, 7m, 15m, 31m, then every 30m -> 12 requests in 4h.
check('4h of 60s ticks -> 12 requests, not 240', ghost.requests === 12, `(got ${ghost.requests})`);
check('settles at the 30m ceiling', ghost.delayFor('Ghost Player') === 1_800_000);

// ── A resolvable player still resolves on the first tick ──────────────────
const good = makeClient(new Set(['Rory McIlroy']));
check('resolvable name answered immediately', good.resolve(['Rory McIlroy'], 0) === true);
check('success resets backoff to the base window', good.delayFor('Rory McIlroy') === 60_000);

// ── Recovery: a name that starts unresolvable and later becomes resolvable ─
const late = new Set();
const recov = makeClient(late);
now = 0;
for (let tick = 0; tick < 60; tick++) { recov.resolve(['Late Arrival'], now); now += 60_000; }
const before = recov.requests;
late.add('Late Arrival');                       // a new event gets indexed
let recovered = false;
for (let tick = 0; tick < 40 && !recovered; tick++) {
  recov.resolve(['Late Arrival'], now);
  if (recov.delayFor('Late Arrival') === 60_000) recovered = true;
  now += 60_000;
}
check('recovers within 30m once the source can answer', recovered);
check('recovery cost only a handful of requests', recov.requests - before <= 2);

// ── Batching: one request covers every unresolved name ────────────────────
const many = makeClient(new Set());
many.resolve(Array.from({ length: 40 }, (_, i) => 'P' + i), 0);
check('40 unresolved names -> 1 batched request', many.requests === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
