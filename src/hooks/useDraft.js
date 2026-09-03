// src/hooks/useDraft.js
// ============================================================================
// The offseason's live state: the draft_state document for the season being
// drafted into, its picks, and the board derived from the two.
//
// Deliberately NOT part of useLeague. useLeague's Tier-1 load is what the
// splash waits on, and the draft is relevant for a few weeks a year to a
// league that is otherwise reading standings — putting two more collection
// reads in front of first paint to serve that would be the wrong trade. This
// hook fetches after mount and then subscribes, so the offseason bar appears a
// moment after the app is already interactive and updates live from there.
//
// The BOARD is derived, never stored. resolveDraftOrder rebuilds the snake and
// re-applies the pick trades on every change, so the order the commissioner
// sees in the rollover panel, the order the draft screen puts on the clock and
// the order the rollover reads back are one computation. A stored board would
// be a fourth copy of it, and this codebase's whole history is copies that
// drifted.
// ============================================================================

import { useState, useEffect, useMemo } from 'react';
import { draftApi } from '../api/firebase';
import { resolveDraftOrder, currentPick, DRAFT_STATUS } from '../../api/_draft.js';

export const useDraft = (season) => {
  const [state, setState] = useState(null);
  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!season) return undefined;
    let cancelled = false;
    const unsubs = [];

    // Fetch once, then subscribe. The fetch is what makes the bar appear on a
    // cold open without waiting for a listener's first snapshot; the
    // subscriptions are what keep a live draft live on every device at once.
    (async () => {
      try {
        const [s, p] = await Promise.all([
          draftApi.get(season).catch(() => null),
          draftApi.getPicks(season).catch(() => []),
        ]);
        if (cancelled) return;
        setState(s);
        setPicks(p || []);
      } finally {
        if (!cancelled) setLoading(false);
      }

      if (cancelled) return;
      try {
        unsubs.push(draftApi.subscribe(season, (next) => { if (!cancelled) setState(next); }));
        unsubs.push(draftApi.subscribePicks(season, (next) => {
          // No emptiness guard, unlike the team/tournament subscriptions in
          // useLeague: a draft legitimately HAS no picks until the first one is
          // made, and swallowing that would leave an undone pick on screen
          // after the commissioner undid it.
          if (!cancelled && Array.isArray(next)) setPicks(next);
        }));
      } catch (e) {
        console.error('[useDraft] subscription setup failed:', e);
      }
    })();

    return () => {
      cancelled = true;
      unsubs.forEach(u => { try { u && u(); } catch { /* already torn down */ } });
    };
  }, [season]);

  const order = useMemo(() => (state ? resolveDraftOrder(state) : []), [state]);
  const onTheClock = useMemo(() => currentPick(order, picks), [order, picks]);

  const status = state?.status || null;

  return {
    state,
    picks,
    order,
    onTheClock,
    status,
    loading,
    keepersOpen: status === DRAFT_STATUS.KEEPERS,
    drafting:    status === DRAFT_STATUS.DRAFTING,
    complete:    status === DRAFT_STATUS.COMPLETE,
  };
};
