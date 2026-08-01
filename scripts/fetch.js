#!/usr/bin/env node
/**
 * 네이버 금융 공개 JSON 엔드포인트에서 국내 주식 시세를 모아
 * public/data/{market,stocks}.json 으로 굽는다.
 *
 * GitHub Actions(서버)에서 돌기 때문에 브라우저 CORS 제약을 받지 않는다.
 * 정적 페이지는 여기서 만든 JSON만 읽는다.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://m.stock.naver.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(600 * 2 ** i);
    }
  }
  throw new Error(`요청 실패 (${tries}회 시도): ${url} — ${lastErr.message}`);
}

/** "12,345" | 12345 | null -> 숫자 (파싱 불가 시 null) */
const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const MARKETS = ['KOSPI', 'KOSDAQ'];
const TYPE_CODE = { stock: 0, etf: 1, etn: 2 };

/** 한 시장의 전 종목을 시가총액 순으로 훑어 가져온다 (ETF·ETN 포함) */
async function fetchMarket(market) {
  const rows = [];
  for (let page = 1; page <= 60; page++) {
    const j = await getJSON(
      `https://m.stock.naver.com/api/stocks/marketValue/${market}?page=${page}&pageSize=100`,
    );
    const list = j.stocks ?? [];
    rows.push(...list);
    if (list.length < 100) break;
    await sleep(120); // 예의상 간격
  }
  return rows.map((s) => {
    const rate = num(s.fluctuationsRatio) ?? 0;
    // 등락 부호는 fluctuationsRatio 가 이미 갖고 있고, 전일대비 절대값에 그 부호를 씌운다
    const absChg = num(s.compareToPreviousClosePriceRaw ?? s.compareToPreviousClosePrice) ?? 0;
    return [
      s.itemCode,                                        // 0 종목코드
      s.stockName,                                       // 1 종목명
      MARKETS.indexOf(market),                           // 2 시장 (0=코스피, 1=코스닥)
      TYPE_CODE[s.stockEndType] ?? 0,                    // 3 종류 (0=종목, 1=ETF, 2=ETN)
      num(s.closePriceRaw ?? s.closePrice) ?? 0,         // 4 현재가 (원)
      rate < 0 ? -Math.abs(absChg) : Math.abs(absChg),   // 5 전일대비 (원)
      rate,                                              // 6 등락률 (%)
      num(s.accumulatedTradingVolumeRaw ?? s.accumulatedTradingVolume) ?? 0, // 7 거래량 (주)
      // Raw 필드는 원 단위, 표시용 문자열은 각각 백만원/억원 단위라 폴백에서 환산한다
      num(s.accumulatedTradingValueRaw) ?? (num(s.accumulatedTradingValue) ?? 0) * 1e6, // 8 거래대금 (원)
      num(s.marketValueRaw) ?? (num(s.marketValue) ?? 0) * 1e8,              // 9 시가총액 (원)
    ];
  });
}

async function fetchIndices() {
  const codes = [
    ['KOSPI', '코스피'],
    ['KOSDAQ', '코스닥'],
    ['KPI200', '코스피 200'],
  ];
  const out = [];
  for (const [code, label] of codes) {
    const j = await getJSON(`https://m.stock.naver.com/api/index/${code}/basic`);
    const rate = num(j.fluctuationsRatio) ?? 0;
    const absChg = Math.abs(num(j.compareToPreviousClosePrice) ?? 0);
    out.push({
      code,
      name: label,
      close: num(j.closePrice),
      change: rate < 0 ? -absChg : absChg,
      rate,
      status: j.marketStatus,          // OPEN / CLOSE / ...
      tradedAt: j.localTradedAt ?? null,
    });
  }
  return out;
}

/**
 * 투자자별 순매수. 종목마다 요청이 하나씩 필요해 전 종목은 무리라,
 * 거래대금 상위 FLOW_UNIVERSE 종목만 훑는다 (동시 8개, 약 6초).
 * 순매수 "수량"만 주므로 금액은 종가를 곱해 추정한다 — 실제 체결 평균가가
 * 아니므로 화면에서도 추정치임을 밝힌다.
 */
const FLOW_UNIVERSE = 500;

async function fetchFlows(rows) {
  const targets = rows
    .filter((r) => r[3] === 0)                 // 주식만 (ETF·ETN 제외)
    .sort((a, b) => b[8] - a[8])               // 거래대금 순
    .slice(0, FLOW_UNIVERSE);

  const queue = [...targets];
  const out = [];

  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (queue.length) {
        const r = queue.shift();
        try {
          const j = await getJSON(`https://m.stock.naver.com/api/stock/${r[0]}/trend`, 2);
          const t = j?.[0];
          if (!t) continue;
          const close = num(t.closePrice) ?? r[4];
          const qty = (v) => num(v) ?? 0;
          out.push([
            r[0],
            Math.round(qty(t.foreignerPureBuyQuant) * close),   // 외국인 순매수 추정금액 (원)
            Math.round(qty(t.organPureBuyQuant) * close),       // 기관
            Math.round(qty(t.individualPureBuyQuant) * close),  // 개인
            num(String(t.foreignerHoldRatio).replace('%', '')), // 외국인 지분율 (%)
            qty(t.foreignerPureBuyQuant),                       // 외국인 순매수 수량 (주)
            qty(t.organPureBuyQuant),                           // 기관 수량
          ]);
        } catch {
          /* 개별 종목 실패는 건너뛴다 — 수급은 부가 정보라 전체를 막지 않는다 */
        }
      }
    }),
  );

  return out;
}

/** 상한가 판정 임계값. 호가 단위 때문에 +30.00%에 못 미치는 경우가 있어 여유를 둔다 */
const LIMIT = 29.5;

/** 시장 폭 — 지수 숫자만으로는 안 보이는 체감 장세 */
function breadth(rows, marketIdx) {
  const t = { up: 0, flat: 0, down: 0, limitUp: 0, limitDown: 0 };
  for (const r of rows) {
    if (r[3] !== 0) continue;                                  // 주식만
    if (marketIdx !== null && r[2] !== marketIdx) continue;
    const rate = r[6];
    if (rate > 0) t.up++;
    else if (rate < 0) t.down++;
    else t.flat++;
    if (rate >= LIMIT) t.limitUp++;
    else if (rate <= -LIMIT) t.limitDown++;
  }
  return t;
}

async function fetchIndustries() {
  const groups = [];
  for (let page = 1; page <= 20; page++) {
    const j = await getJSON(`https://m.stock.naver.com/api/stocks/industry?page=${page}&pageSize=50`);
    const list = j.groups ?? [];
    groups.push(...list);
    if (list.length < 50) break;
    await sleep(120);
  }
  return groups.map((g) => ({
    no: g.no,
    name: g.name,
    rate: num(g.changeRate) ?? 0,
    total: g.totalCount ?? 0,
    up: g.riseCount ?? 0,
    down: g.fallCount ?? 0,
    flat: g.steadyCount ?? 0,
  }));
}

async function main() {
  const started = Date.now();

  const [indices, industries, ...marketRows] = await Promise.all([
    fetchIndices(),
    fetchIndustries(),
    ...MARKETS.map(fetchMarket),
  ]);

  const rows = marketRows.flat();

  // 빈 결과를 배포해서 멀쩡한 이전 화면을 덮어쓰는 사고를 막는다
  if (rows.length < 500) throw new Error(`수집된 종목이 너무 적다 (${rows.length}건) — 배포 중단`);
  if (indices.length !== 3) throw new Error('지수 수집 실패 — 배포 중단');

  // 수급은 종목 목록이 있어야 대상을 고를 수 있어 뒤이어 받는다
  const flows = await fetchFlows(rows);

  const updatedAt = new Date().toISOString();
  const market = {
    updatedAt,
    status: indices[0].status,
    tradedAt: indices[0].tradedAt,
    indices,
    industries,
    breadth: {
      all: breadth(rows, null),
      kospi: breadth(rows, 0),
      kosdaq: breadth(rows, 1),
    },
    counts: {
      total: rows.length,
      stock: rows.filter((r) => r[3] === 0).length,
      etf: rows.filter((r) => r[3] === 1).length,
      etn: rows.filter((r) => r[3] === 2).length,
    },
  };

  const stocks = {
    updatedAt,
    // 파일 크기를 줄이려고 객체 대신 배열 + 컬럼 헤더로 싣는다
    cols: ['code', 'name', 'market', 'type', 'price', 'change', 'rate', 'volume', 'value', 'cap'],
    units: { price: '원', change: '원', rate: '%', volume: '주', value: '원', cap: '원' },
    rows,
  };

  const flowsFile = {
    updatedAt,
    universe: FLOW_UNIVERSE,
    note: '거래대금 상위 종목만 수집. 금액은 순매수 수량 × 종가로 추정한 값이다.',
    cols: ['code', 'foreign', 'organ', 'individual', 'holdRatio', 'foreignQty', 'organQty'],
    rows: flows,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'market.json'), JSON.stringify(market));
  await writeFile(path.join(OUT_DIR, 'stocks.json'), JSON.stringify(stocks));
  await writeFile(path.join(OUT_DIR, 'flows.json'), JSON.stringify(flowsFile));

  const b = market.breadth.all;
  console.log(
    `완료: 종목 ${rows.length}건 (주식 ${market.counts.stock} / ETF ${market.counts.etf} / ETN ${market.counts.etn}), ` +
      `업종 ${industries.length}개, 지수 ${indices.length}개, 수급 ${flows.length}종목\n` +
      `      시장 폭: 상승 ${b.up} / 보합 ${b.flat} / 하락 ${b.down} · 상한 ${b.limitUp} / 하한 ${b.limitDown}` +
      ` — ${((Date.now() - started) / 1000).toFixed(1)}초`,
  );
}

main().catch((err) => {
  console.error('수집 실패:', err.message);
  process.exit(1);
});
