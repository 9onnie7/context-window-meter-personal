# 2026-08-31 — Authenticated conversation detail fetch

- Real Chrome confirmed Project detail GET now runs but receives 404 without an Authorization header.
- Added an in-memory `/api/auth/session` provider and Bearer-authenticated same-origin detail reads using the saved page fetch.
- Optional `ChatGPT-Account-ID` is used only for explicit ChatGPT account-id session fields; generic user, workspace, project, and conversation IDs are ignored.
- 401/403 invalidate the cache and retry once; missing session auth or 404 does not loop.
- Diagnostics record only booleans and response metadata, never tokens, account IDs, session JSON, or conversation bodies.
