#!/usr/bin/env node
/**
 * 공공데이터포털(금융위원회) + OPEN DART 로 시세 데이터를 굽는다.
 *
 * 네이버 스크래핑 버전(scripts/fetch.js)을 대체한다. 두 소스 모두
 * 상업적 이용이 허용돼 있어 광고를 붙여도 라이선스상 안전하다.
 *   - 공공데이터포털 금융위 시세/지수: "이용허락범위 제한 없음"
 *   - OPEN DART: 약관에 재배포·영리 이용 제한 조항 없음
 *
 * 대신 실시간이 아니다. 금융위 데이터는 기준일자로부터 영업일 하루 뒤
 * 오후 1시 이후에야 갱신되므로, 화면에 "언제 기준"인지 반드시 밝힌다.
 *
 *   DATA_GO_KR_KEY=... DART_KEY=... node scripts/fetch-public.js
 *   ... node scripts/fetch-public.js --probe        # 응답 구조만 찍어보고 끝
 *   ... node scripts/fetch-public.js --days 120     # 차트용 과거 일수
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const CACHE_DIR = path.join(ROOT, 'data-cache');

const DATA_KEY = process.env.DATA_GO_KR_KEY;
const DART_KEY = process.env.DART_KEY;

const GO = 'https://apis.data.go.kr/1160100/service';
const DART = 'https://opendart.fss.or.kr/api';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 공통 ---------------- */

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function getJSON(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(700 * 2 ** i);
    }
  }
  throw new Error(`요청 실패: ${url.replace(/serviceKey=[^&]+/, 'serviceKey=***')} — ${lastErr.message}`);
}

async function pool(items, size, fn) {
  const queue = [...items];
  const out = [];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        const r = await fn(item);
        if (r != null) out.push(r);
      } catch (e) {
        if (e.fatal) throw e;
      }
    }
  }));
  return out;
}

/* ---------------- 공공데이터포털 ---------------- */

/**
 * 금융위 API 응답 봉투를 벗긴다.
 *   { response: { header: {resultCode, resultMsg}, body: { items: { item: [...] }, totalCount } } }
 * items 가 빈 문자열로 오거나 item 이 객체 하나로 오는 경우가 있어 모두 배열로 맞춘다.
 */
function unwrap(json, label) {
  const header = json?.response?.header;
  const code = header?.resultCode;
  if (code && code !== '00') {
    const msg = `${label} 실패: [${code}] ${header?.resultMsg ?? ''}`;
    throw Object.assign(new Error(msg), { fatal: code === '30' || code === '31' || code === '22' });
  }
  const body = json?.response?.body;
  const raw = body?.items?.item ?? body?.items ?? [];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return { list, total: num(body?.totalCount) ?? list.length };
}

const goURL = (service, op, params) => {
  const qs = new URLSearchParams({
    serviceKey: DATA_KEY,
    resultType: 'json',
    numOfRows: '10000',
    pageNo: '1',
    ...params,
  });
  return `${GO}/${service}/${op}?${qs}`;
};

/** 기준일 하루치 전 종목 시세 */
async function fetchPrices(basDt) {
  const json = await getJSON(goURL('GetStockSecuritiesInfoService', 'getStockPriceInfo', { basDt }));
  const { list } = unwrap(json, `주식시세 ${basDt}`);
  return list.map((r) => ({
    date: r.basDt,
    code: r.srtnCd,                       // 단축코드 6자리
    isin: r.isinCd,
    name: r.itmsNm,
    market: r.mrktCtg,                    // KOSPI / KOSDAQ / KONEX
    close: num(r.clpr),
    change: num(r.vs),                    // 전일 대비
    rate: num(r.fltRt),                   // 등락률 %
    open: num(r.mkp),
    high: num(r.hipr),
    low: num(r.lopr),
    volume: num(r.trqu),                  // 거래량 (주)
    value: num(r.trPrc),                  // 거래대금 (원)
    shares: num(r.lstgStCnt),             // 상장주식수
    cap: num(r.mrktTotAmt),               // 시가총액 (원)
  }));
}

/** 기준일 지수 시세 */
async function fetchIndices(basDt) {
  const json = await getJSON(goURL('GetMarketIndexInfoService', 'getStockMarketIndex', { basDt }));
  const { list } = unwrap(json, `지수시세 ${basDt}`);
  const want = { '코스피': 'KOSPI', '코스닥': 'KOSDAQ', '코스피 200': 'KPI200' };
  return list
    .filter((r) => want[String(r.idxNm ?? '').trim()])
    .map((r) => ({
      code: want[String(r.idxNm).trim()],
      name: String(r.idxNm).trim(),
      close: num(r.clpr),
      change: num(r.vs),
      rate: num(r.fltRt),
      open: num(r.mkp),
      high: num(r.hipr),
      low: num(r.lopr),
      date: r.basDt,
    }));
}

/** 데이터가 있는 가장 최근 기준일을 뒤로 훑어 찾는다 (주말·휴일·D+1 지연 대응) */
async function findLatestBasDt(maxBack = 12) {
  for (let back = 1; back <= maxBack; back++) {
    const d = kstDate(back);
    const rows = await fetchPrices(d);
    if (rows.length) return { basDt: d, rows };
    await sleep(150);
  }
  throw new Error(`최근 ${maxBack}일 안에 시세 데이터가 있는 기준일을 찾지 못했습니다.`);
}

const kstDate = (backDays = 0) => {
  const d = new Date(Date.now() + 9 * 3600_000 - backDays * 86400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};

/* ---------------- OPEN DART ---------------- */

async function dart(endpoint, params, tries = 3) {
  const qs = new URLSearchParams({ crtfc_key: DART_KEY, ...params });
  const json = await getJSON(`${DART}/${endpoint}?${qs}`, tries);
  if (json.status && json.status !== '000') {
    if (json.status === '013') return { list: [] };            // 결과 없음
    const fatal = ['010', '011', '012', '020', '021'].includes(json.status);
    throw Object.assign(new Error(`DART ${endpoint} [${json.status}] ${json.message}`), { fatal });
  }
  return json;
}

const pickRow = (rows, re, kind = '보통주') => {
  const hit = rows.find((r) => re.test(r.se ?? '') && String(r.stock_knd ?? '보통주').includes(kind));
  const v = hit?.thstrm;
  return v && v !== '-' ? num(v) : null;
};

/**
 * 종목별 재무·배당. DART 는 종목코드가 아니라 corp_code 를 쓰므로
 * data-cache/corp-map.json (scripts/build-corp-map.js 로 만든다) 이 필요하다.
 */
async function fetchFundamentals(codes, corpMap) {
  const year = Number(kstDate(0).slice(0, 4)) - 1;

  return pool(codes, 4, async (code) => {
    const corpCode = corpMap[code];
    if (!corpCode) return null;

    const [acnt, alot] = await Promise.all([
      dart('fnlttSinglAcnt.json', { corp_code: corpCode, bsns_year: String(year), reprt_code: '11011' }, 2)
        .catch(() => ({ list: [] })),
      dart('alotMatter.json', { corp_code: corpCode, bsns_year: String(year), reprt_code: '11011' }, 2)
        .catch(() => ({ list: [] })),
    ]);

    // 재무제표에서 당기순이익·자본총계를 뽑아 EPS/BPS 를 직접 계산한다
    const rows = acnt.list ?? [];
    const acc = (re) => {
      const hit = rows.find((r) => re.test(String(r.account_nm ?? '')) && /CFS|OFS/.test(r.fs_div ?? 'CFS'));
      return hit ? num(hit.thstrm_amount) : null;
    };
    const netIncome = acc(/당기순이익/);
    const equity = acc(/자본총계/);

    const alotRows = alot.list ?? [];
    return {
      code,
      corpCode,
      year,
      netIncome,
      equity,
      dps: pickRow(alotRows, /주당.*현금배당금/),        // 주당 현금배당금 (원)
      divYield: pickRow(alotRows, /현금배당수익률/),      // %
      payout: pickRow(alotRows, /현금배당성향/),          // %
    };
  });
}

/* ---------------- probe ---------------- */

async function probe() {
  const basDt = kstDate(2);
  console.log(`기준일 ${basDt} 로 각 엔드포인트를 한 번씩 호출해 구조를 확인합니다.\n`);

  const shots = [
    ['주식시세', goURL('GetStockSecuritiesInfoService', 'getStockPriceInfo', { basDt, numOfRows: '2' })],
    ['지수시세', goURL('GetMarketIndexInfoService', 'getStockMarketIndex', { basDt, numOfRows: '3' })],
  ];
  for (const [label, url] of shots) {
    try {
      const j = await getJSON(url, 1);
      console.log(`=== ${label} ===`);
      console.log(JSON.stringify(j, null, 1).slice(0, 1600));
    } catch (e) { console.log(`=== ${label} === 실패: ${e.message}`); }
    console.log('');
  }

  if (DART_KEY) {
    for (const [label, ep, params] of [
      ['DART 기업개황', 'company.json', { corp_code: '00126380' }],
      ['DART 주요계정', 'fnlttSinglAcnt.json', { corp_code: '00126380', bsns_year: '2025', reprt_code: '11011' }],
      ['DART 배당사항', 'alotMatter.json', { corp_code: '00126380', bsns_year: '2025', reprt_code: '11011' }],
    ]) {
      try {
        const j = await dart(ep, params, 1);
        console.log(`=== ${label} ===`);
        console.log(JSON.stringify(j, null, 1).slice(0, 1600));
      } catch (e) { console.log(`=== ${label} === 실패: ${e.message}`); }
      console.log('');
    }
  }
}

/* ---------------- main ---------------- */

function args() {
  const a = process.argv.slice(2);
  const get = (n, d) => { const i = a.indexOf(`--${n}`); return i >= 0 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : d; };
  return { probe: a.includes('--probe'), days: Number(get('days', '120')) };
}

async function main() {
  const opt = args();
  if (!DATA_KEY) throw new Error('DATA_GO_KR_KEY 환경변수가 없습니다.');
  if (opt.probe) return probe();
  if (!DART_KEY) console.warn('경고: DART_KEY 가 없어 재무·배당 지표는 건너뜁니다.');

  const started = Date.now();

  // 1) 가장 최근에 데이터가 있는 기준일과 그날 전 종목 시세
  const { basDt, rows: latest } = await findLatestBasDt();
  console.log(`기준일 ${basDt} · 종목 ${latest.length}건`);

  // 2) 차트용 과거 시세 — 날짜별로 한 번씩 부르면 전 종목 이력이 한꺼번에 쌓인다
  const history = new Map();                     // code -> [[date, open, high, low, close, volume], ...]
  const dates = [];
  for (let back = 1; back <= opt.days * 1.6 && dates.length < opt.days; back++) {
    dates.push(kstDate(back));
  }
  const days = await pool(dates, 4, async (d) => {
    const rows = await fetchPrices(d);
    await sleep(60);
    return rows.length ? { date: d, rows } : null;
  });
  for (const day of days.sort((a, b) => a.date.localeCompare(b.date))) {
    for (const r of day.rows) {
      if (!history.has(r.code)) history.set(r.code, []);
      history.get(r.code).push([r.date, r.open, r.high, r.low, r.close, r.volume]);
    }
  }
  console.log(`과거 시세: ${days.length}영업일 · 이력 보유 종목 ${history.size}개`);

  // 3) 지수
  const indices = await fetchIndices(basDt);
  console.log(`지수 ${indices.length}종`);

  // 4) 업종 (미리 만들어 둔 캐시) · corp_code 매핑
  const readCache = async (name) => {
    try { return JSON.parse(await readFile(path.join(CACHE_DIR, name), 'utf8')); }
    catch { return null; }
  };
  const industryMap = (await readCache('industry.json')) ?? {};
  const corpMap = (await readCache('corp-map.json')) ?? {};
  console.log(`캐시: 업종 ${Object.keys(industryMap).length}종목 · corp_code ${Object.keys(corpMap).length}종목`);

  // 5) 재무·배당 (상위 종목만)
  const MARKET_IDX = { KOSPI: 0, KOSDAQ: 1, KONEX: 2 };
  const stocks = latest.filter((r) => MARKET_IDX[r.market] !== undefined);
  const universe = [...stocks].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 800).map((r) => r.code);
  const fundamentals = DART_KEY && Object.keys(corpMap).length
    ? await fetchFundamentals(universe, corpMap)
    : [];
  console.log(`재무·배당 ${fundamentals.length}종목`);

  // ---- 산출 ----
  const rows = stocks.map((r) => [
    r.code, r.name, MARKET_IDX[r.market], 0,
    r.close ?? 0, r.change ?? 0, r.rate ?? 0,
    r.volume ?? 0, r.value ?? 0, r.cap ?? 0,
    0,                                            // 상한/하한 플래그 — 이 소스에는 없다
    r.shares ?? 0,
  ]);
  if (rows.length < 500) throw new Error(`수집된 종목이 너무 적습니다 (${rows.length}건) — 배포 중단`);

  const breadth = (mi) => {
    const t = { up: 0, flat: 0, down: 0, limitUp: 0, limitDown: 0 };
    for (const r of rows) {
      if (mi !== null && r[2] !== mi) continue;
      if (r[6] > 0) t.up++; else if (r[6] < 0) t.down++; else t.flat++;
    }
    return t;
  };

  // 업종 집계 — 종목별 업종을 캐시에서 읽어 평균 등락률을 낸다
  const byIndustry = new Map();
  for (const r of rows) {
    const ind = industryMap[r[0]];
    if (!ind) continue;
    if (!byIndustry.has(ind)) byIndustry.set(ind, []);
    byIndustry.get(ind).push(r);
  }
  const industries = [...byIndustry.entries()]
    .filter(([, list]) => list.length >= 3)
    .map(([name, list]) => ({
      name,
      rate: list.reduce((s, r) => s + r[6], 0) / list.length,
      total: list.length,
      up: list.filter((r) => r[6] > 0).length,
      down: list.filter((r) => r[6] < 0).length,
      flat: list.filter((r) => r[6] === 0).length,
    }))
    .sort((a, b) => b.rate - a.rate);

  const updatedAt = new Date().toISOString();
  const market = {
    updatedAt,
    basDt,                                        // 데이터 기준일 — 화면에 반드시 표시한다
    status: 'CLOSE',
    indices,
    industries,
    breadth: { all: breadth(null), kospi: breadth(0), kosdaq: breadth(1) },
    counts: { total: rows.length, stock: rows.length, etf: 0, etn: 0 },
    detailCodes: [...history.keys()].filter((c) => rows.some((r) => r[0] === c)),
    source: '공공데이터포털 금융위원회 · OPEN DART',
  };

  const fundMap = new Map(fundamentals.map((f) => [f.code, f]));

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'market.json'), JSON.stringify(market));
  await writeFile(path.join(OUT_DIR, 'stocks.json'), JSON.stringify({
    updatedAt,
    basDt,
    cols: ['code', 'name', 'market', 'type', 'price', 'change', 'rate', 'volume', 'value', 'cap', 'limit', 'shares'],
    units: { price: '원', change: '원', rate: '%', volume: '주', value: '원', cap: '원' },
    rows,
  }));

  const detailDir = path.join(OUT_DIR, 'stock');
  await mkdir(detailDir, { recursive: true });
  await Promise.all([...history.entries()].map(([code, chart]) => {
    const row = rows.find((r) => r[0] === code);
    const f = fundMap.get(code);
    const shares = row?.[11] || null;
    const closes = chart.map((c) => c[4]).filter((v) => v != null);
    const eps = f?.netIncome && shares ? (f.netIncome / shares) : null;
    const bps = f?.equity && shares ? (f.equity / shares) : null;
    const price = row?.[4];

    const indicators = {};
    const put = (k, key, value) => { if (value != null) indicators[k] = { key, value }; };
    put('highPriceOf52Weeks', '52주 최고', closes.length ? Math.max(...closes).toLocaleString('ko-KR') : null);
    put('lowPriceOf52Weeks', '52주 최저', closes.length ? Math.min(...closes).toLocaleString('ko-KR') : null);
    put('per', 'PER', eps && price ? (price / eps).toFixed(2) + '배' : null);
    put('eps', 'EPS', eps ? Math.round(eps).toLocaleString('ko-KR') + '원' : null);
    put('pbr', 'PBR', bps && price ? (price / bps).toFixed(2) + '배' : null);
    put('bps', 'BPS', bps ? Math.round(bps).toLocaleString('ko-KR') + '원' : null);
    put('dividend', '주당배당금', f?.dps != null ? f.dps.toLocaleString('ko-KR') + '원' : null);
    put('dividendYieldRatio', '배당수익률', f?.divYield != null ? f.divYield + '%' : null);
    put('payout', '배당성향', f?.payout != null ? f.payout + '%' : null);
    put('shares', '상장주식수', shares ? shares.toLocaleString('ko-KR') + '주' : null);

    return writeFile(path.join(detailDir, `${code}.json`), JSON.stringify({
      code,
      name: row?.[1] ?? code,
      updatedAt,
      basDt,
      indicators,
      chartCols: ['date', 'open', 'high', 'low', 'close', 'volume'],
      chart,
      book: null,                                 // 호가잔량은 이 소스에 없다
    }));
  }));

  const b = market.breadth.all;
  console.log(
    `완료: 기준일 ${basDt} · 종목 ${rows.length} · 차트 ${history.size} · 업종 ${industries.length}\n` +
    `      시장 폭: 상승 ${b.up} / 보합 ${b.flat} / 하락 ${b.down}` +
    ` — ${((Date.now() - started) / 1000).toFixed(1)}초`,
  );
}

main().catch((err) => {
  console.error(`수집 실패: ${err.message}`);
  process.exit(1);
});
