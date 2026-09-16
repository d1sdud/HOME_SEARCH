/**
 * 직방 — 원룸·빌라·오피스텔은 매물 번호로, 아파트는 단지를 거쳐 받는다.
 * 아파트 단지는 국토부 실거래가도 같이 내려 주므로 여기서 함께 모은다.
 */

import crypto from 'node:crypto';
import {
  APT, compact, counter, inside, mapPool, matchesBudget, request, toNumber,
} from './common.mjs';

const API = 'https://apis.zigbang.com';
const HEADERS = { Referer: 'https://www.zigbang.com/' };
const APT_HEADERS = { ...HEADERS, ZigbangOsType: 'web' };

const KIND_PATHS = { 원룸: 'onerooms', 빌라: 'villas', 오피스텔: 'officetels' };

/** 직방에 원룸 매매는 아예 없다. 요청하면 400이 떨어지므로 미리 걸러 둔다. */
const UNSUPPORTED = new Set(['원룸/매매']);

const call = (url, options = {}) => request(url, { ...options, headers: { ...HEADERS, ...options.headers } });

/* ── 원룸·빌라·오피스텔 ──────────────────────────────────── */
function buildListQuery(geohash, trade, filters) {
  const q = new URLSearchParams({ geohash, domain: 'zigbang', checkAnyItemWithoutFilter: 'false' });
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

async function listIds(kind, trade, geohash, filters, box) {
  const q = buildListQuery(geohash, trade, filters);
  const data = await call(`${API}/house/property/v1/items/${KIND_PATHS[kind]}?${q}`);
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
      const data = await call(`${API}/house/property/v1/items/list`, {
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

function normalizeRoom(raw) {
  const trade = raw.sales_type;
  const deposit = toNumber(raw.deposit);   // 만원
  const rent = toNumber(raw.rent);         // 만원
  const loc = raw.location ?? raw.random_location ?? {};
  if (!loc.lat || !loc.lng) return null;

  const kind = raw.service_type in KIND_PATHS ? raw.service_type : '빌라';
  const addr = raw.addressOrigin ?? {};
  const exclusive = raw['전용면적']?.m2 ?? raw.size_m2;

  // 썸네일과 매물 링크는 id 로 그대로 만들 수 있어서 저장하지 않는다 (파일 크기가 30%쯤 준다).
  return compact({
    // 아파트 매물 번호와 겹칠 수 있어 종류를 앞에 붙여 둔다. no 는 링크·사진용 원번호.
    id: `r${raw.item_id}`,
    no: raw.item_id,
    source: '직방',
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

/** 지도 한 칸 안의 아파트 단지. 단지 목록 API 는 geohash 가 5자 이상이어야 한다. */
async function listDanjis(geohash, box) {
  const q = new URLSearchParams({
    geohash: encryptGeohash(geohash),
    minPynArea: '10평이하',
    maxPynArea: '60평대이상',
  });
  const data = await call(`${API}/apt/locals/prices/on-danjis?${q}`, { headers: APT_HEADERS });
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
  const data = await call(`${API}/apt/danjis/${danji.id}/items?${q}`, { headers: APT_HEADERS });
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
        const top = await call(`${API}/apt/locals/local1`, { headers: APT_HEADERS });
        const code = (top.results ?? []).find((r) => r.name === sido)?.code;
        if (!code) return [];
        const sub = await call(`${API}/apt/locals/local2?code=${code}`, { headers: APT_HEADERS });
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
    source: '직방',
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
    danjiKey: `z${danji.id}`,
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

/* ── 실거래가 ─────────────────────────────────────────────
   직방이 국토부 실거래 신고 자료를 단지별로 중계한다. 키가 필요 없고
   매물과 같은 단지 번호를 쓰기 때문에 호가와 나란히 놓고 볼 수 있다. */
const RT_TRADE = { sales: '매매', charter: '전세', rent: '월세', rental: '월세' };

/** '26. 9. 11' → '2026-09-11'. 실패하면 원문을 그대로 둔다. */
function rtDate(text) {
  const m = String(text ?? '').match(/(\d{2})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
  if (!m) return String(text ?? '');
  return `20${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

async function danjiRealPrices(danjiId, limit) {
  const q = new URLSearchParams({ dealType: 'all', offset: '0', limit: String(limit) });
  const data = await call(`${API}/apt/danjis/${danjiId}/rt-prices?${q}`, { headers: APT_HEADERS });
  return (data.data ?? []).map((d) => compact({
    d: rtDate(d.rtDealDate),
    t: RT_TRADE[d.rtDealType] ?? d.rtDealType,
    p: d.rtPrice ?? null,              // 만원. 월세면 보증금
    r: d.rtPriceRent ?? d.rtRent ?? null,   // 월세 (월세 거래일 때만)
    a: Number(d.rtArea) || null,       // 전용면적 m²
    f: d.rtFloor ?? null,
  })).filter((d) => d.p != null);
}

/* ── 한 번에 모으기 ──────────────────────────────────────── */
export async function collect({ config, box, cells, aptCells = cells, trades, log }) {
  const items = [];
  const danjiPrices = {};

  const kinds = config.kinds.filter((k) => k !== APT);
  if (kinds.length) {
    const jobs = [];
    for (const kind of kinds) {
      for (const [trade, tradeFilters] of trades) {
        if (UNSUPPORTED.has(`${kind}/${trade}`)) continue;
        for (const geohash of cells) {
          jobs.push({
            kind, trade, geohash,
            filters: { ...tradeFilters, areaMinM2: config.areaMinM2, areaMaxM2: config.areaMaxM2 },
          });
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
      if (scanned % 25 === 0 || scanned === jobs.length) log(`목록 ${scanned}/${jobs.length} · 후보 ${seen.size}건`);
      const fresh = ids.filter((id) => !seen.has(id));
      fresh.forEach((id) => seen.add(id));
      return fresh;
    });

    // 여러 칸이 같은 매물을 물고 오므로 마지막에 한 번 더 중복을 턴다.
    let ids = [...new Set(found.flat())];
    log(`목록 ${jobs.length}/${jobs.length} · 후보 ${ids.length}건`, true);
    if (ids.length > config.maxItems) {
      console.log(`  후보 ${ids.length}건 중 ${config.maxItems}건까지만 가져온다 (maxItems 설정).`);
      ids = ids.slice(0, config.maxItems);
    }
    if (ids.length) {
      console.log(`  상세 ${ids.length}건 받는 중…`);
      items.push(...(await fetchDetails(ids)).map(normalizeRoom).filter(Boolean));
    }
  }

  if (config.kinds.includes(APT)) {
    const danjis = new Map();
    let scanned = 0;
    await mapPool(aptCells, 3, async (geohash) => {
      try {
        for (const d of await listDanjis(geohash, box)) danjis.set(d.id, d);
      } catch (err) {
        process.stderr.write(`  · 아파트 단지/${geohash} 실패: ${err.message}\n`);
      }
      log(`단지 ${++scanned}/${aptCells.length}칸 · ${danjis.size}개`);
    });

    const all = [...danjis.values()];
    for (const d of all) d.guFull = await fullGuName(d.sido, d.gugun);

    let done = 0;
    const pages = await mapPool(all, 3, async (danji) => {
      try {
        return await listDanjiItems(danji);
      } catch {
        return [];
      } finally {
        log(`아파트 매물 ${++done}/${all.length}단지`);
      }
    });
    log('', true);
    const apts = pages.flat().map(normalizeApt).filter(Boolean);
    items.push(...apts);

    // 실거래가는 매물이 실제로 붙은 단지만 받는다. 요청 수를 아끼고 파일도 가벼워진다.
    const rtLimit = config.realPriceCount ?? 0;
    if (rtLimit > 0) {
      // 예산·면적에 맞는 매물이 남은 단지만 받는다. 단지 수가 크게 줄어 수집이 빨라진다.
      const wanted = [...new Set(apts.filter((it) => matchesBudget(it, config)).map((it) => it.danjiKey))]
        .map((k) => k.slice(1));
      let rt = 0;
      await mapPool(wanted, 3, async (id) => {
        try {
          const rows = await danjiRealPrices(id, rtLimit);
          if (rows.length) danjiPrices[`z${id}`] = rows;
        } catch {
          /* 실거래가는 없으면 없는 대로 둔다. 매물 수집을 막을 이유가 없다. */
        }
        log(`실거래가 ${++rt}/${wanted.length}단지`);
      });
      log('', true);
    }
  }

  return { items, danjiPrices, requests: counter.requests };
}
