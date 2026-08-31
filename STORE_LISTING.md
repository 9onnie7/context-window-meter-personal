# Chrome Web Store listing copy

> Reference copy of the **upstream** store listing
> ([joostmbakker/context-window-meter](https://github.com/joostmbakker/context-window-meter)),
> retained for attribution. This personal fork is a separate project and is not
> published under this listing.

Reference copy for the Developer Dashboard fields. Not shipped in the extension package.

---

## Name (max 75 chars)

```
Context Window Meter for ChatGPT
```

## Short description (max 132 chars)

```
See how full your ChatGPT context window is, in real time — with a breakdown of what's actually filling it up.
```

_109 characters._

## Category

Productivity

## Detailed description

```
Context Window Meter shows you how much of the model's context window your ChatGPT conversation is using — while you're using it.

ChatGPT doesn't tell you this. You find out the hard way: the model starts forgetting things you said earlier, or quietly truncates the long document you pasted in. This extension puts a number on it before that happens.

WHAT YOU GET

• A live token count against your current model's context limit, shown as a percentage
• A breakdown of what is filling the window — your messages, ChatGPT's replies, tool and web search results, reasoning traces, and system instructions
• A badge that matches ChatGPT's own light and dark theme automatically
• Zero configuration. Install it, open a conversation, and it's there.

WHY THE BREAKDOWN MATTERS

The thing eating your context window is usually not the thing you'd guess. Long reasoning traces and tool output routinely take up more room than everything you've typed. Seeing the split tells you what to trim, or when to start a fresh chat.

PRIVACY

This extension does not send your data to the developer or to third parties; it only makes same-origin requests to chatgpt.com.

There is no server, no analytics, no telemetry, and no account. It reads the conversation data your browser has already loaded, counts the tokens, displays the number, and forgets it when you close the tab. Nothing is written to disk or to browser storage.

It can only access chatgpt.com. It cannot see any other site you visit.

The full source is public: https://github.com/joostmbakker/context-window-meter

NOTES

• Token counts are close estimates, not exact figures.
• This extension reads ChatGPT's internal data format, which OpenAI can change at any time. If the badge stops updating after a ChatGPT update, please open an issue.

This is an independent project. It is not affiliated with, endorsed by, or sponsored by OpenAI. "ChatGPT" is a trademark of OpenAI.
```

---

## Privacy tab answers

### Single purpose description

```
Display the current context window token usage of the ChatGPT conversation the user is viewing, so the user knows how much of the model's context window is consumed.
```

### Permission justifications

**Host permission — `https://chatgpt.com/*`**

```
The extension displays a token usage counter on ChatGPT conversation pages. It needs access to chatgpt.com in order to inject that counter into the page and to read the conversation data the page has already loaded, which is the data the token count is computed from. No other host is requested, and the extension has no function on any other site.
```

**Remote code**

```
No. The extension executes no remote code. All scripts are bundled in the package.
```

### Data usage certifications

Declare that the extension does **not** collect or use any of the listed data types.

Certify all three:

- I do not sell or transfer user data to third parties, outside of approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

```
https://joostmbakker.github.io/context-window-meter/
```

---

## Screenshot plan

1280×800 or 640×400, at least one, up to five. Use a conversation with no private content.

1. Badge on a ChatGPT conversation, mid-range usage (amber state) — shows the product in context
2. Expanded breakdown card — the differentiating feature
3. High usage (red state) on a long conversation — shows the warning value
