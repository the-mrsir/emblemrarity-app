# Emblem Rarity v6 — Fast + reliable

Major changes:
- **Token refresh**: avoids silent failures once access token expires.
- **Concurrent per-entity fetch**: emblem discovery is much faster (24-way pool).
- **SQLite cache**: stores collectible→item, item→isEmblem/name/icon, and rarity. Repeat loads are instant.
- **Rarity streaming**: `/api/rarity/stream` (SSE) pushes percentages for first ~32 emblems immediately after grid renders.
- **Low memory**: no giant manifests.

Deploy
1) Replace repo with v6, push.
2) Railway env:
   - BASE_URL, BUNGIE_API_KEY, BUNGIE_CLIENT_ID, BUNGIE_CLIENT_SECRET
   - optional: NODE_OPTIONS=--max-old-space-size=1024
3) Open `/login`, then `/?sid=...` will show emblems fast; rarity fills in.

Debug
- `/debug?sid=...` shows counts and first hashes.
