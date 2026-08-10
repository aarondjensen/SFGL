// src/constants/nameAliases.js
//
// ── Player name aliases ─────────────────────────────────────────────────────
// This file no longer OWNS any alias data. The single source of truth for
// player-name identity — normalization, nickname/initials equivalence, and the
// explicit alias groups — is `api/_playerNames.js`, which both the browser
// bundle and the serverless functions import directly.
//
// It used to hold its own NAME_ALIASES map with a "⚠ KEEP IN SYNC with
// api/field.js" comment, while `src/constants/index.js` held a SECOND map
// (PLAYER_NAME_ALIASES) that pointed the opposite way for two of the same
// players. Whichever table a given code path happened to consult decided which
// spelling won, so the app disagreed with itself about who a player was.
// Both maps are now rows in ALIAS_GROUPS.
//
// More importantly, aliases are no longer a REWRITE applied to one side of a
// comparison — the design that hid Nico Echavarria from the "who's playing"
// data. Names are compared as equivalence classes (see NameSet / namesMatch),
// so it no longer matters which spelling is stored where.
//
// This module remains as the alias-related Firestore plumbing plus a
// re-export, so existing import sites keep working.

export { NAME_ALIASES, ALIAS_GROUPS, resolveAlias } from '../../api/_playerNames.js';

import { NAME_ALIASES } from '../../api/_playerNames.js';

// ── Seed: copy static aliases into Firestore ─────────────────────────────────
// One-shot migration. For each entry, ensures the alias is on the canonical
// player doc's aliases array. Returns a result summary the caller can show:
//   { added: N, alreadyPresent: N, skipped: N (canonical doc missing), errors: [] }
//
// Idempotent: re-checks current state before writing, and skips silently
// when the canonical doc doesn't exist yet (run OWGR sync first, or do a
// full merge via AdminView for that player).
//
// NOTE: seeding is now a convenience for keeping the /players/{name}.aliases
// arrays tidy, not a correctness requirement. Matching works off ALIAS_GROUPS
// and the derivation rules whether or not Firestore has been seeded.
export async function seedAliasesToFirestore(playersApi) {
  const results = { added: 0, alreadyPresent: 0, skipped: 0, errors: [] };
  for (const [alternate, canonical] of Object.entries(NAME_ALIASES)) {
    try {
      const existing = await playersApi.getByName(canonical);
      if (!existing) {
        results.skipped += 1;
        results.errors.push(`${canonical}: canonical doc not found in /players/`);
        continue;
      }
      const aliases = existing.aliases || [];
      if (aliases.includes(alternate)) {
        results.alreadyPresent += 1;
        continue;
      }
      await playersApi.addAlias(canonical, alternate);
      results.added += 1;
    } catch (err) {
      results.skipped += 1;
      results.errors.push(`${canonical} ← ${alternate}: ${err.message}`);
    }
  }
  return results;
}
