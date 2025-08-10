# Emblem Rarity v5 — Fast load

Key changes:
- Immediate emblem grid (no waiting on rarity).
- **Lazy rarity**: client fetches `/api/rarity?hash=` for cards as they scroll into view.
- Playwright browser is reused with a small worker pool (concurrency=4).
- Server pre-warms rarity for the first 24 hashes in the background.
- Per-entity Bungie lookups (low memory) + disk cache for rarity.

Railway tips:
- Optional: `NODE_OPTIONS=--max-old-space-size=1024`
- Make sure postinstall runs Playwright: it's in package.json.

Flow:
1) `/login` → OAuth → redirect `/?sid=...`
2) Client calls `/api/emblems?sid=...` → gets names + images instantly.
3) As you scroll, client calls `/api/rarity?hash=...` and fills in percentages.
