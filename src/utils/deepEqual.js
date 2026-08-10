// src/utils/deepEqual.js
// ============================================================================
// Structural equality, used to decide what actually needs writing to Firestore.
//
// useLeague made that decision twice, in two shapes, with the same tool:
//
//   updateTeams   JSON.stringify(prev) !== JSON.stringify(t)          whole doc
//   updateTeam    JSON.stringify(a[k]) !== JSON.stringify(b[k])       per field
//
// Comparing serialized JSON is not comparing values, and the gaps run in both
// directions:
//
//   • Key order is significant. `{name, roster}` and `{roster, name}` are the
//     same team and different strings, so a rebuild that happens to reorder
//     keys — an object spread over a differently-ordered source, a mapped
//     rebuild — writes every team in the league for no change at all. On the
//     teams path that is 12 documents, each carrying a 13-player roster.
//   • `undefined` disappears. `{backup: undefined}` and `{}` serialize
//     identically, so clearing a field by setting it undefined reads as "no
//     change" and never reaches the database, while the UI shows it cleared.
//     Exactly the local-vs-server divergence this codebase keeps producing.
//   • It is O(document) work on every keystroke-sized update — a lineup toggle
//     serializes every roster in the league twice, then throws both strings
//     away.
//
// This walks the values instead, so key order does not matter, `undefined` is
// a value like any other, and — because it returns at the first difference —
// the common "one field changed" case stops early instead of serializing
// everything.
// ============================================================================

/**
 * True when `a` and `b` have the same structure and values.
 *
 * Compares plain objects, arrays and primitives. Dates compare by timestamp.
 * NaN equals NaN — the point here is "is this worth writing", and a field that
 * was NaN and still is has not changed.
 *
 * Class instances other than Date fall back to reference equality, which is
 * what the data in this app needs: everything persisted is JSON-shaped.
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  // Object.is catches NaN; it would also call +0 and -0 different, so those are
  // let through by the === above.
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);

  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    // `in` rather than a bKeys.includes: a key explicitly present with value
    // undefined is a different document from one where the key is absent, and
    // that difference is the one JSON.stringify used to erase.
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * The subset of `next` whose values differ from `prev` — the fields worth
 * sending in a merge write.
 *
 * A key present in `next` with the value undefined IS reported, because that is
 * how this app clears a field; teamsApi.update translates it into Firestore's
 * deleteField sentinel. A key that `next` drops entirely is NOT reported —
 * there is nothing to send for it — so callers that need whole-key removal
 * check for that themselves and replace the document.
 */
export function changedFields(prev, next) {
  const out = {};
  const before = prev || {};
  for (const k of Object.keys(next || {})) {
    // hasOwnProperty rather than `before[k]`: a key added with the value
    // undefined — the app's idiom for clearing a field — reads as undefined
    // either way, so a plain value comparison calls it unchanged and the clear
    // never leaves the browser. That is the exact silent divergence the
    // JSON.stringify version produced; reproducing it here would defeat the
    // point of replacing it.
    if (!Object.prototype.hasOwnProperty.call(before, k) || !deepEqual(next[k], before[k])) {
      out[k] = next[k];
    }
  }
  return out;
}

export default deepEqual;
