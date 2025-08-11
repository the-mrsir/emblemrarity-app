# Destiny 2 Emblem Rarity Tracker v11.0.0

A unified, database-first system for tracking Destiny 2 emblem rarity with daily synchronization.

## What's New in v11.0.0

- **Complete Backend Rewrite**: Unified, clean architecture that actually works
- **Database-First Approach**: All emblem and rarity data stored locally in SQLite
- **Daily Sync System**: Automatic rarity data refresh once per day
- **No User Data Storage**: Only processes user data when they log in, stores nothing
- **Simplified Architecture**: One system, one database, clear data flow

## How It Works

1. **Catalog Population**: Download all emblem definitions from Bungie manifest
2. **Daily Sync**: Scrape rarity data from light.gg once per day
3. **User Requests**: Match user's emblems with pre-synced rarity data
4. **Instant Response**: No real-time scraping, everything served from database

## Setup

1. **Environment Variables**:
   ```bash
   BASE_URL=https://yourdomain.com
   BUNGIE_API_KEY=your_bungie_api_key
   BUNGIE_CLIENT_ID=your_bungie_client_id
   BUNGIE_CLIENT_SECRET=your_bungie_client_secret
   ADMIN_KEY=your_admin_key
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Populate Catalog**:
   ```bash
   npm run populate
   ```

4. **Start Server**:
   ```bash
   npm start
   ```

## Usage

- **Main Page**: `/` - User login and emblem display
- **Admin Panel**: `/admin/ui.html` - Monitor sync status and trigger operations
- **API**: `/api/emblems?sid=<session_id>` - Get user's emblems with rarity

## Database Schema

```sql
-- Main emblems table
CREATE TABLE emblems (
  itemHash INTEGER PRIMARY KEY,
  name TEXT,
  icon TEXT,
  percent REAL,
  label TEXT,
  source TEXT,
  updatedAt INTEGER
);

-- Sync status tracking
CREATE TABLE sync_status (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_sync_date TEXT,
  last_sync_timestamp INTEGER,
  total_emblems INTEGER,
  sync_status TEXT
);

-- Collectible mapping
CREATE TABLE collectibles (
  collectibleHash INTEGER PRIMARY KEY,
  itemHash INTEGER NOT NULL
);
```

## Admin Commands

- **Populate Catalog**: `npm run populate` (first time setup)
- **Check Database**: `npm run check-db`
- **Reset System**: `npm run reset`
- **Debug**: `npm run debug`

## Architecture

```
Bungie API → Manifest → Catalog Population
     ↓
light.gg → Daily Sync → Rarity Cache
     ↓
User Login → Emblem Matching → Instant Response
```

## Benefits

- **Fast**: All data served from local database
- **Reliable**: No dependency on external API rate limits
- **Efficient**: One sync per day instead of per request
- **Private**: No user data stored, only processed on-demand

## Troubleshooting

- **Empty Catalog**: Run `npm run populate --force`
- **Sync Issues**: Check admin panel at `/admin/ui.html`
- **Database Problems**: Use `npm run check-db` to inspect state

## License

MIT
