import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import cron from "node-cron";
import pino from "pino";
import { launchBrowser, queueScrape } from "./worker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = pino({ level: process.env.LOG_LEVEL || "info" });

const {
  PORT = 3000,
  BASE_URL,
  BUNGIE_API_KEY,
  BUNGIE_CLIENT_ID,
  BUNGIE_CLIENT_SECRET,
  ADMIN_KEY,
  CRON_ENABLED = "true",
  REFRESH_CRON = "0 3 * * *", // 3 AM daily
  CRON_TZ = "America/New_York"
} = process.env;

if (!BASE_URL || !BUNGIE_API_KEY || !BUNGIE_CLIENT_ID || !BUNGIE_CLIENT_SECRET) {
  console.error("Missing env vars: BASE_URL, BUNGIE_API_KEY, BUNGIE_CLIENT_ID, BUNGIE_CLIENT_SECRET");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// Serve snapshot
app.get("/rarity-snapshot.json", (req, res) => {
  const fp = path.join(__dirname, "public", "rarity-snapshot.json");
  try {
    if (!fs.existsSync(fp)) return res.json([]);
    const data = fs.readFileSync(fp, "utf-8");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.send(data);
  } catch { return res.json([]); }
});

// Bungie API client
const BUNGIE = axios.create({
  baseURL: "https://www.bungie.net/Platform",
  headers: { "X-API-Key": BUNGIE_API_KEY },
  timeout: 20000
});

// Admin check
function isAdmin(req) {
  const key = ADMIN_KEY?.trim();
  if (!key) return false;
  const hdr = req.headers["x-admin-key"]?.trim();
  const q = req.query?.key?.trim() || req.body?.key?.trim();
  return (hdr && hdr === key) || (q && q === key);
}

// Database setup
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DB_DIR || path.join(process.cwd(), "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "emblems.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Create tables
db.exec(`
CREATE TABLE IF NOT EXISTS emblems (
  itemHash INTEGER PRIMARY KEY,
  name TEXT,
  icon TEXT,
  percent REAL,
  label TEXT DEFAULT 'light.gg Community',
  source TEXT,
  updatedAt INTEGER
);

CREATE TABLE IF NOT EXISTS sync_status (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_sync_date TEXT,
  last_sync_timestamp INTEGER,
  total_emblems INTEGER,
  sync_status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS collectibles (
  collectibleHash INTEGER PRIMARY KEY,
  itemHash INTEGER NOT NULL
);
`);

// Initialize sync status
db.exec(`INSERT OR IGNORE INTO sync_status (id, last_sync_date, last_sync_timestamp, total_emblems, sync_status) VALUES (1, '', 0, 0, 'pending')`);

// Prepared statements
const getEmblem = db.prepare("SELECT * FROM emblems WHERE itemHash = ?");
const setEmblem = db.prepare("INSERT INTO emblems (itemHash, name, icon, percent, label, source, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(itemHash) DO UPDATE SET name=COALESCE(excluded.name,name), icon=COALESCE(excluded.icon,icon), percent=excluded.percent, label=excluded.label, source=excluded.source, updatedAt=excluded.updatedAt");
const listEmblems = db.prepare("SELECT itemHash FROM emblems");
const countEmblems = db.prepare("SELECT COUNT(*) as count FROM emblems WHERE percent IS NOT NULL");
const getCollectible = db.prepare("SELECT itemHash FROM collectibles WHERE collectibleHash = ?");
const setCollectible = db.prepare("INSERT INTO collectibles (collectibleHash, itemHash) VALUES (?, ?) ON CONFLICT(collectibleHash) DO UPDATE SET itemHash = excluded.itemHash");
const getSyncStatus = db.prepare("SELECT * FROM sync_status WHERE id = 1");
const updateSyncStatus = db.prepare("UPDATE sync_status SET last_sync_date = ?, last_sync_timestamp = ?, total_emblems = ?, sync_status = ? WHERE id = 1");

// Global sync state
let syncProgress = {
  isRunning: false,
  current: 0,
  total: 0,
  currentEmblem: null,
  startTime: null
};

// Update progress
function updateProgress(update) {
  Object.assign(syncProgress, update);
}

// Check if we need to sync today
function shouldSyncToday() {
  const status = getSyncStatus.get();
  if (!status || !status.last_sync_date) return true;
  
  const today = new Date().toISOString().split('T')[0];
  return status.last_sync_date !== today;
}

// Perform daily sync
async function performDailySync() {
  if (syncProgress.isRunning) {
    log.info("Sync already running, skipping");
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const now = Math.floor(Date.now() / 1000);
  
  try {
    log.info("Starting daily emblem rarity sync...");
    updateSyncStatus.run(today, now, 0, "in_progress");
    
    updateProgress({
      isRunning: true,
      current: 0,
      total: 0,
      currentEmblem: null,
      startTime: Date.now()
    });
    
    // Get all emblem hashes
    const emblemRows = listEmblems.all();
    const emblemHashes = emblemRows.map(r => r.itemHash);
    
    if (emblemHashes.length === 0) {
      log.warn("No emblems found, need to populate catalog first");
      updateSyncStatus.run(today, now, 0, "completed");
      updateProgress({ isRunning: false });
      return;
    }
    
    log.info({ total: emblemHashes.length }, "Syncing emblem rarities");
    updateProgress({ total: emblemHashes.length });
    
    // Launch browser
    try {
      await launchBrowser();
    } catch (error) {
      log.error({ error: error.message }, "Failed to launch browser");
      updateSyncStatus.run(today, now, 0, "failed");
      updateProgress({ isRunning: false });
      return;
    }
    
    // Process emblems
    let successCount = 0;
    
    for (let i = 0; i < emblemHashes.length; i++) {
      const itemHash = emblemHashes[i];
      
      updateProgress({
        current: i + 1,
        currentEmblem: `Processing emblem ${itemHash}`
      });
      
      try {
        const result = await new Promise((resolve) => {
          queueScrape(itemHash, resolve);
        });
        
        if (result && result.percent !== null) {
          setEmblem.run(
            itemHash,
            null, // name - keep existing
            null, // icon - keep existing
            result.percent,
            result.label || "light.gg Community",
            result.source || `https://www.light.gg/db/items/${itemHash}/`,
            now
          );
          successCount++;
        }
        
        // Log progress every 10 emblems
        if ((i + 1) % 10 === 0) {
          const percent = Math.round(((i + 1) / emblemHashes.length) * 100);
          log.info({ progress: `${i + 1}/${emblemHashes.length} (${percent}%)`, success: successCount }, "Sync progress");
        }
        
        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (error) {
        log.error({ itemHash, error: error.message }, "Failed to scrape emblem");
      }
    }
    
    // Update sync status
    updateSyncStatus.run(today, now, successCount, "completed");
    updateProgress({ isRunning: false });
    
    // Write snapshot
    writeSnapshot();
    
    log.info({ total: emblemHashes.length, success: successCount }, "Daily sync completed");
    
  } catch (error) {
    log.error({ error: error.message }, "Daily sync failed");
    updateSyncStatus.run(today, now, 0, "failed");
    updateProgress({ isRunning: false });
  }
}

// Write snapshot
function writeSnapshot() {
  try {
    const rows = db.prepare("SELECT itemHash, percent, label, source, updatedAt FROM emblems WHERE percent IS NOT NULL").all();
    fs.writeFileSync(path.join(__dirname, "public", "rarity-snapshot.json"), JSON.stringify(rows));
    log.info({ count: rows.length }, "Snapshot written");
  } catch (error) {
    log.error({ error: error.message }, "Failed to write snapshot");
  }
}

// Populate emblem catalog from Bungie manifest
async function populateCatalog(force = false) {
  try {
    if (force) {
      db.exec("DELETE FROM emblems");
      log.info("Cleared existing emblems");
    }
    
    log.info("Fetching Destiny 2 manifest...");
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
    
    log.info("Downloading inventory item manifest...");
    const manifestUrl = `https://www.bungie.net${inventoryItemPath}`;
    const itemsResponse = await axios.get(manifestUrl, { timeout: 60000 });
    const items = itemsResponse.data;
    
    log.info("Processing manifest items...");
    let processed = 0;
    let emblems = 0;
    
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
          log.info({ processed, emblems }, "Catalog population progress");
        }
      }
    }
    
    log.info({ processed, emblems }, "Catalog population completed");
    
    // Reset sync status to allow sync
    const today = new Date().toISOString().split('T')[0];
    updateSyncStatus.run("", 0, emblems, "pending");
    
    return { success: true, emblems };
    
  } catch (error) {
    log.error({ error: error.message }, "Catalog population failed");
    throw error;
  }
}

// OAuth token storage (memory only, no persistence)
const tokens = new Map();

function makeState() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// Login endpoint
app.get("/login", (req, res) => {
  const state = makeState();
  tokens.set(state, {});
  const url = new URL("https://www.bungie.net/en/OAuth/Authorize");
  url.searchParams.set("client_id", BUNGIE_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `${BASE_URL}/oauth/callback`);
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

// OAuth callback
app.get("/oauth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || !tokens.has(state)) {
      return res.status(400).send("Bad state");
    }
    
    const response = await axios.post("https://www.bungie.net/platform/app/oauth/token/",
      new URLSearchParams({
        client_id: BUNGIE_CLIENT_ID,
        grant_type: "authorization_code",
        code,
        client_secret: BUNGIE_CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/oauth/callback`
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    
    const token = response.data;
    tokens.set(state, {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (token.expires_in || 3600)
    });
    
    res.redirect(`/?sid=${encodeURIComponent(state)}`);
  } catch (error) {
    log.error({ error: error.message }, "OAuth failed");
    res.status(500).send("OAuth failed");
  }
});

// Get authenticated headers
async function getAuthHeaders(sid) {
  let token = tokens.get(sid);
  if (!token) throw new Error("Not linked");
  
  const now = Math.floor(Date.now() / 1000);
  if (token.expires_at - 15 < now) {
    const response = await axios.post("https://www.bungie.net/platform/app/oauth/token/",
      new URLSearchParams({
        client_id: BUNGIE_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_secret: BUNGIE_CLIENT_SECRET
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    
    const newToken = response.data;
    token = {
      access_token: newToken.access_token,
      refresh_token: newToken.refresh_token || token.refresh_token,
      expires_at: now + (newToken.expires_in || 3600)
    };
    tokens.set(sid, token);
  }
  
  return { Authorization: `Bearer ${token.access_token}`, "X-API-Key": BUNGIE_API_KEY };
}

// Get user's Destiny memberships
async function getMembership(sid) {
  const headers = await getAuthHeaders(sid);
  const response = await BUNGIE.get("/User/GetMembershipsForCurrentUser/", { headers });
  const resp = response.data?.Response;
  const memberships = resp?.destinyMemberships || [];
  
  if (!memberships.length) throw new Error("No Destiny memberships");
  
  const primaryId = resp?.primaryMembershipId;
  const chosen = primaryId ? memberships.find(m => String(m.membershipId) === String(primaryId)) : memberships[0];
  return chosen || memberships[0];
}

// Get user's profile
async function getProfile(sid, membershipType, membershipId) {
  const headers = await getAuthHeaders(sid);
  const response = await BUNGIE.get(`/Destiny2/${membershipType}/Profile/${membershipId}/`, {
    headers,
    params: { components: "800,900" }
  });
  return response.data?.Response;
}

// Check if collectible is unlocked
function isUnlocked(state) {
  return (state & 1) === 0;
}

// Get entity from Bungie API with caching
const entityCache = new Map();

async function getEntity(entityType, hash) {
  const key = `${entityType}:${hash}`;
  
  if (entityCache.has(key)) {
    return entityCache.get(key);
  }
  
  if (entityType === "DestinyCollectibleDefinition") {
    const row = getCollectible.get(hash);
    if (row) {
      const result = { itemHash: row.itemHash };
      entityCache.set(key, result);
      return result;
    }
  }
  
  if (entityType === "DestinyInventoryItemDefinition") {
    const emblem = getEmblem.get(hash);
    if (emblem) {
      const result = {
        displayProperties: { name: emblem.name, icon: emblem.icon },
        secondaryIcon: emblem.icon,
        itemCategoryHashes: [19]
      };
      entityCache.set(key, result);
      return result;
    }
  }
  
  try {
    const response = await BUNGIE.get(`/Destiny2/Manifest/${entityType}/${hash}/`);
    const data = response.data?.Response;
    
        if (!data) return null;
    
    if (entityType === "DestinyCollectibleDefinition" && data?.itemHash != null) {
      setCollectible.run(hash, data.itemHash);
    }
    
    entityCache.set(key, data);
    return data;
  } catch (error) {
    if (error.response?.status === 404) return null;
    throw error;
  }
}

// Cache and return multiple icon variants for an item (fetch full def to avoid DB stub)
const itemIconCache = new Map();
async function getItemIconVariants(itemHash) {
  if (itemIconCache.has(itemHash)) return itemIconCache.get(itemHash);
  try {
    const r = await BUNGIE.get(`/Destiny2/Manifest/DestinyInventoryItemDefinition/${itemHash}/`);
    const it = r.data?.Response;
    const makeUrl = (p) => (p ? `https://www.bungie.net${p}` : null);
    const out = {
      small: makeUrl(it?.displayProperties?.icon),
      banner: makeUrl(it?.secondaryIcon),
      overlay: makeUrl(it?.secondaryOverlay),
      special: makeUrl(it?.secondarySpecial)
    };
    itemIconCache.set(itemHash, out);
    return out;
  } catch (e) {
    log.warn({ itemHash, error: e?.message }, "Failed to load full item icons");
    return { small: null, banner: null, overlay: null, special: null };
  }
}

// Get user's owned emblem hashes
async function getOwnedEmblemHashes(profile) {
  const owned = new Set();
  
  // Profile collectibles
  const profileCollectibles = profile?.profileCollectibles?.data?.collectibles || {};
  for (const [hash, value] of Object.entries(profileCollectibles)) {
    if (isUnlocked(value?.state ?? 0)) {
      owned.add(Number(hash));
    }
  }
  
  // Character collectibles
  const characters = profile?.characterCollectibles?.data || {};
  for (const character of Object.values(characters)) {
    const collectibles = character?.collectibles || {};
    for (const [hash, value] of Object.entries(collectibles)) {
      if (isUnlocked(value?.state ?? 0)) {
        owned.add(Number(hash));
      }
    }
  }
  
  // Convert collectible hashes to item hashes
  const collectibleHashes = [...owned];
  const itemHashes = [];
  
  for (const collectibleHash of collectibleHashes) {
    try {
      const collectible = await getEntity("DestinyCollectibleDefinition", collectibleHash);
      if (collectible?.itemHash) {
        itemHashes.push(collectible.itemHash);
      }
    } catch (error) {
      log.warn({ collectibleHash, error: error.message }, "Failed to get collectible");
    }
  }
  
  // Filter to only emblems
  const emblemHashes = [];
  for (const itemHash of itemHashes) {
    try {
      const item = await getEntity("DestinyInventoryItemDefinition", itemHash);
      if (item?.itemCategoryHashes?.includes(19)) {
        emblemHashes.push(itemHash);
      }
    } catch (error) {
      log.warn({ itemHash, error: error.message }, "Failed to get item");
    }
  }
  
  return [...new Set(emblemHashes)];
}

// Main emblems endpoint
app.get("/api/emblems", async (req, res) => {
  try {
    const sid = req.query.sid;
    if (!sid || !tokens.has(sid)) {
      return res.status(401).json({ error: "Not linked" });
    }
    
    log.info({ sid: sid.substring(0, 8) + "..." }, "Processing emblem request");
    
    const membership = await getMembership(sid);
    const profile = await getProfile(sid, membership.membershipType, membership.membershipId);
    const emblemHashes = await getOwnedEmblemHashes(profile);
    
    log.info({ sid: sid.substring(0, 8) + "...", emblemCount: emblemHashes.length }, "Retrieved emblem hashes");
    
    if (!emblemHashes.length) {
      return res.json({ emblems: [] });
    }
    
    // Build response from database and enrich with icon variants
    const emblems = [];
    const iconMap = {};
    await Promise.all(emblemHashes.map(async (hash) => {
      iconMap[hash] = await getItemIconVariants(hash);
    }));
    for (const hash of emblemHashes) {
      const emblem = getEmblem.get(hash);
      if (!emblem) continue;
      const icons = iconMap[hash] || {};
      emblems.push({
        itemHash: hash,
        name: emblem.name || `Emblem ${hash}`,
        image: emblem.icon ? `https://www.bungie.net${emblem.icon}` : (icons.banner || icons.small),
        icons,
        rarityPercent: emblem.percent,
        rarityLabel: emblem.label,
        rarityUpdatedAt: emblem.updatedAt,
        sourceUrl: emblem.source || `https://www.light.gg/db/items/${hash}/`,
        lightUrl: `https://www.light.gg/db/items/${hash}/`
      });
    }
    
    // Sort by rarity (lowest percentage first)
    emblems.sort((a, b) => (a.rarityPercent ?? 999999) - (b.rarityPercent ?? 999999));
    
    log.info({ sid: sid.substring(0, 8) + "...", finalCount: emblems.length }, "Sending emblem response");
    res.json({ emblems });
    
  } catch (error) {
    log.error({ error: error.message }, "/api/emblems failed");
    res.status(500).json({ error: "Server error" });
  }
});

// Health check
app.get("/health", (req, res) => {
  try {
    const status = getSyncStatus.get();
    const { count } = countEmblems.get() || {};
    
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      database: "connected",
      sync: {
        status: status?.sync_status || "unknown",
        lastSync: status?.last_sync_date || "never",
        totalEmblems: status?.total_emblems || 0,
        rarityData: count || 0
      },
      progress: syncProgress
    });
  } catch (error) {
    log.error({ error: error.message }, "Health check failed");
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Sync status endpoint
app.get("/api/sync/status", (req, res) => {
  try {
    const status = getSyncStatus.get();
    const { count } = countEmblems.get() || {};
    const totalEmblems = listEmblems.all().length;
    const needsSync = shouldSyncToday();
    
    res.json({
      last_sync_date: status?.last_sync_date || null,
      last_sync_timestamp: status?.last_sync_timestamp || 0,
      total_emblems: status?.total_emblems || 0,
      catalog_emblems: totalEmblems,
      sync_status: status?.sync_status || "pending",
      should_sync_today: needsSync,
      rarity_stats: {
        with_data: count || 0,
        without_data: totalEmblems - (count || 0)
      },
      progress: syncProgress,
      next_action: totalEmblems === 0 ? "populate_catalog" : (needsSync ? "trigger_sync" : "wait_for_tomorrow"),
      message: totalEmblems === 0 
        ? "No emblems in catalog. Populate catalog first."
        : (needsSync ? "Data needs to be synced today." : "Data is current.")
    });
  } catch (error) {
    log.error({ error: error.message }, "Failed to get sync status");
    res.status(500).json({ error: "Failed to get sync status" });
  }
});

// Sync progress endpoint
app.get("/api/sync/progress", (req, res) => {
  res.json(syncProgress);
});

// On-demand rarity refresh for a single emblem (lightweight utility)
app.post("/api/rarity/refresh", async (req, res) => {
  try {
    const hash = Number(req.query.hash);
    if (!hash) return res.status(400).json({ error: "hash required" });
    // If full sync is running, avoid contention
    if (syncProgress.isRunning) return res.status(409).json({ error: "Sync is running. Try again later." });
    const now = Math.floor(Date.now() / 1000);
    const result = await new Promise((resolve) => queueScrape(hash, resolve));
    if (result && result.percent != null) {
      setEmblem.run(
        hash,
        null,
        null,
        result.percent,
        result.label || "light.gg Community",
        result.source || `https://www.light.gg/db/items/${hash}/`,
        now
      );
      writeSnapshot();
      return res.json({ ok: true, itemHash: hash, percent: result.percent, label: result.label || "light.gg Community", updatedAt: now });
    }
    return res.status(200).json({ ok: true, itemHash: hash, percent: null });
  } catch (e) {
    log.error({ error: e?.message }, "rarity refresh failed");
    res.status(500).json({ error: "refresh failed" });
  }
});

// Trigger sync endpoint
app.post("/api/sync/trigger", async (req, res) => {
  try {
    if (syncProgress.isRunning) {
      return res.json({ message: "Sync already running", status: "already_running" });
    }
    
    if (shouldSyncToday()) {
      performDailySync().catch(error => log.error({ error: error.message }, "Background sync failed"));
      res.json({ message: "Daily sync started", status: "started" });
    } else {
      res.json({ message: "Already synced today", status: "already_synced" });
    }
  } catch (error) {
    log.error({ error: error.message }, "Failed to trigger sync");
    res.status(500).json({ error: "Failed to trigger sync" });
  }
});

// Admin endpoints
app.post("/admin/populate", async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    if (syncProgress.isRunning) {
      return res.status(409).json({ error: "Sync currently running. Try again later." });
    }
    
    const force = req.query.force !== "false";
    
    // Run population in background
    populateCatalog(force).then(() => {
      log.info("Catalog population completed");
    }).catch(error => {
      log.error({ error: error.message }, "Catalog population failed");
    });
    
    res.json({ message: "Catalog population started", force });
    
  } catch (error) {
    log.error({ error: error.message }, "Failed to start catalog population");
    res.status(500).json({ error: "Failed to start catalog population" });
  }
});

app.post("/admin/sync", async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    await performDailySync();
    const { count } = countEmblems.get() || {};
    res.json({ ok: true, rarity: { count } });
    
  } catch (error) {
    log.error({ error: error.message }, "Admin sync failed");
    res.status(500).json({ error: "Admin sync failed" });
  }
});

app.post("/admin/snapshot", (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    writeSnapshot();
    res.json({ ok: true });
    
  } catch (error) {
    res.status(500).json({ error: "Snapshot error" });
  }
});

// Main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Schedule daily sync
if (CRON_ENABLED === "true" && REFRESH_CRON) {
  cron.schedule(REFRESH_CRON, () => {
    log.info("Cron triggered daily sync");
    performDailySync().catch(error => log.error({ error: error.message }, "Cron sync failed"));
  }, { timezone: CRON_TZ });
  log.info({ cron: REFRESH_CRON, tz: CRON_TZ }, "Cron scheduled");
}

// Graceful shutdown
async function gracefulShutdown(signal) {
  log.info({ signal }, "Received shutdown signal, starting graceful shutdown...");
  
  try {
    server.close(() => {
      log.info("HTTP server closed");
    });
    
    if (db) {
      db.close();
      log.info("Database connections closed");
    }
    
    log.info("Graceful shutdown completed");
  process.exit(0);
  } catch (error) {
    log.error({ error: error.message }, "Error during graceful shutdown");
    process.exit(1);
  }
}

// Handle shutdown signals
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  log.error({ error: error.message, stack: error.stack }, "Uncaught Exception");
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  log.error({ reason: reason?.message || reason, stack: reason?.stack }, "Unhandled Rejection at Promise");
});

// Start server
let server;
server = app.listen(PORT, async () => {
  try {
  await launchBrowser();
  log.info(`Listening on ${PORT}`);
    
    // Check if we need to sync on startup
    if (shouldSyncToday()) {
      log.info("Startup sync needed, use admin panel to trigger");
    } else {
      log.info("No startup sync needed, data is current");
    }
    
  } catch (error) {
    log.error({ error: error.message }, "Failed to start server");
    process.exit(1);
  }
});
