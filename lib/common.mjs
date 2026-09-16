/**
 * 수집기 공용 도구 — HTTP, geohash, 경계 상자, 값 정리.
 * 출처별 모듈(zigbang / dabang / naver)이 모두 여기에 기댄다.
 */

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ── 지역 프리셋 ───────────────────────────────────────────────
   대략적인 경계 상자다. 넓게 긁은 뒤 사이트에서 구·동 단위로 좁히는 편이
   요청 수도 적고 다시 수집할 일도 줄어든다. */
export const REGIONS = {
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

/** 아파트는 어느 출처에서든 통로가 달라서 종류 이름을 상수로 둔다. */
export const APT = '아파트';

/* ── geohash ──────────────────────────────────────────────────
   직방 목록 API는 좌표가 아니라 geohash 한 칸을 받는다.
   그래서 경계 상자를 geohash 칸으로 잘라서 칸마다 훑는다.
   한 칸에 걸린 매물은 개수 제한 없이 다 내려온다(정밀도 4 한 칸 = 하위 5 칸 32개의 합).
   다방은 칸 대신 칸의 네 모서리를 경계 상자로 바꿔서 쓴다. */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohashEncode(lat, lng, precision) {
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

/** geohash 한 칸이 덮는 범위. 칸 단위로 다른 API 를 훑을 때 쓴다. */
export function geohashBounds(hash) {
  let evenBit = true;
  let [latMin, latMax, lngMin, lngMax] = [-90, 90, -180, 180];
  for (const ch of hash) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error(`geohash 가 아니다: ${hash}`);
    for (let n = 4; n >= 0; n -= 1) {
      const bit = (idx >> n) & 1;
      if (evenBit) {
        const mid = (lngMin + lngMax) / 2;
        if (bit) lngMin = mid; else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit) latMin = mid; else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }
  return { south: latMin, north: latMax, west: lngMin, east: lngMax };
}

/** geohash 한 칸의 위도/경도 크기. 짝수 번째 비트가 경도로 간다. */
export function cellSize(precision) {
  const bits = precision * 5;
  const lngBits = Math.ceil(bits / 2);
  const latBits = Math.floor(bits / 2);
  return { lat: 180 / 2 ** latBits, lng: 360 / 2 ** lngBits };
}

export function coverBox(box, precision) {
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

/** 지역 상자들 중 하나에라도 들어오면 통과. 훑는 칸은 찾는 범위보다 넓다. */
export const inside = (boxes, lat, lng) =>
  boxes.some((b) => lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east);

export const boundsOf = (boxes) => ({
  south: Math.min(...boxes.map((b) => b.south)),
  north: Math.max(...boxes.map((b) => b.north)),
  west: Math.min(...boxes.map((b) => b.west)),
  east: Math.max(...boxes.map((b) => b.east)),
  parts: boxes,
});

/** 두 상자가 겹치는지. 칸 단위로 훑을 때 헛된 요청을 줄인다. */
export const overlaps = (a, b) =>
  a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;

/* ── HTTP ─────────────────────────────────────────────────── */
export const counter = { requests: 0 };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function request(url, options = {}, attempt = 1) {
  counter.requests += 1;
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(options.timeout ?? 20000),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text()).slice(0, 160)}`);
    return await res.json();
  } catch (err) {
    if (attempt >= (options.retries ?? 4)) throw err;
    await sleep(600 * 2 ** (attempt - 1));
    return request(url, options, attempt + 1);
  }
}

/** 동시 실행 수를 제한해 순서대로 처리한다. 상대 서버에 대한 예의이자 차단 회피. */
export async function mapPool(items, limit, worker, pause = 120) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
      await sleep(pause);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ── 값 정리 ─────────────────────────────────────────────── */
export const toNumber = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** '1억4000' · '3억' · '9500' → 만원 단위 숫자. 다방·네이버가 이런 문자열을 준다. */
export function parseKoreanMoney(text) {
  const t = String(text ?? '').replace(/[\s,]/g, '');
  if (!t) return 0;
  const m = t.match(/^(?:(\d+)억)?(\d+)?/);
  if (!m || (!m[1] && !m[2])) return 0;
  return Number(m[1] ?? 0) * 10000 + Number(m[2] ?? 0);
}

/** null·빈 값은 아예 빼서 저장한다. 사이트에서는 없는 값으로 읽힌다. */
export function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(6)) : v;
  }
  return out;
}

/** '경기도 수원시 팔달구 인계동' → 시도·구·동. 다방·네이버는 주소를 한 줄로 준다. */
export function splitAddress(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { sido: parts[0] ?? '', gu: '', dong: '' };
  const [sido] = parts;
  const dong = parts[parts.length - 1];
  return { sido, gu: parts.slice(1, -1).join(' '), dong };
}

/** 아파트처럼 서버가 안 걸러 주는 출처는 여기서 예산·면적 조건을 맞춘다. */
export function matchesBudget(it, config) {
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
