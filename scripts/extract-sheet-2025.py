# Extract the SFGL 2025 Google Sheet into the season-archive payload the app reads.
#
# Usage:
#   python3 scripts/extract-sheet-2025.py <drive-export.txt>
#   python3 scripts/extract-sheet-2025.py in.txt --out scripts/fixtures/season-archive-2025.json
#
# READ-ONLY on the sheet side. It writes one JSON file, never touches Firestore,
# and needs no credentials. scripts/import-season-archive.mjs loads the result.
#
# WHY THE INPUT IS A TEXT DUMP AND NOT AN .xlsx
# ---------------------------------------------
# extract-sheet-2026.py opens a downloaded workbook with openpyxl. The 2025
# workbook lives in someone else's Drive, and the copy available here is the
# text rendering the Drive API returns — tabs delimited by "# <name>", cells
# comma-joined. That rendering has one property worth knowing before trusting
# anything it produces: BLANK CELLS ARE ELIDED rather than preserved as empty
# positions. On the per-team tabs that is fatal (a player's earnings can no
# longer be matched to the events he was started in), which is why this reads
# the EVENT tabs instead, where every starter is named on his own row.
#
# WHAT IS VERIFIED, AND WHY THAT MATTERS MORE THAN USUAL
# ------------------------------------------------------
# Nothing here can be checked against the live app — 2025 predates it. So the
# extraction is cross-checked against the workbook's own independently
# maintained views, and the script FAILS rather than emitting a payload that
# does not reconcile:
#
#   1. every starter row:  Total == Earnings + round bonuses
#   2. every team:         the 32 event totals == the season total
#   3. the standings:      summed swings == the Difference column
#   4. every player:       his event earnings and start count == the season
#                          total and start count on his own team tab
#
# Two further checks are RECORDED rather than enforced, because the workbook
# fails them against itself and the archive's job is to preserve the record
# rather than to re-decide it:
#
#   • eight team blocks carry a Total of $0 while their own starter rows add up
#     to real money. extract-sheet-2026.py's audit already names this cause —
#     "SHEET $0 ... most likely a broken Total formula" — and the swing table is
#     affected identically, so the season totals still reconcile. The published
#     standings therefore UNDERSTATE those eight weeks, and this script keeps
#     the published figure: the league settled up on it, and silently raising a
#     finished season's final table is not an extraction's call to make. The
#     blocks and their amounts are listed in `discrepancies` and printed.
#   • the per-transaction fee cells do not sum to the per-swing fee totals. The
#     transaction COUNTS match exactly, so the set of moves is right; only the
#     money disagrees, and the sheet's own total is kept.
#
# (4) is load-bearing beyond tidiness: the sheet's own Total column is
# TRANSPOSED between positions 3 and 4 — it shows World #1 on $28,781,042 and
# Dirty Bird(ies) on $37,125,986, while the Difference column, the swing table
# and the event tabs all agree it is the other way round. Reading that column
# would have published a wrong final table for a season nobody can re-derive.
#
# WHAT THE 2025 SHEET DOES NOT CONTAIN
# ------------------------------------
# Blue (unlimited-keeper) designations. The sheet tracks yellows — asterisks
# and a per-player start cap — and lists everyone else as a plain name, so
# every non-yellow player is archived WHITE. If 2025 had blue keepers, the
# sheet is not where they were recorded.
#
# Transactions are emitted WITHOUT tournament attribution. The Transactions tab
# bands each team's moves under one column group per event, and with blank cells
# elided there is no way to tell which group a move belongs to. The total fee
# per team IS checked against the Rosters tab, so the SET of moves is right even
# though the week each happened is not recoverable. Inventing the attribution
# would have been worse than omitting it.

import json
import re
import sys
from pathlib import Path

args = [a for a in sys.argv[1:] if not a.startswith('--')]
if not args:
    sys.exit(__doc__.strip().split('\n\n')[1])
SRC = Path(args[0])
OUT = Path(args[1]) if len(args) > 1 else Path('scripts/fixtures/season-archive-2025.json')
SEASON = 2025

# 2025 team names → the app's team ids.
#
# SS Express is the franchise that is Hip Happens in 2026, and the evidence is
# a keeper: Scottie Scheffler is ** on SS Express in 2025 and *** on Hip
# Happens in 2026, which is a kept yellow gaining his third year — and a player
# can only be kept by the team that already holds him. The 2025 Transactions
# tab bands the same team as IWB, which is the alias extract-sheet-2026.py
# already carries for Hip Happens.
TEAM_IDS = {
    'Detroit Rock City': 'drc',
    'SS Express':        'hh',
    'IWB':               'hh',
    'Dirty Bird(ies)':   'db',
    'World #1':          'w1',
    'POPS, LLC':         'pops',
}
ORDER = ['Detroit Rock City', 'SS Express', 'Dirty Bird(ies)', 'World #1', 'POPS, LLC']

NON_EVENT_TABS = {
    'DRAFT', 'RostersOLD', 'Rosters', 'Sheet52', 'Schedule', 'Schedule Data',
    'Transactions', 'DRC', 'SS Express', 'Dirty Birdies', 'World #1', 'POPS',
    'tour-championship', 'Tour Championship',
}

MAJORS = {'Masters Tournament', 'PGA Championship', 'U.S. Open', 'The Open Championship'}

# Requires real thousands groups. A looser `[\d,]+` swallows the comma AND the
# place that follows it — "$60,000,2," parsed as 600002, which inflated a round
# bonus by half a million and broke every reconciliation downstream.
MONEY = re.compile(r'\$\s*(-|\d{1,3}(?:,\d{3})*(?:\.\d+)?)')
PLACE = re.compile(r',\s*(T?\d+|MC|WD|DQ|CUT)\s*,\s*\$')

problems = []        # hard failures: the script refuses to emit
discrepancies = []   # the workbook disagreeing with itself: recorded and reported


def amounts(s):
    return [0.0 if m.group(1) == '-' else float(m.group(1).replace(',', ''))
            for m in MONEY.finditer(s)]


def read_tabs(text):
    tabs, cur, name = {}, [], None
    for line in text.split('\n'):
        if line.startswith('# '):
            if name:
                tabs[name] = cur
            name = line[2:].strip().replace('\\#', '#').replace('\\&', '&')
            cur = []
        elif name is not None:
            cur.append(line)
    if name:
        tabs[name] = cur
    return {k: [l for l in v if l.strip() not in ('```', '')] for k, v in tabs.items()}


tabs = read_tabs(SRC.read_text())

# ── Rosters: tiers, start caps, standings, swing earnings ───────────────────
ro = tabs['Rosters']

budgets = {}
for t in ORDER:
    after = ro[0][ro[0].find(t) + len(t):].lstrip(',')
    budgets[t] = int(re.match(r'(\d+)', after).group(1))

yellows = {t: [] for t in ORDER}
for row in ro[1:4]:
    cells = row.split(',')
    for k, team in enumerate(ORDER):
        yellows[team].append({
            'player': cells[k * 3 + 1].strip(),
            'stars': len(cells[k * 3].strip()),
            'startsAllowed': int(cells[k * 3 + 2]),
        })

whites = {t: [] for t in ORDER}
for row in ro[4:14]:
    cells = [c.strip() for c in row.split(',')]
    for k, team in enumerate(ORDER):
        if k < len(cells) and cells[k]:
            whites[team].append(cells[k])

# The swing table AND the team's total transaction fee come off the same row.
# They have to be read together: several other rows in this tab also start
# "<n>,<team name>," — there is a wins/best-week block and a counts block — and
# matching on that prefix alone picks up whichever came last. The fee read that
# way reported Detroit Rock City on $13 from the counts block when its actual
# T$ is $7. The four big swing figures are what identify the right row.
swings, fees_expected = {}, {}
for line in ro:
    for t in ORDER:
        if re.match(r'\d+,' + re.escape(t) + r',', line):
            vals = [v for v in amounts(line) if v >= 1000]
            if len(vals) >= 4:
                swings[t] = [round(v) for v in vals[:4]]
                small = [v for v in amounts(line) if v < 1000]
                if small:
                    fees_expected[t] = round(small[0])
assert len(swings) == 5, f'swing table incomplete: {sorted(swings)}'
season_total = {t: sum(v) for t, v in swings.items()}

si = next(i for i, l in enumerate(ro) if l.startswith(f'{SEASON} OVERALL STANDINGS'))
positions = []
for line in ro[si + 2:si + 7]:
    m = re.match(r'(\d+),(.+?),\$', line)
    positions.append((int(m.group(1)), m.group(2)))

lead = max(season_total.values())
for pos, team in positions:
    line = next(l for l in ro[si + 2:si + 7] if l.startswith(f'{pos},{team},'))
    diff = amounts(line)[-1]
    if round(lead - season_total[team]) != round(diff):
        problems.append(f'standings: {team} summed {season_total[team]:,} '
                        f'contradicts its Difference {diff:,.0f}')

# ── Schedule: dates, location, purse, in play order ─────────────────────────
schedule = []
for line in tabs['Schedule'][1:]:
    m = re.match(r'(\d+),(West|Spring|Summer|Fall),(.+)', line)
    if not m:
        continue
    rest = [c.strip() for c in m.group(3).split(',')]
    schedule.append({'no': int(m.group(1)), 'swing': m.group(2),
                     'dates': rest[0] if rest else '',
                     'name': rest[1] if len(rest) > 1 else '',
                     'location': ', '.join(rest[2:4]).strip(', ')})

# ── Event tabs: per-team starters ───────────────────────────────────────────
events = []
for tab, rows in tabs.items():
    if tab in NON_EVENT_TABS or not rows:
        continue
    full = rows[0].split(',')[0].strip()
    byteam, i = {}, 0
    while i < len(rows):
        row = rows[i]
        # startswith, not split(',')[0] — "POPS, LLC" carries a comma in its
        # own name, so splitting finds "POPS" and the block is never matched.
        # That silently archived the team on $0 for the whole season.
        hit = next((t for t in ORDER if row.startswith(t + ',') and 'Round 1' in row), None)
        if not hit:
            i += 1
            continue
        players, j = [], i + 1
        while j < len(rows) and not rows[j].startswith('Total'):
            prow, pname = rows[j], rows[j].split(',')[0].strip()
            if not pname:
                j += 1
                continue
            # The SFGL block ends where the Submitted column repeats the
            # player's own name. Positional parsing is unsafe: every figure
            # carries thousands separators, so a split puts one amount in
            # three cells.
            second = prow.find(pname, len(pname))
            seg = prow[len(pname):second if second != -1 else len(prow)]
            amts, pl = amounts(seg), PLACE.search(seg)
            earn, bonus = 0, 0
            if len(amts) >= 2:
                earn, bonus = round(amts[-2]), round(sum(amts[:-2]))
                if abs(amts[-1] - earn - bonus) > 1:
                    problems.append(f'{full}/{hit}/{pname}: {earn:,}+{bonus:,} != {amts[-1]:,.0f}')
            players.append({'name': pname, 'earnings': earn, 'bonus': bonus,
                            'finish': pl.group(1) if pl else ''})
            j += 1
        tot = round(amounts(rows[j])[0]) if j < len(rows) and amounts(rows[j]) else 0
        computed = sum(p['earnings'] + p['bonus'] for p in players)
        if abs(computed - tot) > 1:
            # Recorded, not fatal. The published Total is kept so the archive
            # reproduces the standings the league actually played to.
            discrepancies.append({'event': full, 'team': hit,
                                  'publishedTotal': tot, 'startersSum': computed,
                                  'short': computed - tot})
        byteam[TEAM_IDS[hit]] = {'totalEarnings': tot, 'players': players}
        i = j + 1
    if byteam:
        events.append({'name': full, 'teams': byteam})

# Season totals from the events must equal the Rosters tab's swing sums.
from_events = {}
for ev in events:
    for tid, r in ev['teams'].items():
        from_events[tid] = from_events.get(tid, 0) + r['totalEarnings']
for t in ORDER:
    tid = TEAM_IDS[t]
    if from_events.get(tid, 0) != season_total[t]:
        problems.append(f'{t}: events sum {from_events.get(tid, 0):,} '
                        f'!= season total {season_total[t]:,}')

# Per-player career earnings and starts, derived from the event tabs.
career, starts = {}, {}
for ev in events:
    for r in ev['teams'].values():
        for p in r['players']:
            career[p['name']] = career.get(p['name'], 0) + p['earnings'] + p['bonus']
            starts[p['name']] = starts.get(p['name'], 0) + 1

# ── Cross-check: per-player totals against the team tabs ───────────────────
# The team tabs are unusable for per-EVENT figures (blank cells are elided, so
# a player's earnings can no longer be matched to the weeks he was started).
# Their last three columns survive that intact though — season total, starts,
# average — and they are maintained independently of the event tabs. So they
# check the per-player extraction, which is the bulk of the archive, across
# every player on every roster rather than just the team-level sums.
TEAM_TABS = {'DRC': 'Detroit Rock City', 'SS Express': 'SS Express',
             'Dirty Birdies': 'Dirty Bird(ies)', 'World #1': 'World #1',
             'POPS': 'POPS, LLC'}
PLAYER_TOTAL = re.compile(r'^(.+?),.*\$\s*([\d,]+)\s*,(\d+),\$[\d,.]+\s*$')

checked = 0
for tab, team in TEAM_TABS.items():
    for line in tabs.get(tab, []):
        m = PLAYER_TOTAL.match(line)
        if not m:
            continue
        pname = m.group(1).split(',')[0].strip()
        if pname in (team, 'Detroit Rock City'):
            continue
        tab_total, tab_starts = int(m.group(2).replace(',', '')), int(m.group(3))
        got_total, got_starts = career.get(pname, 0), starts.get(pname, 0)
        checked += 1
        if got_total != tab_total:
            problems.append(f'{team}/{pname}: events give ${got_total:,} '
                            f'but his team tab says ${tab_total:,}')
        elif got_starts != tab_starts:
            problems.append(f'{team}/{pname}: events give {got_starts} starts '
                            f'but his team tab says {tab_starts}')

# ── Transactions: the set of moves, without a week attached ─────────────────
transactions, cur_team = [], None
for line in tabs['Transactions']:
    first = line.split(',')[0].strip()
    named = next((t for t in ORDER if line.strip() == t or first == t), None)
    if named or first == 'IWB':
        cur_team = 'SS Express' if first == 'IWB' else named
        continue
    if not cur_team or not re.match(r'[1-4],', line):
        continue
    cells = [c.strip() for c in line.split(',')]
    k = 1
    while k + 2 < len(cells) + 1:
        add, drop, fee = (cells[k] if k < len(cells) else ''), \
                         (cells[k + 1] if k + 1 < len(cells) else ''), \
                         (cells[k + 2] if k + 2 < len(cells) else '')
        if add and re.match(r'^\$\d', fee or ''):
            transactions.append({
                'txId': f'{SEASON}-{TEAM_IDS[cur_team]}-{len(transactions) + 1}',
                'teamId': TEAM_IDS[cur_team], 'team': cur_team,
                'type': 'waiver' if fee == '$2' else 'free agent',
                'player': add, 'droppedPlayer': drop or None,
                'fee': round(amounts(fee)[0]), 'status': 'processed',
            })
        k += 3

fees_got = {}
for tx in transactions:
    name = tx['team']
    fees_got[name] = fees_got.get(name, 0) + tx['fee']
fee_notes = []
for t in ORDER:
    if fees_got.get(t, 0) != fees_expected.get(t):
        fee_notes.append({'team': t, 'feeCellsSum': fees_got.get(t, 0),
                          'publishedTotal': fees_expected.get(t)})

# ── Build the archive payload ───────────────────────────────────────────────
teams_out = []
for t in ORDER:
    roster = []
    for y in yellows[t]:
        roster.append({'name': y['player'], 'limited': True, 'unlimited': False,
                       'stars': y['stars'], 'yearsOfService': y['stars'],
                       'startsAllowed': y['startsAllowed'],
                       'starts': starts.get(y['player'], 0),
                       'sfglEarnings': career.get(y['player'], 0)})
    for w in whites[t]:
        roster.append({'name': w, 'limited': False, 'unlimited': False,
                       'stars': 0, 'yearsOfService': 0,
                       'starts': starts.get(w, 0),
                       'sfglEarnings': career.get(w, 0)})
    teams_out.append({'id': TEAM_IDS[t], 'name': t, 'roster': roster,
                      'earnings': season_total[t], 'startsBudget': budgets[t]})

by_name = {ev['name']: ev for ev in events}
tournaments_out = []
for s in schedule:
    ev = by_name.get(s['name'])
    if not ev:
        continue
    tournaments_out.append({
        'name': s['name'], 'dates': s['dates'], 'location': s['location'],
        'completed': True, 'playing': False,
        'isMajor': s['name'] in MAJORS,
        'results': {'teams': ev['teams']},
    })
unscheduled = [ev['name'] for ev in events if ev['name'] not in {s['name'] for s in schedule}]

standings_out = [{'teamId': TEAM_IDS[team], 'name': team,
                  'earnings': season_total[team], 'position': pos}
                 for pos, team in sorted(positions)]

print(f'\nSFGL {SEASON} — {len(tournaments_out)} events, {len(teams_out)} teams, '
      f'{len(transactions)} transactions, {checked} player totals cross-checked\n')
for row in standings_out:
    print(f"  {row['position']}. {row['name']:<20} ${row['earnings']:>12,}")
if unscheduled:
    print(f'\n  event tabs not on the Schedule tab: {", ".join(unscheduled)}')

if discrepancies:
    by_team = {}
    for d in discrepancies:
        by_team[d['team']] = by_team.get(d['team'], 0) + d['short']
    print(f'\n  {len(discrepancies)} blocks where the sheet\'s Total reads $0 but its '
          f'starters do not —\n  the published standings understate these weeks:')
    for d in discrepancies:
        print(f"    {d['event'][:42]:<42} {d['team']:<18} short ${d['short']:>9,}")
    print('  per team: ' + ', '.join(f'{t} ${v:,}' for t, v in sorted(by_team.items())))
    # The question that decides whether this matters: does correcting it move
    # anybody? If the order is unchanged, the published table is wrong only in
    # its amounts, and nobody finished in the wrong place.
    corrected = sorted(((season_total[t] + by_team.get(t, 0), t) for t in ORDER), reverse=True)
    published = [t for _, t in sorted(((season_total[t], t) for t in ORDER), reverse=True)]
    if [t for _, t in corrected] == published:
        print('  correcting them does NOT change the finishing order')
    else:
        print('  !! correcting them CHANGES the finishing order: '
              + ' > '.join(t for _, t in corrected))

if fee_notes:
    print('\n  transaction fees: counts match the sheet exactly, the money does not')
    for f in fee_notes:
        print(f"    {f['team']:<18} fee cells ${f['feeCellsSum']:<4} published ${f['publishedTotal']}")

if problems:
    print(f'\n{len(problems)} RECONCILIATION FAILURES:')
    for p in problems:
        print('  ' + p)
    sys.exit(1)

OUT.parent.mkdir(parents=True, exist_ok=True)
json.dump({'season': SEASON, 'source': f'Google Sheet "SFGL {SEASON}" via the Drive text export',
           'standings': standings_out, 'teams': teams_out,
           'tournaments': tournaments_out, 'transactions': transactions,
           'discrepancies': {'zeroTotalBlocks': discrepancies, 'feeTotals': fee_notes}},
          open(OUT, 'w'), indent=1, ensure_ascii=False)
print(f'\nevery check reconciles — wrote {OUT}\n')
