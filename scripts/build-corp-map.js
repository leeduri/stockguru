#!/usr/bin/env node
/**
 * DART 고유번호(corp_code) 매핑과 업종 캐시를 만든다.
 *
 * DART 는 종목코드가 아니라 자체 corp_code 로만 조회할 수 있어서 매핑이 필요하고,
 * 업종은 회사마다 한 번씩 물어봐야 해서 매일 받기엔 아깝다. 둘 다 거의 안 바뀌므로
 * 여기서 만들어 data-cache/ 에 저장해 두고 저장소에 커밋한다. 한 달에 한 번쯤 다시 돌리면 된다.
 *
 *   DART_KEY=... node scripts/build-corp-map.js              # corp_code 매핑만 (요청 1건)
 *   DART_KEY=... node scripts/build-corp-map.js --industry   # 업종까지 (상장사 수만큼 요청)
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'data-cache');
const KEY = process.env.DART_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 단일 파일 ZIP 에서 내용을 꺼낸다. DART 가 corpCode.xml 을 zip 으로 주는데
 * 의존성을 하나 더 들이기엔 과해서 로컬 파일 헤더만 직접 읽는다.
 * (ZIP 로컬 헤더: 0x04034b50, 압축방식 0=저장 8=deflate)
 */
export function unzipSingle(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP 파일이 아닙니다.');
  const method = buf.readUInt16LE(8);
  const flags = buf.readUInt16LE(6);
  let compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;

  // 스트리밍으로 쓴 zip 은 로컬 헤더의 크기가 0 이고 데이터 뒤에 기술자가 붙는다.
  // 그럴 땐 중앙 디렉터리 시작 위치까지를 압축 데이터로 본다.
  if (!compSize || (flags & 0x08)) {
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), start);
    compSize = (cd > start ? cd : buf.length) - start;
  }

  const body = buf.subarray(start, start + compSize);
  return method === 0 ? body : inflateRawSync(body);
}

async function fetchCorpCodes() {
  const res = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${KEY}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  // 키가 틀리면 zip 이 아니라 JSON/XML 오류가 온다
  if (buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`DART 응답이 ZIP 이 아닙니다: ${buf.toString('utf8').slice(0, 200)}`);
  }

  const xml = unzipSingle(buf).toString('utf8');
  const out = [];
  for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const block = m[1];
    const tag = (t) => (block.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1] ?? '').trim();
    const stock = tag('stock_code');
    if (!stock || stock === ' ') continue;              // 상장사만
    out.push({ corpCode: tag('corp_code'), name: tag('corp_name'), stockCode: stock });
  }
  return out;
}

/* ---------------- 업종 ---------------- */

/** 한국표준산업분류 2자리(중분류) 이름. DART 의 induty_code 앞 두 자리를 읽는다. */
const KSIC2 = {
  '01': '농업', '02': '임업', '03': '어업', '05': '석탄 광업', '06': '원유·천연가스',
  '07': '금속 광업', '08': '비금속광물 광업', '10': '식료품', '11': '음료', '12': '담배',
  '13': '섬유제품', '14': '의복·의복액세서리', '15': '가죽·가방·신발', '16': '목재·나무제품',
  '17': '펄프·종이', '18': '인쇄·기록매체', '19': '코크스·석유정제품', '20': '화학물질·화학제품',
  '21': '의료용 물질·의약품', '22': '고무·플라스틱', '23': '비금속 광물제품', '24': '1차 금속',
  '25': '금속가공제품', '26': '전자부품·컴퓨터·통신장비', '27': '의료·정밀·광학기기',
  '28': '전기장비', '29': '기타 기계·장비', '30': '자동차·트레일러', '31': '기타 운송장비',
  '32': '가구', '33': '기타 제품', '34': '산업용 장비 수리', '35': '전기·가스·증기',
  '36': '수도업', '37': '하수·폐수 처리', '38': '폐기물 처리', '39': '환경 정화·복원',
  '41': '종합 건설업', '42': '전문직별 공사업', '45': '자동차 판매', '46': '도매·상품중개',
  '47': '소매업', '49': '육상운송', '50': '수상운송', '51': '항공운송', '52': '창고·운송관련',
  '55': '숙박업', '56': '음식점·주점', '58': '출판업', '59': '영상·오디오물 제작',
  '60': '방송업', '61': '통신업', '62': '컴퓨터 프로그래밍·시스템통합', '63': '정보서비스업',
  '64': '금융업', '65': '보험·연금', '66': '금융·보험 관련 서비스', '68': '부동산업',
  '70': '연구개발업', '71': '전문서비스업', '72': '건축기술·엔지니어링', '73': '기타 과학기술서비스',
  '74': '사업시설 관리', '75': '사업지원 서비스', '76': '임대업', '84': '공공행정',
  '85': '교육 서비스업', '86': '보건업', '87': '사회복지 서비스', '90': '창작·예술·여가',
  '91': '스포츠·오락', '94': '협회·단체', '95': '수리업', '96': '기타 개인 서비스',
};

const industryName = (code) => {
  const c = String(code ?? '').trim();
  if (!c) return null;
  return KSIC2[c.slice(0, 2)] ?? `기타 (${c.slice(0, 2)})`;
};

async function fetchIndustries(companies) {
  const map = {};
  const queue = [...companies];
  let done = 0;
  let fatal = null;

  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length && !fatal) {
      const c = queue.shift();
      try {
        const res = await fetch(
          `https://opendart.fss.or.kr/api/company.json?crtfc_key=${KEY}&corp_code=${c.corpCode}`,
          { signal: AbortSignal.timeout(20_000) },
        );
        const j = await res.json();
        if (j.status && j.status !== '000') {
          if (['010', '011', '020'].includes(j.status)) { fatal = `${j.status} ${j.message}`; break; }
          continue;                                     // 013 등은 그냥 건너뛴다
        }
        const name = industryName(j.induty_code);
        if (name) map[c.stockCode] = name;
      } catch { /* 개별 실패는 건너뛴다 */ }
      if (++done % 200 === 0) console.log(`  업종 조회 ${done}/${companies.length}`);
      await sleep(40);
    }
  }));

  if (fatal) throw new Error(`DART 중단: ${fatal}`);
  return map;
}

/* ---------------- main ---------------- */

async function main() {
  if (!KEY) {
    console.error('DART_KEY 환경변수가 없습니다.\n  예) DART_KEY=발급받은키 node scripts/build-corp-map.js --industry');
    process.exit(1);
  }
  const withIndustry = process.argv.includes('--industry');
  await mkdir(CACHE_DIR, { recursive: true });

  console.log('DART corpCode.xml 내려받는 중…');
  const companies = await fetchCorpCodes();
  console.log(`상장사 ${companies.length}건`);

  const corpMap = Object.fromEntries(companies.map((c) => [c.stockCode, c.corpCode]));
  await writeFile(path.join(CACHE_DIR, 'corp-map.json'), JSON.stringify(corpMap, null, 0));
  console.log(`저장: data-cache/corp-map.json (${Object.keys(corpMap).length}종목)`);

  if (withIndustry) {
    console.log(`업종 조회 시작 — 회사당 요청 1건이라 ${companies.length}건입니다…`);
    const industry = await fetchIndustries(companies);
    await writeFile(path.join(CACHE_DIR, 'industry.json'), JSON.stringify(industry, null, 0));
    const kinds = new Set(Object.values(industry));
    console.log(`저장: data-cache/industry.json (${Object.keys(industry).length}종목 · 업종 ${kinds.size}종)`);
  } else {
    console.log('업종은 건너뜀 (--industry 를 붙이면 함께 만듭니다)');
  }
}

// 직접 실행할 때만 돈다. unzipSingle 을 테스트에서 import 해도 main 이 돌지 않도록.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`실패: ${err.message}`);
    process.exit(1);
  });
}
