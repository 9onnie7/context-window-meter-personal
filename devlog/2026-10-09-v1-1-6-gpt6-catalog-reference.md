# 2026-10-09 — v1.1.6 GPT-6 catalog-reference candidate

- Evidence: user-observed ordinary Chat catalog returned exact slug
  `gpt-6-thinking` with `max_tokens=262144`; Work/Codex `*-wm` entries are separate.
  The field's precise runtime context semantics remain unverified.
- Changed: page_script.js, content.js, version manifests, targeted tracker tests,
  README.md, PRIVACY.md, and its published docs/index.md copy. No new dependencies.
- Source order: personal override, trusted runtime metadata, documented ChatGPT
  reference, exact GPT-6 Chat catalog reference, existing inference, Unknown.
  GPT-5.6's documented 272K reference remains higher priority.
- Existing same-origin successful JSON GET responses are cloned without blocking
  the page. Only valid safe-integer max_tokens for gpt-6-thinking is cached.
  No polling, additional requests, raw response logging, or persistent storage.
- Both response orders reuse existing aggregate mapping statistics. Late catalog
  updates check the route and conversation identity before refreshing the display.
  Accounting, auth, refresh scheduling, and Guard thresholds are unchanged.
- Validation: baseline 16 tests passed. Candidate tests cover catalog trust
  boundaries, response ordering/body preservation/no extra requests, stale routes,
  model changes, priority, and reference/overflow/Unknown UI. Final test and
  syntax results: 22/22 tests passed; node --check passed for both production
  scripts; git diff --check passed. All six new tests use synthetic data.
- Release gate: real logged-in Windows Chrome validation required. Upload only
  gpt6-catalog-reference; do not update stable main or create a release/tag yet.

## Stable release acceptance

- 2026-10-09: the user confirmed real Windows Chrome acceptance and explicitly
  authorized the official release. This supersedes the candidate-only gate above.
- Release preparation updates only this record and README acceptance wording;
  the tested production implementation is unchanged from candidate 2f3c6a5.
- Publish by fast-forwarding origin/main, creating annotated personal-v1.1.6,
  and creating the official GitHub Release. Preserve the v1.1.5 tag and release.
