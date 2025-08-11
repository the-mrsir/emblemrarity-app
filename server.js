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

const log = pino({ level: process.env.LOG_LEVEL || "info", transport: process.env.NODE_ENV==="production" ? undefined : { target: "pino-pretty", options: { colorize: true } } });

const {
  PORT = 3000,
  BASE_URL,
  BUNGIE_API_KEY,
  BUNGIE_CLIENT_ID,
  BUNGIE_CLIENT_SECRET,
  // Admin
  ADMIN_KEY,
  ALLOW_QUERY_ADMIN = "true",
  // Cron
  CRON_ENABLED = "true",
  REFRESH_CRON = "0 3 * * *",
  CRON_TZ = "America/New_York",
  // Rarity cache TTLs
  LIGHTGG_TTL = "2592000",        // 30d for positives
  LIGHTGG_NULL_TTL = "1800",      // 30m for nulls
  // Bungie/manifest concurrency
  BUNGIE_CONCURRENCY = "12"
} = process.env;

if (!BASE_URL || !BUNGIE_API_KEY || !BUNGIE_CLIENT_ID || !BUNGIE_CLIENT_SECRET) {
  console.error("Missing env vars: BASE_URL, BUNGIE_API_KEY, BUNGIE_CLIENT_ID, BUNGIE_CLIENT_SECRET");
  process.exit(1);
}

const app = express();
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

app.use(express.json({ limit: "1mb" }));

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
`);
const setCollectible = db.prepare("INSERT INTO collectible_item (collectibleHash,itemHash) VALUES (?,?) ON CONFLICT(collectibleHash) DO UPDATE SET itemHash=excluded.itemHash");
const getCollectible = db.prepare("SELECT itemHash FROM collectible_item WHERE collectibleHash=?");
const upsertCatalog = db.prepare("INSERT INTO emblem_catalog (itemHash,name,icon) VALUES (?,?,?) ON CONFLICT(itemHash) DO UPDATE SET name=COALESCE(excluded.name,name), icon=COALESCE(excluded.icon,icon)");
const getCatalog = db.prepare("SELECT itemHash,name,icon FROM emblem_catalog WHERE itemHash=?");
const listCatalog = db.prepare("SELECT itemHash FROM emblem_catalog");
const getRarity = db.prepare("SELECT percent,label,source,updatedAt FROM rarity_cache WHERE itemHash=?");
const setRarity = db.prepare("INSERT INTO rarity_cache (itemHash,percent,label,source,updatedAt) VALUES (?,?,?,?,?) ON CONFLICT(itemHash) DO UPDATE SET percent=excluded.percent,label=excluded.label,source=excluded.source,updatedAt=excluded.updatedAt");
const countRarity = db.prepare("SELECT SUM(CASE WHEN percent IS NULL THEN 1 ELSE 0 END) as nulls, SUM(CASE WHEN percent IS NOT NULL THEN 1 ELSE 0 END) as nonnull FROM rarity_cache");

// ---------------- OAuth (memory tokens) ----------------
const tokens = new Map(); // sid -> {access_token, refresh_token, expires_at}
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

// ---------------- Rarity (cache-first + worker queue) ----------------
const POS_TTL = Number(LIGHTGG_TTL||"2592000");
const NULL_TTL = Number(LIGHTGG_NULL_TTL||"1800");

async function getRarityCached(itemHash){
  const row = getRarity.get(itemHash);
  const now = Math.floor(Date.now()/1000);
  if (row){
    const age = now - (row.updatedAt || 0);
    const stale = (row.percent == null && age >= NULL_TTL) || (row.percent != null && age >= POS_TTL);
    if (stale) queueScrape(itemHash, async (r) => {
      setRarity.run(itemHash, r.percent, r.label, r.source, Math.floor(Date.now()/1000));
      writeSnapshotSafe();
    });
    return { percent: row.percent, label: row.label, source: row.source, updatedAt: row.updatedAt };
  }
  // first time
  queueScrape(itemHash, async (r) => {
    setRarity.run(itemHash, r.percent, r.label, r.source, Math.floor(Date.now()/1000));
    writeSnapshotSafe();
  });
  return { percent: null, label: "light.gg", source: `https://www.light.gg/db/items/${itemHash}/`, updatedAt: null };
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

// nightly refresh
async function refreshAllRarities(limit=null){
  const rows = listCatalog.all();
  const hashes = rows.map(r => r.itemHash);
  const target = limit ? hashes.slice(0, limit) : hashes;
  log.info({ total: target.length }, "nightly refresh start");
  let done = 0;
  await Promise.all(target.map(h => new Promise((resolve) => {
    queueScrape(h, (r) => {
      setRarity.run(h, r.percent, r.label, r.source, Math.floor(Date.now()/1000));
      resolve();
    });
  })));
  writeSnapshotSafe();
  log.info({ total: target.length }, "nightly refresh done");
}

if (CRON_ENABLED === "true" && REFRESH_CRON){
  cron.schedule(REFRESH_CRON, () => {
    refreshAllRarities().catch(e => log.error({ err:e?.message }, "cron refresh failed"));
  }, { timezone: CRON_TZ });
  log.info({ cron: REFRESH_CRON, tz: CRON_TZ }, "cron scheduled");

// public refresh lock
let publicRefreshBusy = false;
let publicRefreshLast = 0;

}

// ---------------- API ----------------
app.get("/api/emblems", async (req, res) => {
  try{
    const sid = req.query.sid;
    if (!sid || !tokens.has(sid)) return res.status(401).json({ error: "Not linked" });
    const mem = await getMembership(sid);
    const profile = await getProfile(sid, mem.membershipType, mem.membershipId);
    const hashes = await getOwnedEmblemItemHashes(profile);
    if (!hashes.length) return res.json({ emblems: [] });

    // Build rows
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
      }catch{}
    }

    // sort by rarity
    rows.sort((a,b)=> (a.rarityPercent ?? 9e9) - (b.rarityPercent ?? 9e9));
    // gentle prewarm for top 24
    rows.slice(0,24).forEach(r => getRarityCached(r.itemHash));

    res.json({ emblems: rows });
  }catch(e){ log.error({ err:e?.message }, "/api/emblems failed"); res.status(500).json({ error: "Server error" }); }
});

app.get("/api/rarity", async (req, res) => {
  try{
    const hash = Number(req.query.hash);
    if (!hash) return res.status(400).json({ error: "hash required" });
    const r = await getRarityCached(hash);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(r);
  }catch(e){ log.error({ err:e?.message }, "/api/rarity failed"); res.status(500).json({ error:"rarity error" }); }
});

// ---- Public refresh endpoints (no auth; temporary) ----
app.get("/refresh-now", async (req,res) => {
  if (publicRefreshBusy) return res.status(429).json({ error: "busy" });
  publicRefreshBusy = true; publicRefreshLast = Date.now();
  try{
    await launchBrowser();
    const limit = req.query?.limit ? Number(req.query.limit) : null;
    await refreshAllRarities(limit);
    const { nulls, nonnull } = countRarity.get() || {};
    return res.json({ ok:true, rarity:{ nulls, nonnull }, last: publicRefreshLast });
  }catch(e){
    log.error({ err:e?.message }, "refresh-now error");
    return res.status(500).json({ error:"refresh error" });
  } finally {
    publicRefreshBusy = false;
  }
});
    publicRefreshBusy = true; publicRefreshLast = Date.now();
    const limit = req.query?.limit ? Number(req.query.limit) : null;
    await launchBrowser();
    await refreshAllRarities(limit);
    publicRefreshBusy = false;
    const { nulls, nonnull } = countRarity.get() || {};
    return res.json({ ok:true, rarity:{ nulls, nonnull }, last: publicRefreshLast });
  }catch(e){ publicRefreshBusy = false; log.error({ err:e?.message }, "refresh-now error"); return res.status(500).json({ error:"refresh error" }); }
});
app.get("/snapshot-now", (req,res)=>{
  try{ writeSnapshotSafe(); res.json({ ok:true }); }
  catch(e){ res.status(500).json({ error:"snapshot error" }); }
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
app.get("/admin/refresh", async (req,res) => {
  try{
    if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    const limit = req.query?.limit ? Number(req.query.limit) : null;
    await launchBrowser();
    await refreshAllRarities(limit);
    const { nulls, nonnull } = countRarity.get() || {};
    res.json({ ok:true, rarity: { nulls, nonnull } });
  }catch(e){ log.error({ err:e?.message }, "admin refresh failed"); res.status(500).json({ error:"admin error" }); }
});
app.post("/admin/snapshot", (req,res) => {
  try{
    if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    writeSnapshotSafe();
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error:"snapshot error" }); }
});

app.get("/stats", (req,res) => {
  try{
    const cat = listCatalog.all().length;
    const rc = countRarity.get() || {};
    res.json({
      catalogCount: cat,
      rarity: rc,
      cron: { enabled: String(CRON_ENABLED)==="true", spec: REFRESH_CRON, tz: CRON_TZ },
      throttle: { concurrency: 2, minGapMs: 200 },
      adminConfigured: Boolean(normKey(ADMIN_KEY))
    });
  }catch(e){ res.status(500).json({ error:"stats error" }); }
});

app.get("/health", (req,res)=>res.json({ok:true}));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

process.on("SIGTERM", async () => {
  try { await (await launchBrowser()).close(); } catch {}
  process.exit(0);
});

app.listen(PORT, async () => {
  await launchBrowser();
  log.info(`Listening on ${PORT}`);
});
