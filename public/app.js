/* =========================================================================
   한국주식 대시보드 — 화면 로직
   GitHub Actions 가 구워 둔 data/*.json 만 읽는다. 외부 API 를 직접 부르지
   않으므로 CORS 문제도, 키 노출도 없다.
   ========================================================================= */
'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

const PAGE = 50;                 // 한 번에 보여줄 행 수
const REFRESH_MS = 60_000;       // 배포 주기(5분)보다 짧게 훑어 새 파일을 빨리 잡는다
const LIMIT_RATE = 29.5;         // 상한가·하한가 판정 (수집 스크립트와 같은 기준)
const BAR_SCALE = 30;            // 등락률 막대는 ±30%(가격제한폭) 고정 눈금 — 필터를 바꿔도 길이가 흔들리지 않는다

const state = {
  market: 'all',                 // 'all' | 0 | 1
  type: 0,                       // 0=종목, 1=ETF, 2=ETN
  tab: 'up',                     // up | down | value | volume | cap | flow
  who: 'foreign',                // 수급 탭: foreign | organ
  fdir: 'buy',                   // 수급 탭: buy | sell
  days: 1,                       // 수급 탭: 연속 최소 일수 (1=당일)
  sort: null,                    // 열 머리글로 직접 정렬했을 때 { key, dir }
  q: '',
  limit: PAGE,
  stocks: null,
  market_: null,
  flowMap: null,                 // code -> flows.json 의 한 행
  flowMeta: null,
};

/* ---------------- 숫자 포맷 ---------------- */

const nf = new Intl.NumberFormat('ko-KR');
const fmtInt = (n) => nf.format(Math.round(n));

/** 원 단위 금액을 조/억 으로 줄여 쓴다 */
function fmtWon(won) {
  const a = Math.abs(won);
  if (a >= 1e12) {
    const jo = won / 1e12;
    return (a >= 1e13 ? fmtInt(jo) : jo.toFixed(1).replace(/\.0$/, '')) + '조';
  }
  if (a >= 1e8) return fmtInt(won / 1e8) + '억';
  if (a >= 1e4) return fmtInt(won / 1e4) + '만';
  return fmtInt(won);
}

/** 거래량(주) */
function fmtVol(v) {
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, '') + '억';
  if (a >= 1e4) return fmtInt(v / 1e4) + '만';
  return fmtInt(v);
}

const fmtRate = (r) => (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(2) + '%';

/** 등락 방향 → 글리프 + 클래스. 색만으로 뜻을 전하지 않기 위해 항상 글리프를 붙인다 */
function dir(v) {
  if (v > 0) return { cls: 'up', mark: '▲', word: '상승' };
  if (v < 0) return { cls: 'down', mark: '▼', word: '하락' };
  return { cls: 'flat', mark: '−', word: '보합' };
}

/* ---------------- 데이터 ---------------- */

async function loadJSON(name) {
  // Pages CDN 이 10분 캐시를 걸기 때문에 분 단위 버스터를 붙인다
  const bust = Math.floor(Date.now() / 60_000);
  const res = await fetch(`data/${name}.json?v=${bust}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${name}.json 응답 ${res.status}`);
  return res.json();
}

async function refresh() {
  try {
    const [m, s, f] = await Promise.all([
      loadJSON('market'),
      loadJSON('stocks'),
      // 수급은 부가 정보라, 없더라도 나머지 화면은 그대로 띄운다
      loadJSON('flows').catch(() => null),
    ]);
    state.market_ = m;
    state.stocks = s;
    state.flowMap = f ? new Map(f.rows.map((r) => [r[0], r])) : null;
    state.flowMeta = f;
    $('#errBox').innerHTML = '';
    document.body.classList.remove('stale');
    renderAll();
  } catch (err) {
    // 첫 로드 실패면 안내를 띄우고, 갱신 실패면 이전 화면을 흐리게 유지한다
    if (!state.stocks) {
      $('#errBox').innerHTML =
        '<div class="err"><strong>데이터를 불러오지 못했습니다.</strong><br>' +
        '아직 첫 수집이 끝나지 않았거나 일시적인 오류일 수 있습니다. 잠시 후 새로고침해 주세요.<br>' +
        '<span style="color:var(--text-muted)">' + String(err.message).replace(/[<>&]/g, '') + '</span></div>';
      $('#stamp').textContent = '불러오기 실패';
    } else {
      document.body.classList.add('stale');
    }
  }
}

/* ---------------- 렌더 ---------------- */

function renderAll() {
  renderStamp();
  renderTiles();
  renderBreadth();
  renderTable();
  renderHeat();
}

function renderStamp() {
  const m = state.market_;
  const open = m.status === 'OPEN';
  $('#statusDot').classList.toggle('open', open);
  const d = new Date(m.updatedAt);
  const t = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  $('#stamp').textContent = `${open ? '장중' : '장마감'} · ${t} 기준`;
  $('#stamp').title = `수집 시각 ${d.toLocaleString('ko-KR')}`;
}

function renderTiles() {
  const box = $('#tiles');
  box.textContent = '';
  for (const ix of state.market_.indices) {
    const d = dir(ix.rate);
    const tile = el('div', 'tile');

    const lab = el('div', 'label');
    lab.textContent = ix.name;

    const val = el('div', 'value');
    val.textContent = ix.close === null ? '—'
      : ix.close.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // 지수는 소수점 둘째 자리까지가 의미 있는 값이라 반올림하지 않는다
    const pt = Math.abs(ix.change).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const dl = el('div', 'delta ' + d.cls);
    dl.textContent = `${d.mark} ${pt} (${fmtRate(ix.rate)})`;
    dl.setAttribute('aria-label', `전일 대비 ${d.word} ${pt}포인트, ${fmtRate(ix.rate)}`);

    tile.append(lab, val, dl);
    box.append(tile);
  }
}

/* ----- 시장 온도계 ----- */

function renderBreadth() {
  const b = state.market_.breadth;
  if (!b) return;

  // 상한가·하한가는 그날 장세에서 가장 먼저 눈에 들어와야 할 숫자
  const lim = $('#limits');
  lim.textContent = '';
  for (const [label, n, cls] of [['상한가', b.all.limitUp, 'up'], ['하한가', b.all.limitDown, 'down']]) {
    const s = el('span');
    const l = el('span', 'lbl');
    l.textContent = label;
    const v = el('b', n > 0 ? cls : 'flat');
    v.textContent = fmtInt(n);
    s.append(l, v);
    lim.append(s);
  }

  const box = $('#breadth');
  box.textContent = '';

  for (const [name, t] of [['코스피', b.kospi], ['코스닥', b.kosdaq]]) {
    const total = t.up + t.flat + t.down || 1;
    const row = el('div', 'br-row');

    const mkt = el('div', 'mkt');
    mkt.textContent = name;

    const bar = el('div', 'br-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label',
      `${name} 상승 ${t.up}종목, 보합 ${t.flat}종목, 하락 ${t.down}종목`);

    for (const [cls, n, word] of [['s-up', t.up, '상승'], ['s-flat', t.flat, '보합'], ['s-down', t.down, '하락']]) {
      if (!n) continue;
      const pct = (n / total) * 100;
      const seg = el('div', 'br-seg ' + cls);
      seg.style.width = pct + '%';
      // 칸이 좁으면 숫자를 넣지 않는다 — 잘린 라벨보다 빈 칸이 낫고, 값은 아래 범례에 있다
      if (pct >= 12) seg.textContent = fmtInt(n);
      seg.title = `${word} ${fmtInt(n)}종목 (${pct.toFixed(1)}%)`;
      bar.append(seg);
    }

    const tot = el('div', 'tot');
    tot.textContent = `${fmtInt(total)}종목`;

    row.append(mkt, bar, tot);
    box.append(row);
  }

  // 색만으로 읽히지 않도록 범례를 항상 붙인다
  const lg = el('div', 'br-legend');
  const a = b.all;
  for (const [cls, label, n] of [['k-up', '상승', a.up], ['k-flat', '보합', a.flat], ['k-down', '하락', a.down]]) {
    const s = el('span');
    const i = el('i', cls);
    const txt = document.createTextNode(`${label} ${fmtInt(n)}`);
    s.append(i, txt);
    lg.append(s);
  }
  const ratio = el('span');
  ratio.style.color = 'var(--text-muted)';
  ratio.textContent = `상승 비중 ${((a.up / (a.up + a.flat + a.down || 1)) * 100).toFixed(0)}%`;
  lg.append(ratio);
  box.append(lg);
}

/* ----- 표 ----- */

const COL = { code: 0, name: 1, market: 2, type: 3, price: 4, change: 5, rate: 6, volume: 7, value: 8, cap: 9 };
const FLOW = {
  foreign: 1, organ: 2, individual: 3, holdRatio: 4, foreignQty: 5, organQty: 6,
  fStreak: 7, fSum: 8, oStreak: 9, oSum: 10, histLen: 11,
};

const isFlowTab = () => state.tab === 'flow';
const isOrgan = () => state.who === 'organ';
const whoLabel = () => (isOrgan() ? '기관' : '외국인');
const dirLabel = () => (state.fdir === 'sell' ? '순매도' : '순매수');
/** 순매도는 값이 음수라, 큰 순매도가 위로 오려면 오름차순이어야 한다 */
const dirSign = () => (state.fdir === 'sell' ? 1 : -1);

const idxToday = () => (isOrgan() ? FLOW.organ : FLOW.foreign);
const idxQty = () => (isOrgan() ? FLOW.organQty : FLOW.foreignQty);
const idxStreak = () => (isOrgan() ? FLOW.oStreak : FLOW.fStreak);
const idxSum = () => (isOrgan() ? FLOW.oSum : FLOW.fSum);

function tabSort() {
  if (isFlowTab()) {
    return {
      key: state.days > 1 ? 'sum' : 'flow',
      dir: dirSign(),
      label: state.days > 1 ? '누적 순매수 많은 순' : `당일 ${dirLabel()} 많은 순`,
    };
  }
  return {
    up:     { key: 'rate',   dir: -1, label: '등락률 높은 순' },
    down:   { key: 'rate',   dir: 1,  label: '등락률 낮은 순' },
    value:  { key: 'value',  dir: -1, label: '거래대금 많은 순' },
    volume: { key: 'volume', dir: -1, label: '거래량 많은 순' },
    cap:    { key: 'cap',    dir: -1, label: '시가총액 큰 순' },
  }[state.tab];
}

/** 행의 정렬 키 값. flow/streak/sum 은 현재 선택한 주체 기준 */
function valueOf(row, key) {
  const f = state.flowMap?.get(row[COL.code]);
  if (key === 'flow') return f ? f[idxToday()] : 0;
  if (key === 'sum') return f ? f[idxSum()] : 0;
  if (key === 'streak') return f ? f[idxStreak()] : 0;
  return row[COL[key]];
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  const flowTab = isFlowTab();
  const wantSign = state.fdir === 'sell' ? -1 : 1;

  const out = [];
  for (const r of state.stocks.rows) {
    if (r[COL.type] !== state.type) continue;
    if (state.market !== 'all' && r[COL.market] !== state.market) continue;
    if (q && !(r[COL.name].toLowerCase().includes(q) || r[COL.code].includes(q))) continue;

    if (flowTab) {
      // 수급 탭에서는 수집 대상(거래대금 상위)만 의미가 있다
      const f = state.flowMap?.get(r[COL.code]);
      if (!f) continue;
      // 연속일수가 방향과 같은 부호이고, 요구한 일수 이상이어야 한다
      const streak = f[idxStreak()];
      if (Math.sign(streak) !== wantSign) continue;
      if (Math.abs(streak) < state.days) continue;
    }
    out.push(r);
  }

  const s = state.sort ?? tabSort();
  if (s.key === 'name') {
    out.sort((a, b) => s.dir * a[COL.name].localeCompare(b[COL.name], 'ko'));
  } else {
    out.sort((a, b) => s.dir * (valueOf(a, s.key) - valueOf(b, s.key)));
  }
  return out;
}

/* 열 구성 — 수급 탭에서는 거래량·시가총액을 접고 수급 열을 편다 */
function columns() {
  const flow = isFlowTab();
  const cols = [
    { key: null, label: '#', cls: 'rank' },
    { key: 'name', label: '종목', cls: 'name' },
    { key: 'rate', label: '등락률', cls: 'c-rate c-key' },
    { key: 'price', label: '현재가', cls: '' },
    { key: 'change', label: '전일대비', cls: 'c-sub' },
    { key: 'value', label: '거래대금', cls: flow ? 'c-sub' : 'c-key' },
  ];
  if (flow) {
    cols.push(
      { key: 'flow', label: `당일 ${dirLabel()}`, cls: 'c-sub' },
      { key: 'streak', label: '연속', cls: '' },
      { key: 'sum', label: `누적 ${dirLabel()}`, cls: 'c-key' },
    );
  } else {
    cols.push(
      { key: 'volume', label: '거래량', cls: 'c-sub' },
      { key: 'cap', label: '시가총액', cls: 'c-sub' },
    );
  }
  return cols;
}

/** 등락률 강도 막대 — ±30% 고정 눈금 */
function rateBar(rate) {
  const bar = el('span', 'bar');
  const fill = el('i', rate < 0 ? 'f-down' : 'f-up');
  fill.style.width = Math.min(100, (Math.abs(rate) / BAR_SCALE) * 100) + '%';
  bar.append(fill);
  bar.setAttribute('aria-hidden', 'true');   // 값은 바로 옆 숫자가 이미 말한다
  return bar;
}

/** 셀 하나를 그린다 */
function renderCell(col, r, idx) {
  const rate = r[COL.rate];
  const d = dir(rate);
  const f = state.flowMap?.get(r[COL.code]);

  switch (col.key) {
    case null: {
      const td = el('td', 'rank');
      td.textContent = idx + 1;
      return td;
    }
    case 'name': {
      const td = el('td', 'name');
      const nm = el('span', 'nm');
      nm.textContent = r[COL.name];
      const cd = el('span', 'cd');
      cd.textContent = r[COL.code];
      td.append(nm, cd);
      const TYPE_TAG = { 1: 'ETF', 2: 'ETN' };
      if (TYPE_TAG[r[COL.type]]) {
        const tag = el('span', 'tag');
        tag.textContent = TYPE_TAG[r[COL.type]];
        td.append(tag);
      }
      if (rate >= LIMIT_RATE || rate <= -LIMIT_RATE) {
        const bg = el('span', 'limit ' + (rate > 0 ? 'limit-up' : 'limit-down'));
        bg.textContent = rate > 0 ? '상한가' : '하한가';
        td.append(bg);
      }
      return td;
    }
    case 'rate': {
      const td = el('td', 'c-rate');
      const cell = el('span', 'rate-cell');
      const n = el('span', 'rate-num ' + d.cls);
      n.textContent = `${d.mark} ${Math.abs(rate).toFixed(2)}%`;
      cell.append(n, rateBar(rate));
      td.append(cell);
      return td;
    }
    case 'price': {
      const td = el('td');
      td.textContent = fmtInt(r[COL.price]);
      return td;
    }
    case 'change': {
      const td = el('td', 'c-sub ' + d.cls);
      td.textContent = `${d.mark} ${fmtInt(Math.abs(r[COL.change]))}`;
      return td;
    }
    case 'value': {
      const td = el('td', col.cls);
      td.textContent = fmtWon(r[COL.value]);
      return td;
    }
    case 'volume': {
      const td = el('td', 'c-sub');
      td.textContent = fmtVol(r[COL.volume]);
      return td;
    }
    case 'cap': {
      const td = el('td', 'c-sub');
      td.textContent = fmtWon(r[COL.cap]);
      return td;
    }
    case 'flow': {
      const amount = f ? f[idxToday()] : 0;
      const fd = dir(amount);
      const td = el('td', 'c-sub ' + fd.cls);
      td.textContent = `${fd.mark} ${fmtWon(Math.abs(amount))}`;
      td.title = `${whoLabel()} 당일 순${amount < 0 ? '매도' : '매수'} ${fmtInt(Math.abs(f ? f[idxQty()] : 0))}주`;
      return td;
    }
    case 'streak': {
      const n = f ? f[idxStreak()] : 0;
      const td = el('td');
      const pill = el('span', 'streak ' + (n > 0 ? 'up' : n < 0 ? 'down' : 'flat'));
      pill.textContent = `${Math.abs(n)}일`;
      // 응답이 10영업일치라 그 이상은 알 수 없다 — 잘렸으면 그렇다고 말한다
      const capped = f && Math.abs(n) >= (f[FLOW.histLen] ?? 10);
      if (capped) pill.textContent += '+';
      pill.title = `${whoLabel()} ${Math.abs(n)}일 연속 순${n < 0 ? '매도' : '매수'}` +
        (capped ? ` (확보한 ${f[FLOW.histLen]}영업일 전체 — 실제로는 더 길 수 있음)` : '');
      td.append(pill);
      return td;
    }
    case 'sum': {
      const amount = f ? f[idxSum()] : 0;
      const fd = dir(amount);
      const td = el('td', 'c-key ' + fd.cls);
      td.textContent = `${fd.mark} ${fmtWon(Math.abs(amount))}`;
      td.title = `연속 기간 ${whoLabel()} 순${amount < 0 ? '매도' : '매수'} 누적 추정금액`;
      return td;
    }
    default:
      return el('td');
  }
}

function renderTable() {
  const rows = filtered();
  const cols = columns();
  const s = state.sort ?? tabSort();

  // 머리글 — 열 구성이 탭에 따라 달라져 매번 다시 그린다
  const head = $('#thead');
  head.textContent = '';
  for (const col of cols) {
    const th = el('th', col.cls + (col.key ? ' sortable' : ''));
    th.scope = 'col';
    th.append(document.createTextNode(col.label));
    if (col.key) {
      th.dataset.sort = col.key;
      const arrow = el('span', 'arrow');
      if (col.key === s.key) {
        th.setAttribute('aria-sort', s.dir === -1 ? 'descending' : 'ascending');
        arrow.textContent = s.dir === -1 ? '▼' : '▲';
      }
      th.append(arrow);
      th.addEventListener('click', () => {
        const cur = state.sort ?? tabSort();
        // 같은 열을 다시 누르면 방향만 뒤집는다. 이름은 오름차순부터.
        state.sort = { key: col.key, dir: cur.key === col.key ? -cur.dir : (col.key === 'name' ? 1 : -1) };
        state.limit = PAGE;
        renderTable();
      });
    }
    head.append(th);
  }

  const hint = $('#tabHint');
  if (isFlowTab()) {
    hint.hidden = false;
    hint.textContent =
      `거래대금 상위 ${fmtInt(state.flowMeta?.universe ?? 500)}종목만 수집합니다. ` +
      `금액은 순매수 수량 × 종가로 추정한 값이고, 연속일수는 최근 ${state.flowMeta?.maxStreak ?? 10}영업일까지만 셀 수 있습니다.`;
  } else {
    hint.hidden = true;
  }

  const body = $('#tbody');
  body.textContent = '';
  const shown = rows.slice(0, state.limit);

  if (!shown.length) {
    const tr = el('tr');
    const td = el('td');
    td.colSpan = cols.length;
    td.className = 'empty';
    td.textContent = state.q
      ? `"${state.q}"에 해당하는 종목이 없습니다.`
      : isFlowTab()
        ? `${whoLabel()}이 ${state.days}일 연속 ${dirLabel()}한 종목이 없습니다.`
        : '표시할 종목이 없습니다.';
    tr.append(td);
    body.append(tr);
  }

  shown.forEach((r, idx) => {
    const tr = el('tr');
    for (const col of cols) tr.append(renderCell(col, r, idx));
    body.append(tr);
  });

  const what = isFlowTab()
    ? `${whoLabel()} ${state.days > 1 ? `${state.days}일 연속 ` : '당일 '}${dirLabel()}`
    : '';
  $('#rankSub').textContent =
    (what ? what + ' · ' : '') +
    `${rows.length.toLocaleString('ko-KR')}개 · ${state.sort ? '직접 정렬' : tabSort().label}`;

  $('#more').hidden = rows.length <= state.limit;
  $('#moreBtn').textContent = `더 보기 (${Math.min(PAGE, rows.length - state.limit)}개)`;
}

/* ----- 업종 히트맵 ----- */

/** 등락률 → 고정 구간(7단계). 날마다 눈금이 바뀌지 않아야 어제와 비교가 된다 */
function bin(rate) {
  if (rate >= 3) return 'b-up3';
  if (rate >= 1) return 'b-up2';
  if (rate >= 0.2) return 'b-up1';
  if (rate > -0.2) return 'b-flat';
  if (rate > -1) return 'b-dn1';
  if (rate > -3) return 'b-dn2';
  return 'b-dn3';
}

function renderHeat() {
  const list = [...state.market_.industries].sort((a, b) => b.rate - a.rate);
  const box = $('#heat');
  box.textContent = '';

  for (const g of list) {
    const d = dir(g.rate);
    const cell = el('div', 'cell ' + bin(g.rate));
    cell.tabIndex = 0;
    cell.setAttribute('role', 'img');
    cell.setAttribute('aria-label',
      `${g.name}, ${d.word} ${fmtRate(g.rate)}, 전체 ${g.total}개 중 상승 ${g.up}개 하락 ${g.down}개 보합 ${g.flat}개`);

    const nm = el('div', 'nm');
    nm.textContent = g.name;
    const rt = el('div', 'rt');
    rt.textContent = `${d.mark} ${Math.abs(g.rate).toFixed(2)}%`;
    cell.append(nm, rt);

    cell._data = g;
    box.append(cell);
  }

  // 표로 보기 (히트맵의 동등한 대체 표현)
  const tb = $('#heatTbody');
  tb.textContent = '';
  list.forEach((g, i) => {
    const d = dir(g.rate);
    const tr = el('tr');
    const cells = [
      ['rank', i + 1],
      ['name', g.name],
      [d.cls, `${d.mark} ${fmtRate(g.rate)}`],
      ['', fmtInt(g.up)],
      ['', fmtInt(g.down)],
      ['', fmtInt(g.flat)],
      ['', fmtInt(g.total)],
    ];
    for (const [cls, text] of cells) {
      const td = el('td', cls);
      td.textContent = text;
      tr.append(td);
    }
    tb.append(tr);
  });

  const rising = list.filter((g) => g.rate > 0).length;
  $('#heatSub').textContent = `${list.length}개 업종 · 상승 ${rising} / 하락 ${list.length - rising}`;
}

/* ---------------- 툴팁 ---------------- */

const tip = $('#tip');

function showTip(g, x, y) {
  const d = dir(g.rate);
  tip.innerHTML = '';
  const nm = el('div', 't-nm');
  nm.textContent = g.name;
  const r1 = el('div', 't-row');
  r1.textContent = `등락률 ${d.mark} ${fmtRate(g.rate)}`;
  const r2 = el('div', 't-row');
  r2.textContent = `상승 ${g.up} · 하락 ${g.down} · 보합 ${g.flat} (총 ${g.total}개)`;
  tip.append(nm, r1, r2);

  tip.dataset.show = '1';
  const box = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, x + 14), window.innerWidth - box.width - 8);
  const top = y + box.height + 20 > window.innerHeight ? y - box.height - 12 : y + 16;
  tip.style.left = left + 'px';
  tip.style.top = Math.max(8, top) + 'px';
}

const hideTip = () => { tip.dataset.show = '0'; };

$('#heat').addEventListener('pointermove', (e) => {
  const cell = e.target.closest('.cell');
  if (cell && cell._data) showTip(cell._data, e.clientX, e.clientY);
  else hideTip();
});
$('#heat').addEventListener('pointerleave', hideTip);
$('#heat').addEventListener('focusin', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell || !cell._data) return;
  const r = cell.getBoundingClientRect();
  showTip(cell._data, r.left + r.width / 2, r.bottom - 8);   // 키보드 포커스도 같은 정보를 준다
});
$('#heat').addEventListener('focusout', hideTip);

/* ---------------- 이벤트 ---------------- */

function bindSeg(attr, onPick) {
  document.querySelectorAll(`[data-${attr}]`).forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      btn.parentElement.querySelectorAll(`[data-${attr}]`)
        .forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      onPick(btn.dataset[attr]);
      state.limit = PAGE;
      if (state.stocks) renderTable();
    });
  });
}

bindSeg('market', (v) => { state.market = v === 'all' ? 'all' : Number(v); });
bindSeg('type', (v) => { state.type = Number(v); });
bindSeg('tab', (v) => {
  state.tab = v;
  state.sort = null;
  // 수급은 주식만 있어 ETF·ETN 선택이 의미가 없다 — 종목으로 되돌리고 잠근다
  const lock = isFlowTab();
  $('#flowFilters').hidden = !lock;
  $('#typeSeg').querySelectorAll('[data-type]').forEach((b) => {
    const isStock = b.dataset.type === '0';
    b.disabled = lock && !isStock;
    if (lock) b.setAttribute('aria-pressed', String(isStock));
  });
  if (lock) state.type = 0;
});

// 수급 탭 하위 필터 — 어느 것을 바꾸든 정렬 기준이 따라 바뀌므로 직접 정렬은 해제한다
bindSeg('who', (v) => { state.who = v; state.sort = null; });
bindSeg('fdir', (v) => { state.fdir = v; state.sort = null; });
bindSeg('days', (v) => { state.days = Number(v); state.sort = null; });

let qTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    state.q = e.target.value;
    state.limit = PAGE;
    if (state.stocks) renderTable();
  }, 150);
});

$('#moreBtn').addEventListener('click', () => {
  state.limit += PAGE;
  renderTable();
});

$('#heatViewBtn').addEventListener('click', (e) => {
  const asTable = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(asTable));
  e.currentTarget.textContent = asTable ? '히트맵으로 보기' : '표로 보기';
  $('#heat').hidden = asTable;
  $('#heatTable').hidden = !asTable;
  hideTip();
});

/* 화면 모드 — 저장된 선택이 OS 설정을 이긴다 */
const applyTheme = (t) => {
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
};
applyTheme(localStorage.getItem('theme'));
$('#themeBtn').addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
    || (!document.documentElement.hasAttribute('data-theme')
        && matchMedia('(prefers-color-scheme: dark)').matches);
  const next = isDark ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
});

/* ---------------- 시작 ---------------- */

refresh();
setInterval(refresh, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
