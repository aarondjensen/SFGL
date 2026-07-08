# SFGL Historical DB — Resume State (2026-07-02, session 2)

## STATUS
- ✅ 2019 RECONSTRUCTION COMPLETE (pending Aaron review).
  All 17 broken back-half events repopulated from ESPN and SFGL values
  recomputed in Python. Validated: US Open (Woodland 2,350,000 / Rose 601,872
  match prior proof), PGA (Koepka 2,060,000 = 1.98M + 80k bonuses),
  Open Championship (Lowry P1 $1,935,000, rounds 67-67-63-72).
  Zero unmatched rostered players across all 17 events.
- ⚠️ Corrections vs prior notes:
  - `wgc-matchplay` raw tab was INTACT all along (64/64 with money in col E;
    the old broken-detector looked at col H). 2019 had **17** broken events.
  - 2019 Tour Championship: roster rows in the master are EMPTY (never entered).
    Raw tab is now populated; totals are $0 until/unless rosters are filled.
    ESPN earnings for this event are FedExCup bonus money (staggered start) —
    Aaron must decide how/whether it counts.
- ⏳ 2018: waiting on Aaron's UPDATED "SFGL 2018" sheet. Alternative: same ESPN
  reconstruction works for all 37 events (rosters intact in current master).
- ⏳ scripts/history/ still NOT in repo — extract_history.py from session 1 is
  gone from the sandbox; only reconstruct_2019.py exists now. Aaron should
  commit this folder (and re-upload session-1 kit files if he still has them).

## ESPN API (CHANGED since session 1)
- Old form 404s: `.../golf/pga/leaderboard?event={id}`
- WORKING leaderboard: `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga&event={id}`
- Season event map (replaces HTML scraping):
  `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates={YYYY}`
  → events[] with id/date/name for the whole calendar year.
- Competitor shape: athlete.displayName, earnings (float; 0 for CUT/amateur),
  status.type.name (STATUS_FINISH/STATUS_CUT/STATUS_WITHDRAWN),
  status.position.displayName ('T35', '-' for cut), linescores[].period/value,
  statistics[] name=cupPoints. Sandbox allowlist: site.api.espn.com.

## 2019 event-id map (all 17 reconstructed)
Wells Fargo 401056550 · Byron Nelson 401056551 · PGA 401056552 ·
Charles Schwab 401056553 · Memorial 401056554 · RBC Canadian 401056555 ·
US Open 401056556 · Travelers 401056549 · Rocket Mortgage 401056557 ·
3M 401056558 · John Deere 401056548 · Open Champ 401056547 ·
WGC-FedEx St. Jude 401056559 · Wyndham 401056545 · Northern Trust 401056544 ·
BMW 401056543 · Tour Champ 401056542 (FLAGGED)

## RECONSTRUCTION MECHANICS (proven)
- Write ONLY A1:I{n} into the slug raw tab (header row + field rows).
  L2:O{~145} already contain live formulas (=A2 / After1/2/3 vlookups) and the
  event tabs' bonus formulas are intact — everything self-heals in Google Sheets.
- Bonus constants are parsed per event tab (regular 10k/20k/30k; majors 20k/40k/60k).
- Name reconciliation: ESPN spelling is rewritten to the sheet's roster spelling
  when canonically equal (nordic/hyphen/punct normalize) so vlookups keep working.
- Event-tab roster layout is FIXED offsets: team names at col-A rows 2,9,16,23,30,
  players at +1..+5. Do NOT parse by scanning for 'Total' (cached blanks bleed blocks).
- CUT/W/D: pos 'CUT'/'W/D', money blank. Money blank when earnings == 0.
- LibreOffice recalc still unnecessary — deliver populated raw tabs; Sheets recomputes.

## FILES (this folder)
- reconstruct_2019.py — full pipeline (fetch → raw tabs → Python SFGL values)
- sfgl2019_reconstructed.xlsx — corrected workbook (all 74 tabs, formulas preserved)
- sfgl2019_reconstructed_values.json — per-event per-player money/bonus/value + team totals
- Repo home: scripts/history/

## NEXT
1. Aaron reviews staged Drive copy "SFGL 2019 (RECONSTRUCTED — staging)".
2. Aaron: send updated 2018 sheet OR green-light ESPN reconstruction of 2018 (37 events).
3. Rebuild/re-deliver extract_history.py (lost with sandbox) → regenerate staged
   history dataset including reconstructed 2019 back half.
4. Tour Championship 2019 decision: count FedEx bonus money or exclude event.
5. After approval: one-off local Node Admin SDK import to sfgl_history/* namespace.

## GOOGLE DRIVE FILE IDS + FRANCHISE MAP + DATA BOUNDARY
(unchanged — see session-1 RESUME; 2015-2017/2020-2025 complete, 2018 rosters-only,
2019 now reconstructed, 2026 future.)
