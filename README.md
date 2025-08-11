# Emblem Rarity v7.1 — Nightly bulk refresh (no user data)

What’s new
- **No user data stored**: removed any per-user ownership tables. Tokens remain memory-only.
- **Global-only storage**: we keep just the `emblem_catalog` (itemHash, name, icon) and `rarity_cache`.
- **Nightly cron**: refreshes rarity for every item in the global catalog (default: 3AM America/New_York).
- **Full grid loads**: we build from catalog and fill missing names/icons for a batch immediately; rest in background.

Environment (Railway → Variables)
```
BASE_URL = https://emblemrarity.app
BUNGIE_API_KEY = <your key>
BUNGIE_CLIENT_ID = <your id>
BUNGIE_CLIENT_SECRET = <your secret>
# optional cron settings:
CRON_ENABLED = true
REFRESH_CRON = 0 3 * * *         # 3:00 AM
CRON_TZ = America/New_York
# optional rarity cache tuning:
LIGHTGG_NULL_TTL = 3600          # seconds to wait before retrying a null
LIGHTGG_TTL = 1209600            # 14 days
LIGHTGG_RETRY_MS = 4000
```

Notes
- The catalog grows passively as users browse, but **nothing is linked to a user**.
- Nightly job runs `refreshAllRarities()` across the catalog and updates `rarity_cache` only.
- You can hit `/debug` to see catalog size and cron status.

Deploy
```bash
git add .
git commit -m "v7.1: nightly bulk refresh; no user data persisted"
git push
```
