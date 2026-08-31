# 2026-08-31 — Phase 2.3 final accuracy stabilization

- Context: the authenticated full-mapping path was already browser-accepted, but `exact mapping` overstated confidence for static context limits and GPT-5.6 web-search output had no verified schema sample.
- Changed: `page_script.js`, `content.js`, `README.md`, version metadata, and focused tests.
- Decision: retain the 200k GPT-5.6 limit as `known ChatGPT inferred`; runtime values must be explicitly model-matched context-window metadata. No API limit fallback is used. Added an opt-in aggregate-only tool-schema fingerprint diagnostic instead of guessing a GPT-5.6 tool classifier.
- Validation: `npm test` (14/14), `node --check` for both scripts, version parity, and `git diff --check` passed.
