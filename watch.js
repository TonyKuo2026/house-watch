// 591＋永慶 新莊/泰山 新物件 → Discord 通知（GitHub Actions 版）
const fs = require('fs');
const STATE_FILE = 'state.json';
// ================== 設定區（只需要改這裡） ==================
const CONFIG = {
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL, // 從 GitHub Secrets 讀取，不要寫在這裡

  // 591 行政區代碼（新北市 regionid=3）：新莊區=44、泰山區=45
  SOURCES_591: [
    { name: '新莊區', section: 44 },
    { name: '泰山區', section: 45 },
  ],
  // 永慶列表頁
  SOURCES_YC: [
    { name: '新莊區', url: 'https://buy.yungching.com.tw/list/新北市-新莊區_c/' },
    { name: '泰山區', url: 'https://buy.yungching.com.tw/list/新北市-泰山區_c/' },
  ],
  YC_MAX_PAGES: 30,        // 永慶每區最多翻幾頁

  QUIET_HOURS: null, // 例如 [0, 7] = 台灣時間 0:00~7:00 先不通知，早上一起送；null = 隨時通知

  TEST_SEND: process.env.TEST_SEND === 'true', // 在 GitHub 手動執行時勾選「測試」即可
};
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
let store = {};
try { store = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
async function httpRequest({ method = 'GET', url, headers = {}, body, json }) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`HTTP ${res.status} ${url.slice(0, 80)}`); e.httpCode = res.status; throw e; }
  if (json === false) return text;
  try { return JSON.parse(text); } catch (e) { return text; }
}
const ctx = { helpers: { httpRequest } };


// ---------- 591 ----------
async function fetch591(src) {
  const url = `https://bff-house.591.com.tw/v1/web/sale/list?type=2&category=1&shType=list&regionid=3&section=${src.section}&order=posttime_desc&firstRow=0`;
  let res = await this.helpers.httpRequest({ url, headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (typeof res === 'string') res = JSON.parse(res);
  const list = (res && res.data && res.data.house_list) || [];
  const out = [];
  for (const h of list) {
    if (!h || !h.houseid || h.is_newhouse || String(h.type) !== '2') continue;
    const sec = h.section_name || src.name;
    if (sec !== src.name) continue;
    const info = [h.room, h.area ? `${h.area}坪` : '', h.floor, h.showhouseage].filter(Boolean).join('｜');
    out.push({
      key: `591-${h.houseid}`,
      source: '591',
      district: sec,
      title: h.title || '',
      price: h.price ? `${h.showprice || h.price}萬` : '',
      info,
      address: `${sec}${h.address || ''}`,
      url: `https://sale.591.com.tw/home/house/detail/2/${h.houseid}.html`,
    });
  }
  return out;
}

// ---------- 永慶 ----------
function parseYC(html, district) {
  const out = [];
  // 永慶的連結格式：href="house/7506076"（可能有或沒有開頭斜線、網域）
  const re = /href="(?:https:\/\/buy\.yungching\.com\.tw)?\/?house\/(\d+)[^"]*"/g;
  const hits = [];
  let m;
  while ((m = re.exec(html)) !== null) hits.push({ id: m[1], pos: m.index });
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].pos : Math.min(html.length, hits[i].pos + 6000);
    const text = html.slice(hits[i].pos, end)
      .replace(/<[^>]*$/, '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/^[^>]*>/, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const addr = (text.match(/[一-鿿]{2}[市縣][一-鿿]{1,3}?[區鄉鎮市][^\s]*/) || [''])[0];
    if (!addr.includes(district)) continue; // 排除其他區域的廣告物件
    const title = text.split(' ')[0].slice(0, 60);
    const price = (text.match(/([\d,]+)\s*$/) || [])[1]; // 卡片最後一個數字＝目前售價（萬）
    const layout = (text.match(/\d+房[^\s]*/) || [''])[0];
    out.push({
      key: `YC-${hits[i].id}`,
      source: '永慶',
      district,
      title,
      price: price ? `${price}萬` : '',
      info: layout,
      address: addr,
      url: `https://buy.yungching.com.tw/house/${hits[i].id}`,
    });
  }
  return out;
}

async function fetchYC(src) {
  const all = new Map();
  const pagesSeen = {}; // 同一個 ID 出現在好幾頁 = 廣告版位
  for (let pg = 1; pg <= CONFIG.YC_MAX_PAGES; pg++) {
    const url = pg === 1 ? src.url : `${src.url}?pg=${pg}`;
    const html = await this.helpers.httpRequest({ url: encodeURI(url), headers: { 'User-Agent': UA }, json: false });
    const items = parseYC(String(html), src.name);
    if (!items.some((it) => !all.has(it.key))) break; // 沒有新的就代表翻到底了
    for (const it of items) {
      pagesSeen[it.key] = (pagesSeen[it.key] || 0) + 1;
      if (!all.has(it.key)) all.set(it.key, it);
    }
    await sleep(800);
  }
  return [...all.values()].filter((it) => pagesSeen[it.key] === 1);
}

// ---------- Discord ----------
const COLORS = { '591': 0xff8000, '永慶': 0xc8102e };
function toEmbed(it) {
  return {
    title: `【${it.source}｜${it.district}】${it.title}`.slice(0, 250),
    url: it.url,
    description: [it.price ? `💰 ${it.price}` : '', it.info, it.address ? `📍 ${it.address}` : ''].filter(Boolean).join('\n').slice(0, 1000),
    color: COLORS[it.source] || 0x5865f2,
  };
}

async function postDiscord(body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await this.helpers.httpRequest({ method: 'POST', url: CONFIG.DISCORD_WEBHOOK_URL, body, json: true });
      return;
    } catch (e) {
      const status = e.httpCode || (e.response && e.response.status);
      if (String(status) === '429') { await sleep(3000); continue; } // 被限速就等一下再送
      throw e;
    }
  }
  throw new Error('Discord 一直限速，下次再送');
}

async function pushDiscord(items, header) {
  // 每則訊息最多 10 張卡片
  for (let i = 0; i < items.length; i += 10) {
    const body = { embeds: items.slice(i, i + 10).map(toEmbed) };
    if (i === 0 && header) body.content = header;
    await postDiscord.call(this, body);
    await sleep(1200);
  }
}

async function main() {
  // ---------- 主流程 ----------
  const results = []; // { srcKey, ok, items }
  for (const s of CONFIG.SOURCES_591) {
    try { results.push({ srcKey: `591-${s.section}`, ok: true, items: await fetch591.call(this, s) }); }
    catch (e) { results.push({ srcKey: `591-${s.section}`, ok: false, items: [] }); log.push(`591 ${s.name} 失敗：${e.message}`); }
    await sleep(800);
  }
  for (const s of CONFIG.SOURCES_YC) {
    try { results.push({ srcKey: `YC-${s.name}`, ok: true, items: await fetchYC.call(this, s) }); }
    catch (e) { results.push({ srcKey: `YC-${s.name}`, ok: false, items: [] }); log.push(`永慶 ${s.name} 失敗：${e.message}`); }
  }
  
  // 永慶同一個 ID 同時出現在兩區 = 廣告版位，排除
  const ycCount = {};
  for (const r of results) if (r.srcKey.startsWith('YC-')) for (const it of r.items) ycCount[it.key] = (ycCount[it.key] || 0) + 1;
  for (const r of results) if (r.srcKey.startsWith('YC-')) r.items = r.items.filter((it) => ycCount[it.key] === 1);
  
  if (CONFIG.TEST_SEND) {
    const sample = results.flatMap((r) => r.items.slice(0, 3));
    await pushDiscord.call(this, sample, `✅ 測試成功！目前抓到：${results.map((r) => `${r.srcKey} ${r.ok ? r.items.length + '筆' : '失敗'}`).join('、')}`);
    console.log(JSON.stringify({ test: true, log, counts: results.map((r) => ({ src: r.srcKey, ok: r.ok, n: r.items.length })) }, null, 2));
    return;
  }
  
  store.seen = store.seen || {};
  store.seeded = store.seeded || {};
  store.pending = store.pending || [];
  const now = Date.now();
  const today = Math.floor(now / 864e5); // 以「天」為單位，避免每 10 分鐘都要存檔
  // 舊格式（毫秒時間戳）轉成天數
  for (const k of Object.keys(store.seen)) if (store.seen[k] > 1e7) store.seen[k] = Math.floor(store.seen[k] / 864e5);
  const newItems = [];
  for (const r of results) {
    if (!r.ok || r.items.length === 0) continue;
    const firstTime = !store.seeded[r.srcKey];
    for (const it of r.items) {
      if (!store.seen[it.key] && !firstTime) newItems.push(it);
      store.seen[it.key] = today; // 記錄「最後一次看到」的日期，掛賣再久也不會被重複通知
    }
    store.seeded[r.srcKey] = true; // 第一次執行只記錄現有物件，不推播
  }
  
  // 下架超過 90 天的物件才刪掉紀錄，避免越存越大
  for (const k of Object.keys(store.seen)) if (today - store.seen[k] > 90) delete store.seen[k];
  
  store.pending.push(...newItems);
  if (store.pending.length > 300) store.pending = store.pending.slice(-300);
  
  const hour = new Date(now + 8 * 3600e3).getUTCHours();
  const quiet = !!(CONFIG.QUIET_HOURS && hour >= CONFIG.QUIET_HOURS[0] && hour < CONFIG.QUIET_HOURS[1]);
  
  let pushed = 0;
  if (store.pending.length && !quiet) {
    const batch = store.pending;
    try {
      await pushDiscord.call(this, batch, `🏠 新物件 ${batch.length} 筆`);
      pushed = batch.length;
      store.pending = [];
    } catch (e) {
      log.push(`Discord 傳送失敗，下次再試：${e.message}`); // 物件留在待送清單，不會漏掉
    }
  }
  
  fs.writeFileSync(STATE_FILE, JSON.stringify(store));
  console.log(JSON.stringify({
    newFound: newItems.length, pushed, pendingLeft: store.pending.length, quiet, log,
    counts: results.map((r) => ({ src: r.srcKey, ok: r.ok, n: r.items.length })),
  }, null, 2));
}

main.call(ctx).catch((e) => { console.error(e); process.exit(1); });
