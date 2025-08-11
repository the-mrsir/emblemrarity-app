import { chromium } from "playwright";
let browser;
let ctx;
let active = 0;
const MAX_CONC = Number(process.env.RARITY_CONCURRENCY || "2");
const MIN_GAP = Number(process.env.RARITY_MIN_GAP_MS || "200");
const COOLDOWN_MS = Number(process.env.RARITY_COOLDOWN_MS || "180000");
const BATCH_SIZE = Number(process.env.RARITY_BATCH_SIZE || "2");
const BATCH_INTERVAL_MS = Number(process.env.RARITY_BATCH_INTERVAL_MS || "300000");
let lastAt = 0;
let cooldownUntil = 0;
let recent403 = 0;
let processedInWindow = 0;

const queue = [];
function runQueue(){
  if (active >= MAX_CONC) return;
  if (Date.now() < cooldownUntil){
    setTimeout(runQueue, Math.max(50, cooldownUntil - Date.now()));
    return;
  }
  // Enforce batch window (process BATCH_SIZE then pause BATCH_INTERVAL_MS)
  if (processedInWindow >= BATCH_SIZE){
    cooldownUntil = Date.now() + BATCH_INTERVAL_MS;
    processedInWindow = 0;
    setTimeout(runQueue, BATCH_INTERVAL_MS);
    return;
  }
  const task = queue.shift();
  if (!task) return;
  active++;
  processedInWindow++;
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
  
  // Try emblem.report first (faster, less rate limiting)
  const emblemReportUrl = `https://emblem.report/emblem/${itemHash}`;
  let res = { percent: null, label: "emblem.report", source: emblemReportUrl, status: null, reason: null };
  
  try{
    const resp = await page.goto(emblemReportUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    res.status = resp ? resp.status() : null;
    
    if (res.status === 200) {
      // Extract rarity from emblem.report
      const pct = await page.evaluate(() => {
        try {
          // Look for rarity percentage on emblem.report
          const rarityEl = document.querySelector('[data-testid="rarity"], .rarity, [class*="rarity"]');
          if (rarityEl) {
            const text = rarityEl.textContent || '';
            const match = text.match(/(\d+(?:\.\d+)?)%/);
            if (match) return parseFloat(match[1]);
          }
          
          // Fallback: search all text for percentage patterns
          const bodyText = document.body.textContent || '';
          const patterns = [
            /Rarity[\s\S]*?(\d+(?:\.\d+)?)%/i,
            /(\d+(?:\.\d+)?)%[\s\S]*?rarity/i,
            /Redeemed[\s\S]*?(\d+(?:\.\d+)?)%/i
          ];
          for (const pattern of patterns) {
            const match = bodyText.match(pattern);
            if (match) return parseFloat(match[1]);
          }
        } catch {}
        return null;
      });
      
      if (pct !== null) {
        res = { ...res, percent: pct, label: "emblem.report" };
        await page.close();
        return res;
      }
    }
  } catch(e) {
    res.reason = e?.message || 'emblem_report_error';
  }
  
  // Fallback to light.gg if emblem.report fails
  try {
    const lightggUrl = `https://www.light.gg/db/items/${itemHash}/`;
    res.source = lightggUrl;
    res.label = "light.gg";
    
    const resp2 = await page.goto(lightggUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    const title = await page.title();
    res.status = resp2 ? resp2.status() : null;
    
    if (/just a moment|attention required/i.test(title)){
      await page.waitForTimeout(Number(process.env.LIGHTGG_RETRY_MS || "4000"));
      await page.goto(lightggUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    }
    
    const pct = await waitForPct(page, Number(process.env.LIGHTGG_WAIT_MS || "15000"));
    
    if (pct !== null) {
      res = { ...res, percent: pct, label: "light.gg Community" };
    } else {
      if (res.status && res.status >= 400) res.reason = `http_${res.status}`;
      else if (/just a moment|attention required/i.test(title)) res.reason = 'cf_challenge';
      else res.reason = res.reason || 'no_match';
    }
  } catch(e) {
    res.reason = res.reason || (e?.message || 'error');
  }
  
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
