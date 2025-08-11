# Emblem Rarity App v10.1.0

A high-performance Destiny 2 emblem rarity tracker that automatically syncs emblem data daily and provides instant database lookups for the fastest possible user experience.

## 🚀 What's New in v10.1.0

### Enhanced Stability & Error Handling
- **Comprehensive error handling** throughout the application
- **Timeout protection** for all async operations (browser launch, scraping, batch processing)
- **Graceful shutdown** handling for clean process termination
- **Uncaught exception handling** to prevent server crashes
- **Memory monitoring** and usage tracking
- **Better process management** and crash prevention

### Debugging & Monitoring Tools
- **Health check endpoints** (`/health`, `/health/detailed`) for real-time monitoring
- **Debug script** (`npm run debug`) for troubleshooting connection issues
- **Enhanced logging** with stack traces and detailed error information
- **Progress tracking** improvements with better error recovery
- **Railway-specific diagnostics** for deployment troubleshooting

### Performance Improvements
- **Batch processing timeouts** (5 minutes per batch) to prevent stuck operations
- **Individual emblem scraping timeouts** (60 seconds) for better resource management
- **Improved startup sequence** with delayed sync to avoid blocking server startup
- **Better concurrency control** with error recovery

## 🏗️ Architecture

This application uses a **database-first approach** that prioritizes local lookups over real-time external API calls:

- **Daily Sync System**: Pulls all emblem rarity data once per day and stores it in a local SQLite database
- **Instant Responses**: User requests get immediate responses from the local database
- **Background Updates**: Data refresh happens automatically without blocking user requests
- **Smart Caching**: Only syncs when needed (once per day) to minimize external API usage

## 🛠️ Setup Instructions

### Environment Variables
```bash
BASE_URL=https://your-app.railway.app
BUNGIE_API_KEY=your_bungie_api_key
BUNGIE_CLIENT_ID=your_bungie_client_id
BUNGIE_CLIENT_SECRET=your_bungie_client_secret
ADMIN_KEY=your_admin_key
CRON_ENABLED=true
REFRESH_CRON=0 3 * * *  # 3 AM daily
CRON_TZ=America/New_York
```

### Installation
```bash
npm install
npm run postinstall  # Installs Playwright browser
```

### Populate Catalog (First Time Only)
```bash
npm run populate-catalog
```

### Start Server
```bash
npm start
```

## 🔄 Daily Sync Process

### Automatic Sync
- **Startup Check**: Automatically checks if sync is needed when server starts
- **Cron Schedule**: Runs daily at 3 AM (configurable)
- **Smart Detection**: Only syncs if data hasn't been refreshed today

### Manual Sync
- **Admin Panel**: Use `/admin/ui.html` to trigger manual syncs
- **API Endpoint**: `POST /api/sync/trigger` to start sync programmatically
- **Status Monitoring**: Real-time progress tracking with percentage and time estimates

### Sync Status
- **pending**: No sync has been performed yet
- **in_progress**: Currently syncing emblem data
- **completed**: Successfully synced today
- **failed**: Last sync attempt failed

## 🗄️ Database Schema

```sql
-- Emblem catalog (names, icons)
emblem_catalog (itemHash, name, icon)

-- Rarity data cache
rarity_cache (itemHash, percent, label, source, updatedAt)

-- Daily sync tracking
daily_sync_status (id, last_sync_date, last_sync_timestamp, total_emblems, sync_status)

-- Collectible mappings
collectible_item (collectibleHash, itemHash)
```

## 🔌 API Endpoints

### Public Endpoints
- `GET /` - Main application page
- `GET /login` - Bungie OAuth login
- `GET /oauth/callback` - OAuth callback handler
- `GET /api/emblems?sid=<token>` - Get user's emblems with rarity
- `GET /api/rarity?hash=<itemHash>` - Get specific emblem rarity
- `GET /rarity-snapshot.json` - Public rarity data snapshot

### Admin Endpoints
- `GET /admin/ui.html` - Admin dashboard
- `GET /admin/help` - Admin configuration info
- `GET /admin/ping` - Admin authentication test
- `POST /admin/sync` - Trigger manual sync
- `POST /admin/snapshot` - Write public snapshot

### Health & Monitoring
- `GET /health` - Basic health check
- `GET /health/detailed` - Comprehensive system status
- `GET /api/sync/status` - Current sync status
- `GET /api/sync/progress` - Real-time sync progress

## 🎛️ Admin Interface

Access the admin panel at `/admin/ui.html` to:
- **Monitor sync status** and progress
- **Trigger manual syncs** when needed
- **View system health** and performance metrics
- **Track sync progress** with real-time updates
- **Manage snapshots** and data exports

## ⚙️ Configuration

### Cron Settings
- **Default**: Daily at 3 AM Eastern Time
- **Customizable**: Set `REFRESH_CRON` and `CRON_TZ` environment variables
- **Timezone Support**: Full timezone support for global deployments

### Concurrency Control
- **Bungie API**: 12 concurrent requests (configurable via `BUNGIE_CONCURRENCY`)
- **Rarity Scraping**: 2 concurrent scrapes (configurable via `RARITY_CONCURRENCY`)
- **Batch Processing**: 50 emblems per batch with 1-second delays

### Timeout Protection
- **Browser Launch**: 30 seconds
- **Emblem Scraping**: 60 seconds per emblem
- **Batch Processing**: 5 minutes per batch
- **Health Checks**: 10-15 seconds

## 📊 Performance Benefits

### Before (Real-time Scraping)
- **Response Time**: 2-10 seconds per request
- **Rate Limiting**: Frequent light.gg rate limit issues
- **Reliability**: Unpredictable performance
- **Resource Usage**: High CPU/memory during requests

### After (Daily Sync + Database)
- **Response Time**: <100ms for most requests
- **Rate Limiting**: No user-facing rate limit issues
- **Reliability**: Consistent, predictable performance
- **Resource Usage**: Low during user requests, high only during daily sync

## 🔍 Monitoring & Debugging

### Health Checks
```bash
# Basic health
curl https://your-app.railway.app/health

# Detailed status
curl https://your-app.railway.app/health/detailed

# Sync status
curl https://your-app.railway.app/api/sync/status
```

### Debug Tool
```bash
# Run comprehensive diagnostics
npm run debug

# Check specific endpoints
curl https://your-app.railway.app/api/sync/progress
```

### Railway Logs
Monitor your Railway deployment logs for:
- Sync progress updates
- Error messages and stack traces
- Memory usage patterns
- Database connection status

## 🚨 Troubleshooting

### Connection Reset Errors
If you see `ERR_CONNECTION_RESET` errors:

1. **Check Railway logs** for server crashes or errors
2. **Run debug tool**: `npm run debug`
3. **Verify health endpoints** are responding
4. **Check memory usage** in detailed health endpoint
5. **Restart Railway service** if needed

### Common Issues

#### Server Not Starting
- Verify all environment variables are set
- Check Railway logs for startup errors
- Ensure Playwright browser is installed

#### Sync Stuck or Failing
- Check `/health/detailed` for sync status
- Monitor memory usage for potential leaks
- Verify light.gg is accessible from Railway

#### Slow Performance
- Check if daily sync is running
- Verify database size and performance
- Monitor memory usage patterns

## 📈 Scaling Considerations

### Memory Management
- **Browser Management**: Single browser instance with proper cleanup
- **Database Connections**: Efficient SQLite usage with WAL mode
- **Token Storage**: In-memory token storage (consider Redis for multi-instance)

### Multi-Instance Deployment
- **Volume Mounts**: Use Railway volume mounts for persistent data
- **Database**: Consider PostgreSQL for multi-instance deployments
- **Load Balancing**: Ensure sticky sessions for OAuth tokens

## 🔄 Migration from Previous Versions

### v9.x to v10.1.0
- **Automatic**: No manual migration required
- **Database**: Existing data is preserved
- **New Features**: Daily sync system activates automatically
- **Admin Interface**: Updated to new system

### Breaking Changes
- **Removed**: Old refresh endpoints (`/refresh-now`, `/admin/refresh`)
- **Updated**: Admin interface completely redesigned
- **New**: Daily sync system replaces real-time scraping

## 📄 License

MIT License - see LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 🆘 Support

For issues and questions:
1. Check the troubleshooting section above
2. Run the debug tool: `npm run debug`
3. Check Railway logs for error details
4. Open an issue with debug output and error details

---

**Version 10.1.0** - Enhanced stability, comprehensive error handling, and powerful debugging tools for production deployments.
