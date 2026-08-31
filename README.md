# Context Window Meter Personal

Personal enhanced fork of [joostmbakker/context-window-meter](https://github.com/joostmbakker/context-window-meter), under the original MIT license. It is a Manifest V3 Chrome extension that shows estimated ChatGPT context usage locally in the current tab.

The primary badge shows **Context XX% left**. Click it for estimated used/left tokens, detected model, context-limit provenance, and category breakdown. These values are estimates from the active conversation mapping and inferred model limits; they are not OpenAI's backend token accounting.

> Independent project — not affiliated with, endorsed by, or sponsored by OpenAI. "ChatGPT" is a trademark of OpenAI.

## Why

ChatGPT gives you no indication of how full the context window is. You find out by hitting the limit: the model starts forgetting the top of the conversation, or silently truncates a long document you pasted. This puts a number on it before that happens — and shows *which* part of the conversation is eating the budget, which is usually not the part you'd guess.

## Personal fork additions

- Context-left badge and compact estimated-context panel
- Context guard at 35%, 25%, and 15% left (no notifications or blocking)
- Static personal model-limit overrides in `page_script.js`
- Known model limits are labelled as inferred unless an explicitly matched ChatGPT runtime context-window value is available
- One debounced same-origin conversation refresh on normal, Project, and Custom GPT conversation routes
- Ephemeral same-origin session auth for the conversation-detail request; credentials stay in page memory
- Honest partial-DOM mode when full conversation data or its model limit is unavailable

Everything runs locally in the tab. No data leaves your browser, nothing is stored, and the extension can only access `chatgpt.com`. See the [privacy policy](PRIVACY.md).

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
- DOM fallback is partial and may exclude history unloaded by ChatGPT. Unknown models and limits remain visibly unknown.
- The extension depends on ChatGPT's internal response shape, which OpenAI can change without notice. If the badge stops updating, that is the likely cause.
- Context limits are inferred from the model slug unless an explicitly matched ChatGPT runtime context-window value is available; they may lag behind new model releases.

## License

MIT — see [LICENSE](LICENSE).
