#!/usr/bin/env node

import axios from "axios";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUNGIE_API_KEY = process.env.BUNGIE_API_KEY;
if (!BUNGIE_API_KEY) {
  console.error("BUNGIE_API_KEY environment variable required");
  process.exit(1);
}

const BUNGIE = axios.create({
  baseURL: "https://www.bungie.net/Platform",
  headers: { "X-API-Key": BUNGIE_API_KEY },
  timeout: 60000
});

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DB_DIR || path.join(process.cwd(), "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "emblems.db");

async function populateCatalog(force = false) {
  const db = new Database(DB_PATH);
  
  try {
    // Ensure tables exist
    db.exec(`
    CREATE TABLE IF NOT EXISTS emblems (
      itemHash INTEGER PRIMARY KEY,
      name TEXT,
      icon TEXT,
      percent REAL,
      label TEXT,
      source TEXT,
      updatedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS sync_status (
      id INTEGER PRIMARY KEY DEFAULT 1,
      last_sync_date TEXT,
      last_sync_timestamp INTEGER,
      total_emblems INTEGER,
      sync_status TEXT
    );
    `);
    db.exec("INSERT OR IGNORE INTO sync_status (id, last_sync_date, last_sync_timestamp, total_emblems, sync_status) VALUES (1, '', 0, 0, 'pending')");

    if (force) {
      console.log("Clearing existing emblems...");
      db.exec("DELETE FROM emblems");
      db.exec("DELETE FROM sync_status");
      db.exec("INSERT INTO sync_status (id, last_sync_date, last_sync_timestamp, total_emblems, sync_status) VALUES (1, '', 0, 0, 'pending')");
    }
    
    console.log("Fetching Destiny 2 manifest...");
    const manifestResponse = await BUNGIE.get("/Destiny2/Manifest/");
    const manifest = manifestResponse.data?.Response;
    
    if (!manifest) {
      throw new Error("Failed to get manifest");
    }
    
    const componentPaths = manifest?.jsonWorldComponentContentPaths?.en || manifest?.jsonWorldComponentContentPaths?.en_us || manifest?.jsonWorldComponentContentPaths?.en_US;
    const inventoryItemPath = componentPaths?.DestinyInventoryItemDefinition;
    if (!inventoryItemPath) {
      throw new Error("No DestinyInventoryItemDefinition component path found in manifest");
    }
    
    console.log("Downloading inventory item manifest...");
    const manifestUrl = `https://www.bungie.net${inventoryItemPath}`;
    const itemsResponse = await axios.get(manifestUrl, { timeout: 120000 });
    const items = itemsResponse.data;
    
    console.log("Processing manifest items...");
    let processed = 0;
    let emblems = 0;
    
    const setEmblem = db.prepare("INSERT INTO emblems (itemHash, name, icon, percent, label, source, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(itemHash) DO UPDATE SET name=COALESCE(excluded.name,name), icon=COALESCE(excluded.icon,icon)");
    
    for (const [hash, item] of Object.entries(items)) {
      processed++;
      
      // Check if it's an emblem (category 19)
      if (item.itemCategoryHashes && item.itemCategoryHashes.includes(19)) {
        const itemHash = parseInt(hash);
        const name = item.displayProperties?.name || null;
        const icon = item.secondaryIcon || item.displayProperties?.icon || null;
        
        setEmblem.run(itemHash, name, icon, null, null, null, null);
        emblems++;
        
        if (emblems % 100 === 0) {
          console.log(`Processed ${processed} items, found ${emblems} emblems...`);
        }
      }
    }
    
    console.log(`Catalog population completed: ${processed} items processed, ${emblems} emblems found`);
    
    // Reset sync status to allow sync
    const upd = db.prepare("UPDATE sync_status SET last_sync_date = '', last_sync_timestamp = 0, total_emblems = ?, sync_status = 'pending' WHERE id = 1");
    upd.run(emblems);
    
    return { success: true, emblems };
    
  } catch (error) {
    console.error("Catalog population failed:", error.message);
    throw error;
  } finally {
    db.close();
  }
}

async function main() {
  const force = process.argv.includes("--force");
  
  try {
    console.log("Starting emblem catalog population...");
    const result = await populateCatalog(force);
    console.log("✅ Success:", result);
    console.log("\nNext steps:");
    console.log("1. Start the server: npm start");
    console.log("2. Go to /admin/ui.html");
    console.log("3. Click 'Trigger Daily Sync' to get rarity data");
  } catch (error) {
    console.error("❌ Failed:", error.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
