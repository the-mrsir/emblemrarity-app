import express from "express";
import axios from "axios";

const {
  PORT = 3000,
  BASE_URL,                // e.g. https://emblemrarity.app
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

// Simple in-memory token store keyed by a short session id in querystring.
// For a real site, switch to a cookie or database.
const tokens = new Map();

function makeState() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// ---- OAuth -----
app.get("/login", (req, res) => {
  const state = makeState();
  tokens.set(state, {}); // reserve key
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
    console.error(e?.response?.data || e.message);
    res.status(500).send("OAuth failed");
  }
});

// ---- Bungie helpers -----
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

let defsCache = { collectible: null, item: null };
async function getDefs() {
  if (defsCache.collectible && defsCache.item) return defsCache;
  const mf = await BUNGIE.get("/Destiny2/Manifest/");
  const paths = mf.data.Response.jsonWorldComponentContentPaths.en;
  const base = "https://www.bungie.net";
  const [coll, item] = await Promise.all([
    axios.get(base + paths.DestinyCollectibleDefinition),
    axios.get(base + paths.DestinyInventoryItemDefinition)
  ]);
  defsCache.collectible = coll.data;
  defsCache.item = item.data;
  return defsCache;
}

function isUnlocked(state) {
  // collectible bit 1 means NotAcquired
  return (state & 1) === 0;
}

async function getOwnedEmblemItemHashes(profile, defs) {
  const owned = new Set();

  const pColl = profile?.profileCollectibles?.data?.collectibles || {};
  for (const [hash, v] of Object.entries(pColl)) {
    if (isUnlocked(v?.state ?? 0)) owned.add(Number(hash));
  }
  const chars = profile?.characterCollectibles?.data || {};
  for (const c of Object.values(chars)) {
    const colls = c?.collectibles || {};
    for (const [hash, v] of Object.entries(colls)) {
      if (isUnlocked(v?.state ?? 0)) owned.add(Number(hash));
    }
  }

  const EMBLEM_CATEGORY_HASH = 19;
  const itemHashes = [];
  for (const ch of owned) {
    const c = defs.collectible[String(ch)];
    const itemHash = c?.itemHash;
    if (itemHash == null) continue;
    const item = defs.item[String(itemHash)];
    if (!item) continue;
    const cats = item.itemCategoryHashes || [];
    if (cats.includes(EMBLEM_CATEGORY_HASH)) itemHashes.push(itemHash);
  }
  return [...new Set(itemHashes)];
}

// ---- Rarity fetching (Warmind first, light.gg fallback) -----
const rarityCache = new Map();

async function fetchWarmindRarity(itemHash) {
  const url = `https://warmind.io/analytics/item/${itemHash}`;
  try {
    const resp = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      },
      timeout: 20000
    });
    const html = resp.data;
    const m1 = html.match(/Global Rarity[^%]*?(\d+(?:\.\d+)?)%/i);
    const m2 = html.match(/Adjusted Rarity[^%]*?(\d+(?:\.\d+)?)%/i);
    if (m1) return { percent: parseFloat(m1[1]), source: url, label: "Warmind Global" };
    if (m2) return { percent: parseFloat(m2[1]), source: url, label: "Warmind Adjusted" };
    return { percent: null, source: url, label: "Warmind" };
  } catch {
    return { percent: null, source: url, label: "Warmind" };
  }
}

async function fetchLightGGRarity(itemHash) {
  const url = `https://www.light.gg/db/items/${itemHash}/`;
  try {
    const resp = await axios.get(url, {
      headers: {
        // look as real as possible
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.google.com/"
      },
      timeout: 25000,
      // follow redirects enabled by default
      validateStatus: (s) => s >= 200 && s < 400
    });

    const html = resp.data;

    // Pattern A: Community Rarity ... Found by 45.96%
    let m = html.match(/Community Rarity[\s\S]{0,200}?Found by\s+(\d{1,3}(?:\.\d+)?)/i);
    if (m) return { percent: parseFloat(m[1]), source: url, label: "light.gg Community" };

    // Pattern B: Found by 45.96%
    m = html.match(/Found by\s+(\d{1,3}(?:\.\d+)?)/i);
    if (m) return { percent: parseFloat(m[1]), source: url, label: "light.gg Community" };

    // Pattern C: Community Rarity ... 45.96%
    m = html.match(/Community Rarity[\s\S]{0,200}?(\d{1,3}(?:\.\d+)?)%/i);
    if (m) return { percent: parseFloat(m[1]), source: url, label: "light.gg Community" };

    // DOM text fallback: strip tags and search again
    const text = String(html).replace(/<[^>]*>/g, " ");
    m = text.match(/Community Rarity[\s\S]{0,200}?Found by\s+(\d{1,3}(?:\.\d+)?)/i) || text.match(/Found by\s+(\d{1,3}(?:\.\d+)?)/i);
    if (m) return { percent: parseFloat(m[1]), source: url, label: "light.gg Community" };

    return { percent: null, source: url, label: "light.gg" };
  } catch (e) {
    return { percent: null, source: url, label: "light.gg" };
  }
}

// --- optional: throttle requests so we don't get blocked ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchRarity(itemHash) {
  if (rarityCache.has(itemHash)) return rarityCache.get(itemHash);
  let r = await fetchWarmindRarity(itemHash);
  if (r.percent == null) {
    r = await fetchLightGGRarity(itemHash);
  }
  rarityCache.set(itemHash, r);
  return r;
}

async function mapWithConcurrency(items, fn, limit = 6) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return out;
}

// API for the page
app.get("/api/emblems", async (req, res) => {
  try {
    const sid = req.query.sid;
    if (!sid || !tokens.has(sid)) return res.status(401).json({ error: "Not linked" });

    const mem = await getMembership(sid);
    const profile = await getProfile(sid, mem.membershipType, mem.membershipId);
    const defs = await getDefs();

    const hashes = await getOwnedEmblemItemHashes(profile, defs);
    if (!hashes.length) return res.json({ emblems: [] });

    const rows = await mapWithConcurrency(hashes, async (h) => {
      const item = defs.item[String(h)];
      const name = item?.displayProperties?.name || `Item ${h}`;
      const icon = item?.secondaryIcon || item?.displayProperties?.icon || null;
      const img = icon ? `https://www.bungie.net${icon}` : null;
      const rarity = await fetchRarity(h);
      return {
        itemHash: h,
        name,
        image: img,
        rarityPercent: rarity.percent,
        rarityLabel: rarity.label,
        sourceUrl: rarity.source
      };
    }, 6);

    rows.sort((a, b) => {
      const aa = a.rarityPercent == null ? 999999 : a.rarityPercent;
      const bb = b.rarityPercent == null ? 999999 : b.rarityPercent;
      return aa - bb;
    });

    res.json({ emblems: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// Landing page
app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/public/index.html");
});

app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
