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

const state = {
  market: 'all',                 // 'all' | 0 | 1
  type: 0,                       // 0=종목, 1=ETF, 2=ETN
  tab: 'up',                     // up | down | value | volume | cap
  sort: null,                    // 사용자가 열 머리글로 직접 정렬했을 때 { key, dir }
  q: '',
  limit: PAGE,
  stocks: null,
  market_: null,
  lastStamp: null,
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
const fmtChange = (c) => (c > 0 ? '+' : c < 0 ? '−' : '') + fmtInt(Math.abs(c));

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

async function refresh({ silent = false } = {}) {
  if (!silent) document.body.classList.remove('stale');
  try {
    const [m, s] = await Promise.all([loadJSON('market'), loadJSON('stocks')]);
    state.market_ = m;
    state.stocks = s;
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
    val.textContent = ix.close === null ? '—' : ix.close.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // 지수는 소수점 둘째 자리까지가 의미 있는 값이라 반올림하지 않는다
    const pt = Math.abs(ix.change).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const dl = el('div', 'delta ' + d.cls);
    dl.textContent = `${d.mark} ${pt} (${fmtRate(ix.rate)})`;
    dl.setAttribute('aria-label', `전일 대비 ${d.word} ${Math.abs(ix.change)}포인트, ${fmtRate(ix.rate)}`);

    tile.append(lab, val, dl);
    box.append(tile);
  }
}

/* ----- 표 ----- */

const COL = { code: 0, name: 1, market: 2, type: 3, price: 4, change: 5, rate: 6, volume: 7, value: 8, cap: 9 };

const TAB_SORT = {
  up:     { key: 'rate',   dir: -1, label: '등락률 높은 순' },
  down:   { key: 'rate',   dir: 1,  label: '등락률 낮은 순' },
  value:  { key: 'value',  dir: -1, label: '거래대금 많은 순' },
  volume: { key: 'volume', dir: -1, label: '거래량 많은 순' },
  cap:    { key: 'cap',    dir: -1, label: '시가총액 큰 순' },
};

function filtered() {
  const rows = state.stocks.rows;
  const q = state.q.trim().toLowerCase();
  const mkt = state.market;
  const ty = state.type;

  const out = [];
  for (const r of rows) {
    if (r[COL.type] !== ty) continue;
    if (mkt !== 'all' && r[COL.market] !== mkt) continue;
    if (q && !(r[COL.name].toLowerCase().includes(q) || r[COL.code].includes(q))) continue;
    out.push(r);
  }

  const s = state.sort ?? TAB_SORT[state.tab];
  const i = COL[s.key];
  if (s.key === 'name') {
    out.sort((a, b) => s.dir * a[i].localeCompare(b[i], 'ko'));
  } else {
    out.sort((a, b) => s.dir * (a[i] - b[i]));
  }
  return out;
}

function renderTable() {
  const rows = filtered();
  const body = $('#tbody');
  body.textContent = '';

  const shown = rows.slice(0, state.limit);
  const TYPE_TAG = { 1: 'ETF', 2: 'ETN' };

  if (!shown.length) {
    const tr = el('tr');
    const td = el('td');
    td.colSpan = 8;
    td.className = 'empty';
    td.textContent = state.q ? `"${state.q}"에 해당하는 종목이 없습니다.` : '표시할 종목이 없습니다.';
    tr.append(td);
    body.append(tr);
  }

  shown.forEach((r, idx) => {
    const d = dir(r[COL.rate]);
    const tr = el('tr');

    const rank = el('td', 'rank');
    rank.textContent = idx + 1;

    const name = el('td', 'name');
    const nm = el('span', 'nm');
    nm.textContent = r[COL.name];
    const cd = el('span', 'cd');
    cd.textContent = r[COL.code];
    name.append(nm, cd);
    if (TYPE_TAG[r[COL.type]]) {
      const tag = el('span', 'tag');
      tag.textContent = TYPE_TAG[r[COL.type]];
      name.append(tag);
    }

    const price = el('td');
    price.textContent = fmtInt(r[COL.price]);

    const chg = el('td', d.cls);
    chg.textContent = `${d.mark} ${fmtInt(Math.abs(r[COL.change]))}`;

    const rate = el('td', d.cls);
    rate.textContent = fmtRate(r[COL.rate]);

    const vol = el('td');
    vol.textContent = fmtVol(r[COL.volume]);

    const val = el('td');
    val.textContent = fmtWon(r[COL.value]);

    const cap = el('td');
    cap.textContent = fmtWon(r[COL.cap]);

    tr.append(rank, name, price, chg, rate, vol, val, cap);
    body.append(tr);
  });

  const s = state.sort ?? TAB_SORT[state.tab];
  $('#rankSub').textContent =
    `${rows.length.toLocaleString('ko-KR')}개 · ${state.sort ? '직접 정렬' : TAB_SORT[state.tab].label}`;

  $('#more').hidden = rows.length <= state.limit;
  $('#moreBtn').textContent = `더 보기 (${Math.min(PAGE, rows.length - state.limit)}개)`;

  document.querySelectorAll('th.sortable').forEach((th) => {
    const key = th.dataset.sort;
    if (key === s.key) {
      th.setAttribute('aria-sort', s.dir === -1 ? 'descending' : 'ascending');
      th.querySelector('.arrow').textContent = s.dir === -1 ? '▼' : '▲';
    } else {
      th.removeAttribute('aria-sort');
      th.querySelector('.arrow').textContent = '';
    }
  });
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
      const group = btn.parentElement.querySelectorAll(`[data-${attr}]`);
      group.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      onPick(btn.dataset[attr]);
      state.limit = PAGE;
      if (state.stocks) renderTable();
    });
  });
}

bindSeg('market', (v) => { state.market = v === 'all' ? 'all' : Number(v); });
bindSeg('type', (v) => { state.type = Number(v); });
bindSeg('tab', (v) => { state.tab = v; state.sort = null; });

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

document.querySelectorAll('th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    const cur = state.sort ?? TAB_SORT[state.tab];
    // 같은 열을 다시 누르면 방향만 뒤집는다. 이름은 오름차순부터.
    state.sort = { key, dir: cur.key === key ? -cur.dir : (key === 'name' ? 1 : -1) };
    state.limit = PAGE;
    renderTable();
  });
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
setInterval(() => refresh({ silent: true }), REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh({ silent: true });
});
