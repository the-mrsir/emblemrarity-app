# Emblem Rarity v6.2 — Faster + debug + lazy rarity

- Confirmed `/debug` route (with helpful message if `sid` missing)
- Timing logs for every step (check Railway logs for `t=...ms` lines)
- 32-way concurrency and DB caching for emblem discovery
- Lazy rarity via `/api/rarity` when cards enter viewport
- Token refresh intact; Playwright rarity cached to SQLite

Tips:
- First load is a cold cache. Second load should drop to a few seconds.
- Use `/debug?sid=...` after `/login` to verify counts, and watch logs for timings.
