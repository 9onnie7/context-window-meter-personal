# 2026-08-31 — Real ChatGPT compatibility fix

- Real Chrome evidence showed the extension remained on DOM fallback and falsely reported `gpt-4o` with a 128k limit.
- Root cause: the MAIN-world script did not request conversation detail on initial `/c/<id>` load or SPA route changes; DOM fallback also hardcoded the model and limit.
- Added deduplicated same-origin detail reads for initial/SPA routes and reply completion, using the saved original `fetch` to prevent wrapper recursion.
- Backend model data now wins; a read-only visible-UI detector is secondary; unresolved model/limit values remain unknown.
- DOM fallback is explicitly partial, never calculates context percentage, and never activates Context Guard.
- Validation: targeted Node tests, syntax checks, diff/privacy review; real logged-in Chrome revalidation remains required.
