/**
 * 다방 — 지도 한 칸씩 매물 목록을 넘겨 받는다.
 *
 * 카테고리(one-two / house-villa / officetel / apt)는 '방 구조' 기준이라
 * 서로 많이 겹친다. 네 개를 다 훑고 매물 번호로 중복을 턴다.
 * 좌표는 다방이 일부러 살짝 흩어 놓은 값(randomLocation)이라 정확한 위치가 아니다.
 */

import {
  APT, compact, counter, geohashBounds, inside, mapPool, overlaps,
  parseKoreanMoney, request, splitAddress,
} from './common.mjs';

const API = 'https://www.dabangapp.com/api/v5';

/* 다방 웹이 붙이는 헤더. 이게 없으면 모든 요청이 400 으로 떨어진다. */
const HEADERS = {
  Referer: 'https://www.dabangapp.com/',
  csrf: 'token',
  'D-Api-Version': '5.0.0',
  'D-App-Version': '1',
  'D-Call-Type': 'web',
};

const CATEGORIES = ['one-two', 'house-villa', 'officetel', 'apt'];
const PAGE_SIZE = 24;   // 서버가 정해 둔 값이라 바꿀 수 없다
const SELLING = { 전세: 'LEASE', 월세: 'MONTHLY_RENT', 매매: 'SELL' };
const M2_PER_PYEONG = 3.305785;

const range = (min, max) => ({ min: min ?? 0, max: max ?? 999999 });

async function call(path, params) {
  const q = new URLSearchParams(params);
  const data = await request(`${API}/${path}?${q}`, { headers: HEADERS });
  if (data.code !== 200) throw new Error(`다방 ${data.code}: ${data.msg ?? ''}`);
  return data.result;
}

/* 카테고리마다 서버가 요구하는 필터 항목이 다르다. 하나라도 빠지면 400 이 온다.
   (빠뜨린 항목을 오류 메시지가 그대로 알려 준다.) */
function buildFilter(category, config, trades) {
  const names = trades.map(([t]) => t);
  const deposits = names.filter((t) => t !== '매매').map((t) => config.trades[t]);
  const monthly = config.trades['월세'];
  const sale = config.trades['매매'];

  const base = {
    sellingTypeList: names.map((t) => SELLING[t]).filter(Boolean),
    depositRange: range(
      Math.min(...deposits.map((f) => f?.depositMin ?? 0), 0),
      deposits.length ? Math.max(...deposits.map((f) => f?.depositMax ?? 999999)) : 999999,
    ),
    priceRange: range(monthly?.rentMin, monthly?.rentMax),
    isIncludeMaintenance: false,
    // 다방이 평 기준 어느 면적을 쓰는지가 분명치 않아 넉넉하게 잡고,
    // 정확한 면적 조건은 받은 뒤에 matchesBudget 이 맞춘다.
    pyeongRange: range(
      config.areaMinM2 ? Math.floor(config.areaMinM2 / M2_PER_PYEONG) : 0,
      config.areaMaxM2 ? Math.ceil(config.areaMaxM2 / M2_PER_PYEONG) : 999999,
    ),
    useApprovalDateRange: range(),
    isShortLease: false,
  };
  const floors = ['GROUND_FIRST', 'GROUND_SECOND_OVER', 'SEMI_BASEMENT', 'ROOFTOP'];
  const rooms = ['ONE_ROOM', 'TWO_ROOM', 'THREE_ROOM', 'FOUR_ROOM'];
  const trade = { tradeRange: range(sale?.priceMin, sale?.priceMax) };
  const common = { canParking: false, hasElevator: false, hasPano: false };

  if (category === 'one-two') {
    // 원룸·투룸에는 매매가 없다. 보내면 400 이 떨어진다.
    return {
      ...base,
      sellingTypeList: base.sellingTypeList.filter((s) => s !== 'SELL'),
      roomFloorList: floors,
      roomTypeList: ['ONE_ROOM', 'TWO_ROOM'],
      ...common,
      isDivision: false,
      isDuplex: false,
    };
  }
  if (category === 'house-villa') {
    return { ...base, ...trade, roomFloorList: floors, ...common, roomCountList: rooms };
  }
  if (category === 'officetel') {
    return { ...base, ...trade, parkingNumRange: range(), ...common, roomCountList: rooms };
  }
  return {
    ...base, ...trade, householdNumRange: range(), parkingNumRange: range(),
    isShortLease: false, hasTakeTenant: false, roomCountList: rooms,
  };
}

/* ── 주소 ─────────────────────────────────────────────────
   매물에는 동 이름과 지역 번호(gid)만 실려 온다. 시·구는 지역 API 로 한 번만 받아 둔다. */
const regionCache = new Map();

async function regionOf(gid) {
  if (!regionCache.has(gid)) {
    regionCache.set(gid, (async () => {
      try {
        const r = await call(`region/${gid}`, {});
        return splitAddress(r.fullName ?? '');
      } catch {
        return { sido: '', gu: '', dong: '' };
      }
    })());
  }
  return regionCache.get(gid);
}

/* ── 정규화 ──────────────────────────────────────────────
   목록이 주는 건 사람이 읽는 문장이다. '8층, 35.94m², 관리비 10만' 같은 식이라
   여기서 숫자로 되돌린다. 층은 '중층'처럼 뭉뚱그린 값도 온다. */
const VAGUE_FLOOR = { 고층: '고', 중층: '중', 저층: '저' };

function parseDesc(desc) {
  const parts = String(desc ?? '').split(',').map((s) => s.trim());
  const out = { floor: null, areaM2: null, manageCost: null };

  const floor = parts[0] ?? '';
  if (VAGUE_FLOOR[floor]) out.floor = VAGUE_FLOOR[floor];
  else if (/^-?\d+층$/.test(floor)) out.floor = floor.replace('층', '');
  else if (floor) out.floor = floor;   // 반지층·옥탑 등은 그대로 보여 준다

  const area = parts.find((p) => /m²/.test(p));
  if (area) out.areaM2 = Number(area.replace(/[^\d.]/g, '')) || null;

  const cost = parts.find((p) => p.startsWith('관리비'));
  if (cost) out.manageCost = /없음/.test(cost) ? 0 : parseKoreanMoney(cost.replace('관리비', '')) * 10000;

  return out;
}

/** '1억4000' / '500/65' / '1억9000/35' → 보증금·월세(만원). */
function parsePrice(trade, title) {
  const [left, right] = String(title ?? '').split('/');
  const first = parseKoreanMoney(left);
  if (trade === '매매') return { price: first, deposit: null, rent: null };
  return { price: null, deposit: first, rent: right ? parseKoreanMoney(right) : 0 };
}

/** 다방의 건물 유형 → 이 사이트가 쓰는 종류. '• 단기' 가 붙어 오기도 한다. */
function kindOf(roomTypeName) {
  const name = String(roomTypeName ?? '').split('•')[0].trim();
  if (name.includes('아파트')) return APT;
  if (name.includes('오피스텔')) return '오피스텔';
  if (name.includes('원룸')) return '원룸';
  return '빌라';   // 투룸·쓰리룸·포룸
}

async function normalize(raw) {
  const loc = raw.randomLocation ?? {};
  if (!loc.lat || !loc.lng) return null;
  const trade = raw.priceTypeName;
  if (!['전세', '월세', '매매'].includes(trade)) return null;

  const { floor, areaM2, manageCost } = parseDesc(raw.roomDesc);
  const money = parsePrice(trade, raw.priceTitle);
  const region = await regionOf(raw.gid);
  const dong = raw.dongName || region.dong;
  const short = /단기/.test(raw.roomTypeName ?? '');

  return compact({
    id: `d${raw.id}`,
    no: raw.id,
    source: '다방',
    kind: kindOf(raw.roomTypeName),
    trade,
    ...money,
    manageCost,
    // 다방은 면적을 하나만 준다. 표본을 맞춰 보면 전용면적 쪽이라 그렇게 둔다.
    exclusiveM2: areaM2,
    floor,
    danji: raw.complexName ?? '',
    title: (raw.roomTitle ?? '').trim(),
    address: [region.gu, dong].filter(Boolean).join(' '),
    sido: region.sido,
    gu: region.gu,
    dong,
    lat: loc.lat,
    lng: loc.lng,
    thumb: raw.imgUrlList?.[0] ?? null,
    tags: short ? ['단기임대'] : null,
    // 좌표를 일부러 흩어 놓은 출처라는 표시. 사이트가 '대략 위치' 라고 알려 준다.
    fuzzy: 1,
  });
}

/* ── 한 번에 모으기 ──────────────────────────────────────── */
export async function collect({ config, box, cells, trades, log }) {
  const maxPages = config.dabang?.maxPages ?? 60;
  const jobs = [];
  for (const hash of cells) {
    const bounds = geohashBounds(hash);
    if (!box.parts.some((p) => overlaps(bounds, p))) continue;
    const bbox = {
      sw: { lat: Math.max(bounds.south, box.south), lng: Math.max(bounds.west, box.west) },
      ne: { lat: Math.min(bounds.north, box.north), lng: Math.min(bounds.east, box.east) },
    };
    for (const category of CATEGORIES) jobs.push({ category, bbox });
  }

  const seen = new Map();
  let done = 0;
  await mapPool(jobs, 2, async (job) => {
    const filters = JSON.stringify(buildFilter(job.category, config, trades));
    const bbox = JSON.stringify(job.bbox);
    for (let page = 1; page <= maxPages; page += 1) {
      let result;
      try {
        result = await call(`room-list/category/${job.category}/bbox`, {
          filters, bbox, zoom: '15', useMap: 'naver', page: String(page),
        });
      } catch (err) {
        process.stderr.write(`  · 다방 ${job.category} ${page}쪽 실패: ${err.message}\n`);
        break;
      }
      const list = result.roomList ?? [];
      for (const raw of list) if (!seen.has(raw.id)) seen.set(raw.id, raw);
      if (list.length < PAGE_SIZE || page * PAGE_SIZE >= (result.total ?? 0)) break;
      if (seen.size >= config.maxItems) break;
    }
    log(`다방 ${++done}/${jobs.length}칸 · ${seen.size}건`);
  }, 200);
  log('', true);

  const items = [];
  for (const raw of seen.values()) {
    const it = await normalize(raw);
    // 좌표를 흩어 놓기 때문에 칸 경계 바로 밖으로 밀려난 매물이 생긴다. 여기서 정리한다.
    if (it && inside(box.parts, it.lat, it.lng)) items.push(it);
  }
  return { items, requests: counter.requests };
}
