import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import Database from "better-sqlite3";
import cron from "node-cron";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 3000,
  BASE_URL,
  BUNGIE_API_KEY,
  BUNGIE_CLIENT_ID,
  BUNGIE_CLIENT_SECRET,
  CRON_ENABLED = "true",
  REFRESH_CRON = "0 3 * * *",            // 3:00 AM
  CRON_TZ = "America/New_York",
  LIGHTGG_NULL_TTL = "1800",             // 30m for nulls
  LIGHTGG_TTL = "2592000",               // 30d for positives
  LIGHTGG_RETRY_MS = "4000",
  ADMIN_KEY,
  RARITY_CONCURRENCY = "2",
  RARITY_MIN_GAP_MS = "200"
} = process.env;

if (!BASE_URL || !BUNGIE_API_KEY || !BUNGIE_CLIENT_ID || !BUNGIE_CLIENT_SECRET) {
  console.error("Missing env vars: BASE_URL, BUNGIE_API_KEY, BUNGIE_CLIENT_ID, BUNGIE_CLIENT_SECRET");
  process.exit(1);
}

const app = express();
app.use(express.static("public"));

const BUNGIE = axios.create({
  baseURL: "https://www.bungie.net/Platform",
  headers: { "X-API-Key": BUNGIE_API_KEY },
  timeout: 20000
});

function logErr(tag, e) {
  const status = e?.response?.status;
  const data = e?.response?.data;
  const msg = e?.message || e;
  console.error(`[${tag}] status=${status} msg=${msg}`);
  if (data) console.error(`[${tag}] body=`, JSON.stringify(data).slice(0, 400));
}
function logInfo(msg) { console.log(`[info] ${msg}`); }
function nowSec(){ return Math.floor(Date.now()/1000); }

// ---------------- DB schema (no user data) ----------------
const db = new Database(path.join(process.cwd(), "cache.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS collectible_item (
  collectibleHash INTEGER PRIMARY KEY,
  itemHash INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS item_emblem (
  itemHash INTEGER PRIMARY KEY,
  isEmblem INTEGER NOT NULL,
  name TEXT,
  icon TEXT
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
DROP TABLE IF EXISTS user_owned;
`);

const upsertColl = db.prepare("INSERT INTO collectible_item (collectibleHash, itemHash) VALUES (?,?) ON CONFLICT(collectibleHash) DO UPDATE SET itemHash=excluded.itemHash");
const getColl = db.prepare("SELECT itemHash FROM collectible_item WHERE collectibleHash=?");
const upsertItem = db.prepare("INSERT INTO item_emblem (itemHash,isEmblem,name,icon) VALUES (?,?,?,?) ON CONFLICT(itemHash) DO UPDATE SET isEmblem=excluded.isEmblem, name=COALESCE(excluded.name, name), icon=COALESCE(excluded.icon, icon)");
const getItem = db.prepare("SELECT isEmblem,name,icon FROM item_emblem WHERE itemHash=?");
const upsertCatalog = db.prepare("INSERT INTO emblem_catalog (itemHash,name,icon) VALUES (?,?,?) ON CONFLICT(itemHash) DO UPDATE SET name=COALESCE(excluded.name, name), icon=COALESCE(excluded.icon, icon)");
const getCatalog = db.prepare("SELECT name,icon FROM emblem_catalog WHERE itemHash=?");
const listCatalog = db.prepare("SELECT itemHash FROM emblem_catalog");
const getRarity = db.prepare("SELECT percent,label,source,updatedAt FROM rarity_cache WHERE itemHash=?");
const setRarity = db.prepare("INSERT INTO rarity_cache (itemHash,percent,label,source,updatedAt) VALUES (?,?,?,?,?) ON CONFLICT(itemHash) DO UPDATE SET percent=excluded.percent,label=excluded.label,source=excluded.source,updatedAt=excluded.updatedAt");
const countRarity = db.prepare("SELECT SUM(CASE WHEN percent IS NULL THEN 1 ELSE 0 END) as nulls, SUM(CASE WHEN percent IS NOT NULL THEN 1 ELSE 0 END) as nonnull FROM rarity_cache");

// ---------------- OAuth tokens (memory only) ----------------
const tokens = new Map(); // sid -> {access_token, refresh_token, expires_at}
function makeState() { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }

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
  try {
    const { code, state } = req.query;
    if (!code || !state || !tokens.has(state)) return res.status(400).send("Bad state");

    const tokenResp = await axios.post(
      "https://www.bungie.net/platform/app/oauth/token/",
      new URLSearchParams({
        client_id: BUNGIE_CLIENT_ID,
        grant_type: "authorization_code",
        code: code,
        client_secret: BUNGIE_CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/oauth/callback`
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const tok = tokenResp.data;
    tokens.set(state, {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (tok.expires_in || 3600)
    });

    res.redirect(`/?sid=${encodeURIComponent(state)}`);
  } catch (e) {
    logErr("oauth/callback", e);
    res.status(500).send("OAuth failed");
  }
});

async function authedHeaders(sid) {
  let t = tokens.get(sid);
  if (!t) throw new Error("Not linked");
  const now = nowSec();
  if (t.expires_at - 15 < now) {
    try {
      const r = await axios.post(
        "https://www.bungie.net/platform/app/oauth/token/",
        new URLSearchParams({
          client_id: BUNGIE_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: t.refresh_token,
          client_secret: BUNGIE_CLIENT_SECRET
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      const nt = r.data;
      t = {
        access_token: nt.access_token,
        refresh_token: nt.refresh_token || t.refresh_token,
        expires_at: now + (nt.expires_in || 3600)
      };
      tokens.set(sid, t);
    } catch (e) {
      logErr("token refresh", e);
      throw e;
    }
  }
  return { Authorization: `Bearer ${t.access_token}`, "X-API-Key": BUNGIE_API_KEY };
}

// ---------------- Bungie helpers ----------------
async function getMembership(sid) {
  const h = await authedHeaders(sid);
  const r = await BUNGIE.get("/User/GetMembershipsForCurrentUser/", { headers: h });
  const resp = r.data?.Response;
  const dms = resp?.destinyMemberships || [];
  if (!dms.length) throw new Error("No Destiny memberships");
  const primaryId = resp?.primaryMembershipId;
  const chosen = primaryId ? dms.find(m => String(m.membershipId) === String(primaryId)) : dms[0];
  return chosen || dms[0];
}

async function getProfile(sid, membershipType, membershipId) {
  const h = await authedHeaders(sid);
  const r = await BUNGIE.get(`/Destiny2/${membershipType}/Profile/${membershipId}/`, {
    headers: h,
    params: { components: "800,900" }
  });
  return r.data?.Response;
}

// Per-entity manifest with DB cache + retries
const inflight = new Map();
async function getEntity(entityType, hash) {
  const key = `${entityType}:${hash}`;

  if (entityType === "DestinyInventoryItemDefinition") {
    const row = getItem.get(hash);
    if (row) return { displayProperties: { name: row.name, icon: row.icon }, secondaryIcon: row.icon, itemCategoryHashes: row.isEmblem ? [19] : [] };
  }
  if (entityType === "DestinyCollectibleDefinition") {
    const row = getColl.get(hash);
    if (row) return { itemHash: row.itemHash };
  }

  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const url = `/Destiny2/Manifest/${entityType}/${hash}/`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await BUNGIE.get(url);
        const data = r.data?.Response;
        if (!data) return null;
        if (entityType === "DestinyInventoryItemDefinition") {
          const isEmblem = (data?.itemCategoryHashes || []).includes(19) ? 1 : 0;
          const name = data?.displayProperties?.name || null;
          const icon = data?.secondaryIcon || data?.displayProperties?.icon || null;
          upsertItem.run(hash, isEmblem, name, icon);
          if (isEmblem) upsertCatalog.run(hash, name, icon);
        } else if (entityType === "DestinyCollectibleDefinition") {
          if (data?.itemHash != null) upsertColl.run(hash, data.itemHash);
        }
        return data;
      } catch (e) {
        const status = e?.response?.status;
        logErr(`getEntity ${entityType}:${hash} attempt ${attempt}`, e);
        if (status === 404) return null;
        await new Promise(r => setTimeout(r, 250 * attempt));
      }
    }
    return null;
  })();

  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

function isUnlocked(state) { return (state & 1) === 0; }

async function concurrentMap(items, fn, concurrency=32) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        logErr("concurrentMap item", e);
        out[idx] = null;
      }
    }
  }
  const workers = Array.from({length: Math.min(concurrency, items.length)}, worker);
  await Promise.all(workers);
  return out;
}

async function getOwnedEmblemItemHashes(profile) {
  const owned = new Set();
  const pColl = profile?.profileCollectibles?.data?.collectibles || {};
  for (const [hash, v] of Object.entries(pColl)) if (isUnlocked(v?.state ?? 0)) owned.add(Number(hash));
  const chars = profile?.characterCollectibles?.data || {};
  for (const c of Object.values(chars)) {
    const colls = c?.collectibles || {};
    for (const [hash, v] of Object.entries(colls)) if (isUnlocked(v?.state ?? 0)) owned.add(Number(hash));
  }

  const ownedArr = [...owned];
  const itemHashes = (await concurrentMap(ownedArr, async (collHash) => {
    const coll = await getEntity("DestinyCollectibleDefinition", collHash);
    return coll?.itemHash ?? null;
  }, 32)).filter(Boolean);

  const emblemHashes = (await concurrentMap(itemHashes, async (itemHash) => {
    const item = await getEntity("DestinyInventoryItemDefinition", itemHash);
    const cats = item?.itemCategoryHashes || [];
    return cats.includes(19) ? itemHash : null;
  }, 32)).filter(Boolean);

  return [...new Set(emblemHashes)];
}

// --------------- Playwright rarity ---------------
let browser;
let lastScrapeAt = 0;
let activeScrapes = 0;
const scrapeQueue = [];
const MAX_CONC = Number(RARITY_CONCURRENCY);
const MIN_GAP = Number(RARITY_MIN_GAP_MS);

async function ensureBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-setuid-sandbox"] });
  }
}

function extractPctFromText(text) {
  const pats = [/Found by\s+(\d{1,3}(?:\.\d+)?)%/i, /Community Rarity[\s\S]{0,200}?(\d{1,3}(?:\.\d+)?)%/i];
  for (const re of pats) { const m = text.match(re); if (m) return parseFloat(m[1]); }
  return null;
}

async function doScrape(itemHash) {
  await ensureBrowser();
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9", "Referer": "https://www.google.com/" }
  });
  const pg = await ctx.newPage();
  const url = `https://www.light.gg/db/items/${itemHash}/`;
  let res = { percent: null, label: "light.gg", source: url };
  try {
    await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const title = await pg.title();
    if (/just a moment|attention required/i.test(title)) {
      await pg.waitForTimeout(Number(LIGHTGG_RETRY_MS));
      await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    const text = await pg.evaluate(() => document.body.innerText || document.body.textContent || "");
    const pct = extractPctFromText(text);
    res = { percent: pct, label: pct != null ? "light.gg Community" : "light.gg", source: url };
  } catch (e) { logErr(`fetchRarity ${itemHash}`, e); }
  try { await pg.close(); await ctx.close(); } catch {}
  return res;
}

function scheduleScrape(itemHash) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      const wait = Math.max(0, MIN_GAP - (Date.now() - lastScrapeAt));
      await new Promise(r => setTimeout(r, wait));
      lastScrapeAt = Date.now();
      try { const r = await doScrape(itemHash); resolve(r); }
      catch (e) { reject(e); }
    };
    scrapeQueue.push(task);
    runQueue();
  });
}
async function runQueue() {
  if (activeScrapes >= MAX_CONC) return;
  const task = scrapeQueue.shift();
  if (!task) return;
  activeScrapes++;
  try { await task(); }
  finally { activeScrapes--; runQueue(); }
}

const rarityInflight = new Map();

async function fetchRarityNetwork(itemHash) {
  // throttle via queue
  return scheduleScrape(itemHash);
}

async function refreshRarityForce(itemHash) {
  const r = await fetchRarityNetwork(itemHash);
  setRarity.run(itemHash, r.percent, r.label, r.source, nowSec());
  return r;
}

function shouldRefresh(row, now=nowSec()) {
  const NULL_TTL = Number(LIGHTGG_NULL_TTL);
  const POS_TTL  = Number(LIGHTGG_TTL);
  const age = now - (row.updatedAt || 0);
  return (row.percent == null && age >= NULL_TTL) || (row.percent != null && age >= POS_TTL);
}

/** Cache-first rarity:
 * - If cached, return instantly and queue a background refresh if stale.
 * - If not cached, scrape once and store.
 */
async function getRarityCached(hash) {
  const row = getRarity.get(hash);
  if (row) {
    if (shouldRefresh(row)) queueRefresh(hash);
    return { percent: row.percent, label: row.label, source: row.source, updatedAt: row.updatedAt };
  }
  const r = await refreshRarityForce(hash);
  return { ...r, updatedAt: nowSec() };
}

// Background refresh queue (no stampede)
const refreshQueue = new Set();
async function queueRefresh(hash) {
  if (refreshQueue.has(hash)) return;
  refreshQueue.add(hash);
  try { await refreshRarityForce(hash); }
  catch (e) { logErr(`queueRefresh ${hash}`, e); }
  finally { refreshQueue.delete(hash); }
}

// --------------- Nightly bulk refresh + snapshot ---------------
function writeSnapshot() {
  try {
    const rows = db.prepare("SELECT itemHash, percent, label, source, updatedAt FROM rarity_cache WHERE percent IS NOT NULL").all();
    const fp = path.join(__dirname, "public", "rarity-snapshot.json");
    fs.writeFileSync(fp, JSON.stringify(rows));
    logInfo(`Wrote rarity-snapshot.json (${rows.length} items)`);
  } catch (e) {
    logErr("writeSnapshot", e);
  }
}

async function refreshAllRarities(limit = null) {
  const rows = listCatalog.all();
  const hashes = rows.map(r => r.itemHash);
  const target = limit ? hashes.slice(0, limit) : hashes;
  logInfo(`Nightly rarity refresh: ${target.length} items`);
  let ok = 0;
  for (const h of target) {
    try { const r = await refreshRarityForce(h); if (r.percent != null) ok++; }
    catch (e) { logErr(`refreshRarityForce ${h}`, e); }
  }
  writeSnapshot();
  logInfo(`Nightly refresh done. Updated ${ok}/${target.length}`);
}

if (CRON_ENABLED === "true" && REFRESH_CRON) {
  try {
    cron.schedule(REFRESH_CRON, () => {
      refreshAllRarities().catch(e => logErr("cron refresh", e));
    }, { timezone: CRON_TZ });
    logInfo(`Cron scheduled: "${REFRESH_CRON}" TZ=${CRON_TZ}`);
  } catch (e) {
    logErr("cron schedule", e);
  }
}

// Snapshot route with caching headers
app.get("/rarity-snapshot.json", (req, res) => {
  try {
    const fp = path.join(__dirname, "public", "rarity-snapshot.json");
    if (!fs.existsSync(fp)) return res.json([]);
    const data = fs.readFileSync(fp, "utf-8");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.send(data);
  } catch (e) {
    logErr("snapshot", e); res.json([]);
  }
});

// Admin: force full refresh & snapshot (no user data). Protect with ADMIN_KEY.
app.post("/admin/refresh", express.json(), async (req, res) => {
  try {
    if (!ADMIN_KEY || req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
    const limit = req.body?.limit ? Number(req.body.limit) : null;
    await refreshAllRarities(limit);
    const { nulls, nonnull } = countRarity.get() || {};
    res.json({ ok: true, rarity: { nulls, nonnull } });
  } catch (e) { logErr("admin/refresh", e); res.status(500).json({ error: "admin error" }); }
});

// ---------------- API ----------------
app.get("/api/emblems", async (req, res) => {
  try {
    const sid = req.query.sid;
    if (!sid || !tokens.has(sid)) return res.status(401).json({ error: "Not linked" });

    const mem = await getMembership(sid);
    const profile = await getProfile(sid, mem.membershipType, mem.membershipId);

    const hashes = await getOwnedEmblemItemHashes(profile);
    if (!hashes.length) return res.json({ emblems: [] });

    // Build rows primarily from catalog, include rarityUpdatedAt
    const rows = [];
    const missing = [];
    for (const h of hashes) {
      const cat = getCatalog.get(h);
      const name = cat?.name || null;
      const icon = cat?.icon || null;
      if (!name || !icon) missing.push(h);
      const rc = getRarity.get(h);
      rows.push({
        itemHash: h,
        name: name || `Emblem ${h}`,
        image: icon ? `https://www.bungie.net${icon}` : null,
        rarityPercent: rc?.percent ?? null,
        rarityLabel: rc?.label ?? null,
        rarityUpdatedAt: rc?.updatedAt ?? null,
        sourceUrl: rc?.source ?? null
      });
    }
    // Resolve some missing now for better UX
    for (const h of missing.slice(0,48)) {
      try {
        const item = await getEntity("DestinyInventoryItemDefinition", h);
        const name = item?.displayProperties?.name || null;
        const icon = item?.secondaryIcon || item?.displayProperties?.icon || null;
        if (name || icon) upsertCatalog.run(h, name, icon);
        const row = rows.find(r => r.itemHash === h);
        if (row) {
          if (name) row.name = name;
          if (icon) row.image = `https://www.bungie.net${icon}`;
        }
      } catch {}
    }
    // Background fill the rest
    (async () => {
      for (const h of missing.slice(48)) {
        try {
          const item = await getEntity("DestinyInventoryItemDefinition", h);
          const name = item?.displayProperties?.name || null;
          const icon = item?.secondaryIcon || item?.displayProperties?.icon || null;
          if (name || icon) upsertCatalog.run(h, name, icon);
        } catch {}
      }
    })();

    // Sort by rarity
    rows.sort((a,b)=> (a.rarityPercent ?? 999999) - (b.rarityPercent ?? 999999));

    res.setHeader("Cache-Control", "no-store");
    res.json({ emblems: rows });
  } catch (e) {
    logErr("api/emblems", e);
    res.status(500).json({ error: "Server error" });
  }
});

// Rarity API: cache-first, background refresh if stale
app.get("/api/rarity", async (req, res) => {
  try {
    const hash = Number(req.query.hash);
    if (!hash) return res.status(400).json({ error: "hash required" });
    const r = await getRarityCached(hash);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({ percent: r.percent, label: r.label, source: r.source, updatedAt: r.updatedAt });
  } catch (e) {
    logErr("api/rarity", e);
    res.status(500).json({ error: "rarity error" });
  }
});

// Stats (no user info)
app.get("/stats", (req, res) => {
  try {
    const cat = listCatalog.all().length;
    const rc = countRarity.get() || {};
    res.json({ catalogCount: cat, rarity: rc, cron: { enabled: CRON_ENABLED==="true", spec: REFRESH_CRON, tz: CRON_TZ }, throttle: { concurrency: MAX_CONC, minGapMs: MIN_GAP }});
  } catch (e) { logErr("stats", e); res.status(500).json({ error: "stats error" }); }
});

// UI
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

process.on("SIGTERM", async () => { try { if (browser) await browser.close(); } catch {} process.exit(0); });

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
