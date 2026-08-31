# 2026-08-31 — Personal context meter enhancement

- Started from upstream `a51b184` on branch `personal-enhanced`.
- Added a context-left badge, compact guard thresholds, static model-limit overrides, and one debounced same-origin detail refresh after a reply stream completes.
- Kept the active-branch parser and category accounting; removed the unused stream parser rather than adding per-chunk work.
- Updated identity/privacy/readme text and added focused Node tests.
- Validation: `npm test` — 7 passing tests; `node --check` and `git diff --check` pass.
