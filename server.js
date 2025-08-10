import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 3000,
  BASE_URL,
  BUNGIE_API_KEY,
  BUNGIE_CLIENT_ID,
  BUNGIE_CLIENT_SECRET
} = process.env;

if (!BASE_URL || !BUNGIE_API_KEY || !BUNGIE_CLIENT_ID || !BUNGIE_CLIENT_SECRET) {
  console.error("Missing env vars: BASE_URL, BUNGIE_API_KEY, BUNGIE_CLIENT_ID, BUNGIE_CLIENT_SECRET");
  process.exit(1);
}

const app = express();
app.use(express.static("public"));

const BUNGIE = axios.create({
  baseURL: "https://www.bungie.net/Platform",
  headers: { "X-API-Key": BUNGIE_API_KEY }
});

// ---------------- OAuth ----------------
const tokens = new Map();
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

// --------------- Bungie helpers ---------------
async function getAuthHeaders(sid) {
  const t = tokens.get(sid);
  if (!t) throw new Error("Not linked");
  return { Authorization: `Bearer ${t.access_token}`, "X-API-Key": BUNGIE_API_KEY };
}

async function getMembership(sid) {
  const h = await getAuthHeaders(sid);
  const r = await BUNGIE.get("/User/GetMembershipsForCurrentUser/", { headers: h });
  const resp = r.data?.Response;
  const dms = resp?.destinyMemberships || [];
  if (!dms.length) throw new Error("No Destiny memberships");
  const primaryId = resp?.primaryMembershipId;
  const chosen = primaryId ? dms.find(m => String(m.membershipId) === String(primaryId)) : dms[0];
  return chosen;
}

async function getProfile(sid, membershipType, membershipId) {
  const h = await getAuthHeaders(sid);
  const r = await BUNGIE.get(`/Destiny2/${membershipType}/Profile/${membershipId}/`, {
    headers: h,
    params: { components: "800,900" } // profileCollectibles, characterCollectibles
  });
  return r.data?.Response;
}

// ---- Per-entity manifest fetch (low memory) ----
const entityCache = new Map(); // key: `${type}:${hash}`
async function getEntity(entityType, hash) {
  const key = `${entityType}:${hash}`;
  if (entityCache.has(key)) return entityCache.get(key);
  const url = `/Destiny2/Manifest/${entityType}/${hash}/`;
  const r = await BUNGIE.get(url);
  const data = r.data?.Response;
  entityCache.set(key, data);
  return data;
}

function isUnlocked(state) { return (state & 1) === 0; } // bit 1 is NotAcquired

async function getOwnedEmblemItemHashes(profile) {
  const ownedCollectibleHashes = new Set();

  const pColl = profile?.profileCollectibles?.data?.collectibles || {};
  for (const [hash, v] of Object.entries(pColl)) {
    if (isUnlocked(v?.state ?? 0)) ownedCollectibleHashes.add(Number(hash));
  }
  const chars = profile?.characterCollectibles?.data || {};
  for (const c of Object.values(chars)) {
    const colls = c?.collectibles || {};
    for (const [hash, v] of Object.entries(colls)) {
      if (isUnlocked(v?.state ?? 0)) ownedCollectibleHashes.add(Number(hash));
    }
  }

  const EMBLEM_CATEGORY_HASH = 19;
  const itemHashes = [];

  for (const collHash of ownedCollectibleHashes) {
    const coll = await getEntity("DestinyCollectibleDefinition", collHash);
    const itemHash = coll?.itemHash;
    if (itemHash == null) continue;
    const item = await getEntity("DestinyInventoryItemDefinition", itemHash);
    const cats = item?.itemCategoryHashes || [];
    if (cats.includes(EMBLEM_CATEGORY_HASH)) itemHashes.push(itemHash);
  }
  return [...new Set(itemHashes)];
}

// --------------- Playwright rarity (light.gg) ---------------
const RARITY_CACHE_FILE = path.join(process.cwd(), "rarity-cache.json");
const rarityCache = new Map();
try {
  if (fs.existsSync(RARITY_CACHE_FILE)) {
    const obj = JSON.parse(fs.readFileSync(RARITY_CACHE_FILE, "utf-8"));
    for (const [k,v] of Object.entries(obj)) rarityCache.set(Number(k), v);
  }
} catch {}

function persistRarity() {
  try { fs.writeFileSync(RARITY_CACHE_FILE, JSON.stringify(Object.fromEntries(rarityCache)), "utf-8"); } catch {}
}

let browser, page;
let q = [];
let working = false;

async function ensureBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-setuid-sandbox"] });
    page = await browser.newPage({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
    });
  }
}

function extractFromHTML(html) {
  const patterns = [
    /Community Rarity[\s\S]{0,200}?Found by\s+(\d{1,3}(?:\.\d+)?)/i,
    /Found by\s+(\d{1,3}(?:\.\d+)?)/i,
    /Community Rarity[\s\S]{0,200}?(\d{1,3}(?:\.\d+)?)%/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return parseFloat(m[1]);
  }
  const text = html.replace(/<[^>]*>/g, " ");
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

async function fetchLightGGRarityBrowser(itemHash) {
  await ensureBrowser();
  const url = `https://www.light.gg/db/items/${itemHash}/`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(400);
    const html = await page.content();
    const pct = extractFromHTML(html);
    return { percent: pct, source: url, label: "light.gg Community" };
  } catch (e) {
    return { percent: null, source: url, label: "light.gg" };
  }
}

async function fetchRarity(itemHash) {
  if (rarityCache.has(itemHash)) return rarityCache.get(itemHash);
  return new Promise((resolve) => { q.push({ itemHash, resolve }); pump(); });
}

async function pump() {
  if (working) return;
  working = true;
  while (q.length) {
    const job = q.shift();
    const res = await fetchLightGGRarityBrowser(job.itemHash);
    rarityCache.set(job.itemHash, res);
    persistRarity();
    await new Promise(r => setTimeout(r, 300)); // polite delay
    job.resolve(res);
  }
  working = false;
}

// ---------------- API ----------------
app.get("/api/emblems", async (req, res) => {
  try {
    const sid = req.query.sid;
    if (!sid || !tokens.has(sid)) return res.status(401).json({ error: "Not linked" });

    const mem = await getMembership(sid);
    const profile = await getProfile(sid, mem.membershipType, mem.membershipId);

    const hashes = await getOwnedEmblemItemHashes(profile);
    if (!hashes.length) return res.json({ emblems: [] });

    const rows = [];
    for (const h of hashes) {
      const item = await getEntity("DestinyInventoryItemDefinition", h);
      const name = item?.displayProperties?.name || `Item ${h}`;
      const icon = item?.secondaryIcon || item?.displayProperties?.icon || null;
      const img = icon ? `https://www.bungie.net${icon}` : null;
      const rarity = await fetchRarity(h);
      rows.push({
        itemHash: h,
        name,
        image: img,
        rarityPercent: rarity.percent,
        rarityLabel: rarity.label,
        sourceUrl: rarity.source
      });
    }

    rows.sort((a, b) => {
      const aa = a.rarityPercent == null ? 999999 : a.rarityPercent;
      const bb = b.rarityPercent == null ? 999999 : b.rarityPercent;
      return aa - bb;
    });

    res.json({ emblems: rows });
  } catch (e) {
    console.error("API error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// Debug route to verify data flow
app.get("/debug", async (req, res) => {
  try {
    const sid = req.query.sid;
    if (!sid || !tokens.has(sid)) return res.status(401).send("Not linked");
    const mem = await getMembership(sid);
    const profile = await getProfile(sid, mem.membershipType, mem.membershipId);
    const pCount = Object.keys(profile?.profileCollectibles?.data?.collectibles || {}).length;
    const cCount = Object.keys(profile?.characterCollectibles?.data || {}).length;
    const hashes = await getOwnedEmblemItemHashes(profile);
    res.json({
      membershipType: mem.membershipType,
      membershipId: mem.membershipId,
      profileCollectibles: pCount,
      characters: cCount,
      emblemCount: hashes.length,
      firstHashes: hashes.slice(0, 10)
    });
  } catch (e) {
    res.status(500).send("debug error");
  }
});

// ---------------- UI ----------------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

process.on("SIGTERM", async () => { try { if (browser) await browser.close(); } catch {} process.exit(0); });

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
