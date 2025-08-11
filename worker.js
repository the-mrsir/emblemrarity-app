import { chromium } from "playwright";
let browser;
let ctx;
let active = 0;
const MAX_CONC = Number(process.env.RARITY_CONCURRENCY || "2");
const MIN_GAP = Number(process.env.RARITY_MIN_GAP_MS || "200");
const COOLDOWN_MS = Number(process.env.RARITY_COOLDOWN_MS || "180000");
let lastAt = 0;
let cooldownUntil = 0;
let recent403 = 0;

const queue = [];
function runQueue(){
  if (active >= MAX_CONC) return;
  if (Date.now() < cooldownUntil){
    setTimeout(runQueue, Math.max(50, cooldownUntil - Date.now()));
    return;
  }
  const task = queue.shift();
  if (!task) return;
  active++;
  (async () => {
    const jitter = Math.floor(Math.random() * MIN_GAP);
    const wait = Math.max(0, (MIN_GAP + jitter) - (Date.now() - lastAt));
    await new Promise(r => setTimeout(r, wait));
    lastAt = Date.now();
    try { await task(); } finally { active--; runQueue(); }
  })();
}

export async function launchBrowser(){
  if (!browser){
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-setuid-sandbox","--disable-gpu","--disable-dev-shm-usage"] });
  }
  if (!ctx){
    ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York",
      viewport: { width: 1280, height: 720 },
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9", "Referer": "https://www.google.com/" }
    });
    // Block heavy resources to speed up loads
    await ctx.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet') return route.abort();
      return route.continue();
    });
    ctx.setDefaultNavigationTimeout(15000);
    ctx.setDefaultTimeout(15000);
    // Warm the domain once (cookies/cf)
    try { const p = await ctx.newPage(); await p.goto('https://www.light.gg/', { waitUntil: 'domcontentloaded', timeout: 10000 }); await p.close(); } catch {}
  }
  return browser;
}

function extractPct(text){
  const pats = [
    /Community\s*Rarity[\s\S]{0,200}?(\d{1,3}(?:\.\d+)?)%/i,
    /Found\s*by\s+(\d{1,3}(?:\.\d+)?)%/i,
    /rarity[\s\S]{0,100}?([0-9]{1,3}(?:\.[0-9]+)?)%/i,
    /"rarity"\s*:\s*\{[\s\S]*?"pct"\s*:\s*([0-9]{1,3}(?:\.[0-9]+)?)/i
  ];
  for (const re of pats){ const m = text.match(re); if (m) return parseFloat(m[1]); }
  return null;
}

async function waitForPct(page, timeoutMs=20000){
  const start = Date.now();
  while(Date.now()-start < timeoutMs){
    try{
      const txt = await page.evaluate(() => document.body.innerText || document.body.textContent || "");
      const html = await page.content();
      // Try DOM-targeted extraction
      const fromDom = await page.evaluate(() => {
        try{
          const rePct = /([0-9]{1,3}(?:\.[0-9]+)?)%/;
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
          while(walker.nextNode()){
            const el = walker.currentNode;
            const t = (el.textContent || '').trim();
            if (/Community\s*Rarity/i.test(t)){
              const m = t.match(rePct);
              if (m) return parseFloat(m[1]);
            }
          }
        }catch{}
        return null;
      });
      const pct = fromDom ?? extractPct(txt) ?? extractPct(html);
      if (pct != null) return pct;
    }catch{}
    await page.waitForTimeout(1000);
  }
  return null;
}

async function scrapeOnce(itemHash){
  await launchBrowser();
  if (!ctx) { await launchBrowser(); }
  const page = await ctx.newPage();
  const url = `https://www.light.gg/db/items/${itemHash}/`;
  let res = { percent: null, label: "light.gg", source: url, status: null, reason: null };
  try{
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    const title = await page.title();
    res.status = resp ? resp.status() : null;
    if (/just a moment|attention required/i.test(title)){
      await page.waitForTimeout(Number(process.env.LIGHTGG_RETRY_MS || "4000"));
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    }
    let pct = await waitForPct(page, Number(process.env.LIGHTGG_WAIT_MS || "20000"));
    // Fallback: allow styles/images on a fresh page and retry once
    if (pct == null){
      try{
        const p2 = await ctx.newPage();
        await p2.unroute('**/*').catch(()=>{});
        await p2.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        pct = await waitForPct(p2, 15000);
        await p2.close();
      }catch(e){ res.reason = res.reason || 'retry_failed'; }
    }
    if (pct == null){
      if (res.status && res.status >= 400) res.reason = `http_${res.status}`;
      else if (/just a moment|attention required/i.test(title)) res.reason = 'cf_challenge';
      else res.reason = res.reason || 'no_match';
    }
    res = { ...res, percent: pct, label: pct != null ? "light.gg Community" : "light.gg", source: url };
  }catch(e){ res.reason = res.reason || (e?.message || 'error'); }
  try{ await page.close(); }catch{}
  return res;
}

export function queueScrape(itemHash, onDone){
  queue.push(async () => {
    try {
      const r = await scrapeOnce(itemHash);
      // 403 handling & cooldown
      if ((r?.status === 403) || (r?.reason === 'http_403')){
        recent403++;
        if (recent403 >= 5){
          cooldownUntil = Date.now() + COOLDOWN_MS;
          recent403 = 0;
        }
      } else if (r?.percent != null) {
        recent403 = Math.max(0, recent403 - 1);
      }
      await onDone(r);
    } catch {}
  });
  runQueue();
}
