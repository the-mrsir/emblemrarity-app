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


## v8.1.2
- Admin auth is easier: header **or** `?key=` query (enable/disable via `ALLOW_QUERY_ADMIN`, default true).
- New endpoints:
  - `GET /admin/ping?key=...` – quick auth check.
  - `GET /admin/refresh?key=...&limit=200` – run warm job without curl JSON flags.
  - `POST /admin/snapshot` – rewrite `rarity-snapshot.json` from the current cache.
- `/stats` now shows `adminConfigured: true/false`.
- Gentler Bungie fetch: `BUNGIE_CONCURRENCY` env (default 12).


## v8.1.4
- Fix: remove duplicate `chips` declaration in client JS (was causing "Identifier 'chips' has already been declared" and blocking login/emblem fetch).


## v8.1.5
- Admin key is normalized (trims surrounding quotes/whitespace). Works even if Railway shows `"warm123"`.
- New `GET /admin/help` reports whether admin is configured (without exposing the key) and whether query auth is allowed.
