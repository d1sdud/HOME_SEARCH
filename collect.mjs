#!/usr/bin/env node
/**
 * 매물 수집기 — 직방 공개 매물 API에서 조건에 맞는 매물을 모아
 * data/listings.js 파일 하나로 저장한다.
 *
 *   node collect.mjs                      # collect.config.json 설정대로 수집
 *   node collect.mjs --region 경기         # 설정 일부만 덮어쓰기
 *   node collect.mjs --dry-run            # 몇 건 잡히는지만 세어 보기
 *
 * 의존성 없음. Node 18 이상이면 그냥 돌아간다.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://apis.zigbang.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ── 지역 프리셋 ───────────────────────────────────────────────
   대략적인 경계 상자다. 넓게 긁은 뒤 사이트에서 구·동 단위로 좁히는 편이
   요청 수도 적고 다시 수집할 일도 줄어든다. */
const REGIONS = {
  서울:   { south: 37.42, north: 37.70, west: 126.76, east: 127.19 },
  경기:   { south: 36.89, north: 38.29, west: 126.38, east: 127.86 },
  인천:   { south: 37.30, north: 37.63, west: 126.34, east: 126.79 },
  수도권: { south: 36.89, north: 38.29, west: 126.34, east: 127.86 },
  수원:   { south: 37.22, north: 37.34, west: 126.93, east: 127.09 },
  성남:   { south: 37.35, north: 37.49, west: 127.07, east: 127.20 },
  용인:   { south: 37.14, north: 37.38, west: 127.03, east: 127.35 },
  화성:   { south: 37.05, north: 37.28, west: 126.66, east: 127.10 },
  부산:   { south: 35.05, north: 35.39, west: 128.82, east: 129.30 },
  대구:   { south: 35.65, north: 36.02, west: 128.35, east: 128.76 },
  대전:   { south: 36.18, north: 36.50, west: 127.26, east: 127.55 },
  광주:   { south: 35.05, north: 35.26, west: 126.65, east: 127.02 },
  울산:   { south: 35.44, north: 35.71, west: 129.07, east: 129.47 },
  세종:   { south: 36.42, north: 36.72, west: 127.15, east: 127.40 },
  제주:   { south: 33.11, north: 33.58, west: 126.14, east: 126.98 },
};

const KIND_PATHS = {
  원룸: 'onerooms',
  빌라: 'villas',
  오피스텔: 'officetels',
};

const KIND_URL_SEGMENT = {
  원룸: 'oneroom',
  빌라: 'villa',
  오피스텔: 'officetel',
};

/** 아파트는 통로가 완전히 달라서 따로 다룬다. KIND_PATHS 에 넣지 않는다. */
const APT = '아파트';

/** 직방에 원룸 매매는 아예 없다. 요청하면 400이 떨어지므로 미리 걸러 둔다. */
const UNSUPPORTED = new Set(['원룸/매매']);

/* ── geohash ──────────────────────────────────────────────────
   직방 목록 API는 좌표가 아니라 geohash 한 칸을 받는다.
   그래서 경계 상자를 geohash 칸으로 잘라서 칸마다 훑는다.
   한 칸에 걸린 매물은 개수 제한 없이 다 내려온다(정밀도 4 한 칸 = 하위 5 칸 32개의 합).
   그래서 칸을 잘게 쪼갤수록 요청만 늘고 얻는 건 같다. 기본값 4로 충분하다. */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function geohashEncode(lat, lng, precision) {
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let hash = '';
  let [latMin, latMax, lngMin, lngMax] = [-90, 90, -180, 180];

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { idx = idx * 2 + 1; lngMin = mid; } else { idx *= 2; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { idx = idx * 2 + 1; latMin = mid; } else { idx *= 2; latMax = mid; }
    }
    evenBit = !evenBit;
    if (++bit === 5) { hash += BASE32[idx]; bit = 0; idx = 0; }
  }
  return hash;
}

/** geohash 한 칸의 위도/경도 크기. 짝수 번째 비트가 경도로 간다. */
function cellSize(precision) {
  const bits = precision * 5;
  const lngBits = Math.ceil(bits / 2);
  const latBits = Math.floor(bits / 2);
  return { lat: 180 / 2 ** latBits, lng: 360 / 2 ** lngBits };
}

function coverBox(box, precision) {
  const cell = cellSize(precision);
  const stepLat = cell.lat / 2;
  const stepLng = cell.lng / 2;
  const cells = new Set();
  for (let lat = box.south; lat <= box.north + stepLat; lat += stepLat) {
    for (let lng = box.west; lng <= box.east + stepLng; lng += stepLng) {
      cells.add(geohashEncode(Math.min(lat, box.north), Math.min(lng, box.east), precision));
    }
  }
  return [...cells].sort();
}

/* ── HTTP ─────────────────────────────────────────────────── */
let requestCount = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, options = {}, attempt = 1) {
  requestCount += 1;
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.zigbang.com/',
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text()).slice(0, 160)}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(600 * 2 ** (attempt - 1));
    return request(url, options, attempt + 1);
  }
}

/** 동시 실행 수를 제한해 순서대로 처리한다. 상대 서버에 대한 예의이자 차단 회피. */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
      await sleep(120);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ── 수집 ─────────────────────────────────────────────────── */
function buildListQuery(geohash, trade, filters) {
  const q = new URLSearchParams({
    geohash,
    domain: 'zigbang',
    checkAnyItemWithoutFilter: 'false',
  });
  q.append('salesTypes[0]', trade);

  // 매매는 매매가, 전월세는 보증금·월세로 필터 필드가 갈린다.
  const map = trade === '매매'
    ? { priceMin: 'salesPriceMin', priceMax: 'salesPriceMax' }
    : { depositMin: 'depositMin', depositMax: 'depositMax', rentMin: 'rentMin', rentMax: 'rentMax' };

  for (const [key, param] of Object.entries(map)) {
    if (filters[key] != null) q.set(param, String(filters[key]));
  }
  if (filters.areaMinM2 != null) q.set('sizeMinM2', String(filters.areaMinM2));
  if (filters.areaMaxM2 != null) q.set('sizeMaxM2', String(filters.areaMaxM2));
  return q;
}

/** 지역 상자들 중 하나에라도 들어오면 통과. geohash 칸은 찾는 범위보다 넓다. */
const inside = (boxes, lat, lng) =>
  boxes.some((b) => lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east);

const boundsOf = (boxes) => ({
  south: Math.min(...boxes.map((b) => b.south)),
  north: Math.max(...boxes.map((b) => b.north)),
  west: Math.min(...boxes.map((b) => b.west)),
  east: Math.max(...boxes.map((b) => b.east)),
  parts: boxes,
});

async function listIds(kind, trade, geohash, filters, box) {
  const q = buildListQuery(geohash, trade, filters);
  const data = await request(`${API}/house/property/v1/items/${KIND_PATHS[kind]}?${q}`);
  // 목록에 좌표가 같이 오므로 비싼 상세 조회를 하기 전에 범위 밖 매물을 여기서 버린다.
  return (data.items ?? [])
    .filter((it) => inside(box.parts, it.lat, it.lng))
    .map((it) => it.id);
}

/** 상세 조회는 한 번에 15건까지만 받는다. */
const DETAIL_BATCH = 15;

async function fetchDetails(ids) {
  const batches = [];
  for (let i = 0; i < ids.length; i += DETAIL_BATCH) batches.push(ids.slice(i, i + DETAIL_BATCH));

  const pages = await mapPool(batches, 3, async (batch) => {
    try {
      const data = await request(`${API}/house/property/v1/items/list`, {
        method: 'POST',
        body: JSON.stringify({ domain: 'zigbang', withCoalition: true, item_ids: batch }),
      });
      return data.items ?? [];
    } catch (err) {
      process.stderr.write(`  · 상세 ${batch.length}건 실패 (건너뜀): ${err.message}\n`);
      return [];
    }
  });
  return pages.flat();
}

/* ── 아파트 ───────────────────────────────────────────────
   아파트는 통로가 다르다. 두 단계를 거친다.
     1) 지도 칸 → 그 안의 단지 목록 (좌표와 주소는 여기서만 나온다)
     2) 단지 → 그 단지에 나와 있는 매물 전부
   단지 목록 API 는 geohash 를 평문으로 받지 않는다. 직방 웹이 하는 대로
   AES-256-CBC 로 감싸서 보내야 한다. 키는 직방 웹 코드에 박혀 있는 값이다. */
const GEOHASH_KEY = Buffer.from('osZDx4zzfVX/iHB9SpOZXOWYZDjWW/PtXxdkR4L0nns=', 'base64');

function encryptGeohash(geohash) {
  const iv = crypto.createHmac('sha256', GEOHASH_KEY).update(geohash, 'utf8').digest().subarray(0, 16);
  const cipher = crypto.createCipheriv('aes-256-cbc', GEOHASH_KEY, iv);
  const body = Buffer.concat([cipher.update(geohash, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body]).toString('base64');
}

const APT_HEADERS = { ZigbangOsType: 'web' };

/** 지도 한 칸 안의 아파트 단지. 단지 목록 API 는 geohash 가 5자 이상이어야 한다. */
async function listDanjis(geohash, box) {
  const q = new URLSearchParams({
    geohash: encryptGeohash(geohash),
    minPynArea: '10평이하',
    maxPynArea: '60평대이상',
  });
  const data = await request(`${API}/apt/locals/prices/on-danjis?${q}`, { headers: APT_HEADERS });
  return (data.filtered ?? [])
    .filter((d) => inside(box.parts, d.lat, d.lng))
    .filter((d) => d.real_type === APT);
}

/** 단지 하나에 나와 있는 매물. 거래 유형을 안 주면 전세·월세·매매가 모두 온다. */
async function listDanjiItems(danji) {
  const q = new URLSearchParams({
    limit: '200',
    isIncludeAdvertisementItems: 'true',
    isIncludeLocalAgentItems: 'true',
  });
  const data = await request(`${API}/apt/danjis/${danji.id}/items?${q}`, { headers: APT_HEADERS });
  return (data.list ?? []).map((item) => ({ item, danji }));
}

const TRAN_TYPE = { charter: '전세', rental: '월세', trade: '매매' };

/* 단지 목록은 구 이름을 '권선구' 처럼 시를 뗀 채로 준다. 빌라·원룸 쪽은 '수원시 권선구'
   라고 붙여서 주기 때문에, 그대로 두면 지역 필터에서 같은 동네가 둘로 갈린다.
   직방의 지역 코드 목록으로 시도별 시군구 전체 이름을 받아 맞춰 준다. */
const guCache = new Map();

async function fullGuName(sido, gugun) {
  if (!sido || !gugun) return gugun ?? '';
  if (!guCache.has(sido)) {
    guCache.set(sido, (async () => {
      try {
        const top = await request(`${API}/apt/locals/local1`, { headers: APT_HEADERS });
        const code = (top.results ?? []).find((r) => r.name === sido)?.code;
        if (!code) return [];
        const sub = await request(`${API}/apt/locals/local2?code=${code}`, { headers: APT_HEADERS });
        return (sub.results ?? []).map((r) => r.name);
      } catch {
        return [];
      }
    })());
  }
  const names = await guCache.get(sido);
  const hits = names.filter((n) => n === gugun || n.endsWith(` ${gugun}`));
  return hits.length === 1 ? hits[0] : gugun;
}

function normalizeApt({ item, danji }) {
  const trade = TRAN_TYPE[item.tranType];
  if (!trade || item.status !== 'open') return null;

  const deposit = toNumber(item.deposit);
  const supply = item.roomTypeData?.['공급면적']?.m2;
  const exclusive = item.roomTypeData?.['전용면적']?.m2;

  return compact({
    id: `a${item.itemId}`,
    no: item.itemId,
    kind: APT,
    trade,
    price: trade === '매매' ? deposit : null,
    deposit: trade === '매매' ? null : deposit,
    rent: trade === '매매' ? null : toNumber(item.rent),
    // 아파트 매물에는 관리비가 실려 오지 않는다. 0 이 아니라 '모름' 이므로 비워 둔다.
    areaM2: Number(supply) || null,
    exclusiveM2: Number(exclusive ?? supply) || null,
    floor: item.floor != null ? String(item.floor) : null,
    buildingFloor: item.buildingFloor != null ? String(item.buildingFloor) : null,
    danji: item.areaDanjiName ?? danji.name ?? '',
    unit: [item.areaBuildingName, item.areaHoName].filter(Boolean).join(' '),
    rooms: item.roomCount ?? null,
    title: (item.description ?? '').trim(),
    address: [danji.guFull ?? danji.gugun, danji.dong].filter(Boolean).join(' '),
    sido: danji.sido ?? '',
    gu: danji.guFull ?? danji.gugun ?? '',
    dong: danji.dong ?? '',
    lat: danji.lat,
    lng: danji.lng,
    thumb: item.thumbnail || null,
    regDate: item.createdAt ? item.createdAt.slice(0, 10) : null,
  });
}

async function collectApartments(cells, box, onProgress) {
  const danjis = new Map();
  let scanned = 0;
  await mapPool(cells, 3, async (geohash) => {
    try {
      for (const d of await listDanjis(geohash, box)) danjis.set(d.id, d);
    } catch (err) {
      process.stderr.write(`  · 아파트 단지/${geohash} 실패: ${err.message}\n`);
    }
    onProgress(`단지 ${++scanned}/${cells.length}칸 · ${danjis.size}개`);
  });

  const all = [...danjis.values()];
  for (const d of all) d.guFull = await fullGuName(d.sido, d.gugun);

  let done = 0;
  const pages = await mapPool(all, 3, async (danji) => {
    try {
      return await listDanjiItems(danji);
    } catch (err) {
      return [];
    } finally {
      onProgress(`아파트 매물 ${++done}/${all.length}단지`);
    }
  });
  return pages.flat();
}

/* ── 정규화 ──────────────────────────────────────────────── */
const toNumber = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

function normalize(raw) {
  const trade = raw.sales_type;
  const deposit = toNumber(raw.deposit);   // 만원
  const rent = toNumber(raw.rent);         // 만원
  const loc = raw.location ?? raw.random_location ?? {};
  if (!loc.lat || !loc.lng) return null;

  const kind = raw.service_type in KIND_URL_SEGMENT ? raw.service_type : '빌라';
  const addr = raw.addressOrigin ?? {};
  const exclusive = raw['전용면적']?.m2 ?? raw.size_m2;

  // 썸네일과 매물 링크는 id 로 그대로 만들 수 있어서 저장하지 않는다 (파일 크기가 30%쯤 준다).
  return compact({
    // 아파트 매물 번호와 겹칠 수 있어 종류를 앞에 붙여 둔다. no 는 링크·사진용 원번호.
    id: `r${raw.item_id}`,
    no: raw.item_id,
    kind,
    trade,                                     // 전세 · 월세 · 매매
    price: trade === '매매' ? deposit : null,  // 매매가 (만원)
    deposit: trade === '매매' ? null : deposit,
    rent: trade === '매매' ? null : rent,
    manageCost: toNumber(raw.manage_cost),     // 원
    areaM2: Number(raw.size_m2) || null,
    exclusiveM2: Number(exclusive) || null,
    floor: raw.floor_string ?? raw.floor ?? null,
    buildingFloor: raw.building_floor ?? null,
    title: (raw.title ?? '').trim(),
    address: raw.address ?? addr.localText ?? '',
    sido: addr.local1 ?? '',
    gu: addr.local2 ?? '',
    dong: addr.local3 ?? '',
    lat: loc.lat,
    lng: loc.lng,
    regDate: raw.reg_date ? raw.reg_date.slice(0, 10) : null,
    tags: raw.tags?.length ? raw.tags : null,
  });
}

/** null·빈 값은 아예 빼서 저장한다. 사이트에서는 없는 값으로 읽힌다. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(6)) : v;
  }
  return out;
}

/** 같은 집을 제목만 바꿔 여러 번 올리는 경우가 많다.
    조건(거래·가격·면적·층)과 좌표가 모두 같으면 한 건으로 묶고 몇 건이었는지만 남긴다. */
function dedupe(items) {
  const seen = new Map();
  for (const it of items) {
    const key = [
      it.trade, it.deposit ?? '', it.rent ?? '', it.price ?? '',
      Math.round((it.areaM2 ?? 0) * 10), it.floor ?? '',
      it.lat.toFixed(4), it.lng.toFixed(4),
    ].join('|');
    const kept = seen.get(key);
    if (kept) kept.dupes = (kept.dupes ?? 1) + 1;
    else seen.set(key, it);
  }
  return [...seen.values()];
}

/** 아파트는 단지 단위로 통째로 받아 오기 때문에 예산·면적 조건을 여기서 맞춘다.
    (원룸·빌라·오피스텔은 직방 서버가 걸러서 내려 준다.) */
function matchesBudget(it, config) {
  const f = config.trades[it.trade];
  if (!f) return false;
  if (it.trade === '매매') {
    if (f.priceMin != null && it.price < f.priceMin) return false;
    if (f.priceMax != null && it.price > f.priceMax) return false;
  } else {
    if (f.depositMin != null && it.deposit < f.depositMin) return false;
    if (f.depositMax != null && it.deposit > f.depositMax) return false;
    if (it.trade === '월세') {
      if (f.rentMin != null && it.rent < f.rentMin) return false;
      if (f.rentMax != null && it.rent > f.rentMax) return false;
    }
  }
  const area = it.exclusiveM2 ?? it.areaM2 ?? 0;
  if (config.areaMinM2 != null && area < config.areaMinM2) return false;
  if (config.areaMaxM2 != null && area > config.areaMaxM2) return false;
  return true;
}

/* ── 설정 ─────────────────────────────────────────────────── */
const DEFAULT_CONFIG = {
  regions: ['수원', '서울'],
  kinds: ['아파트', '빌라', '오피스텔', '원룸'],
  trades: {
    전세: { depositMax: 40000 },
    월세: { depositMax: 10000, rentMax: 120 },
    매매: { priceMax: 80000 },
  },
  areaMinM2: null,
  areaMaxM2: null,
  geohashPrecision: 4,
  maxItems: 6000,
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i += 1;
  }
  return out;
}

async function loadConfig(args) {
  const file = path.join(HERE, 'collect.config.json');
  let config = { ...DEFAULT_CONFIG };
  try {
    config = { ...config, ...JSON.parse(await fs.readFile(file, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    process.stderr.write('collect.config.json 이 없어 기본 설정으로 수집한다.\n');
  }
  if (args.region) { config.regions = String(args.region).split(',').map((s) => s.trim()); delete config.region; }
  if (args.kinds) config.kinds = String(args.kinds).split(',').map((s) => s.trim());
  if (args.precision) config.geohashPrecision = Number(args.precision);
  if (args['max-items']) config.maxItems = Number(args['max-items']);
  if (args.bbox) {
    const [south, west, north, east] = String(args.bbox).split(',').map(Number);
    config.box = { south, west, north, east };
  }
  return config;
}

/* ── 실행 ─────────────────────────────────────────────────── */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args);
  const dryRun = Boolean(args['dry-run']);

  const names = config.box ? [] : (config.regions ?? [config.region]);
  const boxes = config.box ? [config.box] : names.map((name) => {
    const found = REGIONS[name];
    if (!found) throw new Error(`'${name}' 은 모르는 지역이다. 쓸 수 있는 값: ${Object.keys(REGIONS).join(', ')} (또는 --bbox 남,서,북,동)`);
    return found;
  });

  // 지역을 여러 개 받을 때 서로 겹치는 칸은 한 번만 훑는다.
  const cells = [...new Set(boxes.flatMap((b) => coverBox(b, config.geohashPrecision)))].sort();
  const box = boundsOf(boxes);
  const trades = Object.entries(config.trades).filter(([, v]) => v && v !== false);
  const label = config.box ? '직접 지정' : names.join('+');

  console.log(`지역 ${label} · geohash ${cells.length}칸 · ${config.kinds.join('/')} · ${trades.map(([t]) => t).join('/')}`);

  // 1단계: 조건에 맞는 매물 번호만 모은다. 여기서 이미 서버가 걸러 준다.
  const jobs = [];
  for (const kind of config.kinds.filter((k) => k !== APT)) {
    for (const [trade, tradeFilters] of trades) {
      if (UNSUPPORTED.has(`${kind}/${trade}`)) continue;
      for (const geohash of cells) {
        jobs.push({ kind, trade, geohash, filters: { ...tradeFilters, areaMinM2: config.areaMinM2, areaMaxM2: config.areaMaxM2 } });
      }
    }
  }

  const seen = new Set();
  let scanned = 0;
  const found = await mapPool(jobs, 3, async (job) => {
    let ids = [];
    try {
      ids = await listIds(job.kind, job.trade, job.geohash, job.filters, box);
    } catch (err) {
      process.stderr.write(`  · ${job.kind}/${job.trade}/${job.geohash} 목록 실패: ${err.message}\n`);
    }
    scanned += 1;
    if (scanned % 25 === 0 || scanned === jobs.length) {
      process.stdout.write(`\r  목록 ${scanned}/${jobs.length}칸 · 후보 ${seen.size}건   `);
    }
    const fresh = ids.filter((id) => !seen.has(id));
    fresh.forEach((id) => seen.add(id));
    return fresh;
  });
  // 여러 칸이 같은 매물을 물고 오므로 마지막에 한 번 더 중복을 턴다.
  let ids = [...new Set(found.flat())];
  process.stdout.write(`\r  목록 ${jobs.length}/${jobs.length}칸 · 후보 ${ids.length}건   \n`);
  if (ids.length > config.maxItems) {
    console.log(`  후보 ${ids.length}건 중 ${config.maxItems}건까지만 가져온다 (maxItems 설정).`);
    ids = ids.slice(0, config.maxItems);
  }

  if (dryRun) {
    console.log(`조건에 맞는 매물 ${ids.length}건. (--dry-run 이라 상세는 받지 않았다. 요청 ${requestCount}회)`);
    return;
  }
  if (ids.length === 0) {
    console.log('조건에 맞는 매물이 없다. collect.config.json 의 가격·면적 범위를 넓혀 보자.');
    return;
  }

  // 2단계: 가격·면적·주소 같은 실제 내용은 상세 조회에서만 나온다.
  console.log(`  상세 ${ids.length}건 받는 중…`);
  const details = await fetchDetails(ids);
  const all = details.map(normalize).filter(Boolean);

  if (config.kinds.includes(APT)) {
    // 아파트는 지도 칸이 5자 이상이어야 해서 목록 수집과 정밀도를 따로 잡는다.
    const aptCells = coverBox(box, Math.max(config.geohashPrecision, 5));
    console.log(`  아파트 — geohash ${aptCells.length}칸`);
    const raw = await collectApartments(aptCells, box, (msg) => process.stdout.write(`\r  ${msg}      `));
    process.stdout.write('\n');
    const apts = raw.map(normalizeApt).filter(Boolean).filter((it) => matchesBudget(it, config));
    console.log(`  아파트 ${apts.length}건`);
    all.push(...apts);
  }
  all.sort((a, b) => String(b.regDate ?? '').localeCompare(String(a.regDate ?? '')));
  const items = dedupe(all);
  if (items.length < all.length) {
    console.log(`  같은 집을 여러 번 올린 것으로 보이는 ${all.length - items.length}건은 하나로 묶었다.`);
  }

  const payload = {
    collectedAt: new Date().toISOString(),
    source: '직방',
    // 경계 상자가 네모라서 옆 동네가 딸려 온다. '일대' 라고 해 두는 편이 사실에 가깝다.
    region: config.box ? '직접 지정한 범위' : `${label} 일대`,
    query: { kinds: config.kinds, trades: config.trades, areaMinM2: config.areaMinM2, areaMaxM2: config.areaMaxM2 },
    count: items.length,
    // 사이트가 id 로 링크·썸네일을 만들 때 쓰는 규칙
    urlTemplate: { 원룸: 'oneroom', 빌라: 'villa', 오피스텔: 'officetel' },
    items,
  };

  const outDir = path.join(HERE, 'data');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, 'listings.js'),
    `/* 수집 시각 ${payload.collectedAt} · ${payload.count}건 · collect.mjs 가 만든 파일이라 직접 고치지 않는다. */\n`
      + `window.__LISTINGS__ = ${JSON.stringify(payload)};\n`,
    'utf8',
  );

  console.log(`완료 — ${items.length}건을 data/listings.js 에 저장했다. (요청 ${requestCount}회)`);
}

main().catch((err) => {
  process.stderr.write(`\n수집 실패: ${err.message}\n`);
  process.exit(1);
});
