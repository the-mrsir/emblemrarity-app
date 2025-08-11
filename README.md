# Emblem Rarity v8 — Instant rarity via cache-first + nightly snapshot

Focus: **no user data stored**, fast loads, minimal scraping.

## What’s new
- **Cache-first rarity API**: returns DB value instantly; if stale, refreshes in the background.
- **30d TTL for positives, 30m TTL for nulls** (tunable with env).
- **Nightly cron refresh** of *all* emblems in the global catalog, plus a **rarity-snapshot.json** written to `/public` for the client to prefill badges offline.
- **Scrape throttle**: global queue with configurable concurrency (default 2) and min gap between requests to avoid anti-bot pages.
- **Admin endpoint** `POST /admin/refresh` with `x-admin-key` to force a full refresh + rewrite snapshot (no user data involved).
- **UI prefill**: client fetches `rarity-snapshot.json` and shows percentages immediately; lazy `/api/rarity` calls are cache hits most of the time.
- **Stats** at `/stats` and snapshot caching headers for better browser perf.

## Deploy
```bash
git add -A
git commit -m "v8: cache-first rarity + nightly snapshot + throttle"
git push
```
Railway → Variables (or copy `.env.example`):
```
BASE_URL=https://emblemrarity.app
BUNGIE_API_KEY=...
BUNGIE_CLIENT_ID=...
BUNGIE_CLIENT_SECRET=...
ADMIN_KEY=change-me
CRON_ENABLED=true
REFRESH_CRON=0 3 * * *
CRON_TZ=America/New_York
LIGHTGG_TTL=2592000
LIGHTGG_NULL_TTL=1800
LIGHTGG_RETRY_MS=4000
RARITY_CONCURRENCY=2
RARITY_MIN_GAP_MS=200
```

Optional: use the included **Dockerfile** for a fully pinned Playwright runtime.

## Quick checks
- `GET /stats` → see `catalogCount` and rarity counts.
- `GET /rarity-snapshot.json` → array of cached rarities.
- `POST /admin/refresh` with header `x-admin-key: <ADMIN_KEY>` to force a rebuild (no user data touched).

## Privacy
- We persist **only** global emblem metadata and rarity numbers — no membership IDs, no ownership, no tokens on disk.
