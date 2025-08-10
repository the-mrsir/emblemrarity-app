# Emblem Rarity v6.1 — More robust

- Adds `/health` endpoint
- Strong error logging + retries for per-entity manifest calls
- Safer `/api/emblems` building (skip bad rows, no blanket 500)
- Keeps token refresh, SQLite cache, and Playwright rarity

Deploy:
1) Replace repo with v6.1
2) Push and redeploy
3) After login, `/debug?sid=...` should show counts; homepage should render emblems.

If you still see errors, open Railway Logs — each failure is tagged (getMembership / getProfile / getEntity / buildRow).
