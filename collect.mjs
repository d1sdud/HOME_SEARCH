#!/usr/bin/env node
/**
 * 매물 수집기 — 직방·다방·네이버에 올라온 매물을 한데 모아
 * data/listings.js 파일 하나로 저장한다.
 *
 *   node collect.mjs                       # collect.config.json 설정대로
 *   node collect.mjs --region 수원          # 설정 일부만 덮어쓰기
 *   node collect.mjs --only 직방,다방        # 출처 골라서
 *   node collect.mjs --skip 네이버           # 출처 빼고
 *   node collect.mjs --dry-run             # 몇 건 잡히는지만 세어 보기
 *
 * 직방·다방은 Node 18 이상이면 그냥 돌아간다(설치할 것 없음).
 * 네이버만 진짜 크롬이 필요하다 — lib/naver.mjs 맨 위 설명을 보자.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APT, REGIONS, boundsOf, coverBox, counter, matchesBudget,
} from './lib/common.mjs';
import * as zigbang from './lib/zigbang.mjs';
import * as dabang from './lib/dabang.mjs';
import * as naver from './lib/naver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SOURCES = {
  직방: { mod: zigbang, precision: (p) => p },
  // 다방·네이버는 한 번에 받는 범위가 좁아서 지도 칸을 더 잘게 쪼갠다.
  다방: { mod: dabang, precision: (p) => Math.max(p, 5) },
  네이버: { mod: naver, precision: (p) => Math.max(p, 5) },
};

const DEFAULT_CONFIG = {
  sources: ['직방', '다방'],
  regions: ['수원'],
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
  realPriceCount: 6,
};

/* ── 설정 ─────────────────────────────────────────────────── */
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

const listArg = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);

async function loadConfig(args) {
  const file = path.join(HERE, 'collect.config.json');
  let config = { ...DEFAULT_CONFIG };
  try {
    config = { ...config, ...JSON.parse(await fs.readFile(file, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    process.stderr.write('collect.config.json 이 없어 기본 설정으로 수집한다.\n');
  }
  if (args.region) config.regions = listArg(args.region);
  if (args.kinds) config.kinds = listArg(args.kinds);
  if (args.only) config.sources = listArg(args.only);
  if (args.skip) config.sources = config.sources.filter((s) => !listArg(args.skip).includes(s));
  if (args.precision) config.geohashPrecision = Number(args.precision);
  if (args['max-items']) config.maxItems = Number(args['max-items']);
  if (args.bbox) {
    const [south, west, north, east] = String(args.bbox).split(',').map(Number);
    config.box = { south, west, north, east };
  }
  const unknown = config.sources.filter((s) => !SOURCES[s]);
  if (unknown.length) throw new Error(`모르는 출처: ${unknown.join(', ')} (쓸 수 있는 값: ${Object.keys(SOURCES).join(', ')})`);
  return config;
}

/* ── 중복 정리 ─────────────────────────────────────────────
   같은 집이 한 사이트 안에서도 여러 번 올라오고, 사이트끼리도 겹친다.
   조건(거래·가격·면적·층)이 같으면서 좌표가 붙어 있거나 단지 이름이 같으면
   한 건으로 묶고, 어디어디에 올라와 있었는지만 남긴다. */
const plainName = (s) => String(s ?? '').replace(/[\s()·]/g, '').replace(/\(.*?\)/g, '');

function dupKeys(it) {
  const shape = [
    it.trade, it.deposit ?? '', it.rent ?? '', it.price ?? '',
    Math.round((it.exclusiveM2 ?? it.areaM2 ?? 0) * 10), it.floor ?? '',
  ].join('|');
  // 다방은 좌표를 일부러 흩어 놓으므로 소수점 3자리(약 100m)까지만 본다.
  const keys = [`좌표|${shape}|${it.lat.toFixed(3)}|${it.lng.toFixed(3)}`];
  if (it.danji) keys.push(`단지|${shape}|${plainName(it.danji)}`);
  return keys;
}

/** 좌표가 정확하고 정보가 많은 쪽을 대표로 남긴다. */
const quality = (it) => (it.fuzzy ? 0 : 4) + (it.manageCost != null ? 2 : 0) + (it.danji ? 1 : 0);

function mergeAll(items) {
  const byKey = new Map();
  const kept = [];
  for (const it of items) {
    const keys = dupKeys(it);
    const hit = keys.map((k) => byKey.get(k)).find(Boolean);
    if (!hit) {
      const box = { item: it, sources: new Set([it.source]), dupes: 1 };
      kept.push(box);
      for (const k of keys) byKey.set(k, box);
      continue;
    }
    hit.dupes += 1;
    hit.sources.add(it.source);
    if (quality(it) > quality(hit.item)) hit.item = it;
    for (const k of keys) if (!byKey.has(k)) byKey.set(k, hit);
  }
  return kept.map(({ item, sources, dupes }) => {
    const others = [...sources].filter((s) => s !== item.source);
    return { ...item, ...(dupes > 1 ? { dupes } : {}), ...(others.length ? { also: others } : {}) };
  });
}

/* ── 실행 ─────────────────────────────────────────────────── */
function progress(prefix) {
  return (msg, done = false) => {
    if (done) { process.stdout.write('\n'); return; }
    process.stdout.write(`\r  ${prefix}${msg}      `);
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args);
  const dryRun = Boolean(args['dry-run']);

  const names = config.box ? [] : config.regions;
  const boxes = config.box ? [config.box] : names.map((name) => {
    const found = REGIONS[name];
    if (!found) throw new Error(`'${name}' 은 모르는 지역이다. 쓸 수 있는 값: ${Object.keys(REGIONS).join(', ')} (또는 --bbox 남,서,북,동)`);
    return found;
  });
  const box = boundsOf(boxes);
  const trades = Object.entries(config.trades).filter(([, v]) => v && v !== false);
  const label = config.box ? '직접 지정' : names.join('+');

  console.log(`지역 ${label} · ${config.kinds.join('/')} · ${trades.map(([t]) => t).join('/')}`);
  console.log(`출처 ${config.sources.join(', ')}`);

  const all = [];
  const danjiPrices = {};
  const report = [];

  for (const name of config.sources) {
    const { mod, precision } = SOURCES[name];
    const depth = precision(config.geohashPrecision);
    const cells = [...new Set(boxes.flatMap((b) => coverBox(b, depth)))].sort();
    // 직방 아파트는 단지 목록 API 가 geohash 5자 이상을 요구해서 따로 더 잘게 쪼갠다.
    const aptCells = depth >= 5 ? cells : [...new Set(boxes.flatMap((b) => coverBox(b, 5)))].sort();
    const before = counter.requests;
    console.log(`\n[${name}] 지도 ${cells.length}칸`);
    try {
      const got = await mod.collect({ config, box, cells, aptCells, trades, log: progress(`${name} — `) });
      const fresh = got.items.filter((it) => config.kinds.includes(it.kind)).filter((it) => matchesBudget(it, config));
      all.push(...fresh);
      Object.assign(danjiPrices, got.danjiPrices ?? {});
      report.push({ name, count: fresh.length, requests: counter.requests - before });
      console.log(`  ${name} ${fresh.length}건 (요청 ${counter.requests - before}회)`);
    } catch (err) {
      process.stdout.write('\n');
      console.log(`  ${name} 건너뜀 — ${err.message}`);
      report.push({ name, count: 0, requests: counter.requests - before, error: err.message });
    }
  }

  if (dryRun) {
    console.log(`\n조건에 맞는 매물 ${all.length}건. (--dry-run 이라 파일은 만들지 않았다. 요청 ${counter.requests}회)`);
    return;
  }
  if (!all.length) {
    console.log('\n조건에 맞는 매물이 없다. collect.config.json 의 가격·면적 범위를 넓혀 보자.');
    return;
  }

  all.sort((a, b) => String(b.regDate ?? '').localeCompare(String(a.regDate ?? '')));
  const items = mergeAll(all);
  if (items.length < all.length) {
    console.log(`\n같은 집으로 보이는 ${all.length - items.length}건은 하나로 묶었다.`);
  }
  const shared = items.filter((it) => it.also?.length).length;
  if (shared) console.log(`그중 ${shared}건은 두 곳 이상에 함께 올라와 있다.`);

  // 매물이 남지 않은 단지의 실거래가는 들고 있을 이유가 없다.
  const usedDanjis = new Set(items.map((it) => it.danjiKey).filter(Boolean));
  const prices = Object.fromEntries(Object.entries(danjiPrices).filter(([k]) => usedDanjis.has(k)));

  const payload = {
    collectedAt: new Date().toISOString(),
    sources: report.filter((r) => r.count > 0).map((r) => r.name),
    sourceReport: report,
    // 경계 상자가 네모라서 옆 동네가 딸려 온다. '일대' 라고 해 두는 편이 사실에 가깝다.
    region: config.box ? '직접 지정한 범위' : `${label} 일대`,
    query: { kinds: config.kinds, trades: config.trades, areaMinM2: config.areaMinM2, areaMaxM2: config.areaMaxM2 },
    count: items.length,
    // 사이트가 id 로 링크·썸네일을 만들 때 쓰는 규칙
    urlTemplate: { 원룸: 'oneroom', 빌라: 'villa', 오피스텔: 'officetel' },
    danjiPrices: prices,
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

  console.log(`\n완료 — ${items.length}건을 data/listings.js 에 저장했다. (요청 ${counter.requests}회)`);
}

main().catch((err) => {
  process.stderr.write(`\n수집 실패: ${err.message}\n`);
  process.exit(1);
});
