// src/constants/nameAliases.js
//
// ── Player name aliases ─────────────────────────────────────────────────────
// Maps "alternate" name (as seen in OWGR or PGA Tour data) → "canonical" name
// (the doc ID we want to keep on /players/{name}).
//
// SOURCE OF TRUTH at runtime is Firestore: /players/{canonical}.aliases array.
// Aliases get added to Firestore via the AdminView "Merge Players" feature.
// The static map below is *fallback only* — used when an alias hasn't been
// seeded into Firestore yet, so OWGR/PGA writes still land on the right doc.
//
// To migrate static → dynamic, the commish runs the "Sync Static Aliases"
// button in AdminView, which calls seedAliasesToFirestore(). That writes
// each entry to the matching player doc's aliases array. Idempotent.
//
// To add a NEW alias going forward: use AdminView's Merge Players feature,
// not this file. New entries here only matter if you want to permanently
// hard-code the alias as a fallback (rare — the dynamic system covers most
// cases).
//
// OWGR bracket suffixes like "Jackson Koivun(Am)" or "Daniel Brown(Oct1994)"
// are stripped by cleanName() in AdminView before any alias lookup, so they
// no longer need entries here.

export const NAME_ALIASES = {
  // Format: alternate (OWGR/PGA form) → canonical (roster form)
  'Samuel Stevens':        'Sam Stevens',
  'Vincent Whaley':        'Vince Whaley',
  'Rafa Cabrera Bello':    'Rafael Cabrera Bello',
  'Si-Woo Kim':            'Si Woo Kim',
  'Byeong Hun An':         'Byeong-Hun An',
  'Nico Echavarria':       'Nicolas Echavarria',
};

// Resolve an alternate name to its canonical form. Used as a fallback when
// the dynamic Firestore alias map doesn't have the entry.
export function resolveAlias(name) {
  return NAME_ALIASES[name?.trim()] || name?.trim();
}

// ── Seed: copy static aliases into Firestore ─────────────────────────────────
// One-shot migration. For each entry, ensures the alias is on the canonical
// player doc's aliases array. Returns a result summary the caller can show:
//   { added: N, alreadyPresent: N, skipped: N (canonical doc missing), errors: [] }
//
// Idempotent: re-checks current state before writing, and skips silently
// when the canonical doc doesn't exist yet (run OWGR sync first, or do a
// full merge via AdminView for that player).
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
