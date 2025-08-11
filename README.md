

## v9.2.1 — Persistent cache
- DB path now uses `RAILWAY_VOLUME_MOUNT_PATH` (or `./data/cache.db` locally). Attach a Volume at **/app/data** to persist rarity across deploys.
