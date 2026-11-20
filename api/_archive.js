// api/_archive.js — where a finished season's archive lives in sfgl_data.
// ============================================================================
// SHARED BY BOTH DEPLOY TARGETS, and by scripts/. See api/_league.js for why a
// shared module has to sit under api/.
//
// This is layout, not logic: the document keys, the parts a season is split
// into, and the size ceiling. It is here because THREE things have to agree
// about them and they cannot share an implementation:
//
//   src/api/firebase.js            writes and reads via the client SDK
//   src/pages/SeasonArchiveView    reads
//   scripts/import-season-archive  writes via firebase-admin
//
// The script cannot import the client API (it pulls in firebase/firestore and
// _init.js, which wants browser env vars), so without this module the key
// naming would exist twice — once in the app and once in a script that only
// runs by hand, months apart, which is precisely the drift this repo's history
// is made of. A season imported under the wrong key is invisible rather than
// broken, which is the worst way for that mistake to show up.
// ============================================================================

export const ARCHIVE_PREFIX = 'season-archive';
export const ARCHIVE_INDEX = 'season-archive-index';

/**
 * One document per collection, rather than one per season.
 *
 * A Firestore document caps at 1 MiB. A season carries thirty-odd events of
 * per-player results for five teams, every transaction and the final rosters:
 * the 2025 archive is 139 kB and the 2026 sheet snapshot is 744 kB of
 * comparable detail, so one document works now and is a little closer to the
 * ceiling every year. Splitting it costs one extra read per part and removes
 * the question.
 */
export const ARCHIVE_PARTS = ['teams', 'tournaments', 'transactions'];

/**
 * Refuse a part this large rather than letting Firestore reject it.
 *
 * Its own error names neither the collection nor the size, and this write
 * happens at step 1 of a rollover — the step everything after it is gated on.
 * If this ever fires, the fix is to chunk that part across several documents,
 * deliberately not built in advance because an untested chunker is worse than
 * a clear error.
 */
export const ARCHIVE_PART_LIMIT = 900_000;

/** `season-archive-2025` for the manifest, `…-2025-teams` for a part. */
export const archiveKey = (season, part) =>
  part ? `${ARCHIVE_PREFIX}-${season}-${part}` : `${ARCHIVE_PREFIX}-${season}`;
