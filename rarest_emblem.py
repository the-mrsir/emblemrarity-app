#!/usr/bin/env python3
import http.server
import json
import os
import queue
import re
import socketserver
import sys
import threading
import time
from urllib.parse import urlencode, urlparse, parse_qs

import requests
from bs4 import BeautifulSoup

# ========= CONFIG =========
API_KEY       = "26fd5ae5906d41ff896498d34b647fe4"
CLIENT_ID     = "50509"
CLIENT_SECRET = "hF3Poyy1EmZ7uNt0N7GwUwlTIp8rfV8G2..OQWwXvsg"
REDIRECT_URI  = "https://localhost:8721/callback"  # had to use https instead of http

# How many rarest to print
TOP_N = 25

# Simple on-disk cache for manifest and scraped rarity
CACHE_DIR = ".cache_raremblems"
os.makedirs(CACHE_DIR, exist_ok=True)

HEADERS = {"X-API-Key": API_KEY, "Accept": "application/json"}

# ========= Small helpers =========
def cache_get(path):
    p = os.path.join(CACHE_DIR, path)
    if os.path.exists(p):
        with open(p, "rb") as f:
            return f.read()
    return None

def cache_put(path, data: bytes):
    p = os.path.join(CACHE_DIR, path)
    with open(p, "wb") as f:
        f.write(data)

def get_json(url, headers=None, params=None):
    r = requests.get(url, headers=headers or HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.json()

def get(url, headers=None, params=None):
    r = requests.get(url, headers=headers or HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.text

def post_form(url, data, headers=None):
    h = {"Content-Type": "application/x-www-form-urlencoded"}
    if headers:
        h.update(headers)
    r = requests.post(url, headers=h, data=data, timeout=30)
    r.raise_for_status()
    return r.json()

# ========= OAuth (local callback) =========
class OAuthCodeHandler(http.server.BaseHTTPRequestHandler):
    q: "queue.Queue[str]" = None  # set from outside

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return
        params = parse_qs(parsed.query)
        code = params.get("code", [""])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"You can close this tab now.")
        if code:
            OAuthCodeHandler.q.put(code)

    def log_message(self, *args, **kwargs):
        # keep console clean
        pass

def get_oauth_tokens():
    auth_url = (
        "https://www.bungie.net/en/OAuth/Authorize?"
        + urlencode({"client_id": CLIENT_ID, "response_type": "code", "redirect_uri": REDIRECT_URI})
    )
    print("Open this URL in your browser and authorize:")
    print(auth_url)

    q = queue.Queue()
    OAuthCodeHandler.q = q

    with socketserver.TCPServer(("localhost", 8721), OAuthCodeHandler) as httpd:
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        print("Waiting for OAuth redirect on http://localhost:8721/callback ...")
        code = q.get()  # blocking
        httpd.shutdown()

    token_url = "https://www.bungie.net/platform/app/oauth/token/"
    data = {
        "client_id": CLIENT_ID,
        "grant_type": "authorization_code",
        "code": code,
        "client_secret": CLIENT_SECRET,
        "redirect_uri": REDIRECT_URI,
    }
    tok = post_form(token_url, data)
    if "access_token" not in tok:
        raise SystemExit("OAuth failed. Check client id/secret and redirect URL.")
    return tok

def refresh_tokens(refresh_token):
    token_url = "https://www.bungie.net/platform/app/oauth/token/"
    data = {
        "client_id": CLIENT_ID,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_secret": CLIENT_SECRET,
    }
    return post_form(token_url, data)

# ========= Bungie profile and collectibles =========
def authed_headers(access_token):
    h = dict(HEADERS)
    h["Authorization"] = f"Bearer {access_token}"
    return h

def get_memberships(access_token):
    j = get_json("https://www.bungie.net/Platform/User/GetMembershipsForCurrentUser/", headers=authed_headers(access_token))
    return j["Response"]

def pick_primary_membership(resp):
    # Prefer cross-save override if present, else first
    dms = resp.get("destinyMemberships", [])
    if not dms:
        raise SystemExit("No Destiny memberships found on this account.")
    override = resp.get("primaryMembershipId")
    if override:
        for m in dms:
            if str(m["membershipId"]) == str(override):
                return m
    return dms[0]

def get_profile_with_collectibles(mtype, mid, access_token):
    comps = ",".join(map(str, [100, 102, 200, 204, 800, 900]))
    url = f"https://www.bungie.net/Platform/Destiny2/{mtype}/Profile/{mid}/"
    j = get_json(url, headers=authed_headers(access_token), params={"components": comps})
    return j["Response"]

def get_manifest():
    cached = cache_get("manifest_index.json")
    if cached:
        mf = json.loads(cached.decode("utf-8"))
    else:
        mf = get_json("https://www.bungie.net/Platform/Destiny2/Manifest/")
        cache_put("manifest_index.json", json.dumps(mf).encode("utf-8"))
    paths = mf["Response"]["jsonWorldComponentContentPaths"]["en"]
    # We need Collectible and InventoryItem
    base = "https://www.bungie.net"
    coll_url = base + paths["DestinyCollectibleDefinition"]
    item_url = base + paths["DestinyInventoryItemDefinition"]

    def fetch(path_name, url):
        cached = cache_get(path_name)
        if cached:
            return json.loads(cached.decode("utf-8"))
        txt = get(url)
        cache_put(path_name, txt.encode("utf-8"))
        return json.loads(txt)

    collectible_def = fetch("DestinyCollectibleDefinition_en.json", coll_url)
    item_def        = fetch("DestinyInventoryItemDefinition_en.json", item_url)
    return collectible_def, item_def

def emblem_item_hashes_owned(profile, collectible_def, item_def):
    # Collectibles can be on profile and per character
    def is_unlocked(state):
        # Bit 1 means NotAcquired. Unlocked if bit not set.
        return (state & 1) == 0

    owned_collectible_hashes = set()

    prof_coll = profile.get("profileCollectibles", {}).get("data", {}).get("collectibles", {})
    for ch, v in prof_coll.items():
        if is_unlocked(v.get("state", 0)):
            owned_collectible_hashes.add(int(ch))

    chars = profile.get("characterCollectibles", {}).get("data", {})
    for _, cdata in chars.items():
        for ch, v in cdata.get("collectibles", {}).items():
            if is_unlocked(v.get("state", 0)):
                owned_collectible_hashes.add(int(ch))

    # Map collectibleHash -> itemHash and filter to emblem category 19
    EMBLEM_CATEGORY_HASH = 19
    emblems = set()
    for coll_hash in owned_collectible_hashes:
        coll = collectible_def.get(str(coll_hash))
        if not coll:
            continue
        item_hash = coll.get("itemHash")
        if item_hash is None:
            continue
        item = item_def.get(str(item_hash))
        if not item:
            continue
        cats = item.get("itemCategoryHashes", []) or []
        if EMBLEM_CATEGORY_HASH in cats:
            emblems.add(int(item_hash))
    return emblems

# ========= light.gg scraping for community rarity =========
RARITY_RE = re.compile(r"Community Rarity[^%]*?(\d+(?:\.\d+)?)%")

def fetch_lightgg_rarity(item_hash):
    cache_name = f"rarity_{item_hash}.json"
    cached = cache_get(cache_name)
    if cached:
        d = json.loads(cached.decode("utf-8"))
        return d["percent"], d["source"]

    url = f"https://www.light.gg/db/items/{item_hash}/"
    try:
        html = get(url, headers={"User-Agent": "Mozilla/5.0"})
    except Exception:
        return None, None
    m = RARITY_RE.search(html)
    if not m:
        # Some pages lazy-load. Try a gentler parse
        soup = BeautifulSoup(html, "html.parser")
        text = soup.get_text(" ", strip=True)
        m = RARITY_RE.search(text)
    if not m:
        return None, None
    pct = float(m.group(1))
    cache_put(cache_name, json.dumps({"percent": pct, "source": url}).encode("utf-8"))
    time.sleep(0.5)  # be polite
    return pct, url

def main():
    if "<PUT_YOUR_" in API_KEY or "<PUT_YOUR_" in CLIENT_ID or "<PUT_YOUR_" in CLIENT_SECRET:
        print("Set API key, client id, and client secret at the top or via env vars.")
        sys.exit(1)

    # OAuth
    tokens = get_oauth_tokens()
    access = tokens["access_token"]
    refresh = tokens.get("refresh_token")

    # Get memberships and profile
    mems = get_memberships(access)
    primary = pick_primary_membership(mems)
    membership_type = primary["membershipType"]
    membership_id = primary["membershipId"]

    profile = get_profile_with_collectibles(membership_type, membership_id, access)

    # Manifest and owned emblems
    collectible_def, item_def = get_manifest()
    owned_emblems = emblem_item_hashes_owned(profile, collectible_def, item_def)
    if not owned_emblems:
        print("No owned emblems found. Are your collections visible?")
        sys.exit(0)

    # Build data with names and rarity
    rows = []
    for h in owned_emblems:
        item = item_def.get(str(h), {})
        name = item.get("displayProperties", {}).get("name", f"Hash {h}")
        pct, src = fetch_lightgg_rarity(h)
        rows.append({
            "itemHash": h,
            "name": name,
            "community_rarity_percent": pct,
            "lightgg_url": src
        })

    # Sort, handling None as bottom
    rows.sort(key=lambda r: (r["community_rarity_percent"] is None, r["community_rarity_percent"] if r["community_rarity_percent"] is not None else 9999.0))

    # Print top N
    print(f"\nRarest {TOP_N} emblems you own by light.gg Community Rarity:")
    printed = 0
    for r in rows:
        if printed >= TOP_N:
            break
        pct = r["community_rarity_percent"]
        pct_s = f"{pct:.4f}%" if pct is not None else "Unknown"
        print(f"{printed+1:2}. {r['name']}  |  {pct_s}  |  {r['lightgg_url'] or ''}")
        printed += 1

    # Save CSV
    out_path = "my_emblems_rarity.csv"
    import csv
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["name", "itemHash", "community_rarity_percent", "lightgg_url"])
        for r in rows:
            w.writerow([r["name"], r["itemHash"], r["community_rarity_percent"], r["lightgg_url"] or ""])
    print(f"\nSaved full list to {out_path}")

if __name__ == "__main__":
    main()
