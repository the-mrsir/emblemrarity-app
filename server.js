import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 3000,
  BASE_URL,
  BUNGIE_API_KEY,
  BUNGIE_CLIENT_ID,
  BUNGIE_CLIENT_SECRET,
  NODE_OPTIONS
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

// ---------------- DB cache ----------------
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
CREATE TABLE IF NOT EXISTS rarity_cache (
  itemHash INTEGER PRIMARY KEY,
  percent REAL,
  label TEXT,
  source TEXT,
  updatedAt INTEGER
);
`);

const upsertColl = db.prepare("INSERT INTO collectible_item (collectibleHash, itemHash) VALUES (?,?) ON CONFLICT(collectibleHash) DO UPDATE SET itemHash=excluded.itemHash");
const getColl = db.prepare("SELECT itemHash FROM collectible_item WHERE collectibleHash=?");
const upsertItem = db.prepare("INSERT INTO item_emblem (itemHash,isEmblem,name,icon) VALUES (?,?,?,?) ON CONFLICT(itemHash) DO UPDATE SET isEmblem=excluded.isEmblem, name=excluded.name, icon=excluded.icon");
const getItem = db.prepare("SELECT isEmblem,name,icon FROM item_emblem WHERE itemHash=?");
const getRarity = db.prepare("SELECT percent,label,source,updatedAt FROM rarity_cache WHERE itemHash=?");
const setRarity = db.prepare("INSERT INTO rarity_cache (itemHash,percent,label,source,updatedAt) VALUES (?,?,?,?,?) ON CONFLICT(itemHash) DO UPDATE SET percent=excluded.percent,label=excluded.label,source=excluded.source,updatedAt=excluded.updatedAt");

// ---------------- OAuth tokens ----------------
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
    console.error("OAuth error:", e?.response?.data || e.message);
    res.status(500).send("OAuth failed");
  }
});

async function authedHeaders(sid) {
  let t = tokens.get(sid);
  if (!t) throw new Error("Not linked");
  const now = Math.floor(Date.now()/1000);
  if (t.expires_at - 15 < now) {
    // refresh
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
  return chosen;
}

async function getProfile(sid, membershipType, membershipId) {
  const h = await authedHeaders(sid);
  const r = await BUNGIE.get(`/Destiny2/${membershipType}/Profile/${membershipId}/`, {
    headers: h,
    params: { components: "800,900" }
  });
  return r.data?.Response;
}

// Per-entity manifest with concurrency + DB cache
const inflight = new Map();
async function getEntity(entityType, hash) {
  const key = `${entityType}:${hash}`;
  // db cache for items
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
    const r = await BUNGIE.get(`/Destiny2/Manifest/${entityType}/${hash}/`);
    const data = r.data?.Response;
    // store in DB cache for next time
    if (entityType === "DestinyInventoryItemDefinition") {
      const isEmblem = (data?.itemCategoryHashes || []).includes(19) ? 1 : 0;
      const name = data?.displayProperties?.name || null;
      const icon = data?.secondaryIcon || data?.displayProperties?.icon || null;
      upsertItem.run(hash, isEmblem, name, icon);
    } else if (entityType === "DestinyCollectibleDefinition") {
      if (data?.itemHash != null) upsertColl.run(hash, data.itemHash);
    }
    return data;
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

function isUnlocked(state) { return (state & 1) === 0; }

async function concurrentMap(items, fn, concurrency=16) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
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
  // Map collectibles -> itemHashes concurrently
  const itemHashes = (await concurrentMap(ownedArr, async (collHash) => {
    const coll = await getEntity("DestinyCollectibleDefinition", collHash);
    return coll?.itemHash ?? null;
  }, 24)).filter(Boolean);

  // Filter emblem items concurrently
  const emblemHashes = (await concurrentMap(itemHashes, async (itemHash) => {
    const item = await getEntity("DestinyInventoryItemDefinition", itemHash);
    const cats = item?.itemCategoryHashes || [];
    return cats.includes(19) ? itemHash : null;
  }, 24)).filter(Boolean);

  // unique
  return [...new Set(emblemHashes)];
}

// --------------- Playwright rarity with SSE ---------------
let browser;
async function ensureBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-setuid-sandbox"] });
}
function extractPct(html) {
  const pats = [
    /Community Rarity[\s\S]{0,200}?Found by\s+(\d{1,3}(?:\.\d+)?)/i,
    /Found by\s+(\d{1,3}(?:\.\d+)?)/i,
    /Community Rarity[\s\S]{0,200}?(\d{1,3}(?:\.\d+)?)%/i
  ];
  for (const re of pats) { const m = html.match(re); if (m) return parseFloat(m[1]); }
  const text = html.replace(/<[^>]*>/g, " ");
  for (const re of pats) { const m = text.match(re); if (m) return parseFloat(m[1]); }
  return null;
}

async function fetchRarityOnce(itemHash) {
  // DB cache first
  const row = getRarity.get(itemHash);
  if (row && row.percent != null) return { percent: row.percent, label: row.label, source: row.source };

  await ensureBrowser();
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36" });
  const pg = await ctx.newPage();
  const url = `https://www.light.gg/db/items/${itemHash}/`;
  let res = { percent: null, label: "light.gg", source: url };
  try {
    await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await pg.waitForTimeout(300);
    const html = await pg.content();
    const pct = extractPct(html);
    res = { percent: pct, label: "light.gg Community", source: url };
  } catch {}
  await pg.close(); await ctx.close();
  const now = Math.floor(Date.now()/1000);
  setRarity.run(itemHash, res.percent, res.label, res.source, now);
  return res;
}

// rarity API (single)
app.get("/api/rarity", async (req, res) => {
  try {
    const hash = Number(req.query.hash);
    if (!hash) return res.status(400).json({ error: "hash required" });
    const r = await fetchRarityOnce(hash);
    res.json(r);
  } catch (e) { res.status(500).json({ error: "rarity error" }); }
});

// rarity SSE stream (batch)
app.get("/api/rarity/stream", async (req, res) => {
  try {
    const hashes = String(req.query.hashes || "").split(",").map(x => Number(x)).filter(Boolean);
    if (!hashes.length) return res.status(400).end("no hashes");
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    for (const h of hashes) {
      const r = await fetchRarityOnce(h);
      res.write(`data: ${JSON.stringify({ itemHash: h, ...r })}\n\n`);
      await new Promise(r => setTimeout(r, 120));
    }
    res.end();
  } catch (e) {
    try { res.end(); } catch {}
  }
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

    // Build item rows concurrently
    const rows = await concurrentMap(hashes, async (h) => {
      const item = await getEntity("DestinyInventoryItemDefinition", h);
      const name = item?.displayProperties?.name || `Item ${h}`;
      const icon = item?.secondaryIcon || item?.displayProperties?.icon || null;
      const img = icon ? `https://www.bungie.net${icon}` : null;
      // pull cached rarity if present
      const rc = getRarity.get(h);
      const rarity = rc ? { percent: rc.percent, label: rc.label, source: rc.source } : { percent: null, label: null, source: null };
      return { itemHash: h, name, image: img, rarityPercent: rarity.percent, rarityLabel: rarity.label, sourceUrl: rarity.source };
    }, 24);

    // Sort by rarity if available
    rows.sort((a,b)=> (a.rarityPercent ?? 999999) - (b.rarityPercent ?? 999999));

    // Prewarm rarity for top 32 in background (doesn't block)
    (async () => {
      for (const h of hashes.slice(0,32)) { try { await fetchRarityOnce(h); } catch {} }
    })();

    res.json({ emblems: rows });
  } catch (e) {
    console.error("API error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// Debug route
app.get("/debug", async (req, res) => {
  try {
    const sid = req.query.sid;
    if (!sid || !tokens.has(sid)) return res.status(401).send("Not linked");
    const mem = await getMembership(sid);
    const profile = await getProfile(sid, mem.membershipType, mem.membershipId);
    const pCount = Object.keys(profile?.profileCollectibles?.data?.collectibles || {}).length;
    const cCount = Object.keys(profile?.characterCollectibles?.data || {}).length;
    const hashes = await getOwnedEmblemItemHashes(profile);
    res.json({ membershipType: mem.membershipType, membershipId: mem.membershipId, profileCollectibles: pCount, characters: cCount, emblemCount: hashes.length, firstHashes: hashes.slice(0, 10) });
  } catch (e) {
    res.status(500).send("debug error");
  }
});

// ---------------- UI ----------------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

process.on("SIGTERM", async () => { try { if (browser) await browser.close(); } catch {} process.exit(0); });

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
