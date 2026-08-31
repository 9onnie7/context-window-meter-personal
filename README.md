# Context Window Meter Personal

Personal enhanced fork of [joostmbakker/context-window-meter](https://github.com/joostmbakker/context-window-meter), under the original MIT license. It is a Manifest V3 Chrome extension that shows estimated ChatGPT context usage locally in the current tab.

The primary badge shows **Context XX% left** against the model's reference window. Click it for the estimated mapping size, reference percentage, detected model, context-limit provenance, and category breakdown. These values are estimates from the active conversation mapping and model references; they are not OpenAI's runtime token accounting.

> Independent project — not affiliated with, endorsed by, or sponsored by OpenAI. "ChatGPT" is a trademark of OpenAI.

## Why

ChatGPT gives you no indication of how full the context window is. You find out by hitting the limit: the model starts forgetting the top of the conversation, or silently truncates a long document you pasted. This puts a number on it before that happens — and shows *which* part of the conversation is eating the budget, which is usually not the part you'd guess.

## Personal fork additions

- Context-left badge and compact estimated-context panel
- Context guard at 35%, 25%, and 15% left (no notifications or blocking)
- Static personal model-limit overrides in `page_script.js`
- Known model limits are labelled with their provenance — inferred unless an explicitly matched ChatGPT runtime context-window value or a documented ChatGPT reference is available
- One debounced same-origin conversation refresh on normal, Project, and Custom GPT conversation routes
- Ephemeral same-origin session auth for the conversation-detail request; credentials stay in page memory
- Backend model-slug detection with a read-only UI label fallback
- Honest partial-DOM mode when full conversation data or its model limit is unavailable
- Privacy-safe optional structural tool-schema diagnostic (disabled by default)

Everything is processed locally in the tab. The extension sends no conversation data to the developer or to third parties; it only makes the documented same-origin requests to chatgpt.com using your existing session, and it does not persist conversation or credential data. See the [privacy policy](PRIVACY.md).

### Personal context-limit override

At the top of `page_script.js`, edit this object when a locally observed model slug needs an inferred limit override:

```js
const PERSONAL_CONTEXT_LIMIT_OVERRIDES = {
  // 'my-model-slug': 200000,
};
```

## Install

### From source

1. Clone this repository.
2. Open `chrome://extensions/`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the repository root.
5. Open any conversation on `https://chatgpt.com/`.

## Mapping size vs runtime context

The meter estimates countable content persisted in ChatGPT's active conversation
mapping. ChatGPT may manage long conversations server-side before constructing
the model's next-turn context — truncation, compaction, summarization, selective
history inclusion, hidden system context, output reservations, and transient
tool context all happen outside the browser.

**Mapping size is not live runtime context usage.** A conversation mapping may
therefore exceed the model's documented reference window while the conversation
remains usable. When the mapping meets or exceeds the reference, the extension
reports that the mapping exceeds the reference window and stops presenting a
remaining-context percentage, because actual runtime usage is not observable.

### GPT-5.6 Thinking reference

GPT-5.6 Thinking currently uses a **272K documented ChatGPT Sol reference**
(OpenAI documents 272K for GPT-5.6 Sol; paid ChatGPT Medium/High uses Sol). This
is a documented ChatGPT product reference, **not** a per-session runtime limit
and **not** the GPT-5.6 Sol API's 1.05M context window, which is API capability
and is deliberately not used as the ChatGPT Web reference.

## How it works

1. **Response interception** — a `MAIN`-world script reads ChatGPT conversation-detail JSON. It makes one debounced, same-origin detail request on initial/SPA conversation routes and after a reply stream finishes.
2. **Branch walk** — the conversation is a tree, not a list. Only the active branch from the root to `current_node` counts toward the context window, so the parser walks that path and ignores edited-away siblings.
3. **Token estimation** — a lightweight heuristic across message categories, including reasoning traces, tool output, file search results, and the user profile / custom instructions block.
4. **Badge** — a pill in the bottom-right, expanding on click into the category breakdown.

## Development

```bash
npm test              # node --test, no dependencies
npm run package       # writes dist/extension.zip for store upload
```

Icons are generated from `icons/icon.svg`:

```bash
for s in 16 48 128; do rsvg-convert -w $s -h $s icons/icon.svg -o icons/icon$s.png; done
```

### Styling

`styles.css` is hand-written and needs no build step. It is scoped entirely to the two injected roots and inherits ChatGPT's own CSS custom properties (`--text-primary`, `--main-surface-primary`, `--border-light`, …), so the widget follows the site's theme and typeface with no JavaScript. Each `var()` carries a fallback in case OpenAI renames a token.

### Test fixtures

`test/fixtures/conversation-sample.json` is a **scrubbed** capture. The graph structure, content types, and message sizes are real; all free text, URLs, and account fields are synthetic.

**Never commit a raw capture from your own account.** A ChatGPT conversation response embeds your email address, user ID, avatar URL, and the full text of the conversation. `.gitignore` blocks the common filenames, but the safe habit is to scrub before the file ever enters the working tree.

## Caveats

- Token counts and context limits are **estimates**; they are not OpenAI backend accounting.
- "Full mapping" means the complete **active** conversation mapping was available to the extension. It does not mean exact OpenAI runtime token accounting, access to hidden server context, hidden system prompts, or transient tool context.
- Mapping size and live runtime context usage are different things. Below the reference window the badge shows a reference ratio; at or above it the extension shows "Mapping > ref" and no percentage, because runtime usage is not observable.
- Tool/search usage reflects only countable tool content persisted in the active conversation mapping. Some ChatGPT tool executions may retain structural tool nodes without persisted text and can therefore contribute zero estimated tokens; this is not an extension bug.
- DOM fallback is partial and may exclude history unloaded by ChatGPT. Unknown models and limits remain visibly unknown.
- The extension depends on ChatGPT's internal response shape, which OpenAI can change without notice. If the badge stops updating, that is the likely cause.
- Context limits are inferred from the model slug unless an explicitly matched ChatGPT runtime context-window value or a documented ChatGPT reference is available; they may lag behind new model releases.

## References

- [GPT-5.6 in ChatGPT](https://help.openai.com/en/articles/20001354) — GPT-5.6 Sol powers Medium and High on eligible paid ChatGPT plans, including Plus.
- [ChatGPT Business — Models & Limits](https://help.openai.com/en/articles/12003714) — GPT-5.6 Luna: 128K, GPT-5.6 Terra: 128K, GPT-5.6 Sol: 272K.
- [ChatGPT Rate Card](https://help.openai.com/en/articles/11481834) — defines >272K input tokens as long context for supported GPT-5.x usage; long context is available in Work/Codex, not the Chat tab.
- GPT-5.6 Sol API model page — API context window of 1.05M; deliberately not used as the ChatGPT Web reference.

## License

MIT — see [LICENSE](LICENSE).
