# Emblem Rarity App - Daily Sync System

A Destiny 2 emblem rarity tracker that efficiently syncs emblem rarity data once per day and provides fast database lookups.

## 🚀 New Daily Sync System

This app now uses a **database-first approach** that:
- **Pulls emblem rarity data once per day** (configurable via cron)
- **Stores data permanently** in SQLite for instant lookups
- **Automatically checks** if today's sync is needed
- **Processes data in batches** to avoid overwhelming external APIs
- **Provides real-time status monitoring** via admin interface

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Bungie API   │    │  Light.gg API   │    │   SQLite DB     │
│   (Emblem List)│    │  (Rarity Data)  │    │  (Permanent)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Catalog Sync  │    │  Daily Rarity   │    │  Fast Lookups   │
│  (One-time)    │    │  Sync (Daily)   │    │  (Instant)      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 📋 Setup Instructions

### 1. Environment Variables

Create a `.env` file with:

```bash
# Required
BUNGIE_API_KEY=your_bungie_api_key
BUNGIE_CLIENT_ID=your_bungie_client_id
BUNGIE_CLIENT_SECRET=your_bungie_client_secret
BASE_URL=http://localhost:3000

# Optional
PORT=3000
CRON_ENABLED=true
REFRESH_CRON="0 3 * * *"  # 3 AM daily
CRON_TZ=America/New_York
ADMIN_KEY=your_admin_key
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Populate Emblem Catalog (One-time Setup)

```bash
npm run populate-catalog
```

This script:
- Downloads the Destiny 2 manifest
- Extracts all emblem definitions
- Populates the local database
- Sets up the sync system

### 4. Start the Server

```bash
npm start
```

## 🔄 Daily Sync Process

### Automatic Sync
- **Cron-based**: Runs daily at 3 AM (configurable)
- **Startup check**: Automatically syncs if needed on server restart
- **Smart detection**: Only syncs if today's data is missing

### Manual Sync
- **Admin interface**: `/admin/ui.html`
- **API endpoint**: `POST /api/sync/trigger`
- **Admin command**: `POST /admin/sync`

### Sync Status
- **Pending**: No sync has been performed
- **In Progress**: Sync is currently running
- **Completed**: Sync finished successfully
- **Failed**: Sync encountered an error

## 📊 Database Schema

### `emblem_catalog`
```sql
CREATE TABLE emblem_catalog (
  itemHash INTEGER PRIMARY KEY,
  name TEXT,
  icon TEXT
);
```

### `rarity_cache`
```sql
CREATE TABLE rarity_cache (
  itemHash INTEGER PRIMARY KEY,
  percent REAL,
  label TEXT,
  source TEXT,
  updatedAt INTEGER
);
```

### `daily_sync_status`
```sql
CREATE TABLE daily_sync_status (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_sync_date TEXT,
  last_sync_timestamp INTEGER,
  total_emblems INTEGER,
  sync_status TEXT
);
```

## 🎯 API Endpoints

### Public Endpoints
- `GET /api/sync/status` - Get current sync status
- `POST /api/sync/trigger` - Trigger daily sync (if needed)
- `GET /api/emblems?sid=<session>` - Get user's emblems with rarity
- `GET /api/rarity?hash=<itemHash>` - Get rarity for specific emblem

### Admin Endpoints
- `GET /admin/ui.html` - Admin interface
- `POST /admin/sync` - Force daily sync
- `POST /admin/snapshot` - Write rarity snapshot

## 🖥️ Admin Interface

Access `/admin/ui.html` to:
- **Monitor sync status** in real-time
- **Trigger manual syncs** when needed
- **View sync statistics** and history
- **Control system operations**

## ⚙️ Configuration

### Cron Schedule
```bash
# Examples
REFRESH_CRON="0 3 * * *"     # 3 AM daily
REFRESH_CRON="0 */6 * * *"   # Every 6 hours
REFRESH_CRON="0 2 * * 0"     # 2 AM every Sunday
```

### Concurrency Settings
```bash
RARITY_CONCURRENCY=2          # Browser instances
RARITY_MIN_GAP_MS=200        # Delay between requests
```

## 🚀 Performance Benefits

### Before (Real-time Scraping)
- ❌ **Slow**: 2-5 seconds per emblem
- ❌ **Unreliable**: External API rate limits
- ❌ **Expensive**: Repeated scraping for same data

### After (Daily Sync + Database)
- ✅ **Fast**: Instant database lookups
- ✅ **Reliable**: Data stored locally
- ✅ **Efficient**: One sync per day
- ✅ **Scalable**: Handles thousands of emblems

## 🔍 Monitoring

### Logs
The system logs all sync activities with structured logging:
```json
{"level":30,"time":1703123456789,"msg":"Daily sync completed","total":1250,"success":1248,"processed":1250}
```

### Metrics
- Total emblems in catalog
- Sync success/failure rates
- Last sync timestamp
- Current sync status

## 🛠️ Troubleshooting

### Common Issues

1. **"No emblems found in catalog"**
   - Run `npm run populate-catalog` first

2. **"Sync failed"**
   - Check Bungie API key validity
   - Verify network connectivity
   - Check admin interface for details

3. **"Browser launch failed"**
   - Ensure Playwright is installed: `npx playwright install chromium`
   - Check system dependencies

### Debug Mode
```bash
LOG_LEVEL=debug npm start
```

## 📈 Scaling Considerations

- **Database**: SQLite handles thousands of emblems efficiently
- **Memory**: Minimal memory footprint with streaming processing
- **Storage**: ~1-2MB for full emblem catalog + rarity data
- **Concurrency**: Configurable browser instances for parallel processing

## 🔄 Migration from Old System

If upgrading from the previous version:
1. Backup existing database
2. Run `npm run populate-catalog --force`
3. Restart server
4. Monitor first sync completion

## 📝 License

This project is open source. See LICENSE for details.

## 🤝 Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

---

**Need help?** Check the admin interface at `/admin/ui.html` or review the logs for detailed information about sync operations.
