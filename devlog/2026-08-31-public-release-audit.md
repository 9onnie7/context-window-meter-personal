# 2026-08-31 — v1.1.4 public release audit

- Audited the full reachable Git history (16 commits, 135 reachable blobs plus
  unreachable objects) for credentials, raw captures, and private data: clean.
  The pre-purge raw fixture referenced by the old test was never committed; the
  unreachable objects are only the pre-amend copy of `c25ac00` with the same
  scrubbed fixture blob.
- Verified `TOOL_SCHEMA_DIAGNOSTICS = false`; the structural diagnostic logs
  only aggregate fingerprints (roles, type names, metadata key names, lengths)
  and is gated behind the disabled flag.
- Verified manifest (MV3, only `https://chatgpt.com/*`, no permissions key),
  zero runtime/dev dependencies, no remote code, and no telemetry.
- Confirmed the working tree content is identical to HEAD; the initial
  `M page_script.js` was a CRLF stat-cache artifact (autocrlf normalization),
  resolved with a stat refresh — no content change.
- Docs-only fixes: README gained a "full mapping" honesty caveat, the
  tool/search zero-token caveat, and two missing feature bullets; `docs/index.md`
  was synced with PRIVACY.md substance (session auth + diagnostic description,
  date); STORE_LISTING.md now labels itself as the upstream listing copy.
- Validation: `npm test` 14/14, `node --check` for both scripts, `git diff --check`,
  package contents verified manually (zip tool unavailable on this machine).
- Result: PUBLIC_RELEASE_READY.
