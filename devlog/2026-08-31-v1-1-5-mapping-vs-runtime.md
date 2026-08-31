# 2026-08-31 — v1.1.5 mapping vs runtime context semantics fix

- Context: real Chrome evidence showed GPT-5.6 Thinking conversations with
  ~289K and ~505K estimated mapping tokens were clamped against the obsolete
  200K inferred limit, producing misleading "100% used / 0% left / High
  context pressure".
- Root cause: the extension treated persisted active-conversation mapping size
  as live model runtime-context usage. Mapping size is not runtime usage —
  ChatGPT manages long conversations server-side (truncation, compaction,
  summarization, hidden context) outside the browser.
- Changed: `page_script.js` — replaced the 200K `gpt-5-6-thinking` mapping
  with a 272K documented ChatGPT Sol reference (source
  `documented ChatGPT reference`, confidence `documented`); `contextMetrics`
  now returns `referenceExceeded` and nulls percentage/left/remaining instead
  of clamping to a fake 100%/0% when mapping >= reference. `content.js` — new
  reference / overflow / unknown states; badge shows `Ref. X% left` below the
  reference and `Mapping > ref` at/above it; overflow panel shows mapping
  tokens, reference window, "Mapping exceeds reference window" and "Runtime
  context unavailable"; guard wording now reference-based (35/25/15 kept).
  README documents mapping-vs-runtime and the 272K reference with official
  OpenAI references. Version 1.1.5.
- API 1.05M window deliberately NOT used as the ChatGPT Web reference.
- Validation: `npm test` 16/16 (new regression tests for 136K/271999/272000/
  272001/289254/505729 and badge states), `node --check`, `git diff --check`.
- Remaining: real logged-in Chrome regression test of the five manual checks
  before publication.
