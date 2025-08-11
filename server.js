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
  ALLOW_QUERY_ADMIN = "true",
  CRON_ENABLED = "true",
  REFRESH_CRON = "0 3 * * *", // 3 AM daily
  CRON_TZ = "America/New_York",
  LIGHTGG_TTL = "2592000",
  LIGHTGG_NULL_TTL = "1800",
  BUNGIE_CONCURRENCY = "12",
  RARITY_CONCURRENCY = "2",
  RARITY_MIN_GAP_MS = "200"
} = process.env;

if (!BASE_URL || !BUNGIE_API_KEY || !BUNGIE_CLIENT_ID || !BUNGIE_CLIENT_SECRET) {
  console.error("Missing env vars: BASE_URL, BUNGIE_API_KEY, BUNGIE_CLIENT_ID, BUNGIE_CLIENT_SECRET");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// Serve snapshot even if file missing (return empty array)
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



const BUNGIE = axios.create({
  baseURL: "https://www.bungie.net/Platform",
  headers: { "X-API-Key": BUNGIE_API_KEY },
  timeout: 20000
});

function normKey(v){ try { return (v==null?"":String(v)).trim().replace(/^(['"])(.*)\1$/, "$2"); } catch { return ""; } }
function isAdmin(req){
  const key = normKey(ADMIN_KEY);
  if (!key) return false;
  const hdr = normKey(req.headers["x-admin-key"] || req.headers["x-admin_key"]);
  const allowQuery = String(ALLOW_QUERY_ADMIN||"true").toLowerCase()==="true";
  const q = allowQuery ? normKey((req.query && req.query.key) || (req.body && req.body.key)) : "";
  return (hdr && hdr === key) || (q && q === key);
}

// ---------------- DB ----------------
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DB_DIR || path.join(process.cwd(), "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "cache.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS collectible_item (
  collectibleHash INTEGER PRIMARY KEY,
  itemHash INTEGER NOT NULL
);
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

const setCollectible = db.prepare("INSERT INTO collectible_item (collectibleHash,itemHash) VALUES (?,?) ON CONFLICT(collectibleHash) DO UPDATE SET itemHash=excluded.itemHash");
const getCollectible = db.prepare("SELECT itemHash FROM collectible_item WHERE collectibleHash=?");
const upsertCatalog = db.prepare("INSERT INTO emblem_catalog (itemHash,name,icon) VALUES (?,?,?) ON CONFLICT(itemHash) DO UPDATE SET name=COALESCE(excluded.name,name), icon=COALESCE(excluded.icon,icon)");
const getCatalog = db.prepare("SELECT itemHash,name,icon FROM emblem_catalog WHERE itemHash=?");
const listCatalog = db.prepare("SELECT itemHash FROM emblem_catalog");
const getRarity = db.prepare("SELECT percent,label,source,updatedAt FROM rarity_cache WHERE itemHash=?");
const setRarity = db.prepare("INSERT INTO rarity_cache (itemHash,percent,label,source,updatedAt) VALUES (?,?,?,?,?) ON CONFLICT(itemHash) DO UPDATE SET percent=excluded.percent,label=excluded.label,source=excluded.source,updatedAt=excluded.updatedAt");
const countRarity = db.prepare("SELECT SUM(CASE WHEN percent IS NULL THEN 1 ELSE 0 END) as nulls, SUM(CASE WHEN percent IS NOT NULL THEN 1 ELSE 0 END) as nonnull FROM rarity_cache");
const getSyncStatus = db.prepare("SELECT last_sync_date, last_sync_timestamp, total_emblems, sync_status FROM daily_sync_status WHERE id = 1");
const updateSyncStatus = db.prepare("UPDATE daily_sync_status SET last_sync_date = ?, last_sync_timestamp = ?, total_emblems = ?, sync_status = ? WHERE id = 1");

// ---------------- Health Endpoints ----------------
app.get("/health", (req,res)=>{
  try {
    // Check database connectivity
    const dbStatus = db.prepare("SELECT 1 as test").get();
    
    // Check memory usage
    const memUsage = process.memoryUsage();
    
    // Check uptime
    const uptime = process.uptime();
    
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      uptime: Math.round(uptime),
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024) + "MB",
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + "MB",
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + "MB"
      },
      database: dbStatus ? "connected" : "error",
      syncStatus: syncProgress.isRunning ? "running" : "idle",
      activeTokens: tokens.size
    });
  } catch (error) {
    log.error({ error: error.message }, "Health check failed");
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Detailed health check for debugging
app.get("/health/detailed", (req,res)=>{
  try {
    const status = getSyncStatus.get();
    const { nulls, nonnull } = countRarity.get() || {};
    
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      database: {
        path: DB_PATH,
        size: fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0
      },
      sync: {
        status: status?.sync_status || "unknown",
        lastSync: status?.last_sync_date || "never",
        totalEmblems: status?.total_emblems || 0,
        rarityData: { nulls: nulls || 0, nonnull: nonnull || 0 }
      },
      progress: syncProgress,
      tokens: {
        count: tokens.size,
        active: Array.from(tokens.keys()).map(k => k.substring(0, 8) + "...")
      }
    });
  } catch (error) {
    log.error({ error: error.message, stack: error.stack }, "Detailed health check failed");
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  }
});

// ---------------- Rarity (ONE SYSTEM ONLY) ----------------
async function getRarityCached(itemHash){
  // ONLY check database - NO scraping, NO sync triggering
  const row = getRarity.get(itemHash);
  if (row && row.percent !== null) {
    return { percent: row.percent, label: row.label, source: row.source, updatedAt: row.updatedAt };
  }
  
  // If no data, return null - let the daily sync handle it
  return { percent: null, label: "light.gg", source: `https://www.light.gg/db/items/${itemHash}/`, updatedAt: null };
}

// ---------------- Daily Sync System (THE ONLY SYNC) ----------------
function isToday(dateString) {
  const today = new Date().toISOString().split('T')[0];
  return dateString === today;
}

async function shouldSyncToday() {
  const status = getSyncStatus.get();
  if (!status || !status.last_sync_date) return true;
  return !isToday(status.last_sync_date);
}

// Global sync state for progress tracking
let syncProgress = {
  isRunning: false,
  current: 0,
  total: 0,
  currentBatch: 0,
  totalBatches: 0,
  currentEmblem: null,
  startTime: null,
  estimatedTimeRemaining: null
};

function updateSyncProgress(update) {
  Object.assign(syncProgress, update);
  
  // Calculate estimated time remaining
  if (syncProgress.current > 0 && syncProgress.startTime) {
    const elapsed = Date.now() - syncProgress.startTime;
    const rate = syncProgress.current / elapsed;
    const remaining = (syncProgress.total - syncProgress.current) / rate;
    syncProgress.estimatedTimeRemaining = Math.round(remaining / 1000); // in seconds
  }
}

async function performDailySync() {
  // Prevent multiple syncs from running
  if (syncProgress.isRunning) {
    log.info("Daily sync already running, skipping");
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const now = Math.floor(Date.now() / 1000);
  
  try {
    log.info("Starting daily emblem rarity sync...");
    updateSyncStatus.run(today, now, 0, "in_progress");
    
    // Initialize progress tracking
    updateSyncProgress({
      isRunning: true,
      current: 0,
      total: 0,
      currentBatch: 0,
      totalBatches: 0,
      currentEmblem: null,
      startTime: Date.now(),
      estimatedTimeRemaining: null
    });
    
    // Get all emblem hashes from catalog
    const catalogRows = listCatalog.all();
    const emblemHashes = catalogRows.map(r => r.itemHash);
    
    if (emblemHashes.length === 0) {
      log.warn("No emblems found in catalog, skipping sync");
      updateSyncStatus.run(today, now, 0, "completed");
      updateSyncProgress({ isRunning: false });
      return;
    }
    
    log.info({ total: emblemHashes.length }, "Syncing emblem rarities");
    
    // Update progress with total count
    updateSyncProgress({
      total: emblemHashes.length,
      totalBatches: Math.ceil(emblemHashes.length / 50)
    });
    
    // Launch browser for scraping with timeout
    try {
      await Promise.race([
        launchBrowser(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Browser launch timeout")), 30000)
        )
      ]);
    } catch (browserError) {
      log.error({ error: browserError.message }, "Failed to launch browser for sync");
      updateSyncStatus.run(today, now, 0, "failed");
      updateSyncProgress({ isRunning: false });
      return;
    }
    
    // Process emblems in batches to avoid overwhelming the system
    const batchSize = 50;
    let processed = 0;
    let successCount = 0;
    
    for (let i = 0; i < emblemHashes.length; i += batchSize) {
      const batch = emblemHashes.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      
      updateSyncProgress({
        currentBatch: batchNumber,
        currentEmblem: `Processing batch ${batchNumber}/${Math.ceil(emblemHashes.length / batchSize)}`
      });
      
      log.info({ batch: batchNumber, total: Math.ceil(emblemHashes.length / batchSize), size: batch.length }, "Processing batch");
      
      // Process batch with concurrency control and timeout protection
      const promises = batch.map(itemHash => 
        new Promise(async (resolve) => {
          try {
            updateSyncProgress({ currentEmblem: `Scraping emblem ${itemHash}` });
            
            // Add timeout to individual emblem scraping
            const result = await Promise.race([
              scrapeEmblemRarity(itemHash),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error("Emblem scraping timeout")), 60000)
              )
            ]);
            
            if (result.percent !== null) {
              setRarity.run(itemHash, result.percent, result.label, result.source, now);
              successCount++;
            }
            processed++;
            
            updateSyncProgress({ current: processed });
            
            // Log progress every 10 emblems
            if (processed % 10 === 0) {
              const percent = Math.round((processed / emblemHashes.length) * 100);
              log.info({ 
                progress: `${processed}/${emblemHashes.length} (${percent}%)`,
                success: successCount,
                current: itemHash
              }, "Sync progress update");
            }
            
          } catch (error) {
            log.error({ itemHash, error: error.message }, "Failed to scrape emblem");
            processed++;
            updateSyncProgress({ current: processed });
          }
          resolve();
        })
      );
      
      // Process batch with timeout
      try {
        await Promise.race([
          Promise.all(promises),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Batch processing timeout")), 300000) // 5 minutes per batch
          )
        ]);
      } catch (batchError) {
        log.error({ batch: batchNumber, error: batchError.message }, "Batch processing failed, continuing with next batch");
        // Continue with next batch instead of failing completely
      }
      
      // Small delay between batches
      if (i + batchSize < emblemHashes.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Update sync status
    updateSyncStatus.run(today, now, successCount, "completed");
    
    // Clear progress tracking
    updateSyncProgress({ isRunning: false });
    
    // Write snapshot
    writeSnapshotSafe();
    
    log.info({ total: emblemHashes.length, success: successCount, processed }, "Daily sync completed");
    
  } catch (error) {
    log.error({ error: error.message, stack: error.stack }, "Daily sync failed");
    updateSyncStatus.run(today, now, 0, "failed");
    updateSyncProgress({ isRunning: false });
  }
}

async function scrapeEmblemRarity(itemHash) {
  return new Promise((resolve) => {
    queueScrape(itemHash, (result) => {
      resolve(result);
    });
  });
}

// ---------------- OAuth (memory tokens) ----------------
const tokens = new Map();
function makeState(){ return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2); }

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

app.get("/oauth/callback", async (req, res) => {
  try{
    const { code, state } = req.query;
    if (!code || !state || !tokens.has(state)) return res.status(400).send("Bad state");
    const r = await axios.post("https://www.bungie.net/platform/app/oauth/token/",
      new URLSearchParams({
        client_id: BUNGIE_CLIENT_ID,
        grant_type: "authorization_code",
        code, client_secret: BUNGIE_CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/oauth/callback`
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const tok = r.data;
    tokens.set(state, { access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: Math.floor(Date.now()/1000)+(tok.expires_in||3600) });
    res.redirect(`/?sid=${encodeURIComponent(state)}`);
  }catch(e){ log.error({ err:e?.message }, "oauth failed"); res.status(500).send("OAuth failed"); }
});

async function authedHeaders(sid){
  let t = tokens.get(sid);
  if (!t) throw new Error("Not linked");
  const now = Math.floor(Date.now()/1000);
  if (t.expires_at - 15 < now){
    const r = await axios.post("https://www.bungie.net/platform/app/oauth/token/",
      new URLSearchParams({
        client_id: BUNGIE_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_secret: BUNGIE_CLIENT_SECRET
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const nt = r.data;
    t = { access_token: nt.access_token, refresh_token: nt.refresh_token || t.refresh_token, expires_at: now + (nt.expires_in || 3600) };
    tokens.set(sid, t);
  }
  return { Authorization: `Bearer ${t.access_token}`, "X-API-Key": BUNGIE_API_KEY };
}

// ---------------- Bungie helpers ----------------
function isUnlocked(state){ return (state & 1) === 0; }
async function concurrentMap(items, fn, concurrency=Number(BUNGIE_CONCURRENCY||"12")){
  const out = new Array(items.length);
  let i=0;
  async function worker(){
    while(i<items.length){
      const idx=i++;
      try{ out[idx] = await fn(items[idx], idx); }catch{ out[idx] = null; }
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency, items.length)}, worker));
  return out;
}

async function getMembership(sid){
  const h = await authedHeaders(sid);
  const r = await BUNGIE.get("/User/GetMembershipsForCurrentUser/", { headers: h });
  const resp = r.data?.Response;
  const dms = resp?.destinyMemberships || [];
  if (!dms.length) throw new Error("No Destiny memberships");
  const primaryId = resp?.primaryMembershipId;
  const chosen = primaryId ? dms.find(m => String(m.membershipId) === String(primaryId)) : dms[0];
  return chosen || dms[0];
}

async function getProfile(sid, mType, mId){
  const h = await authedHeaders(sid);
  const r = await BUNGIE.get(`/Destiny2/${mType}/Profile/${mId}/`, {
    headers: h, params: { components: "800,900" }
  });
  return r.data?.Response;
}

// Manifest entity fetcher with local caches
const inflight = new Map();
async function getEntity(entityType, hash){
  const key = `${entityType}:${hash}`;
  if (entityType === "DestinyCollectibleDefinition"){
    const row = getCollectible.get(hash);
    if (row) return { itemHash: row.itemHash };
  }
  if (entityType === "DestinyInventoryItemDefinition"){
    const cat = getCatalog.get(hash);
    if (cat) return { displayProperties: { name: cat.name, icon: cat.icon }, secondaryIcon: cat.icon, itemCategoryHashes: [19] };
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const url = `/Destiny2/Manifest/${entityType}/${hash}/`;
    for (let attempt=1; attempt<=3; attempt++){
      try {
        const r = await BUNGIE.get(url);
        const data = r.data?.Response;
        if (!data) return null;
        if (entityType === "DestinyCollectibleDefinition"){
          if (data?.itemHash != null) setCollectible.run(hash, data.itemHash);
        } else if (entityType === "DestinyInventoryItemDefinition"){
          const isEmblem = (data?.itemCategoryHashes || []).includes(19);
          if (isEmblem){
            const name = data?.displayProperties?.name || null;
            const icon = data?.secondaryIcon || data?.displayProperties?.icon || null;
            upsertCatalog.run(hash, name, icon);
          }
        }
        return data;
      } catch(e){
        const status = e?.response?.status;
        if (status === 404) return null;
        await new Promise(r => setTimeout(r, 250*attempt));
      }
    }
    return null;
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

async function getOwnedEmblemItemHashes(profile){
  const owned = new Set();
  const pColl = profile?.profileCollectibles?.data?.collectibles || {};
  for (const [hash, v] of Object.entries(pColl)) if (isUnlocked(v?.state ?? 0)) owned.add(Number(hash));
  const chars = profile?.characterCollectibles?.data || {};
  for (const c of Object.values(chars)){
    const colls = c?.collectibles || {};
    for (const [hash, v] of Object.entries(colls)) if (isUnlocked(v?.state ?? 0)) owned.add(Number(hash));
  }
  const collHashes = [...owned];
  const itemHashes = (await concurrentMap(collHashes, async (collHash) => {
    const c = await getEntity("DestinyCollectibleDefinition", collHash);
    return c?.itemHash ?? null;
  })).filter(Boolean);
  const emblemHashes = (await concurrentMap(itemHashes, async (ih) => {
    const it = await getEntity("DestinyInventoryItemDefinition", ih);
    const cats = it?.itemCategoryHashes || [];
    return cats.includes(19) ? ih : null;
  })).filter(Boolean);
  return [...new Set(emblemHashes)];
}

// snapshot writer with debounce
let snapshotTimer = null;
function writeSnapshotSafe(){
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    try {
      const rows = db.prepare("SELECT itemHash, percent, label, source, updatedAt FROM rarity_cache WHERE percent IS NOT NULL").all();
      fs.writeFileSync(path.join(__dirname, "public", "rarity-snapshot.json"), JSON.stringify(rows));
      log.info({ count: rows.length }, "snapshot written");
    } catch(e){ log.error({ err: e?.message }, "snapshot failed"); }
  }, 500);
}

// ---------------- Daily Sync Endpoints ----------------
app.get("/api/sync/status", (req, res) => {
  try {
    const status = getSyncStatus.get();
    const { nulls, nonnull } = countRarity.get() || {};
    
    // Calculate what needs to happen
    const needsSync = status ? !isToday(status.last_sync_date) : true;
    const hasData = (nonnull || 0) > 0;
    const syncState = status?.sync_status || "pending";
    
    res.json({
      last_sync_date: status?.last_sync_date || null,
      last_sync_timestamp: status?.last_sync_timestamp || 0,
      total_emblems: status?.total_emblems || 0,
      sync_status: syncState,
      should_sync_today: needsSync,
      has_rarity_data: hasData,
      rarity_stats: {
        with_data: nonnull || 0,
        without_data: nulls || 0
      },
      progress: syncProgress,
      next_action: needsSync ? "trigger_sync" : "wait_for_tomorrow",
      message: needsSync 
        ? "Data needs to be synced today. Use admin panel to trigger sync."
        : "Data is current. Next sync will be tomorrow."
    });
  } catch (e) {
    log.error({ error: e.message }, "Failed to get sync status");
    res.status(500).json({ error: "Failed to get sync status" });
  }
});

app.get("/api/sync/progress", (req, res) => {
  try {
    res.json(syncProgress);
  } catch (e) {
    log.error({ error: e.message }, "Failed to get sync progress");
    res.status(500).json({ error: "Failed to get sync progress" });
  }
});

app.post("/api/sync/trigger", async (req, res) => {
  try {
    if (syncProgress.isRunning) {
      return res.json({ message: "Sync already running", status: "already_running" });
    }
    
    if (await shouldSyncToday()) {
      // Start sync in background
      performDailySync().catch(e => log.error({ error: e.message }, "Background sync failed"));
      res.json({ message: "Daily sync started", status: "started" });
    } else {
      res.json({ message: "Already synced today", status: "already_synced" });
    }
  } catch (e) {
    log.error({ error: e.message }, "Failed to trigger sync");
    res.status(500).json({ error: "Failed to trigger sync" });
  }
});

// ---------------- API ----------------
app.get("/api/emblems", async (req, res) => {
  try{
    const sid = req.query.sid;
    if (!sid || !tokens.has(sid)) return res.status(401).json({ error: "Not linked" });
    
    log.info({ sid: sid.substring(0, 8) + "..." }, "Processing emblem request");
    
    const mem = await getMembership(sid);
    const profile = await getProfile(sid, mem.membershipType, mem.membershipId);
    const hashes = await getOwnedEmblemItemHashes(profile);
    
    log.info({ sid: sid.substring(0, 8) + "...", emblemCount: hashes.length }, "Retrieved emblem hashes");
    
    if (!hashes.length) return res.json({ emblems: [] });

    // Build rows from database
    const rows = [];
    const missing = [];
    for (const h of hashes){
      const cat = getCatalog.get(h);
      const name = cat?.name || `Emblem ${h}`;
      const icon = cat?.icon ? `https://www.bungie.net${cat.icon}` : null;
      if (!cat) missing.push(h);
      const rc = getRarity.get(h);
      rows.push({
        itemHash: h,
        name, image: icon,
        rarityPercent: rc?.percent ?? null,
        rarityLabel: rc?.label ?? null,
        rarityUpdatedAt: rc?.updatedAt ?? null,
        sourceUrl: rc?.source ?? null
      });
    }
    
    log.info({ sid: sid.substring(0, 8) + "...", rows: rows.length, missing: missing.length }, "Built emblem rows");
    
    // resolve some missing name/icons now
    for (const h of missing.slice(0,48)){
      try {
        const it = await BUNGIE.get(`/Destiny2/Manifest/DestinyInventoryItemDefinition/${h}/`);
        const d = it.data?.Response;
        if (d){
          const nm = d?.displayProperties?.name || null;
          const ic = d?.secondaryIcon || d?.displayProperties?.icon || null;
          upsertCatalog.run(h, nm, ic);
          const row = rows.find(r => r.itemHash===h);
          if (row){
            if (nm) row.name = nm;
            if (ic) row.image = `https://www.bungie.net${ic}`;
           }
        }
      }catch(e){
        log.warn({ itemHash: h, error: e.message }, "Failed to resolve missing emblem data");
      }
    }

    // sort by rarity
    rows.sort((a,b)=> (a.rarityPercent ?? 9e9) - (b.rarityPercent ?? 9e9));
    
    // NO MORE SYNC TRIGGERING - let the daily sync handle it
    log.info({ sid: sid.substring(0, 8) + "...", finalCount: rows.length }, "Sending emblem response");
    res.json({ emblems: rows });
  }catch(e){ 
    log.error({ err:e?.message, stack: e?.stack }, "/api/emblems failed"); 
    res.status(500).json({ error: "Server error" }); 
  }
});

app.get("/api/rarity", async (req, res) => {
  try{
    const hash = Number(req.query.hash);
    if (!hash) return res.status(400).json({ error: "hash required" });
    
    log.info({ hash }, "Processing rarity request");
    
    const r = await getRarityCached(hash);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(r);
  }catch(e){ 
    log.error({ err:e?.message, stack: e?.stack }, "/api/rarity failed"); 
    res.status(500).json({ error:"rarity error" }); 
  }
});

// Admin endpoints
app.get("/admin/help", (req,res) => {
  const k = normKey(ADMIN_KEY);
  const allow = String(ALLOW_QUERY_ADMIN||"true").toLowerCase()==="true";
  res.json({ adminConfigured: Boolean(k), allowQuery: allow, keyLength: k.length });
});

app.get("/admin/ping", (req,res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  res.json({ ok:true, admin:true });
});

app.post("/admin/sync", async (req,res) => {
  try{
    if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    await performDailySync();
    const { nulls, nonnull } = countRarity.get() || {};
    res.json({ ok:true, rarity: { nulls, nonnull } });
  }catch(e){ log.error({ err:e?.message }, "admin sync failed"); res.status(500).json({ error:"admin error" }); }
});

app.post("/admin/snapshot", (req,res) => {
  try{
    if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    writeSnapshotSafe();
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error:"snapshot error" }); }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---------------- Startup and Cron ----------------
// Check if we need to sync on startup
async function checkStartupSync() {
  try {
    log.info("Checking if startup sync is needed...");
    
    if (await shouldSyncToday()) {
      log.info("Startup sync needed, but will wait for manual trigger or cron");
      // Don't auto-start sync - let admin or cron handle it
      log.info("Use admin panel to trigger sync or wait for scheduled cron");
    } else {
      log.info("No startup sync needed, data is current");
    }
  } catch (e) {
    log.error({ error: e.message, stack: e.stack }, "Startup sync check failed");
  }
}

// Graceful shutdown handling
async function gracefulShutdown(signal) {
  log.info({ signal }, "Received shutdown signal, starting graceful shutdown...");
  
  try {
    // Stop accepting new requests
    server.close(() => {
      log.info("HTTP server closed");
    });
    
    // Close database connections
    if (db) {
      db.close();
      log.info("Database connections closed");
    }
    
    // Close browser
    try {
      const browser = await launchBrowser();
      if (browser) {
        await browser.close();
        log.info("Browser closed");
      }
    } catch (e) {
      log.warn({ error: e.message }, "Failed to close browser during shutdown");
    }
    
    log.info("Graceful shutdown completed");
    process.exit(0);
  } catch (error) {
    log.error({ error: error.message }, "Error during graceful shutdown");
    process.exit(1);
  }
}

// Schedule daily sync
if (CRON_ENABLED === "true" && REFRESH_CRON){
  cron.schedule(REFRESH_CRON, () => {
    log.info("Cron triggered daily sync");
    performDailySync().catch(e => log.error({ err:e?.message, stack: e?.stack }, "cron sync failed"));
  }, { timezone: CRON_TZ });
  log.info({ cron: REFRESH_CRON, tz: CRON_TZ }, "cron scheduled");
}

// Handle various shutdown signals
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
process.on("SIGUSR2", gracefulShutdown); // For nodemon

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  log.error({ error: error.message, stack: error.stack }, "Uncaught Exception");
  // Don't exit immediately, let the process continue if possible
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  log.error({ reason: reason?.message || reason, stack: reason?.stack }, "Unhandled Rejection at Promise");
  // Don't exit immediately, let the process continue if possible
});

let server;
process.on("SIGTERM", async () => {
  try { 
    const browser = await launchBrowser();
    if (browser) await browser.close(); 
  } catch {}
  process.exit(0);
});

app.listen(PORT, async () => {
  try {
    await launchBrowser();
    log.info(`Listening on ${PORT}`);
    
    // Check startup status but don't auto-start sync
    setTimeout(checkStartupSync, 5000); // Wait 5 seconds after startup
  } catch (error) {
    log.error({ error: error.message, stack: error.stack }, "Failed to start server");
    process.exit(1);
  }
});
