# 2026-08-31 — Project conversation route compatibility

- Real Chrome evidence showed Project conversations never sent the detail request because route extraction only accepted paths beginning with `/c/`.
- Replaced the anchored matcher with strict UUID-style `c/<conversation-id>` segment extraction, supporting normal, Project, and Custom GPT routes without treating project IDs as conversations.
- Classified `/backend-api/conversation/init` as initialization metadata rather than a detail response.
- Kept backend conversation model precedence and rejected obvious reasoning-effort labels from the UI model fallback.
- Validation: `npm test`, syntax checks, diff/privacy review; real logged-in Chrome revalidation remains required.
