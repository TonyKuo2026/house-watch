// 591＋永慶＋信義 新莊/泰山 新物件 → Discord 通知（GitHub Actions 版）
const fs = require('fs');
const { execSync } = require('child_process');
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
  // 信義房屋（郵遞區號）：新莊區=242、泰山區=243
  SOURCES_SY: [
    { name: '新莊區', zip: 242 },
    { name: '泰山區', zip: 243 },
  ],

  CHECK_EVERY_MIN: 10,        // 每幾分鐘檢查一次
  LOOP_MINUTES: 110,          // 每次 GitHub 執行持續循環多久（下一次排程會接手）
  SKIP_HOURS: [0, 8],         // 台灣時間 0:00~8:00 不檢查

  P591_MAX_PAGES: 5,          // 591 最多往後翻幾頁（補齊漏掉的新物件）
  SY_NEW_PAGES: 5,            // 信義平常最多往後翻幾頁
  SY_MAX_PAGES: 80,           // 信義每天一次完整掃描的頁數上限

  YC_MAX_PAGES: 30,           // 永慶每區最多翻幾頁
  YC_OK_INTERVAL_MIN: [60, 120],  // 永慶成功後，下次檢查間隔（分鐘，隨機）
  YC_FAIL_RETRY_MIN: [10, 20],    // 永慶失敗後，多久重試（分鐘，隨機）
  YC_WARN_HOURS: 6,               // 永慶超過幾小時都沒成功就傳警告

  // 判定「同一間房子」：同一區、樓層／總樓層相同、坪數差距、總價差距都在範圍內
  DUP_AREA_TOLERANCE: 0.2,    // 坪
  DUP_PRICE_TOLERANCE: 0.03,  // 3%

  TEST_SEND: process.env.TEST_SEND === 'true', // 在 GitHub 手動執行時勾選「測試」即可
};
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const BROWSER_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
};
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const twHour = (t) => new Date(t + 8 * 3600e3).getUTCHours();
const isSkipHour = (t) => CONFIG.SKIP_HOURS && twHour(t) >= CONFIG.SKIP_HOURS[0] && twHour(t) < CONFIG.SKIP_HOURS[1];

let store = {};
try { store = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
store.seen = store.seen || {};
store.seeded = store.seeded || {};
store.pending = store.pending || [];
store.fp = store.fp || {};

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

// ---------- 591 ----------
async function fetch591(src, firstTime) {
  const out = [];
  const maxPages = firstTime ? 1 : CONFIG.P591_MAX_PAGES;
  for (let page = 0; page < maxPages; page++) {
    const url = `https://bff-house.591.com.tw/v1/web/sale/list?type=2&category=1&shType=list&regionid=3&section=${src.section}&order=posttime_desc&firstRow=${page * 30}`;
    let res = await httpRequest({ url, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (typeof res === 'string') res = JSON.parse(res);
    const list = (res && res.data && res.data.house_list) || [];
    let hitSeen = false;
    for (const h of list) {
      if (!h || !h.houseid || h.is_newhouse || String(h.type) !== '2') continue;
      const sec = h.section_name || src.name;
      if (sec !== src.name) continue;
      const key = `591-${h.houseid}`;
      if (store.seen[key]) hitSeen = true;
      const fl = String(h.floor || '').match(/B?(\d+)F?(?:~\d+F?)?\/(\d+)F/);
      out.push({
        key, source: '591', district: sec,
        title: h.title || '',
        priceNum: num(h.price), areaNum: num(h.area),
        floorNum: fl ? +fl[1] : null, totalFloorNum: fl ? +fl[2] : null,
        info: [h.room, h.area ? `${h.area}坪` : '', h.floor, h.showhouseage].filter(Boolean).join('｜'),
        address: `${sec}${h.address || ''}`,
        url: `https://sale.591.com.tw/home/house/detail/2/${h.houseid}.html`,
      });
    }
    if (hitSeen || list.length < 20) break; // 已經接到看過的物件，就不用再往後翻
    await sleep(rand(800, 1500));
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
    const area = (text.match(/建坪\s*([\d.]+)/) || [])[1];
    const fl = text.match(/B?(\d+)(?:[-~]\d+)?\s*樓?\s*\/\s*(\d+)\s*樓/);
    out.push({
      key: `YC-${hits[i].id}`, source: '永慶', district, title,
      priceNum: num(price), areaNum: num(area),
      floorNum: fl ? +fl[1] : null, totalFloorNum: fl ? +fl[2] : null,
      info: [layout, area ? `${area}坪` : '', fl ? `${fl[1]}/${fl[2]}樓` : ''].filter(Boolean).join('｜'),
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
    const html = await httpRequest({ url: encodeURI(url), headers: { ...BROWSER_HEADERS, Referer: pg === 1 ? 'https://buy.yungching.com.tw/' : encodeURI(src.url) }, json: false });
    const items = parseYC(String(html), src.name);
    if (!items.some((it) => !all.has(it.key))) break; // 沒有新的就代表翻到底了
    for (const it of items) {
      pagesSeen[it.key] = (pagesSeen[it.key] || 0) + 1;
      if (!all.has(it.key)) all.set(it.key, it);
    }
    await sleep(rand(2000, 4500)); // 放慢翻頁速度，像真人瀏覽
  }
  return [...all.values()].filter((it) => pagesSeen[it.key] === 1);
}

// ---------- 信義 ----------
async function fetchSY(src, fullScan) {
  const out = [];
  const maxPages = fullScan ? CONFIG.SY_MAX_PAGES : CONFIG.SY_NEW_PAGES;
  for (let pg = 1; pg <= maxPages; pg++) {
    const url = `https://www.sinyi.com.tw/buy/list/NewTaipei-city/${src.zip}-zip/publish-desc/${pg === 1 ? '' : pg}`;
    const html = await httpRequest({ url, headers: { ...BROWSER_HEADERS, Referer: 'https://www.sinyi.com.tw/buy/list' }, json: false });
    const m = String(html).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('信義頁面格式改變（找不到資料）');
    const reducer = JSON.parse(m[1]).props.initialReduxState.buyReducer;
    const list = reducer.list || [];
    let hitSeen = false;
    for (const x of list) {
      if (!x || !x.houseNo) continue;
      if (x.address && !String(x.address).includes(src.name)) continue;
      const key = `SY-${x.houseNo}`;
      if (store.seen[key]) hitSeen = true;
      const floorTxt = x.floor ? `${x.floor}/${x.totalfloor}樓` : '';
      out.push({
        key, source: '信義', district: src.name,
        title: x.name || '',
        priceNum: num(x.totalPrice), areaNum: num(x.areaBuilding),
        floorNum: num(String(x.floor || '').split('-')[0]), totalFloorNum: num(x.totalfloor),
        info: [x.layout, x.areaBuilding ? `${x.areaBuilding}坪` : '', floorTxt, x.age].filter(Boolean).join('｜'),
        address: x.address || src.name,
        url: `https://www.sinyi.com.tw/buy/house/${x.houseNo}`,
      });
    }
    if (list.length === 0 || (!fullScan && hitSeen)) break;
    await sleep(rand(1500, 3000));
  }
  return out;
}

// ---------- 判定同一間房子 ----------
const fpOf = (it) => [it.district, it.areaNum, it.floorNum, it.totalFloorNum, it.priceNum];
function sameHouse(a, b) {
  const [da, aa, fa, ta, pa] = a, [db, ab, fb, tb, pb] = b;
  if (da !== db || !aa || !ab || !pa || !pb) return false;
  if (Math.abs(aa - ab) > CONFIG.DUP_AREA_TOLERANCE) return false;
  if (Math.abs(pa - pb) / Math.max(pa, pb) > CONFIG.DUP_PRICE_TOLERANCE) return false;
  if (fa != null && fb != null && ta != null && tb != null) return fa === fb && ta === tb;
  // 有一邊沒有樓層資料：坪數、價格要更接近才算
  return Math.abs(aa - ab) <= 0.05 && Math.abs(pa - pb) / Math.max(pa, pb) <= 0.01;
}
function findDuplicate(it) {
  const f = fpOf(it);
  for (const [k, g] of Object.entries(store.fp)) if (k !== it.key && sameHouse(f, g)) return k;
  return null;
}

// ---------- Discord ----------
const COLORS = { '591': 0xff8000, '永慶': 0xc8102e, '信義': 0x00964b };
function toEmbed(it) {
  return {
    title: `【${it.source}｜${it.district}】${it.title}`.slice(0, 250),
    url: it.url,
    description: [it.priceNum ? `💰 ${it.priceNum.toLocaleString()}萬` : '', it.info, it.address ? `📍 ${it.address}` : ''].filter(Boolean).join('\n').slice(0, 1000),
    color: COLORS[it.source] || 0x5865f2,
  };
}
async function postDiscord(body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await httpRequest({ method: 'POST', url: CONFIG.DISCORD_WEBHOOK_URL, body, json: true }); return; }
    catch (e) {
      if (String(e.httpCode) === '429') { await sleep(3000); continue; } // 被限速就等一下再送
      throw e;
    }
  }
  throw new Error('Discord 一直限速，下次再送');
}
async function pushDiscord(items, header) {
  for (let i = 0; i < items.length; i += 10) { // 每則訊息最多 10 張卡片
    const body = { embeds: items.slice(i, i + 10).map(toEmbed) };
    if (i === 0 && header) body.content = header;
    await postDiscord(body);
    await sleep(1200);
  }
}

// ---------- 存檔（每輪檢查完就推回 GitHub，中途停掉也不會遺失） ----------
function saveAndPush() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(store));
  if (!process.env.GITHUB_ACTIONS) return;
  try {
    execSync('git add state.json', { stdio: 'ignore' });
    try { execSync('git diff --cached --quiet'); return; } catch (e) { /* 有變化才提交 */ }
    execSync('git commit -q -m "更新物件紀錄"', { stdio: 'ignore' });
    execSync('git pull -q --rebase && git push -q', { stdio: 'ignore' });
  } catch (e) { console.log('推送紀錄失敗，下一輪再試：', e.message); }
}

// ---------- 一輪檢查 ----------
async function checkOnce() {
  const log = [];
  const now = Date.now();
  const today = Math.floor(now / 864e5);
  const results = []; // { srcKey, ok, items }

  for (const s of CONFIG.SOURCES_591) {
    const key = `591-${s.section}`;
    try { results.push({ srcKey: key, ok: true, items: await fetch591(s, !store.seeded[key]) }); }
    catch (e) { results.push({ srcKey: key, ok: false, items: [] }); log.push(`591 ${s.name} 失敗：${e.message}`); }
    await sleep(800);
  }

  // 信義：平常只看最新幾頁；每天第一次（或第一次使用）完整掃描一遍，建立比對資料
  const syFull = CONFIG.TEST_SEND ? false : store.syFullDay !== today;
  let syAllOk = true;
  for (const s of CONFIG.SOURCES_SY) {
    const key = `SY-${s.zip}`;
    try { results.push({ srcKey: key, ok: true, items: await fetchSY(s, !CONFIG.TEST_SEND && (syFull || !store.seeded[key])) }); }
    catch (e) { syAllOk = false; results.push({ srcKey: key, ok: false, items: [] }); log.push(`信義 ${s.name} 失敗：${e.message}`); }
    await sleep(rand(1500, 3000));
  }
  if (syFull && syAllOk && !CONFIG.TEST_SEND) store.syFullDay = today;

  // 永慶：成功後隔 1~2 小時；失敗時 10~20 分鐘就重試
  const ycDue = CONFIG.TEST_SEND || !store.ycNextAt || now >= store.ycNextAt;
  let ycTried = false, ycAllOk = true;
  if (ycDue) {
    ycTried = true;
    for (const s of CONFIG.SOURCES_YC) {
      try { results.push({ srcKey: `YC-${s.name}`, ok: true, items: await fetchYC(s) }); }
      catch (e) { ycAllOk = false; results.push({ srcKey: `YC-${s.name}`, ok: false, items: [] }); log.push(`永慶 ${s.name} 失敗：${e.message}`); if (e.httpCode === 403) break; }
      await sleep(rand(3000, 6000));
    }
    if (!CONFIG.TEST_SEND) {
      const [a, b] = ycAllOk ? CONFIG.YC_OK_INTERVAL_MIN : CONFIG.YC_FAIL_RETRY_MIN;
      store.ycNextAt = now + rand(a, b) * 60e3;
    }
  }

  // 永慶同一個 ID 同時出現在兩區 = 廣告版位，排除
  const ycCount = {};
  for (const r of results) if (r.srcKey.startsWith('YC-')) for (const it of r.items) ycCount[it.key] = (ycCount[it.key] || 0) + 1;
  for (const r of results) if (r.srcKey.startsWith('YC-')) r.items = r.items.filter((it) => ycCount[it.key] === 1);

  const counts = results.map((r) => ({ src: r.srcKey, ok: r.ok, n: r.items.length }));

  if (CONFIG.TEST_SEND) {
    const sample = results.flatMap((r) => r.items.slice(0, 2));
    await pushDiscord(sample, `✅ 測試成功！目前抓到：${counts.map((c) => `${c.src} ${c.ok ? c.n + '筆' : '失敗'}`).join('、')}`);
    return { test: true, log, counts };
  }

  // 舊格式（毫秒時間戳）轉成天數
  for (const k of Object.keys(store.seen)) if (store.seen[k] > 1e7) store.seen[k] = Math.floor(store.seen[k] / 864e5);

  const newItems = [], dups = [];
  for (const r of results) {
    if (!r.ok || r.items.length === 0) continue;
    const firstTime = !store.seeded[r.srcKey];
    for (const it of r.items) {
      const isNew = !store.seen[it.key] && !firstTime;
      if (isNew) {
        const dupOf = findDuplicate(it);
        if (dupOf) dups.push(`${it.key}＝${dupOf}`); else newItems.push(it);
      }
      store.seen[it.key] = today; // 記錄「最後一次看到」的日期，掛賣再久也不會被重複通知
      if (it.areaNum && it.priceNum) store.fp[it.key] = fpOf(it);
    }
    store.seeded[r.srcKey] = true; // 第一次只記錄現有物件，不推播
  }

  // 下架超過 90 天的物件才刪掉紀錄
  for (const k of Object.keys(store.seen)) if (today - store.seen[k] > 90) { delete store.seen[k]; delete store.fp[k]; }
  for (const k of Object.keys(store.fp)) if (!store.seen[k]) delete store.fp[k];

  store.pending.push(...newItems);
  if (store.pending.length > 300) store.pending = store.pending.slice(-300);

  // 永慶太久沒成功的警告／恢復通知
  const notices = [];
  if (!store.ycLastOk) store.ycLastOk = now;
  if (ycTried && ycAllOk) {
    if (store.ycWarned) notices.push('✅ 永慶已恢復正常，繼續幫你盯新物件。');
    store.ycLastOk = now; store.ycWarned = false;
  } else if (!store.ycWarned && now - store.ycLastOk > CONFIG.YC_WARN_HOURS * 3600e3) {
    notices.push(`⚠️ 永慶已經超過 ${CONFIG.YC_WARN_HOURS} 小時抓不到資料（可能被網站擋住），這段期間永慶的新物件不會通知。591、信義不受影響。`);
    store.ycWarned = true;
  }
  for (const text of notices) {
    try { await postDiscord({ content: text }); } catch (e) { log.push(`警告訊息傳送失敗：${e.message}`); }
  }

  let pushed = 0;
  if (store.pending.length) {
    const batch = store.pending;
    try {
      await pushDiscord(batch, `🏠 新物件 ${batch.length} 筆`);
      pushed = batch.length;
      store.pending = [];
    } catch (e) {
      log.push(`Discord 傳送失敗，下次再試：${e.message}`); // 物件留在待送清單，不會漏掉
    }
  }

  saveAndPush();
  return { newFound: newItems.length, pushed, duplicatesSkipped: dups, ycChecked: ycTried, ycOk: ycTried ? ycAllOk : null, syFull, log, counts };
}

// ---------- 主程式：在 LOOP_MINUTES 內，每 CHECK_EVERY_MIN 分鐘檢查一次 ----------
async function main() {
  const start = Date.now();
  if (CONFIG.TEST_SEND) { console.log(JSON.stringify(await checkOnce(), null, 2)); return; }
  while (Date.now() - start < CONFIG.LOOP_MINUTES * 60e3) {
    const t0 = Date.now();
    if (isSkipHour(t0)) { console.log(`台灣時間 ${twHour(t0)} 點，休息時段不檢查，結束`); break; }
    try {
      const r = await checkOnce();
      console.log(new Date(t0 + 8 * 3600e3).toISOString().slice(11, 16), JSON.stringify(r));
    } catch (e) { console.log('本輪發生錯誤：', e.message); }
    const wait = CONFIG.CHECK_EVERY_MIN * 60e3 - (Date.now() - t0);
    if (Date.now() - start + wait >= CONFIG.LOOP_MINUTES * 60e3) break;
    if (wait > 0) await sleep(wait);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
