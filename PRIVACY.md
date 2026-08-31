# Privacy Policy — Context Window Meter for ChatGPT

_Last updated: 20 July 2026_

_This personal fork has no published privacy-policy copy or remote service._

## Summary

This extension collects nothing, stores nothing, and sends nothing anywhere.

## What the extension does

The extension runs only on `https://chatgpt.com/*`. It wraps the page's own
`fetch` function so it can read ChatGPT conversation JSON, estimate its tokens,
and display the result in a badge. On a conversation route or after a reply
stream completes, it may make one debounced same-origin request to ChatGPT for
that conversation's detail; it never sends conversation data to another service.

All of this happens in your browser tab, in memory, while the tab is open.

## Data collection

The extension does **not**:

- transmit any data off your device, to the developer or to any third party
- store conversation content on disk, in `chrome.storage`, in `localStorage`, or in cookies
- use analytics, telemetry, tracking pixels, or advertising identifiers
- read pages or requests on any site other than `chatgpt.com`
- create a user account or ask for any personal information

Conversation text is read to compute a token count and is discarded when the
tab is closed or reloaded. Nothing persists between sessions.

## Permissions

- **Host permission `https://chatgpt.com/*`** — required to inject the counter
  into ChatGPT pages and read the conversation payload the page has already
  fetched. This is the only site the extension can access.

The extension requests no other permissions.

## Third parties

None. There is no backend server associated with this extension.

## Changes

If this policy changes, the updated version will be published at this URL and
the "last updated" date will change.

## Contact

Questions about this policy can be raised as an issue on the
[project repository](https://github.com/joostmbakker/context-window-meter/issues).

---

_This extension is an independent project. It is not affiliated with,
endorsed by, or sponsored by OpenAI. "ChatGPT" is a trademark of OpenAI._
