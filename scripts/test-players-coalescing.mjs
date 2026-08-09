// Validates the exact single-flight pattern used in src/api/firebase.js
// (readAllPlayers), independent of Firestore.
let fetchCount = 0;
let failNext = false;

async function _fetchAllPlayers() {
  fetchCount++;
  await new Promise(r => setTimeout(r, 10));
  if (failNext) throw new Error('firestore down');
  return [{ _id: 'b' }, { _id: 'a' }];
}

let _inFlight = null;
function readAllPlayers() {
  if (!_inFlight) {
    _inFlight = _fetchAllPlayers().finally(() => { _inFlight = null; });
  }
  return _inFlight.then(rows => rows.slice());
}

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name)); };

// 1. Concurrent callers share one fetch (the Tier-2 Promise.all case)
fetchCount = 0;
const [a, b, c] = await Promise.all([readAllPlayers(), readAllPlayers(), readAllPlayers()]);
check('3 concurrent callers -> 1 network read', fetchCount === 1);
check('all three receive the data', a.length === 2 && b.length === 2 && c.length === 2);

// 2. Each caller gets its own array (no shared-mutation hazard)
check('callers get distinct array instances', a !== b && b !== c);
a.sort((x, y) => x._id.localeCompare(y._id));
check("one caller's in-place sort does not affect another", b[0]._id === 'b');

// 3. No staleness: a later call re-fetches (this is NOT a TTL cache)
fetchCount = 0;
await readAllPlayers();
await readAllPlayers();
check('2 sequential calls -> 2 network reads (no stale window)', fetchCount === 2);

// 4. Rejection propagates to every joined caller and clears the slot
failNext = true; fetchCount = 0;
const results = await Promise.allSettled([readAllPlayers(), readAllPlayers()]);
check('failure fans out to all joined callers', results.every(r => r.status === 'rejected'));
check('failed fetch was still only 1 read', fetchCount === 1);
failNext = false; fetchCount = 0;
const after = await readAllPlayers();
check('slot cleared after failure — next call retries', fetchCount === 1 && after.length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
