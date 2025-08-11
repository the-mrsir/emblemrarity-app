# Emblem Rarity v8.1 — Smooth live sorting

What’s new on top of v8:
- **Seed from snapshot** before first render so initial order uses cached rarity.
- **Auto re-sort** when a card’s rarity arrives from `/api/rarity`.
- **Background prefetch**: fetch rarity for off-screen items so you don’t need to scroll to trigger it.

Result: no more “scroll → new %s arrive → manual refresh.” The grid reorders itself as numbers stream in.

Deploy
```bash
git add -A
git commit -m "v8.1: snapshot seeding + live re-sort + background prefetch"
git push
```
