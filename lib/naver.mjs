/**
 * 네이버 부동산 — 이 파일만 직방·다방과 사정이 다르다.
 *
 * 네이버는 서버에서 직접 부르는 요청(curl·fetch)을 403 으로 막고,
 * 자동화 흔적이 보이는 브라우저도 404 로 돌려보낸다. 그래서 진짜 크롬을
 * Playwright 로 띄워 페이지 안에서 부르는 길밖에 없다. 즉 이 출처는
 * **네 맥북에서만** 돌아간다. 서버·클라우드에서는 실패하고, 실패해도
 * 나머지 출처 수집은 그대로 이어진다.
 *
 * 처음 한 번만:
 *     npm install playwright
 *   (크롬은 이미 깔려 있는 걸 쓴다. 따로 받지 않는다.)
 *
 * 쓰는 곳 (2026-08 기준으로 살아 있는 통로):
 *   GET  m.land.naver.com/map/getRegionList?cortarNo=…      법정동 코드 트리
 *   POST fin.land.naver.com/front-api/v1/article/legalDivisionArticleList
 *        법정동 단위 매물 목록 (가격·면적은 서버가 걸러 준다)
 */

import {
  APT, compact, counter, inside, sleep, splitAddress,
} from './common.mjs';

const REGION_URL = 'https://m.land.naver.com/map/getRegionList';
const ROOT_CORTAR = '0000000000';
const HOME_URL = 'https://fin.land.naver.com/home';
const ARTICLE_PATH = '/front-api/v1/article/legalDivisionArticleList';
const PAGE_SIZE = 30;

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const TRADE_CODE = { 매매: 'A1', 전세: 'B1', 월세: 'B2' };
const TRADE_NAME = { A1: '매매', B1: '전세', B2: '월세' };

/* 네이버가 쓰는 매물 유형 코드. 아파트·재건축·연립·다세대·빌라까지는 확인했고,
   오피스텔·원룸 코드는 확인하지 못해 기본값에서 빼 두었다. */
const TYPE_KIND = { A01: APT, A04: APT, A05: '빌라', A06: '빌라', C02: '빌라' };
const DEFAULT_TYPES = ['A01', 'A04', 'A05', 'A06', 'C02'];

/* ── 법정동 코드 ──────────────────────────────────────────
   시도 → 시군구 → 읍면동 순으로 내려가며, 찾는 상자에 들어오는 동만 남긴다.
   단계마다 중심 좌표가 같이 오므로 멀리 있는 가지는 펴 보지 않는다. */
async function regionChildren(cortarNo) {
  counter.requests += 1;
  const res = await fetch(`${REGION_URL}?cortarNo=${cortarNo}`, {
    headers: {
      'User-Agent': MOBILE_UA,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      Referer: 'https://m.land.naver.com/',
      'X-Requested-With': 'XMLHttpRequest',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`지역 목록 HTTP ${res.status}`);
  const data = await res.json();
  return (data.result?.list ?? []).map((r) => ({
    name: r.CortarNm,
    code: r.CortarNo,
    lat: Number(r.MapYCrdn),
    lng: Number(r.MapXCrdn),
  }));
}

const padded = (box, pad) => ({
  south: box.south - pad, north: box.north + pad, west: box.west - pad, east: box.east + pad,
});

async function findDongs(box, limit) {
  const dongs = [];
  // 시도·시군구는 중심 좌표만 보고 거르므로 경계 근처를 놓치지 않게 넉넉히 둔다.
  for (const sido of await regionChildren(ROOT_CORTAR)) {
    if (!inside([padded(box, 1.0)], sido.lat, sido.lng)) continue;
    for (const gu of await regionChildren(sido.code)) {
      if (!inside([padded(box, 0.25)], gu.lat, gu.lng)) continue;
      for (const dong of await regionChildren(gu.code)) {
        if (!inside(box.parts, dong.lat, dong.lng)) continue;
        dongs.push({ ...dong, sido: sido.name, gu: gu.name });
        if (dongs.length >= limit) return dongs;
      }
      await sleep(300);
    }
  }
  return dongs;
}

/* ── 브라우저 ─────────────────────────────────────────── */
const FETCH_IN_PAGE = async ({ path, body }) => {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
};

async function openBrowser() {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error(
      '네이버는 진짜 크롬이 필요하다. 이 폴더에서 `npm install playwright` 를 한 번 실행하면 된다.',
    );
  }
  const browser = await playwright.chromium.launch({
    channel: 'chrome',                                    // 설치돼 있는 구글 크롬을 쓴다
    headless: true,
    timeout: 180000,
    args: ['--disable-blink-features=AutomationControlled'],  // 이게 없으면 404 로 튕긴다
  });
  const context = await browser.newContext({
    userAgent: MOBILE_UA,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    locale: 'ko-KR',
  });
  const page = await context.newPage();
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);
  if (!page.url().includes('fin.land')) {
    throw new Error(`네이버가 접속을 막았다 (${page.url()}). 잠시 뒤 다시 해 보자.`);
  }
  return { browser, page };
}

/* ── 매물 ─────────────────────────────────────────────── */
function buildFilter(dongCode, tradeCode, types, config) {
  const won = (man) => (man == null ? undefined : man * 10000);
  const f = config.trades[TRADE_NAME[tradeCode]] ?? {};
  const filter = {
    tradeTypes: [tradeCode],
    realEstateTypes: types,
    legalDivisionNumbers: [dongCode],
    legalDivisionType: 'EUP',
    // 아래 빈 항목들은 네이버 필터 폼 그대로다. 빠지면 조건이 통째로 무시된다.
    roomCount: [], bathRoomCount: [], optionTypes: [], oneRoomShapeTypes: [],
    moveInTypes: [], floorTypes: [], directionTypes: [], parkingTypes: [], entranceTypes: [],
    filtersExclusiveSpace: true,
    hasArticlePhoto: false, isAuthorizedByOwner: false, hasArticle: false,
  };
  if (config.areaMinM2 != null || config.areaMaxM2 != null) {
    filter.space = { min: config.areaMinM2 ?? 0, max: config.areaMaxM2 ?? 999999 };
  }
  if (tradeCode === 'A1') {
    filter.dealPrice = { min: won(f.priceMin) ?? 0, max: won(f.priceMax) ?? 99999999999 };
  } else {
    filter.warrantyPrice = { min: won(f.depositMin) ?? 0, max: won(f.depositMax) ?? 99999999999 };
    if (tradeCode === 'B2') {
      filter.rentPrice = { min: won(f.rentMin) ?? 0, max: won(f.rentMax) ?? 99999999999 };
    }
  }
  return filter;
}

function normalize(item, dong) {
  const a = item.representativeArticleInfo ?? {};
  const price = a.priceInfo ?? {};
  const space = a.spaceInfo ?? {};
  const detail = a.articleDetail ?? {};
  const verify = a.verificationInfo ?? {};
  const coord = a.address?.coordinates ?? {};
  const trade = TRADE_NAME[a.tradeType];
  const lat = Number(coord.yCoordinate);
  const lng = Number(coord.xCoordinate);
  if (!trade || !lat || !lng) return null;

  const man = (won) => (won ? Math.round(won / 10000) : 0);
  // '5/15' 처럼 해당층/총층으로 온다. '저/15' 같이 뭉뚱그린 값도 있다.
  const [floor, buildingFloor] = String(detail.floorInfo ?? '').split('/');
  const addr = splitAddress(a.address?.legalDivisionName ?? '');

  return compact({
    id: `n${a.articleNumber}`,
    no: a.articleNumber,
    source: '네이버',
    kind: TYPE_KIND[a.realEstateType] ?? '빌라',
    trade,
    price: trade === '매매' ? man(price.dealPrice) : null,
    deposit: trade === '매매' ? null : man(price.warrantyPrice),
    rent: trade === '매매' ? null : man(price.rentPrice),
    manageCost: price.managementFeeAmount ?? null,     // 원
    areaM2: Number(space.supplySpace) || null,
    exclusiveM2: Number(space.exclusiveSpace ?? space.supplySpace) || null,
    floor: floor || null,
    buildingFloor: buildingFloor || null,
    danji: a.complexName ?? a.articleName ?? '',
    unit: a.dongName ?? '',
    title: (detail.articleFeatureDescription ?? '').trim(),
    address: [dong.gu, dong.name].filter(Boolean).join(' '),
    sido: addr.sido || dong.sido,
    gu: dong.gu,
    dong: dong.name,
    lat,
    lng,
    regDate: (verify.exposureStartDate ?? '').slice(0, 10) || null,
  });
}

/* ── 한 번에 모으기 ──────────────────────────────────────── */
export async function collect({ config, box, trades, log }) {
  const settings = config.naver ?? {};
  const types = settings.realEstateTypes ?? DEFAULT_TYPES;
  const maxPages = settings.maxPages ?? 40;
  const pause = settings.pauseMs ?? 700;   // 더 빨리 부르면 IP 가 막힌다

  log('네이버 법정동 목록 찾는 중…');
  const dongs = await findDongs(box, settings.maxDongs ?? 400);
  if (!dongs.length) throw new Error('찾는 범위 안에서 법정동을 못 찾았다.');
  console.log(`  네이버 — 법정동 ${dongs.length}곳`);

  const { browser, page } = await openBrowser();
  const seen = new Map();
  let done = 0;
  const total = dongs.length * trades.length;

  try {
    for (const dong of dongs) {
      for (const [trade] of trades) {
        const code = TRADE_CODE[trade];
        const body = {
          filter: buildFilter(dong.code, code, types, config),
          articlePagingRequest: {
            size: PAGE_SIZE, userChannelType: 'MOBILE', articleSortType: 'RANKING_DESC', lastInfo: [],
          },
        };
        for (let p = 0; p < maxPages; p += 1) {
          await sleep(pause);
          counter.requests += 1;
          const res = await page.evaluate(FETCH_IN_PAGE, { path: ARTICLE_PATH, body });
          if (res.status !== 200) {
            process.stderr.write(`  · 네이버 ${dong.name}/${trade} HTTP ${res.status}\n`);
            break;
          }
          const data = JSON.parse(res.text);
          if (!data.isSuccess) {
            process.stderr.write(`  · 네이버 ${dong.name}/${trade} 실패: ${res.text.slice(0, 120)}\n`);
            break;
          }
          for (const raw of data.result?.list ?? []) {
            const it = normalize(raw, dong);
            if (it && !seen.has(it.id) && inside(box.parts, it.lat, it.lng)) seen.set(it.id, it);
          }
          if (!data.result?.hasNextPage) break;
          body.articlePagingRequest.lastInfo = data.result.lastInfo ?? [];
          if (data.result.seed) body.articlePagingRequest.seed = data.result.seed;
        }
        log(`네이버 ${++done}/${total} · ${seen.size}건`);
        if (seen.size >= config.maxItems) break;
      }
      if (seen.size >= config.maxItems) break;
    }
  } finally {
    await browser.close().catch(() => {});
  }
  log('', true);
  return { items: [...seen.values()], requests: counter.requests };
}
