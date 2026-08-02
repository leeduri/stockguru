#!/usr/bin/env node
/**
 * 배당공시 수집·요약
 *
 * DART 공시검색(list.json)에서 최근 며칠간 올라온 "배당" 관련 공시를 모으고,
 * 각 회사의 최근 사업보고서 배당 실적(alotMatter.json)을 붙여 요약한다.
 *
 *   DART_KEY=발급받은키 node scripts/dividend.js
 *   DART_KEY=... node scripts/dividend.js --days 14 --out public/data/dividends.json
 *
 * 옵션
 *   --days N     최근 N일 (기본 7)
 *   --from/--to  YYYYMMDD 로 직접 지정 (--days 보다 우선)
 *   --out PATH   JSON 저장 경로 (기본 public/data/dividends.json)
 *   --no-history 배당 이력 조회를 건너뛴다 (빠름)
 *   --quiet      콘솔 요약을 생략한다
 *
 * 왜 두 API 를 쓰나:
 *   - 수시공시(현금·현물배당결정 등)는 "언제 무엇이 발표됐나"를 바로 알려주지만
 *     금액이 구조화된 형태로 오지 않는다(본문 문서 안에 있다).
 *   - 정기보고서의 배당에 관한 사항은 주당배당금·배당수익률이 구조화돼 있지만
 *     1년에 몇 번뿐이라 속보성이 없다.
 *   둘을 붙여야 "오늘 배당 공시를 낸 회사 + 그 회사가 작년에 얼마 줬는지"가 된다.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = 'https://opendart.fss.or.kr/api';
const KEY = process.env.DART_KEY;

/** DART 는 HTTP 200 에 status 코드로 결과를 알려준다 */
const STATUS = {
  '000': null,
  '010': '등록되지 않은 인증키입니다. DART_KEY 를 확인하세요.',
  '011': '사용할 수 없는(정지된) 인증키입니다.',
  '012': '접근할 수 없는 IP 입니다.',
  '013': null,                                   // 조회 결과 없음 — 오류가 아니다
  '014': '파일이 존재하지 않습니다.',
  '020': '요청 제한을 초과했습니다 (일 20,000건).',
  '021': '조회 가능한 회사 개수를 초과했습니다.',
  '100': '요청 파라미터가 잘못되었습니다.',
  '101': '부적절한 접근입니다.',
  '800': 'DART 시스템 점검 중입니다.',
  '900': '정의되지 않은 오류가 발생했습니다.',
  '901': '사용자 계정의 개인정보 보유기간이 만료되었습니다.',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(endpoint, params, tries = 3) {
  const qs = new URLSearchParams({ crtfc_key: KEY, ...params });
  const url = `${BASE}/${endpoint}?${qs}`;

  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      if (json.status && json.status !== '000') {
        const known = STATUS[json.status];
        if (json.status === '013') return { ...json, list: [] };   // 결과 없음
        // 키·한도 문제는 재시도해도 소용없으니 즉시 던진다
        throw Object.assign(new Error(known ?? json.message ?? `status ${json.status}`), { fatal: true });
      }
      return json;
    } catch (err) {
      if (err.fatal) throw err;
      lastErr = err;
      if (i < tries - 1) await sleep(500 * 2 ** i);
    }
  }
  throw new Error(`${endpoint} 요청 실패: ${lastErr.message}`);
}

/** 동시 실행 제한 순회 */
async function pool(items, size, fn) {
  const queue = [...items];
  const out = [];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { out.push(await fn(item)); } catch (e) { if (e.fatal) throw e; }
    }
  }));
  return out;
}

/* ---------------- 날짜 ---------------- */

const KST = (offsetDays = 0) => {
  const d = new Date(Date.now() + 9 * 3600_000 - offsetDays * 86400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};
const prettyDate = (s) => `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;

/* ---------------- 공시 수집 ---------------- */

/** 보고서명으로 배당 공시를 가려낸다 */
const DIVIDEND_RE = /배당/;
/** 배당이라는 말이 들어가도 성격이 다른 것들은 뺀다 */
const EXCLUDE_RE = /배당관련|배당락|무배당/;

/** 보고서명에서 배당 종류를 추려 라벨을 붙인다 */
function kindOf(reportName) {
  if (/주식배당/.test(reportName)) return '주식배당';
  if (/현금.*현물배당|현금배당|현물배당/.test(reportName)) return '현금·현물배당';
  if (/기준일/.test(reportName)) return '배당기준일';
  if (/중간배당|분기배당/.test(reportName)) return '중간·분기배당';
  return '기타 배당공시';
}

async function fetchDisclosures(from, to) {
  const items = [];

  // 유가증권(Y)·코스닥(K) 만 본다. 비상장까지 훑으면 양만 늘고 쓸모가 없다
  for (const corpCls of ['Y', 'K']) {
    for (let page = 1; page <= 100; page++) {
      const j = await call('list.json', {
        bgn_de: from,
        end_de: to,
        corp_cls: corpCls,
        page_no: String(page),
        page_count: '100',
        sort: 'date',
        sort_mth: 'desc',
      });

      const list = j.list ?? [];
      for (const d of list) {
        const nm = d.report_nm ?? '';
        if (!DIVIDEND_RE.test(nm) || EXCLUDE_RE.test(nm)) continue;
        items.push({
          receivedAt: d.rcept_dt,
          corpName: d.corp_name,
          corpCode: d.corp_code,
          stockCode: d.stock_code || null,
          market: corpCls === 'Y' ? '코스피' : '코스닥',
          reportName: nm.replace(/\s+/g, ' ').trim(),
          kind: kindOf(nm),
          filer: d.flr_nm,
          rceptNo: d.rcept_no,
          url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${d.rcept_no}`,
        });
      }

      if (page >= Number(j.total_page ?? 1)) break;
      await sleep(80);
    }
  }

  // 같은 공시가 두 번 잡히는 일은 없지만, 접수번호로 한 번 더 확인한다
  const seen = new Set();
  return items
    .filter((it) => (seen.has(it.rceptNo) ? false : seen.add(it.rceptNo)))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.corpName.localeCompare(b.corpName, 'ko'));
}

/* ---------------- 배당 이력 ---------------- */

const pick = (rows, re, kind = '보통주') => {
  const hit = rows.find((r) => re.test(r.se ?? '') && (r.stock_knd ?? '보통주').includes(kind));
  const v = hit?.thstrm;
  return v && v !== '-' ? String(v).trim() : null;
};

/**
 * 최근 사업보고서의 배당 실적. 올해 사업보고서가 아직 없을 수 있어
 * 작년 → 재작년 순으로 내려가며 찾는다.
 */
async function fetchHistory(corpCode) {
  const thisYear = Number(KST(0).slice(0, 4));
  for (const year of [thisYear - 1, thisYear - 2]) {
    const j = await call('alotMatter.json', {
      corp_code: corpCode,
      bsns_year: String(year),
      reprt_code: '11011',      // 사업보고서
    }, 2);

    const rows = j.list ?? [];
    if (!rows.length) continue;

    const history = {
      year: String(year),
      dps: pick(rows, /주당.*현금배당금/),          // 주당 현금배당금 (원)
      yield: pick(rows, /현금배당수익률/),           // 현금배당수익률 (%)
      payout: pick(rows, /현금배당성향/),            // 현금배당성향 (%)
      stockDps: pick(rows, /주당.*주식배당/),        // 주당 주식배당 (주)
    };
    if (history.dps || history.yield || history.stockDps) return history;
  }
  return null;
}

/* ---------------- 요약 출력 ---------------- */

function printSummary(result) {
  const { range, items } = result;
  const line = '─'.repeat(72);

  console.log(`\n배당공시 요약  ${prettyDate(range.from)} ~ ${prettyDate(range.to)}`);
  console.log(`${items.length}건${items.length ? '' : ' (해당 기간에 배당 공시가 없습니다)'}`);
  if (!items.length) return;

  const byKind = {};
  for (const it of items) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
  console.log(Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(' · '));

  let day = null;
  for (const it of items) {
    if (it.receivedAt !== day) {
      day = it.receivedAt;
      console.log(`\n${line}\n${prettyDate(day)}\n${line}`);
    }
    const code = it.stockCode ? ` (${it.stockCode})` : '';
    console.log(`  ${it.corpName}${code}  [${it.market}]`);
    console.log(`    ${it.reportName}`);
    if (it.history) {
      const h = it.history;
      const parts = [
        h.dps && `주당 ${Number(h.dps.replace(/,/g, '')).toLocaleString('ko-KR')}원`,
        h.yield && `수익률 ${h.yield}%`,
        h.payout && `배당성향 ${h.payout}%`,
        h.stockDps && `주식배당 ${h.stockDps}주`,
      ].filter(Boolean);
      if (parts.length) console.log(`    ${h.year}년 실적: ${parts.join(' · ')}`);
    }
    console.log(`    ${it.url}`);
  }
  console.log('');
}

/* ---------------- 실행 ---------------- */

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const has = (name) => argv.includes(`--${name}`);
  const days = Number(get('days', '7'));
  return {
    from: get('from', KST(days - 1)),
    to: get('to', KST(0)),
    out: get('out', 'public/data/dividends.json'),
    history: !has('no-history'),
    quiet: has('quiet'),
  };
}

async function main() {
  if (!KEY) {
    console.error('DART_KEY 환경변수가 없습니다.\n  예) DART_KEY=발급받은키 node scripts/dividend.js');
    process.exit(1);
  }

  const opt = parseArgs(process.argv.slice(2));
  const started = Date.now();

  const items = await fetchDisclosures(opt.from, opt.to);

  if (opt.history && items.length) {
    // 같은 회사가 여러 공시를 냈으면 이력은 한 번만 받는다
    const codes = [...new Set(items.map((it) => it.corpCode))];
    const map = new Map();
    await pool(codes, 4, async (code) => {
      map.set(code, await fetchHistory(code));
      await sleep(60);
    });
    for (const it of items) it.history = map.get(it.corpCode) ?? null;
  }

  const result = {
    generatedAt: new Date().toISOString(),
    source: 'OPEN DART (금융감독원 전자공시)',
    range: { from: opt.from, to: opt.to },
    count: items.length,
    items,
  };

  const outPath = path.resolve(process.cwd(), opt.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2));

  if (!opt.quiet) printSummary(result);
  console.log(`저장: ${path.relative(process.cwd(), outPath)}  (${items.length}건, ${((Date.now() - started) / 1000).toFixed(1)}초)`);
}

main().catch((err) => {
  console.error(`\n실패: ${err.message}`);
  process.exit(1);
});
