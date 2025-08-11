#!/usr/bin/env node

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// Database setup
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DB_DIR || path.join(process.cwd(), "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "cache.db");

console.log("🔍 Database Check Script");
console.log("=" * 50);
console.log(`Database path: ${DB_PATH}`);
console.log(`Database exists: ${fs.existsSync(DB_PATH)}`);

if (!fs.existsSync(DB_PATH)) {
  console.log("❌ Database file not found!");
  process.exit(1);
}

const db = new Database(DB_PATH);

try {
  // Check catalog
  console.log("\n📚 Emblem Catalog:");
  const catalogCount = db.prepare("SELECT COUNT(*) as count FROM emblem_catalog").get();
  console.log(`   Total emblems: ${catalogCount.count}`);
  
  if (catalogCount.count > 0) {
    const sample = db.prepare("SELECT itemHash, name FROM emblem_catalog LIMIT 5").all();
    console.log("   Sample emblems:");
    sample.forEach((e, i) => {
      console.log(`     ${i+1}. ${e.itemHash} - ${e.name}`);
    });
  }
  
  // Check rarity cache
  console.log("\n💎 Rarity Cache:");
  const rarityCount = db.prepare("SELECT COUNT(*) as count FROM rarity_cache").get();
  console.log(`   Total entries: ${rarityCount.count}`);
  
  const rarityWithData = db.prepare("SELECT COUNT(*) as count FROM rarity_cache WHERE percent IS NOT NULL").get();
  console.log(`   With rarity data: ${rarityWithData.count}`);
  
  const rarityWithoutData = db.prepare("SELECT COUNT(*) as count FROM rarity_cache WHERE percent IS NULL").get();
  console.log(`   Without rarity data: ${rarityWithoutData.count}`);
  
  // Check sync status
  console.log("\n🔄 Sync Status:");
  const syncStatus = db.prepare("SELECT * FROM daily_sync_status WHERE id = 1").get();
  if (syncStatus) {
    console.log(`   Last sync: ${syncStatus.last_sync_date || 'Never'}`);
    console.log(`   Sync status: ${syncStatus.sync_status}`);
    console.log(`   Total emblems: ${syncStatus.total_emblems}`);
  } else {
    console.log("   No sync status found");
  }
  
  // Check database size
  const stats = fs.statSync(DB_PATH);
  console.log(`\n💾 Database size: ${Math.round(stats.size / 1024)} KB`);
  
  console.log("\n🎯 Summary:");
  if (catalogCount.count < 100) {
    console.log("   ⚠️  Catalog has very few emblems - needs repopulation");
    console.log("   Run: npm run populate-catalog --force");
  } else {
    console.log("   ✅ Catalog looks properly populated");
  }
  
  if (rarityWithData.count === 0) {
    console.log("   ⚠️  No rarity data found - needs daily sync");
    console.log("   Use admin panel to trigger sync");
  } else {
    console.log("   ✅ Rarity data found");
  }
  
} catch (error) {
  console.error("❌ Error checking database:", error.message);
} finally {
  db.close();
}
