---
summary: "Adopted the master-mirror + local-integration branch model; master now equals upstream, local carries the 15 adopted commits, PR branches are cut from master."
type: diary
---

# Branch model: master mirrors upstream, local runs here

Before: the checkout was on `master`, 19 ahead of `origin/master` with two merge
commits from landing PR branches; `fork/master` was 22 behind. "His main and my main"
had drifted apart.

After (tree byte-identical, verified with `git diff --stat` against the old HEAD;
the untracked Pi opener files and the modified deploy README were autostashed and came
back):

- `master` = `origin/master` (`355d684`), fast-forward only, pushed to `fork/master`.
- `local` = master + 15 linear commits (`feat(local)`/`docs(local)` adoptions and the
  three open PRs #9/#10/#11), rebased onto master on every pull, pushed to
  `fork/local` with `--force-with-lease`. This is what the service runs.
- `fix/*` branches are cut from `master`, one PR each, worked in
  `contrib/.worktrees/aiconvo-<slug>`, tested on an isolated instance (port 7499,
  scratch cache) — never on this checkout, which serves files with no cache.
- The `merge/upstream-2026-09-14` landing branch and its worktree were retired.

Procedure and scripts live in the `softwareco-contrib-upstream` skill
(`fork-status.sh`, `pull-upstream.sh --apply|--adopt`, `pr-worktree.sh`).
