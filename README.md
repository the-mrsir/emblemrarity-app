# Emblem Rarity v3

This build uses Playwright to extract light.gg Community Rarity reliably.

## Railway setup
Env vars:
- BASE_URL = https://emblemrarity.app
- BUNGIE_API_KEY = your key
- BUNGIE_CLIENT_ID = your id
- BUNGIE_CLIENT_SECRET = your secret

Build:
- Nixpacks will run `npm install` then `npx playwright install --with-deps chromium` from package.json postinstall.
- Start command: `npm start`

Notes:
- A small JSON cache `rarity-cache.json` is written in the app folder to reduce repeated lookups.
- If Railway uses multiple instances, each instance has its own cache. For persistence, mount a volume or move to a DB.
