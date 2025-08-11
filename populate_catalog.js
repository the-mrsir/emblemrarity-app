#!/usr/bin/env node

import Database from "better-sqlite3";
import axios from "axios";
import fs from "fs";
import path from "path";

const BUNGIE_API_KEY = process.env.BUNGIE_API_KEY;

if (!BUNGIE_API_KEY) {
  console.error("BUNGIE_API_KEY environment variable is required");
  process.exit(1);
}

const BUNGIE = axios.create({
  baseURL: "https://www.bungie.net/Platform",
  headers: { "X-API-Key": BUNGIE_API_KEY },
  timeout: 30000
});

// Database setup
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DB_DIR || path.join(process.cwd(), "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "cache.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Ensure tables exist
db.exec(`
CREATE TABLE IF NOT EXISTS emblem_catalog (
  itemHash INTEGER PRIMARY KEY,
  name TEXT,
  icon TEXT
);
CREATE TABLE IF NOT EXISTS rarity_cache (
  itemHash INTEGER PRIMARY KEY,
  percent REAL,
  label TEXT,
  source TEXT,
  updatedAt INTEGER
);
CREATE TABLE IF NOT EXISTS daily_sync_status (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_sync_date TEXT,
  last_sync_timestamp INTEGER,
  total_emblems INTEGER,
  sync_status TEXT
);
`);

// Initialize daily sync status if empty
db.exec(`INSERT OR IGNORE INTO daily_sync_status (id, last_sync_date, last_sync_timestamp, total_emblems, sync_status) VALUES (1, '', 0, 0, 'pending')`);

const upsertCatalog = db.prepare("INSERT INTO emblem_catalog (itemHash,name,icon) VALUES (?,?,?) ON CONFLICT(itemHash) DO UPDATE SET name=COALESCE(excluded.name,name), icon=COALESCE(excluded.icon,icon)");
const countCatalog = db.prepare("SELECT COUNT(*) as count FROM emblem_catalog");

async function getDestinyManifest() {
  try {
    console.log("Fetching Destiny 2 manifest...");
    const response = await BUNGIE.get("/Destiny2/Manifest/");
    const manifest = response.data?.Response;
    
    if (!manifest) {
      throw new Error("No manifest data received");
    }
    
    console.log("Manifest fetched successfully");
    return manifest;
  } catch (error) {
    console.error("Failed to fetch manifest:", error.message);
    throw error;
  }
}

async function downloadManifestFile(url, filename) {
  try {
    console.log(`Downloading ${filename}...`);
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    fs.writeFileSync(filename, response.data);
    console.log(`${filename} downloaded successfully`);
    return true;
  } catch (error) {
    console.error(`Failed to download ${filename}:`, error.message);
    return false;
  }
}

async function extractEmblemsFromManifest(manifestPath) {
  try {
    console.log("Extracting emblems from manifest...");
    
    // Read the manifest file
    const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    
    const emblems = [];
    let processed = 0;
    
    // Process each item definition
    for (const [hash, item] of Object.entries(manifestData)) {
      processed++;
      if (processed % 1000 === 0) {
        console.log(`Processed ${processed} items...`);
      }
      
      // Check if this is an emblem (category hash 19)
      if (item.itemCategoryHashes && item.itemCategoryHashes.includes(19)) {
        const name = item.displayProperties?.name || null;
        const icon = item.secondaryIcon || item.displayProperties?.icon || null;
        
        if (name && icon) {
          emblems.push({
            itemHash: parseInt(hash),
            name,
            icon
          });
        }
      }
    }
    
    console.log(`Found ${emblems.length} emblems in manifest`);
    return emblems;
  } catch (error) {
    console.error("Failed to extract emblems:", error.message);
    throw error;
  }
}

async function populateCatalog(emblems) {
  try {
    console.log("Populating emblem catalog...");
    
    const transaction = db.transaction((emblems) => {
      for (const emblem of emblems) {
        upsertCatalog.run(emblem.itemHash, emblem.name, emblem.icon);
      }
    });
    
    transaction(emblems);
    
    const count = countCatalog.get().count;
    console.log(`Catalog populated with ${count} emblems`);
    
    // Update sync status
    const today = new Date().toISOString().split('T')[0];
    const now = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE daily_sync_status SET last_sync_date = ?, last_sync_timestamp = ?, total_emblems = ?, sync_status = ? WHERE id = 1").run(today, now, count, "completed");
    
    return count;
  } catch (error) {
    console.error("Failed to populate catalog:", error.message);
    throw error;
  }
}

async function main() {
  try {
    console.log("Starting emblem catalog population...");
    
    // Get current catalog count
    const currentCount = countCatalog.get().count;
    console.log(`Current catalog has ${currentCount} emblems`);
    
    if (currentCount > 0) {
      console.log("Catalog already has data. Use --force to repopulate.");
      process.exit(0);
    }
    
    // Get manifest
    const manifest = await getDestinyManifest();
    
    // Download inventory item definitions
    const inventoryUrl = `https://www.bungie.net${manifest.inventoryItem.jsonWorldContentPaths.en}`;
    const inventoryFile = "inventory_items.json";
    
    if (!await downloadManifestFile(inventoryUrl, inventoryFile)) {
      throw new Error("Failed to download inventory items");
    }
    
    // Extract emblems
    const emblems = await extractEmblemsFromManifest(inventoryFile);
    
    if (emblems.length === 0) {
      throw new Error("No emblems found in manifest");
    }
    
    // Populate catalog
    const finalCount = await populateCatalog(emblems);
    
    console.log(`\n✅ Successfully populated emblem catalog with ${finalCount} emblems!`);
    console.log("The daily sync system is now ready to fetch rarity data.");
    
    // Clean up
    try {
      fs.unlinkSync(inventoryFile);
      console.log("Cleaned up temporary files");
    } catch (e) {
      // Ignore cleanup errors
    }
    
  } catch (error) {
    console.error("\n❌ Failed to populate catalog:", error.message);
    process.exit(1);
  }
}

// Handle command line arguments
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Emblem Catalog Populator

This script downloads the Destiny 2 manifest and populates the emblem catalog
with all available emblems. This is a one-time setup step.

Usage:
  node populate_catalog.js [options]

Options:
  --force    Force repopulation even if catalog has data
  --help     Show this help message

Environment Variables:
  BUNGIE_API_KEY    Your Bungie API key (required)
  DB_DIR            Database directory (optional)
  DB_PATH           Full database path (optional)

Example:
  BUNGIE_API_KEY=your_key_here node populate_catalog.js
`);
  process.exit(0);
}

if (process.argv.includes('--force')) {
  console.log("Force flag detected - will repopulate catalog");
  // Clear existing data
  db.exec("DELETE FROM emblem_catalog");
  db.exec("DELETE FROM rarity_cache");
  db.exec("UPDATE daily_sync_status SET last_sync_date = '', last_sync_timestamp = 0, total_emblems = 0, sync_status = 'pending'");
  console.log("Cleared existing catalog data");
}

main();
