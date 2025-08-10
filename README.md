# Emblem Rarity (emblemrarity.app)

Simple site that lets a user sign in with Bungie.net and lists their owned Destiny 2 emblems sorted by light.gg Community Rarity.

## Environment
Set these variables in Railway:
- BASE_URL = https://emblemrarity.app
- BUNGIE_API_KEY = your Bungie API key
- BUNGIE_CLIENT_ID = your Bungie client id
- BUNGIE_CLIENT_SECRET = your Bungie client secret

## Bungie App
Set Redirect URL to:
https://emblemrarity.app/oauth/callback

## Run locally
1. `npm install`
2. Set env vars above in your shell
3. `npm start`
4. Open http://localhost:3000 then click the login button. Bungie will still redirect to BASE_URL, so for local dev temporarily set BASE_URL to http://localhost:3000 and redirect URI in the Bungie app to http://localhost:3000/oauth/callback.

## Deploy on Railway
1. Push this repo to GitHub.
2. On Railway: New Project -> Deploy from GitHub -> pick the repo.
3. Set the environment variables.
4. Railway gives you an HTTPS URL. If you want to use emblemrarity.app as the primary domain, add it as a custom domain on Railway, then update BASE_URL and the Bungie Redirect URL to https://emblemrarity.app.

## Notes
- Rarity is scraped from light.gg and may return Unknown for some items.
- Token storage is in-memory. For multiple instances or persistence, replace with a database.
