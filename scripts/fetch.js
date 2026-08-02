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

/** 동시 실행 개수를 제한해 순회한다 */
async function pool(items, size, fn) {
  const queue = [...items];
  const out = [];
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          const r = await fn(item);
          if (r != null) out.push(r);
        } catch {
          /* 개별 실패는 건너뛴다 — 부가 정보가 전체 수집을 막지 않도록 */
        }
      }
    }),
  );
  return out;
}

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
    // 상한가·하한가는 등락률로 어림잡지 않고 원본이 주는 플래그를 그대로 쓴다
    const mark = s.compareToPreviousPrice?.name;
    const limitFlag = mark === 'UPPER_LIMIT' ? 1 : mark === 'LOWER_LIMIT' ? -1 : 0;
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
      limitFlag,                                         // 10 상한 1 / 하한 -1 / 없음 0
    ];
  });
}

/**
 * 테마별 구성종목. 테마 하나당 요청 하나(구성종목이 100개를 넘으면 더) 라
 * 266개를 동시 8개로 돌면 4초 남짓이다.
 */
async function fetchThemeGroups() {
  const groups = [];
  for (let page = 1; page <= 20; page++) {
    const j = await getJSON(`https://m.stock.naver.com/api/stocks/theme?page=${page}&pageSize=50`);
    const list = j.groups ?? [];
    groups.push(...list);
    if (list.length < 50) break;
    await sleep(120);
  }

  return pool(groups, 8, async (g) => {
    const codes = [];
    for (let page = 1; page <= 10; page++) {
      const j = await getJSON(`https://m.stock.naver.com/api/stocks/theme/${g.no}?page=${page}&pageSize=100`, 2);
      const list = j.stocks ?? [];
      codes.push(...list.map((s) => s.itemCode));
      if (list.length < 100) break;
    }
    return {
      no: g.no,
      name: g.name,
      rate: num(g.changeRate) ?? 0,
      up: g.riseCount ?? 0,
      down: g.fallCount ?? 0,
      flat: g.steadyCount ?? 0,
      codes,
    };
  });
}

/** 상세를 받아 둘 종목 — 사용자가 순위표에서 실제로 누를 만한 것들의 합집합 */
function detailUniverse(rows) {
  const stocks = rows.filter((r) => r[3] === 0);
  const byDesc = (i) => [...stocks].sort((a, b) => b[i] - a[i]);
  const set = new Set();
  const take = (list, n) => list.slice(0, n).forEach((r) => set.add(r[0]));
  take(byDesc(8), 500);                                              // 거래대금
  take(byDesc(9), 200);                                              // 시가총액
  take(byDesc(6), 200);                                              // 상승률
  take([...stocks].sort((a, b) => a[6] - b[6]), 200);                // 하락률
  return [...set];
}

/** siseJson 은 작은따옴표를 쓰는 유사 JSON 이라 손질해서 파싱한다 */
function parseSiseJson(text) {
  const cleaned = text.replace(/'/g, '"').replace(/,\s*]/g, ']');
  const rows = JSON.parse(cleaned);
  return rows.slice(1)                                   // 첫 줄은 헤더
    .filter((r) => Array.isArray(r) && r.length >= 6)
    .map((r) => [String(r[0]), r[1], r[2], r[3], r[4], r[5]]);  // 날짜, 시가, 고가, 저가, 종가, 거래량
}

const KST_DATE = (offsetDays = 0) => {
  const d = new Date(Date.now() + 9 * 3600_000 - offsetDays * 86400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};

/**
 * 종목 상세 — 지표(integration)와 일봉(siseJson). 종목마다 요청 두 개라
 * 전 종목은 무리고, 위 universe 만 받는다.
 */
async function fetchDetails(codes, nameByCode) {
  const start = KST_DATE(260);   // 영업일 기준 대략 6개월치
  const end = KST_DATE(0);

  return pool(codes, 8, async (code) => {
    const [info, chartText, asking] = await Promise.all([
      getJSON(`https://m.stock.naver.com/api/stock/${code}/integration`, 2),
      fetch(
        `https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${start}&endTime=${end}&timeframe=day`,
        { headers: HEADERS, signal: AbortSignal.timeout(20_000) },
      ).then((r) => (r.ok ? r.text() : null)).catch(() => null),
      // 호가잔량 — 체결된 양이 아니라 "대기 중인" 매수·매도 물량이다
      getJSON(`https://m.stock.naver.com/api/stock/${code}/askingPrice`, 2).catch(() => null),
    ]);

    const indicators = {};
    for (const t of info?.totalInfos ?? []) indicators[t.code] = { key: t.key, value: t.value };

    let chart = [];
    if (chartText) { try { chart = parseSiseJson(chartText); } catch { chart = []; } }

    const level = (x) => [num(x.price) ?? 0, num(x.count) ?? 0];
    const book = asking?.totalBuy && asking?.totalSell
      ? {
        totalBuy: num(asking.totalBuy) ?? 0,     // 총 매수잔량 (주)
        totalSell: num(asking.totalSell) ?? 0,   // 총 매도잔량 (주)
        sell: (asking.sellInfo ?? []).map(level),   // 매도호가 5단계 (가격 내림차순)
        buy: (asking.buyInfos ?? []).map(level),    // 매수호가 5단계 (가격 내림차순)
      }
      : null;

    return {
      code,
      name: nameByCode.get(code) ?? info?.stockName ?? code,
      indicators,
      chartCols: ['date', 'open', 'high', 'low', 'close', 'volume'],
      chart,
      book,
    };
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
 *
 * 응답은 최근 10영업일치가 최신순으로 온다. 추가 요청 없이 이 배열만으로
 * 연속 순매수/순매도 일수를 셀 수 있다.
 */
const FLOW_UNIVERSE = 500;

/**
 * 최신일과 같은 부호가 며칠이나 이어지는지 센다.
 * 반환: { days, sum } — days 는 부호 있는 값(+3 = 3일 연속 순매수, -3 = 3일 연속 순매도),
 * sum 은 그 기간의 순매수 추정금액 합계(원, 부호 유지).
 * 응답이 10일치뿐이라 연속일수는 10에서 잘린다.
 */
function streakOf(history, qtyKey, fallbackClose) {
  const qty = (d) => num(d[qtyKey]) ?? 0;
  const sign = Math.sign(qty(history[0]));
  if (!sign) return { days: 0, sum: 0 };

  let days = 0;
  let sum = 0;
  for (const d of history) {
    const q = qty(d);
    if (Math.sign(q) !== sign) break;
    days++;
    sum += q * (num(d.closePrice) ?? fallbackClose);
  }
  return { days: days * sign, sum: Math.round(sum) };
}

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
          const fs = streakOf(j, 'foreignerPureBuyQuant', close);
          const os = streakOf(j, 'organPureBuyQuant', close);
          out.push([
            r[0],
            Math.round(qty(t.foreignerPureBuyQuant) * close),   // 외국인 당일 순매수 추정금액 (원)
            Math.round(qty(t.organPureBuyQuant) * close),       // 기관
            Math.round(qty(t.individualPureBuyQuant) * close),  // 개인
            num(String(t.foreignerHoldRatio).replace('%', '')), // 외국인 지분율 (%)
            qty(t.foreignerPureBuyQuant),                       // 외국인 당일 순매수 수량 (주)
            qty(t.organPureBuyQuant),                           // 기관 수량
            fs.days,                                            // 외국인 연속일수 (+매수 / -매도)
            fs.sum,                                             // 외국인 연속기간 누적 추정금액
            os.days,                                            // 기관 연속일수
            os.sum,                                             // 기관 연속기간 누적 추정금액
            j.length,                                           // 확보한 과거 영업일 수 (연속 판정 상한)
          ]);
        } catch {
          /* 개별 종목 실패는 건너뛴다 — 수급은 부가 정보라 전체를 막지 않는다 */
        }
      }
    }),
  );

  return out;
}

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
    if (r[10] === 1) t.limitUp++;
    else if (r[10] === -1) t.limitDown++;
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

  const [indices, industries, themes, ...marketRows] = await Promise.all([
    fetchIndices(),
    fetchIndustries(),
    fetchThemeGroups(),
    ...MARKETS.map(fetchMarket),
  ]);

  const rows = marketRows.flat();

  // 빈 결과를 배포해서 멀쩡한 이전 화면을 덮어쓰는 사고를 막는다
  if (rows.length < 500) throw new Error(`수집된 종목이 너무 적다 (${rows.length}건) — 배포 중단`);
  if (indices.length !== 3) throw new Error('지수 수집 실패 — 배포 중단');

  // 수급과 상세는 종목 목록이 있어야 대상을 고를 수 있어 뒤이어 받는다
  const nameByCode = new Map(rows.map((r) => [r[0], r[1]]));
  const universe = detailUniverse(rows);
  const [flows, details] = await Promise.all([
    fetchFlows(rows),
    fetchDetails(universe, nameByCode),
  ]);

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
    // 상세(지표·차트) 를 받아 둔 종목. 화면은 이 목록으로 차트 유무를 미리 안다
    detailCodes: details.map((d) => d.code),
  };

  const stocks = {
    updatedAt,
    // 파일 크기를 줄이려고 객체 대신 배열 + 컬럼 헤더로 싣는다
    cols: ['code', 'name', 'market', 'type', 'price', 'change', 'rate', 'volume', 'value', 'cap', 'limit'],
    units: { price: '원', change: '원', rate: '%', volume: '주', value: '원', cap: '원' },
    rows,
  };

  const flowsFile = {
    updatedAt,
    universe: FLOW_UNIVERSE,
    maxStreak: 10,   // 응답이 10영업일치라 연속일수는 여기서 잘린다
    note: '거래대금 상위 종목만 수집. 금액은 순매수 수량 × 종가로 추정한 값이다.',
    cols: ['code', 'foreign', 'organ', 'individual', 'holdRatio', 'foreignQty', 'organQty',
      'fStreak', 'fSum', 'oStreak', 'oSum', 'histLen'],
    rows: flows,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'market.json'), JSON.stringify(market));
  await writeFile(path.join(OUT_DIR, 'stocks.json'), JSON.stringify(stocks));
  await writeFile(path.join(OUT_DIR, 'flows.json'), JSON.stringify(flowsFile));
  await writeFile(path.join(OUT_DIR, 'themes.json'), JSON.stringify({
    updatedAt,
    // 구성종목 코드만 싣는다. 시세·시총은 stocks.json 에 이미 있어 화면에서 합친다
    groups: themes.filter((t) => t.codes.length),
  }));

  // 종목 상세는 클릭할 때만 필요하니 한 덩어리로 묶지 않고 종목별 파일로 쪼갠다
  const detailDir = path.join(OUT_DIR, 'stock');
  await mkdir(detailDir, { recursive: true });
  await Promise.all(details.map((d) =>
    writeFile(path.join(detailDir, `${d.code}.json`), JSON.stringify({ ...d, updatedAt }))));

  const b = market.breadth.all;
  const cnt = (i, min) => flows.filter((f) => (min > 0 ? f[i] >= min : f[i] <= min)).length;
  console.log(
    `완료: 종목 ${rows.length}건 (주식 ${market.counts.stock} / ETF ${market.counts.etf} / ETN ${market.counts.etn}), ` +
      `업종 ${industries.length}개, 지수 ${indices.length}개, 수급 ${flows.length}종목\n` +
      `      시장 폭: 상승 ${b.up} / 보합 ${b.flat} / 하락 ${b.down} · 상한 ${b.limitUp} / 하한 ${b.limitDown}\n` +
      `      연속 순매수 3일↑ 외국인 ${cnt(7, 3)} / 기관 ${cnt(9, 3)} · 7일↑ 외국인 ${cnt(7, 7)} / 기관 ${cnt(9, 7)}\n` +
      `      연속 순매도 3일↑ 외국인 ${cnt(7, -3)} / 기관 ${cnt(9, -3)} · 7일↑ 외국인 ${cnt(7, -7)} / 기관 ${cnt(9, -7)}\n` +
      `      테마 ${themes.length}개 (구성종목 ${themes.reduce((s, t) => s + t.codes.length, 0)}쌍), ` +
      `상세 ${details.length}종목 (차트 ${details.filter((d) => d.chart.length).length} / 호가 ${details.filter((d) => d.book).length})` +
      ` — ${((Date.now() - started) / 1000).toFixed(1)}초`,
  );
}

main().catch((err) => {
  console.error('수집 실패:', err.message);
  process.exit(1);
});
