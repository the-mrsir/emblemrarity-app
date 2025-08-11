import { chromium } from "playwright";
let browser;
let ctx;
let active = 0;
const MAX_CONC = Number(process.env.RARITY_CONCURRENCY || "2");
const MIN_GAP = Number(process.env.RARITY_MIN_GAP_MS || "200");
let lastAt = 0;

const queue = [];
function runQueue(){
  if (active >= MAX_CONC) return;
  const task = queue.shift();
  if (!task) return;
  active++;
  (async () => {
    const wait = Math.max(0, MIN_GAP - (Date.now() - lastAt));
    await new Promise(r => setTimeout(r, wait));
    lastAt = Date.now();
    try { await task(); } finally { active--; runQueue(); }
  })();
}

export async function launchBrowser(){
  if (!browser){
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-setuid-sandbox"] });
  }
  if (!ctx){
    ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York",
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9", "Referer": "https://www.google.com/" }
    });
  }
  return browser;
}

function extractPct(text){
  const pats = [/Found by\s+(\d{1,3}(?:\.\d+)?)%/i, /Community Rarity[\s\S]{0,200}?(\d{1,3}(?:\.\d+)?)%/i];
  for (const re of pats){ const m = text.match(re); if (m) return parseFloat(m[1]); }
  return null;
}

async function scrapeOnce(itemHash){
  await launchBrowser();
  if (!ctx) { await launchBrowser(); }
  const page = await ctx.newPage();
  const url = `https://www.light.gg/db/items/${itemHash}/`;
  let res = { percent: null, label: "light.gg", source: url };
  try{
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const title = await page.title();
    if (/just a moment|attention required/i.test(title)){
      await page.waitForTimeout(Number(process.env.LIGHTGG_RETRY_MS || "4000"));
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    const text = await page.evaluate(() => document.body.innerText || document.body.textContent || "");
    const pct = extractPct(text);
    res = { percent: pct, label: pct != null ? "light.gg Community" : "light.gg", source: url };
  }catch(e){}
  try{ await page.close(); }catch{}
  return res;
}

export function queueScrape(itemHash, onDone){
  queue.push(async () => {
    try {
      const r = await scrapeOnce(itemHash);
      await onDone(r);
    } catch {}
  });
  runQueue();
}
