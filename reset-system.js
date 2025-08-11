#!/usr/bin/env node

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// Database setup
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DB_DIR || path.join(process.cwd(), "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "cache.db");

console.log("🔧 System Reset Script");
console.log("=" * 50);

if (!fs.existsSync(DB_PATH)) {
  console.log("❌ Database file not found!");
  process.exit(1);
}

const db = new Database(DB_PATH);

try {
  console.log("📊 Current Database State:");
  
  // Check current state
  const catalogCount = db.prepare("SELECT COUNT(*) as count FROM emblem_catalog").get();
  const rarityCount = db.prepare("SELECT COUNT(*) as count FROM rarity_cache").get();
  const rarityWithData = db.prepare("SELECT COUNT(*) as count FROM rarity_cache WHERE percent IS NOT NULL").get();
  const syncStatus = db.prepare("SELECT * FROM daily_sync_status WHERE id = 1").get();
  
  console.log(`   Catalog: ${catalogCount.count} emblems`);
  console.log(`   Rarity cache: ${rarityCount.count} entries (${rarityWithData.count} with data)`);
  console.log(`   Sync status: ${syncStatus?.sync_status || 'unknown'}`);
  console.log(`   Last sync: ${syncStatus?.last_sync_date || 'never'}`);
  
  console.log("\n🧹 Resetting System...");
  
  // Clear all sync state
  console.log("   ✓ Clearing sync status");
  db.prepare("UPDATE daily_sync_status SET last_sync_date = '', last_sync_timestamp = 0, total_emblems = 0, sync_status = 'pending' WHERE id = 1").run();
  
  // Clear rarity cache
  console.log("   ✓ Clearing rarity cache");
  db.prepare("DELETE FROM rarity_cache").run();
  
  // Keep catalog but reset its associated sync status
  console.log("   ✓ Keeping emblem catalog");
  
  // Clean up any orphaned snapshot
  const snapshotPath = path.join(process.cwd(), "public", "rarity-snapshot.json");
  if (fs.existsSync(snapshotPath)) {
    console.log("   ✓ Removing old snapshot");
    fs.unlinkSync(snapshotPath);
  }
  
  console.log("\n✅ System Reset Complete!");
  console.log("\n🎯 Next Steps:");
  
  if (catalogCount.count < 100) {
    console.log("   1. Populate catalog: npm run populate-catalog --force");
    console.log("   2. Start server: npm start");
    console.log("   3. Go to admin panel: /admin/ui.html");
    console.log("   4. Click 'Trigger Daily Sync'");
  } else {
    console.log("   1. Start server: npm start");
    console.log("   2. Go to admin panel: /admin/ui.html");
    console.log("   3. Click 'Trigger Daily Sync'");
  }
  
  // Show final state
  const newSyncStatus = db.prepare("SELECT * FROM daily_sync_status WHERE id = 1").get();
  console.log("\n📊 Reset Database State:");
  console.log(`   Catalog: ${catalogCount.count} emblems`);
  console.log(`   Rarity cache: 0 entries`);
  console.log(`   Sync status: ${newSyncStatus?.sync_status || 'unknown'}`);
  console.log(`   Last sync: ${newSyncStatus?.last_sync_date || 'never'}`);
  
} catch (error) {
  console.error("❌ Error resetting system:", error.message);
  process.exit(1);
} finally {
  db.close();
}
