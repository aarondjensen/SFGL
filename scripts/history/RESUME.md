# SFGL Historical DB — Resume State (2026-07-02)

One-off tooling to build a queryable history DB from 12 Google Sheets season
masters (2015–2026). Nothing here touches prod; staging only.

## STATUS
- ✅ Franchise map confirmed (all 12 seasons). Extractor built & validated.
- ✅ Staged review dataset produced: `sfgl_history_staged.xlsx` / `.json`
  (PlayerSeasons, PlayerCareers, TeamSeasons, DataQuality).
- ✅ Data-quality boundary established (below).
- ✅ Reconstruction pipeline PROVEN on 2019 US Open (money + round-leader bonuses
  recompute exactly — Woodland 2.35M incl. R2+R3 bonuses, Rose 601,872 incl. R1).
- ⏳ NEXT: reconstruct 2019 (18 broken events) + 2018 (37 broken events) via ESPN,
  fold into DB, deliver corrected workbooks. Blocked only on ESPN allowlist
  reaching a fresh sandbox (a mid-session settings change does not apply; start a
  new conversation in this project; if the single-domain add isn't honored, use
  "All domains" temporarily).

## FILES (this folder)
- `extract_history.py` — 12-season extractor (openpyxl). Recomputes all totals
  from per-event cells (derive-don't-trust). Run against sfgl20XX.xlsx in cwd.
- `reconstruct_events.py` — ESPN→raw-tab→SFGL-value pipeline. Verify parse_field
  key paths against a live ESPN dump on first run.
- `sfgl_history_staged.xlsx/.json` — current staged dataset for review.

## GOOGLE DRIVE FILE IDS (season masters; all readable native Sheets)
2015 1Ax0qRyv936zyARstzimOiM9w8FTUMYanbMhXavVC0O0
2016 1J3WthclyBGis4TYDth1rA5hS2R0gZsE038A6x78MxQI
2017 1JZsZiP_i2yExVIxa8GI0wRjG9WXDANyIlrJfwTKUmrg
2018 1MqszvU_o5OULb4QVtLDU0TJc1e-PU7fM2c39DKVFruA  (broken: all 37 events "Loading...")
2019 1uF1tX3jegj_gZOCDUmNhRFCv9SzVM0hIXzJqnSjk7OA  (front half OK, back 18 broken)
2020 1U9YtIpBbwknJ2nrrKiwDUwer7CHfuxTp70ulUiYOm9Q
2021 1KdT7ruVsK4wFZ9yaku7d8f3970WAMhw_E8LMV2WYyjg
2022 1i4pGUlq4eetAOlHfb855G9SP63s5193j4U2GLToZ3L8
2023 1o_fR0IVvsi87aQ78ObQS6NPLldNrtVvEbUBgtNAFWxM
2024 140cH7ecDiYq6AuUlmOmvxL_dxOU9uwHTsYx-Uf6Nekw
2025 1QLzcSqm_q7_cnUaxSCaCp1KFKcid_3dNLGYkxN2UV6s
2026 1zKAs6kqY_dvJ9G1Vm1SuMkD29238ijXADcEk2kUamaM  (real; season not played)
Download pattern: Google Drive:download_file_content, exportMimeType xlsx;
obj[0]["text"] is a JSON string whose "content" is base64 xlsx.

## FRANCHISE MAP (slot -> manager -> current team; labels churn, manager continuous)
- TJ Crawforth  -> Detroit Rock City (DRC). Stable all years.
- Josh Fano     -> Hip Happens. Labels: You'll F***ing See(15) Nubs(16) TWhooo(17)
  TwistFace(18) GBD(19) I'm Baaaaccckk(20) I'm Waaaaay Baaaaccckk(21-22) IWB(23-25)
  "SS Express"(2025 tab) Hip Happens(26). Win-code GBD(23+).
- Michael Hershfield -> Dirty Bird(ies) (DB). Stable.
- Aaron Jensen  -> World #1. Air Jordan(15-17) The Big Cat's Back(18) World #1(19+).
- Dave Lutz     -> POPS, LLC. Mac12(15) Texas Bulldozers(16) National Champs(17-21)
  WtF Point(22) CTTP(23-25) POPS LLC(26). Win-code NC(23+).

## DATA-QUALITY BOUNDARY
- COMPLETE (9): 2015-2017, 2020(COVID-short but intact), 2021-2025.
- 2019 PARTIAL: front 16/33 events intact; back 18 broken (live-import "Loading...").
- 2018 ROSTERS-ONLY: all 37 events broken; names intact, earnings gone.
- 2026 future/empty.
Career totals in staged data intentionally use COMPLETE seasons only.

## RECONSTRUCTION (2018 + 2019) — how to finish
Source: ESPN JSON `site.api.espn.com/apis/site/v2/sports/golf/pga/leaderboard?event={id}`
(full field: rounds + earnings). Reach it from bash once allowlisted.
1. Fetch ESPN schedule pages (STATIC html, web_fetch works):
   season/2019/tour/pga and season/2018/tour/pga -> map every event name -> tournamentId.
   Confirmed 2019 ids: US Open 401056556, PGA 401056552, Open 401056547, BMW 401056543,
   Tour Champ 401056542, WGC Match Play 401056524 (others 401056542..559 range — verify by name).
2. Per broken event: fetch ESPN -> parse_field -> populate_raw() into the slug tab
   (event tab A1 holds the slug name). Read bonus constants from the event tab.
3. Compute SFGL value = money + round-leader bonuses (MC => $0). Fold into DB.
4. Recalc corrected workbook in LibreOffice for delivery (note: LibreOffice throws
   #VALUE! on the sheet's "sum(""+n)" quirk — Google Sheets is fine; compute values
   in Python for the DB, ship populated raw tabs for the sheet to self-heal).
Raw-tab layout: A player,B pos,C-F R1-R4,G total,H money,I fedex,L player,
M/N/O = After1/2/3 cumulative. Event tab reads raw cols 2,8,13,14,15.
SPECIALS: WGC Match Play = money only (no rounds/bonuses). 2019 Tour Championship
= FedEx staggered start + bonus money; flag & review before trusting.

## AFTER APPROVAL
Firestore import = one-off local Node Admin SDK script, isolated `sfgl_history/*`
namespace (not a cron action — preserve 12-fn cap). Names via normalizeNordic()/
canonicalName(). Repo home for this tooling: `scripts/history/`.
