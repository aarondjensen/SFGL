# SFGL — working notes for Claude

## Git workflow

**Do not open pull requests.** Merge finished work straight into `main`.

The standing instruction is: branch, commit, merge to `main`, push. No PR, no
review gate, no waiting for approval. If a session's setup names a feature
branch to develop on, still finish by merging that branch into `main` and
pushing `main` — leaving work on a branch is not "done".

```
git checkout -b <branch>          # work here
git commit                        # commit as you go
git checkout main
git merge <branch>
git push -u origin main
```

Merging to `main` is what makes a change real: **Vercel deploys `main`**. Code
sitting on a branch is not live, no matter how finished it is. A change isn't
delivered until `main` has it.

Bring `main` into a long-running branch (`git merge main`) before merging back,
so conflicts surface on the branch rather than on `main`.

## Deploy targets

Three separate deploy targets that cannot import from each other. When logic is
shared, it gets copied — and every copy carries a `KEEP IN SYNC` comment naming
its twin. Change one, change the other.

- `src/` — the Vite-bundled browser app.
- `api/` — Vercel serverless functions. Cannot import from `src/`. Files
  starting with `_` (e.g. `api/_constants.js`) are shared imports, not routes,
  and don't count against the Hobby-plan 12-function cap.
- `scripts/` — one-off Node maintenance scripts, run by hand.

The native iOS/Android apps are Capacitor shells that live-load
`https://www.sfglgolf.com` (see `capacitor.config.ts`), so a Vercel deploy
reaches phones too — no app-store resubmission needed for web changes.

## Checks before merging

```
npx eslint <changed files>    # 0 errors; the repo carries pre-existing warnings
npm run build                 # must succeed
```

There is no test suite. For logic that's awkward to exercise by hand, a
throwaway Node script that imports the real function beats retyping it into a
test — several bugs here have come from a second copy drifting from the first.
