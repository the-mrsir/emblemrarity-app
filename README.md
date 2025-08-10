# Emblem Rarity v4

- Per-entity Bungie manifest lookups (no giant JSON files) — fixes OOM
- Playwright headless Chromium to extract light.gg Community Rarity
- Disk + memory cache for rarity (rarity-cache.json)
- Debug route: `/debug?sid=...`

## Railway
Set env vars:
- BASE_URL = https://emblemrarity.app
- BUNGIE_API_KEY = your key
- BUNGIE_CLIENT_ID = your id
- BUNGIE_CLIENT_SECRET = your secret
- NODE_OPTIONS = --max-old-space-size=1024  (optional safety margin)

Build: postinstall installs Playwright + deps automatically.

## Test
- Visit `/login`, finish OAuth.
- After redirect to `/?sid=...`, open `/debug?sid=...` once to verify emblemCount > 0.
- Go back to home and check the grid.
