/* 금집부쌤의 서울시 아파트 실거래 대시보드 — 프론트엔드 로직 */
'use strict';

const PYEONG = 3.3058;              // 1평 = 3.3058 m²
const RENT_MULT = 100;              // 환산보증금 = 보증금 + 월세 × 100

const state = {
  gu: '강남구',           // 선택된 자치구('all'=전체 서울, 25개 구 합산)
  granularity: 'week',   // 'week' | 'month'
  dong: 'all',           // 'all' | 실제 등장한 법정동 이름(로드 후 동적으로 채워짐)
  indexMode: 'index',    // 'index' | 'price'
  indexVisible: { sale: true, jeonse: true, monthly: true },
  indexView: 'type',     // 'type'=매매/전세/월세 겹쳐보기 | 'gu'=구별 비교 | 'dong'=동별 비교
  cmpType: 'sale',       // 비교 모드에서 비교할 거래 유형
  cmpSel: { gu: [], dong: [] },   // 비교 모드에서 선택된 지역(최대 6개)
  cmpBase: true,         // 기준선(서울시/해당 구 전체 평균) 표시
  cmpGhost: true,        // 선택 안 한 나머지 지역을 옅은 회색으로 함께 표시(큰 흐름 파악용, 기본 켜짐)
  topTab: 'deal',        // TOP10 카드 전환: 'deal' | 'pyeong' | 'rate'
  showRebIndex: false,   // 한국부동산원 공식 지수(구 단위, 분기) 보조 표시 여부
  rebIndex: null,        // { gu, unit, points } | null | 'loading'
  topDealType: 'sale',
  topPyeongType: 'sale',
  rateType: 'sale',
  locKey: null,
  locInfo: null,         // /api/locinfo 결과 캐시(구 단위)
  deals: [],
  raw: null,
  mapRows: [],
  selectedRowIdx: null,
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const won = (manwon) => {
  if (manwon == null) return '-';
  if (manwon >= 10000) {
    const eok = Math.floor(manwon / 10000);
    const rest = Math.round(manwon % 10000);
    return rest ? `${eok}억 ${rest.toLocaleString()}` : `${eok}억`;
  }
  return `${Math.round(manwon).toLocaleString()}`;
};
const comma = (n) => Math.round(n).toLocaleString();
const fmtDate = (iso) => iso.slice(2).replace(/-/g, '.');

/* ─────────────── 날짜 유틸 ─────────────── */
function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function weekStart(iso) {
  const d = new Date(iso + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7;
  return toISO(addDays(d, -dow));
}
function monthStart(iso) { return iso.slice(0, 7) + '-01'; }
function bucketKey(iso) { return state.granularity === 'week' ? weekStart(iso) : monthStart(iso); }
function bucketLabel(key) {
  if (state.granularity === 'month') {
    const [y, m] = key.split('-');
    return `${y.slice(2)}.${m}`;
  }
  const d = new Date(key + 'T00:00:00');
  return `${String(d.getMonth() + 1)}/${String(d.getDate()).padStart(2, '0')}`;
}
// "최근 N개월"의 기준일. 정적 스냅샷 모드에서는 static-shim.js가 스냅샷 종료일(≈오늘)을
// window.__REF_DATE__로 심어 두므로, 빠른 기간 버튼이 자료가 있는 마지막 날에 맞춰진다.
function refDate() {
  const ref = window.__REF_DATE__;
  return ref ? new Date(ref + 'T00:00:00') : new Date();
}

/* ─────────────── 거래 → 파생 값 ─────────────── */
function repAmount(d) {
  if (d.type === 'sale') return d.amount;
  if (d.type === 'jeonse') return d.deposit;
  return d.deposit + d.rent * RENT_MULT;
}
function pyeong(d) { return d.area / PYEONG; }
function perPyeong(d) { return repAmount(d) / pyeong(d); }
function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function filterDong(deals) {
  return state.dong === 'all' ? deals : deals.filter((d) => d.dong === state.dong);
}

/* ─────────────── 데이터 로드 ─────────────── */
async function loadData({ refresh = false } = {}) {
  const start = $('#startDate').value;
  const end = $('#endDate').value;
  if (!start || !end) { showStatus('error', '시작일과 종료일을 선택하세요.'); return; }

  setBusy(true);
  const guLabel = state.gu === 'all' ? '서울시 전체(25개 구)' : state.gu;
  showStatus('loading', `<span class="spinner"></span>${esc(guLabel)} 실거래 데이터를 가져오는 중… (${start} ~ ${end})${state.gu === 'all' ? ' — 전체 서울은 처음 조회 시 다소 오래 걸릴 수 있습니다' : ''}`);

  const url = `/api/deals?gu=${encodeURIComponent(state.gu)}&start=${start}&end=${end}${refresh ? '&refresh=1' : ''}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`);

    state.raw = data;
    state.deals = data.deals;
    state.locInfo = null;
    $('#fetchedAt').innerHTML = `<span class="live-dot"></span>조회 시각 ${data.fetchedAt} · 총 ${data.count.toLocaleString()}건`;

    if (data.count === 0) {
      showStatus('warn', '해당 기간·지역에 아파트 실거래 데이터가 없습니다. 기간이나 구를 바꿔보세요.');
      $('#dash').hidden = true;
      return;
    }
    if (data.errors && data.errors.length) {
      showStatus('warn', `일부 조회에 실패했습니다: ${data.errors.slice(0, 3).join(' / ')}${data.errors.length > 3 ? ` 외 ${data.errors.length - 3}건` : ''}`);
    } else {
      hideStatus();
    }

    syncDongFilter();
    $('#dash').hidden = false;
    initKakaoMapIfPossible();
    loadRebIndex();
    renderAll();
  } catch (err) {
    showStatus('error', `데이터를 불러오지 못했습니다: ${err.message}`);
    $('#dash').hidden = true;
  } finally {
    setBusy(false);
  }
}

// 실제 로드된 데이터에 등장하는 법정동만 필터 버튼으로 생성(하드코딩 목록 없음)
function syncDongFilter() {
  const dongs = [...new Set(state.deals.map((d) => d.dong))].sort();
  if (!dongs.includes(state.dong)) state.dong = 'all';
  const box = $('#dongFilter');
  box.innerHTML = `<button class="seg-btn ${state.dong === 'all' ? 'is-on' : ''}" data-d="all">전체</button>` +
    dongs.map((dn) => `<button class="seg-btn ${state.dong === dn ? 'is-on' : ''}" data-d="${esc(dn)}">${esc(dn)}</button>`).join('');
}

function setBusy(b) {
  $('#loadBtn').disabled = b;
  $('#refreshBtn').disabled = b;
  $('#loadBtn').textContent = b ? '조회 중…' : '조회';
}
function showStatus(kind, html) { const el = $('#status'); el.className = `status ${kind}`; el.innerHTML = html; el.hidden = false; }
function hideStatus() { $('#status').hidden = true; }

/* ─────────────── 렌더 마스터 ─────────────── */
function renderAll() {
  renderKpis();
  renderIndex();
  renderVolume();
  renderTopDeal();
  renderTopPyeong();
  renderRateTop();
  renderLocSummary();
  if (state.locKey) renderLocDetail();
}

/* ─────────────── KPI ─────────────── */
function renderKpis() {
  const deals = filterDong(state.deals);
  const by = (t) => deals.filter((d) => d.type === t);
  const sale = by('sale'), jeonse = by('jeonse'), monthly = by('monthly');

  const medSalePP = median(sale.map(perPyeong));
  const maxSale = sale.reduce((a, d) => (d.amount > (a?.amount ?? -1) ? d : a), null);

  const cards = [
    { label: '총 거래 건수', value: deals.length.toLocaleString(), unit: '건', sub: `${state.raw.start} ~ ${state.raw.end}` },
    { label: '매매 / 전세 / 월세', value: `${sale.length} / ${jeonse.length} / ${monthly.length}`, unit: '건', sub: '유형별 거래 수' },
    { label: '매매 중위 평당가', value: medSalePP ? comma(medSalePP) : '-', unit: '만원', sub: `매매 ${sale.length}건 기준` },
    { label: '최고가 매매', value: maxSale ? won(maxSale.amount) : '-', unit: '', sub: maxSale ? `${maxSale.apt} · ${maxSale.area.toFixed(0)}㎡` : '거래 없음' },
  ];

  $('#kpis').innerHTML = cards.map((c) => `
    <div class="kpi">
      <div class="k-label">${c.label}</div>
      <div class="k-value">${c.value}${c.unit ? `<small>${c.unit}</small>` : ''}</div>
      <div class="k-sub">${c.sub}</div>
    </div>`).join('');
}

/* ─────────────── 1. 가격지수 차트 ─────────────── */
const SERIES = [
  { key: 'sale', label: '매매', color: 'var(--sale)', hex: '#4f8cff' },
  { key: 'jeonse', label: '전세', color: 'var(--jeonse)', hex: '#34d399' },
  { key: 'monthly', label: '월세(환산)', color: 'var(--monthly)', hex: '#fbbf24' },
];

function buildSeries() {
  const deals = filterDong(state.deals);
  const buckets = {};
  for (const d of deals) {
    const k = bucketKey(d.date);
    (buckets[k] ??= { sale: [], jeonse: [], monthly: [] })[d.type].push(perPyeong(d));
  }
  const keys = Object.keys(buckets).sort();
  const out = {};
  for (const s of SERIES) {
    out[s.key] = keys.map((k) => ({ key: k, med: median(buckets[k][s.key]) })).filter((p) => p.med != null);
  }
  return { keys, series: out };
}

function renderIndex() {
  const gran = state.granularity === 'week' ? '주간(월요일 시작) 구간별' : '월간 구간별';
  const modeTxt = state.indexMode === 'index' ? '중위 평당가 지수' : '중위 평당가';

  $$('#indexView .seg-btn').forEach((b) => b.classList.toggle('is-on', b.getAttribute('data-v') === state.indexView));
  $('#cmpPanel').hidden = state.indexView === 'type';

  if (state.indexView === 'type') {
    const regionTxt = state.gu === 'all' ? '서울시 전체' : (state.dong === 'all' ? state.gu : `${state.gu} ${state.dong}`);
    $('#indexSub').textContent = `${gran} ${modeTxt} · ${regionTxt}`;

    const { keys, series } = buildSeries();
    $('#indexLegend').innerHTML = SERIES.map((s) => {
      const n = series[s.key].length;
      const on = state.indexVisible[s.key];
      return `<button type="button" class="lg lg-btn ${on ? 'is-on' : 'is-off'}" data-s="${s.key}">
        <span class="sw" style="background:${s.color}"></span>${s.label} <span class="dim">(${n})</span>
      </button>`;
    }).join('') + rebToggleHtml();

    drawChart(keys, series, SERIES.filter((s) => state.indexVisible[s.key]));
    renderRebIndexPanel();
    return;
  }

  renderCmpIndex(gran, modeTxt);
}

/* ── 구별/동별 비교 모드 ────────────────────────────────────────────
   같은 그래프 위에 여러 지역(자치구 또는 법정동)의 추세를 최대 6개까지 겹쳐 그린다.
   지수(기준=100)는 "각 지역의 첫 거래 구간"을 각각 100으로 잡으므로 선의 기울기끼리 바로 비교된다. */
const CMP_MAX = 6;
const CMP_COLORS = ['#4f7fe6', '#e2703a', '#3f9e6d', '#9b59d0', '#c94f6d', '#2f9bb5'];
const CMP_BASE_KEY = '__base__';       // 기준선(전체 평균) 시리즈 키
const CMP_BASE_COLOR = '#2b3245';
const GHOST_CAP = 40;                  // 회색 참고선은 거래 많은 40곳까지만(선이 너무 많으면 오히려 안 보임)

// "서로 연관성이 있는" 자치구 묶음 — 시장이 함께 움직이는 권역 위주로 미리 넣어둔 빠른 선택
const GU_PRESETS = [
  { label: '강남 3구', gus: ['강남구', '서초구', '송파구'] },
  { label: '마·용·성', gus: ['마포구', '용산구', '성동구'] },
  { label: '노·도·강', gus: ['노원구', '도봉구', '강북구'] },
  { label: '금·관·구', gus: ['금천구', '관악구', '구로구'] },
  { label: '한강벨트', gus: ['광진구', '영등포구', '동작구', '강동구'] },
  { label: '서남권', gus: ['양천구', '강서구', '구로구', '영등포구'] },
  { label: '도심권', gus: ['종로구', '중구', '용산구'] },
];

function cmpSel() { return state.cmpSel[state.indexView] || []; }
function cmpGroupKey(d) {
  if (state.indexView === 'gu') return d.gu;
  return state.gu === 'all' ? `${d.gu} ${d.dong}` : d.dong;
}

// 현재 거래유형 기준으로 비교 가능한 지역과 거래 건수(많은 순)
function cmpGroups() {
  const m = new Map();
  for (const d of state.deals) {
    if (d.type !== state.cmpType) continue;
    const k = cmpGroupKey(d);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()]
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ko'));
}

// 선택이 비었거나(첫 진입) 지금 데이터에 없는 지역만 남았으면 거래가 많은 3곳을 자동 선택한다.
function ensureCmpSel(groups) {
  const valid = new Set(groups.map((g) => g.name));
  let sel = cmpSel().filter((g) => valid.has(g));
  if (!sel.length) sel = groups.slice(0, 3).map((g) => g.name);
  state.cmpSel[state.indexView] = sel;
  return sel;
}

// 기준선 = 지금 불러온 전체 데이터의 구간별 중위 평당가.
//   구별 비교(전체 서울) → "서울시 전체 평균", 동별 비교(예: 서초구) → "서초구 전체 평균"
function cmpBaseLabel() {
  return state.gu === 'all' ? '서울시 전체 평균' : `${state.gu} 전체 평균`;
}

function buildCmpSeries(sel, ghostNames) {
  const all = {};        // 구간 -> 전체 평당가 목록(기준선용)
  const byGroup = {};    // 지역 -> 구간 -> 평당가 목록
  for (const d of state.deals) {
    if (d.type !== state.cmpType) continue;
    const k = bucketKey(d.date);
    (all[k] ??= []).push(perPyeong(d));
    const g = cmpGroupKey(d);
    ((byGroup[g] ??= {})[k] ??= []).push(perPyeong(d));
  }
  // x축은 선택과 무관하게 "전체 데이터가 있는 구간" 기준 — 칩을 눌러도 축이 흔들리지 않는다.
  const keys = Object.keys(all).sort();
  const pick = (m) => keys.map((k) => ({ key: k, med: median(m[k] || []) })).filter((p) => p.med != null);

  const out = {};
  for (const g of sel) out[g] = pick(byGroup[g] || {});
  if (state.cmpBase) out[CMP_BASE_KEY] = pick(all);

  const ghost = {};
  for (const g of (ghostNames || [])) {
    const pts = pick(byGroup[g] || {});
    if (pts.length > 1) ghost[g] = pts;
  }
  return { keys, series: out, ghost };
}

function renderCmpIndex(gran, modeTxt) {
  const guMode = state.indexView === 'gu';
  const typeLabel = SERIES.find((s) => s.key === state.cmpType).label;
  $$('#cmpType .seg-btn').forEach((b) => b.classList.toggle('is-on', b.getAttribute('data-t') === state.cmpType));

  // 구별 비교는 25개 구 데이터가 모두 있어야 의미가 있다(한 구만 조회하면 비교 대상이 하나뿐).
  if (guMode && state.gu !== 'all') {
    $('#indexSub').textContent = `${gran} 자치구별 ${typeLabel} ${modeTxt} 비교`;
    $('#cmpPresets').innerHTML = '';
    $('#cmpToggles').innerHTML = '';
    $('#cmpChips').innerHTML = `<div class="cmp-guide">
      구별 추세를 비교하려면 자치구를 <b>전체 서울(25개 구 합산)</b>로 조회해야 합니다.
      <button type="button" class="cmp-loadall" id="cmpLoadAll">전체 서울로 조회하기</button>
    </div>`;
    $('#cmpHint').textContent = '지금은 ' + state.gu + ' 데이터만 불러온 상태입니다. (동별 비교는 바로 사용할 수 있습니다)';
    $('#indexLegend').innerHTML = '';
    $('#indexChart').innerHTML = '<div class="empty">전체 서울로 조회하면 구별 추세를 겹쳐 비교할 수 있습니다.</div>';
    $('#rebIndexPanel').hidden = true;
    return;
  }

  const groups = cmpGroups();
  const sel = ensureCmpSel(groups);
  const unitTxt = guMode ? '자치구별' : '법정동별';
  const scopeTxt = state.gu === 'all' ? '서울시 전체' : state.gu;
  $('#indexSub').textContent = `${gran} ${unitTxt} ${typeLabel} ${modeTxt} 비교 · ${scopeTxt} · ${sel.length}곳 선택`;

  // 빠른 선택(권역 프리셋 / 거래 상위)
  const presets = guMode
    ? GU_PRESETS.map((p) => ({ label: p.label, names: p.gus.filter((g) => groups.some((x) => x.name === g)) }))
        .filter((p) => p.names.length >= 2)
    : [
        { label: '거래 상위 3곳', names: groups.slice(0, 3).map((g) => g.name) },
        { label: '거래 상위 6곳', names: groups.slice(0, CMP_MAX).map((g) => g.name) },
      ].filter((p) => p.names.length >= 2);
  $('#cmpPresets').innerHTML = presets.map((p, i) =>
    `<button type="button" class="cmp-preset" data-p="${i}">${esc(p.label)}</button>`).join('');
  $('#cmpPresets').__presets = presets;

  // 동이 아주 많은 경우(전체 서울 동별)에는 거래 상위 60곳까지만 칩으로 노출
  const CAP = 60;
  const shown = groups.slice(0, CAP);
  const extraSel = sel.filter((g) => !shown.some((x) => x.name === g));
  const chips = [...shown, ...extraSel.map((g) => ({ name: g, n: 0 }))];
  const full = sel.length >= CMP_MAX;

  $('#cmpChips').innerHTML = chips.map((g) => {
    const i = sel.indexOf(g.name);
    const on = i >= 0;
    const style = on ? ` style="--c:${CMP_COLORS[i % CMP_COLORS.length]}"` : '';
    return `<button type="button" class="cmp-chip ${on ? 'is-on' : ''} ${!on && full ? 'is-dim' : ''}"${style} data-g="${esc(g.name)}">
      ${esc(g.name)}<span class="n">${g.n.toLocaleString()}</span>
    </button>`;
  }).join('') || '<span class="cmp-guide">비교할 거래가 없습니다. 거래유형이나 기간을 바꿔보세요.</span>';

  $('#cmpHint').textContent = `선택 ${sel.length}/${CMP_MAX} · 칩을 클릭해 추가·해제합니다`
    + (groups.length > CAP ? ` (거래 많은 ${CAP}곳만 표시 · 전체 ${groups.length.toLocaleString()}곳)` : '');

  // 기준선(전체 평균)·나머지 참고선 켜고 끄기
  const unitWord = guMode ? '구' : '동';
  $('#cmpToggles').innerHTML = `
    <button type="button" class="cmp-toggle ${state.cmpBase ? 'is-on' : ''}" data-k="base">
      <span class="sw sw-dash"></span>${esc(cmpBaseLabel())} 기준선
    </button>
    <button type="button" class="cmp-toggle ${state.cmpGhost ? 'is-on' : ''}" data-k="ghost">
      <span class="sw sw-ghost"></span>나머지 ${unitWord} 참고선
    </button>`;

  const ghostNames = state.cmpGhost
    ? groups.slice(0, GHOST_CAP).map((g) => g.name).filter((g) => !sel.includes(g))
    : [];

  const defs = sel.map((g, i) => ({ key: g, label: g, color: CMP_COLORS[i % CMP_COLORS.length] }));
  if (state.cmpBase) defs.push({ key: CMP_BASE_KEY, label: cmpBaseLabel(), color: CMP_BASE_COLOR, dash: true });

  $('#indexLegend').innerHTML = (defs.length
    ? defs.map((d) => `<span class="lg"><span class="sw ${d.dash ? 'sw-dash' : ''}" style="${d.dash ? '' : `background:${d.color}`}"></span>${esc(d.label)}</span>`).join('')
    : '<span class="lg dim">아래에서 비교할 지역을 선택하세요</span>')
    + (ghostNames.length ? `<span class="lg dim"><span class="sw sw-ghost"></span>나머지 ${unitWord} ${ghostNames.length}곳 (참고)</span>` : '');

  const { keys, series, ghost } = buildCmpSeries(sel, ghostNames);
  drawChart(keys, series, defs, ghost);
  $('#rebIndexPanel').hidden = true;
}

function rebToggleHtml() {
  if (state.gu === 'all') return '';   // 공식 지수는 구 단위만 지원
  const on = state.showRebIndex;
  return `<button type="button" class="lg lg-btn reb-btn ${on ? 'is-on' : 'is-off'}" id="rebToggleBtn">
    <span class="sw" style="background:#7c3aed"></span>공식(부동산원) 지수 비교
  </button>`;
}

/* keys=x축 구간, series={시리즈키: [{key,med}]}, defs=[{key,label,color,dash?}] (그릴 시리즈 정의),
   ghost={지역: [{key,med}]} (선택 안 된 나머지 지역의 옅은 참고선 — 툴팁에는 안 잡힌다)
   유형별 모드(매매/전세/월세)와 구·동 비교 모드가 같은 렌더러를 공유한다. */
function drawChart(keys, series, defs, ghost) {
  const host = $('#indexChart');
  const cmp = state.indexView !== 'type';
  if (!keys.length) { host.innerHTML = '<div class="empty">표시할 구간이 없습니다.</div>'; return; }

  const visibleSeries = defs;
  if (!visibleSeries.length) {
    host.innerHTML = `<div class="empty">${cmp
      ? '비교할 지역을 하나 이상 선택해 주세요.'
      : '표시할 항목이 없습니다. 위 범례에서 매매·전세·월세 중 하나 이상을 켜주세요.'}</div>`;
    return;
  }

  const toValues = (pts) => {
    if (state.indexMode === 'price') return pts.map((p) => ({ key: p.key, v: p.med }));
    if (!pts.length) return [];
    const base = pts[0].med;
    return pts.map((p) => ({ key: p.key, v: (p.med / base) * 100 }));
  };

  const dataByKey = {};
  const converted = {};
  let vMin = Infinity, vMax = -Infinity;
  for (const s of visibleSeries) {
    converted[s.key] = toValues(series[s.key]);
    for (const p of converted[s.key]) {
      vMin = Math.min(vMin, p.v); vMax = Math.max(vMax, p.v);
      (dataByKey[p.key] ??= {})[s.key] = p.v;
    }
  }
  // 회색 참고선도 y축 범위 계산에는 포함해야 선이 위아래로 잘리지 않는다.
  const ghostConv = {};
  for (const g of Object.keys(ghost || {})) {
    ghostConv[g] = toValues(ghost[g]);
    for (const p of ghostConv[g]) { vMin = Math.min(vMin, p.v); vMax = Math.max(vMax, p.v); }
  }
  if (!isFinite(vMin)) { host.innerHTML = '<div class="empty">표시할 값이 없습니다.</div>'; return; }
  if (state.indexMode === 'index') { vMin = Math.min(vMin, 100); vMax = Math.max(vMax, 100); }

  const pad = (vMax - vMin) * 0.12 || 10;
  vMin -= pad; vMax += pad;
  if (state.indexMode === 'index' && vMin < 0) vMin = 0;

  const W = Math.max(560, keys.length * 46 + 90);
  const H = 340;
  const M = { t: 18, r: 18, b: 48, l: 58 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;

  const x = (i) => M.l + (keys.length === 1 ? iw / 2 : (i / (keys.length - 1)) * iw);
  const y = (v) => M.t + ih - ((v - vMin) / (vMax - vMin)) * ih;
  const xIndex = Object.fromEntries(keys.map((k, i) => [k, i]));

  const ticks = 5;
  let grid = '', yl = '';
  for (let i = 0; i <= ticks; i++) {
    const v = vMin + (i / ticks) * (vMax - vMin);
    const yy = y(v);
    grid += `<line class="gridline" x1="${M.l}" y1="${yy}" x2="${W - M.r}" y2="${yy}"/>`;
    yl += `<text class="axis-txt" x="${M.l - 8}" y="${yy + 4}" text-anchor="end">${state.indexMode === 'index' ? v.toFixed(0) : comma(v)}</text>`;
  }
  let baseLine = '';
  if (state.indexMode === 'index' && vMin <= 100 && vMax >= 100) {
    baseLine = `<line x1="${M.l}" y1="${y(100)}" x2="${W - M.r}" y2="${y(100)}" stroke="var(--txt-mute)" stroke-dasharray="4 4" stroke-width="1"/>
      <text class="axis-txt" x="${W - M.r}" y="${y(100) - 6}" text-anchor="end">기준 100</text>`;
  }

  const step = Math.ceil(keys.length / 12);
  let xl = '';
  keys.forEach((k, i) => {
    if (i % step === 0 || i === keys.length - 1) {
      xl += `<text class="axis-txt" x="${x(i)}" y="${H - M.b + 20}" text-anchor="middle">${bucketLabel(k)}</text>`;
    }
  });

  const dpath = (pts) => pts.map((p, i) => (i ? 'L' : 'M')
    + x(xIndex[p.key]).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');

  // 1) 나머지 지역 참고선을 맨 뒤에 옅게 깔고
  let ghostPaths = '';
  for (const g of Object.keys(ghostConv)) {
    ghostPaths += `<path d="${dpath(ghostConv[g])}" fill="none" stroke="#c9cfda" stroke-width="1.1" stroke-linejoin="round" opacity="0.8"/>`;
  }

  // 2) 선택한 지역·기준선을 그 위에 그린다
  let paths = '', dots = '';
  for (const s of visibleSeries) {
    const pts = converted[s.key];
    if (!pts.length) continue;
    const coords = pts.map((p) => [x(xIndex[p.key]), y(p.v)]);
    if (coords.length > 1) {
      paths += `<path d="${dpath(pts)}" fill="none" stroke="${s.color}" stroke-width="${s.dash ? 2.2 : 2.4}"`
        + `${s.dash ? ' stroke-dasharray="7 5"' : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    pts.forEach((p) => {
      const cx = x(xIndex[p.key]), cy = y(p.v);
      dots += `<circle class="dot" cx="${cx}" cy="${cy}" r="${coords.length === 1 ? 5 : (s.dash ? 2.8 : 3.6)}" fill="${s.color}" stroke="var(--card)" stroke-width="1.5" data-x="${p.key}" data-s="${s.key}" data-v="${p.v.toFixed(2)}"/>`;
    });
  }

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
    ${grid}${baseLine}${yl}${xl}
    <text class="axis-lbl" x="${M.l}" y="12" text-anchor="start">${state.indexMode === 'index' ? '지수' : '만원/평'}</text>
    ${ghostPaths}${paths}${dots}
  </svg>`;

  wireTooltip(host, dataByKey, defs);
}

function getTip(id) {
  let tip = $(`#${id}`);
  if (!tip) { tip = document.createElement('div'); tip.id = id; tip.className = 'tip'; document.body.appendChild(tip); }
  return tip;
}
function placeTip(tip, e) {
  const o = 14;
  let left = e.clientX + o, top = e.clientY + o;
  if (left + 190 > window.innerWidth) left = e.clientX - 190;
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}

function wireTooltip(host, dataByKey, defs) {
  const tip = getTip('chartTip');
  $$('.dot', host).forEach((dot) => {
    dot.addEventListener('mouseenter', (e) => {
      const xk = dot.getAttribute('data-x');
      const row = dataByKey[xk] || {};
      const unit = state.indexMode === 'index' ? '' : ' 만원';
      const body = defs.filter((s) => row[s.key] != null).map((s) =>
        `<div class="tt-row"><span style="color:${s.color}">${esc(s.label)}</span><b>${state.indexMode === 'index' ? row[s.key].toFixed(1) : comma(row[s.key])}${unit}</b></div>`).join('');
      tip.innerHTML = `<div class="tt-title">${state.granularity === 'week' ? '주 시작 ' : ''}${xk}</div>${body}`;
      tip.style.opacity = '1';
      placeTip(tip, e);
    });
    dot.addEventListener('mousemove', (e) => placeTip(tip, e));
    dot.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
  });
}

/* ─────────────── 한국부동산원 공식 지수(구 단위, 분기) ─────────────── */
async function loadRebIndex() {
  state.rebIndex = null;
  if (state.gu === 'all') return;
  state.rebIndex = 'loading';
  try {
    const res = await fetch(`/api/price-index?gu=${encodeURIComponent(state.gu)}`);
    const data = await res.json();
    state.rebIndex = (data && data.points && data.points.length) ? data : null;
  } catch {
    state.rebIndex = null;
  }
  if ($('#indexLegend')) { renderIndex(); }
}

function renderRebIndexPanel() {
  const host = $('#rebIndexPanel');
  if (!host) return;
  if (!state.showRebIndex || state.gu === 'all') { host.hidden = true; return; }
  if (state.rebIndex === 'loading' || state.rebIndex == null) {
    host.hidden = false;
    host.innerHTML = `<p class="note">${state.rebIndex === 'loading' ? '공식 지수를 불러오는 중…' : '이 구는 한국부동산원 공식 지수를 불러오지 못했습니다.'}</p>`;
    return;
  }
  host.hidden = false;
  const pts = state.rebIndex.points;
  const W = Math.max(480, pts.length * 60 + 80), H = 180;
  const M = { t: 14, r: 16, b: 30, l: 50 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const vMin = Math.min(...pts.map((p) => p.value)), vMax = Math.max(...pts.map((p) => p.value));
  const pad = (vMax - vMin) * 0.15 || 5;
  const lo = vMin - pad, hi = vMax + pad;
  const x = (i) => M.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v) => M.t + ih - ((v - lo) / (hi - lo)) * ih;
  const coords = pts.map((p, i) => [x(i), y(p.value)]);
  const dstr = coords.map((c, i) => (i ? 'L' : 'M') + c[0].toFixed(1) + ' ' + c[1].toFixed(1)).join(' ');
  const dots = coords.map((c, i) => `<circle cx="${c[0]}" cy="${c[1]}" r="3.6" fill="#7c3aed"/>
    <text class="axis-txt" x="${c[0]}" y="${H - M.b + 18}" text-anchor="middle">${pts[i].period}</text>`).join('');

  host.innerHTML = `
    <p class="card-sub">📐 ${esc(state.gu)} 공동주택 매매 실거래가격지수(한국부동산원, ${esc(state.rebIndex.unit)}) — 분기별, 구 전체 기준</p>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
      <path d="${dstr}" fill="none" stroke="#7c3aed" stroke-width="2.2" stroke-linejoin="round"/>
      ${dots}
    </svg>`;
}

/* ─────────────── 거래량 추이(막대) ─────────────── */
function renderVolume() {
  const sub = state.granularity === 'week' ? '주간(월요일 시작) 구간별 거래 건수' : '월간 구간별 거래 건수';
  const regionTxt = state.gu === 'all' ? '서울시 전체' : (state.dong === 'all' ? state.gu : `${state.gu} ${state.dong}`);
  $('#volumeSub').textContent = `${sub} · ${regionTxt}`;

  const deals = filterDong(state.deals);
  const buckets = {};
  for (const d of deals) {
    const k = bucketKey(d.date);
    (buckets[k] ??= { sale: 0, jeonse: 0, monthly: 0 })[d.type]++;
  }
  const keys = Object.keys(buckets).sort();

  $('#volumeLegend').innerHTML = SERIES.map((s) => {
    const total = keys.reduce((sum, k) => sum + buckets[k][s.key], 0);
    return `<span class="lg"><span class="sw" style="background:${s.color}"></span>${s.label} <span class="dim">(${total.toLocaleString()}건)</span></span>`;
  }).join('');

  drawVolumeChart(keys, buckets);
}

function drawVolumeChart(keys, buckets) {
  const host = $('#volumeChart');
  if (!keys.length) { host.innerHTML = '<div class="empty">표시할 구간이 없습니다.</div>'; return; }

  const totals = keys.map((k) => SERIES.reduce((sum, s) => sum + buckets[k][s.key], 0));
  const vMax = Math.max(...totals, 1);

  const W = Math.max(560, keys.length * 46 + 90);
  const H = 300;
  const M = { t: 18, r: 18, b: 48, l: 50 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const barW = Math.min(34, (iw / keys.length) * 0.6);

  const x = (i) => M.l + (keys.length === 1 ? iw / 2 : (i / Math.max(1, keys.length - 1)) * iw);
  const y = (v) => M.t + ih - (v / vMax) * ih;

  const ticks = 5;
  let grid = '', yl = '';
  for (let i = 0; i <= ticks; i++) {
    const v = (i / ticks) * vMax;
    const yy = y(v);
    grid += `<line class="gridline" x1="${M.l}" y1="${yy}" x2="${W - M.r}" y2="${yy}"/>`;
    yl += `<text class="axis-txt" x="${M.l - 8}" y="${yy + 4}" text-anchor="end">${Math.round(v)}</text>`;
  }

  const step = Math.ceil(keys.length / 12);
  let xl = '';
  keys.forEach((k, i) => {
    if (i % step === 0 || i === keys.length - 1) {
      xl += `<text class="axis-txt" x="${x(i)}" y="${H - M.b + 20}" text-anchor="middle">${bucketLabel(k)}</text>`;
    }
  });

  let bars = '';
  keys.forEach((k, i) => {
    let yTop = M.t + ih;
    const bx = x(i) - barW / 2;
    for (const s of SERIES) {
      const v = buckets[k][s.key];
      if (!v) continue;
      const h = (v / vMax) * ih;
      const yTopSeg = yTop - h;
      bars += `<rect class="bar-rect" x="${bx.toFixed(1)}" y="${yTopSeg.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}" data-x="${k}"/>`;
      yTop = yTopSeg;
    }
  });

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
    ${grid}${yl}${xl}
    <text class="axis-lbl" x="${M.l}" y="12" text-anchor="start">건수</text>
    ${bars}
  </svg>`;

  wireVolumeTooltip(host, buckets);
}

function wireVolumeTooltip(host, buckets) {
  const tip = getTip('chartTip');
  $$('.bar-rect', host).forEach((rect) => {
    rect.addEventListener('mouseenter', (e) => {
      const xk = rect.getAttribute('data-x');
      const row = buckets[xk] || {};
      const total = SERIES.reduce((sum, s) => sum + (row[s.key] || 0), 0);
      const body = SERIES.filter((s) => row[s.key]).map((s) =>
        `<div class="tt-row"><span style="color:${s.color}">${s.label}</span><b>${row[s.key]}건</b></div>`).join('');
      tip.innerHTML = `<div class="tt-title">${state.granularity === 'week' ? '주 시작 ' : ''}${xk} · 총 ${total}건</div>${body}`;
      tip.style.opacity = '1';
      placeTip(tip, e);
    });
    rect.addEventListener('mousemove', (e) => placeTip(tip, e));
    rect.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
  });
}

/* ─────────────── 2/3. TOP 10 테이블 ─────────────── */
function amountHeader(type) {
  if (type === 'sale') return '매매가';
  if (type === 'jeonse') return '전세보증금';
  return '보증금 / 월세';
}
function amountCell(d) {
  if (d.type === 'sale') return `<span class="big">${won(d.amount)}</span>`;
  if (d.type === 'jeonse') return `<span class="big">${won(d.deposit)}</span>`;
  return `<span class="big">${won(d.deposit)}</span> <span class="dim">/ ${comma(d.rent)}</span>`;
}

function renderTopDeal() {
  const type = state.topDealType;
  const rows = filterDong(state.deals).filter((d) => d.type === type)
    .sort((a, b) => repAmount(b) - repAmount(a)).slice(0, 10);
  state.mapRows = rows;
  state.selectedRowIdx = null;
  renderTopTable($('#topDealTable'), rows, type, 'deal');
  renderGeoMap();
}
function renderTopPyeong() {
  const type = state.topPyeongType;
  const rows = filterDong(state.deals).filter((d) => d.type === type)
    .sort((a, b) => perPyeong(b) - perPyeong(a)).slice(0, 10);
  renderTopTable($('#topPyeongTable'), rows, type, 'pyeong');
}

function renderTopTable(tableEl, rows, type, mode) {
  if (!rows.length) {
    tableEl.innerHTML = `<tbody><tr><td class="empty">해당 유형 거래가 없습니다.</td></tr></tbody>`;
    return;
  }
  const metricHead = mode === 'pyeong' ? '평당가' : amountHeader(type);
  const head = `<thead><tr>
      <th>#</th><th>아파트</th><th>동</th>
      <th class="num">전용</th><th class="num">평</th><th class="num">층</th>
      <th class="num">${metricHead}</th>
      <th class="num">${mode === 'pyeong' ? amountHeader(type) : '평당가'}</th>
      <th>계약일</th>
    </tr></thead>`;

  const body = rows.map((d, i) => {
    const pp = perPyeong(d);
    const rankCls = i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '';
    const metricCell = mode === 'pyeong'
      ? `<span class="big">${comma(pp)}</span> <span class="dim">만원</span>`
      : amountCell(d);
    const secondCell = mode === 'pyeong'
      ? amountCell(d)
      : `<span class="big">${comma(pp)}</span> <span class="dim">만원</span>`;
    const rowAttr = mode === 'deal' ? ` data-i="${i}"` : '';
    return `<tr${rowAttr}>
      <td><span class="rank ${rankCls}">${i + 1}</span></td>
      <td><b>${esc(d.apt)}</b> ${d.buildYear ? `<span class="dim">'${String(d.buildYear).slice(2)}</span>` : ''}</td>
      <td>${dongPill(d.dong)}</td>
      <td class="num">${d.area.toFixed(1)}</td>
      <td class="num">${pyeong(d).toFixed(1)}</td>
      <td class="num">${d.floor || '-'}</td>
      <td class="num">${metricCell}</td>
      <td class="num">${secondCell}</td>
      <td class="dim">${fmtDate(d.date)}</td>
    </tr>`;
  }).join('');

  tableEl.innerHTML = head + `<tbody>${body}</tbody>`;
}

/* ─────────────── 평당가 상승률 TOP 10 ─────────────── */
function renderRateTop() {
  const tableEl = $('#rateTopTable');
  const type = state.rateType;
  const deals = filterDong(state.deals).filter((d) => d.type === type);

  if (!state.raw || !state.raw.start || !state.raw.end) {
    tableEl.innerHTML = `<tbody><tr><td class="empty">데이터가 없습니다.</td></tr></tbody>`;
    return;
  }
  const startMs = new Date(state.raw.start + 'T00:00:00').getTime();
  const endMs = new Date(state.raw.end + 'T00:00:00').getTime();
  const midIso = toISO(new Date((startMs + endMs) / 2));

  const g = {};
  for (const d of deals) {
    const k = `${d.dong}||${d.apt}`;
    (g[k] ??= { dong: d.dong, apt: d.apt, early: [], late: [] });
    (d.date < midIso ? g[k].early : g[k].late).push(perPyeong(d));
  }

  const rows = Object.values(g)
    .map((x) => ({ ...x, nEarly: x.early.length, nLate: x.late.length, medEarly: median(x.early), medLate: median(x.late) }))
    .filter((x) => x.nEarly > 0 && x.nLate > 0)
    .map((x) => ({ ...x, rate: ((x.medLate - x.medEarly) / x.medEarly) * 100 }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 10);

  if (!rows.length) {
    tableEl.innerHTML = `<tbody><tr><td class="empty">비교 가능한 단지가 부족합니다. 기간을 넓혀보세요 (3개월 이상 권장).</td></tr></tbody>`;
    return;
  }

  const head = `<thead><tr>
      <th>#</th><th>아파트</th><th>동</th>
      <th class="num">전반부 평당가</th><th class="num">후반부 평당가</th>
      <th class="num">변동률</th><th class="num">표본(전/후)</th>
    </tr></thead>`;

  const body = rows.map((r, i) => {
    const rankCls = i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '';
    const up = r.rate >= 0;
    return `<tr>
      <td><span class="rank ${rankCls}">${i + 1}</span></td>
      <td><b>${esc(r.apt)}</b></td>
      <td>${dongPill(r.dong)}</td>
      <td class="num">${comma(r.medEarly)} <span class="dim">만원</span></td>
      <td class="num">${comma(r.medLate)} <span class="dim">만원</span></td>
      <td class="num"><span class="rate-badge ${up ? 'is-up' : 'is-down'}">${up ? '▲' : '▼'} ${Math.abs(r.rate).toFixed(1)}%</span></td>
      <td class="num dim">${r.nEarly} / ${r.nLate}</td>
    </tr>`;
  }).join('');

  tableEl.innerHTML = head + `<tbody>${body}</tbody>`;
}

/* ─────────────── 지도: TOP 10 위치(카카오맵) ───────────────
   서울 전역(467개 법정동)을 손으로 그린 개략도로 대체하는 건 비현실적이라
   개략도 폴백 없이 카카오맵만 사용한다. 카카오맵이 못 뜨면 안내 문구만 표시. */
function updateGeoChrome(rows) {
  const dongsShown = new Set(rows.map((d) => d.dong));
  $('#geoLegend').innerHTML = [...dongsShown].map((dn) =>
    `<span class="lg"><span class="sw" style="background:${dongColor(dn)}"></span>${esc(dn)}</span>`).join('')
    || '<span class="lg dim">표시할 거래가 없습니다</span>';

  const resetBtn = $('#geoResetBtn');
  const hint = $('#geoMapHint');
  if (state.dong === 'all') {
    resetBtn.disabled = true;
    hint.textContent = '지도를 드래그·휠로 확대해 보세요';
  } else {
    resetBtn.disabled = false;
    hint.textContent = `${state.dong}으로 확대됨`;
  }
}

function renderGeoMap() {
  if (kakaoReady) return renderKakaoMap();
  const host = $('#geoMap');
  updateGeoChrome(state.mapRows);
  host.hidden = false;
  host.innerHTML = '<div class="empty">지도를 불러오지 못했습니다. 인터넷 연결 또는 카카오맵 도메인 등록을 확인해 주세요.</div>';
}

function amountLabel(d) {
  if (d.type === 'sale') return `${won(d.amount)}만원`;
  if (d.type === 'jeonse') return `${won(d.deposit)}만원`;
  return `${won(d.deposit)}/${comma(d.rent)}만원`;
}

/* ─────────────── 실제 카카오맵 (정확한 좌표) ─────────────── */
let kakaoReady = false;
let kakaoMap = null;
let kakaoOverlays = [];
let kakaoInitStarted = false;
const geoLiveCache = {};   // key: "구|동|단지명"

function buildDongCenters() {
  const sums = {};
  if (typeof GEO_COORDS !== 'undefined') {
    for (const key of Object.keys(GEO_COORDS)) {
      const parts = key.split('|');
      const dong = parts[1] ?? parts[0];
      const c = GEO_COORDS[key];
      const s = (sums[dong] ??= { lat: 0, lng: 0, n: 0 });
      s.lat += c.lat; s.lng += c.lng; s.n += 1;
    }
  }
  const out = {};
  for (const [dong, s] of Object.entries(sums)) out[dong] = { lat: s.lat / s.n, lng: s.lng / s.n };
  return out;
}
let DONG_CENTER = null;

function geoKey(d) { return `${d.gu}|${d.dong}|${d.apt}`; }

let kakaoWaitAttempts = 0;
function initKakaoMapIfPossible() {
  if (kakaoInitStarted) return;
  if (typeof kakao === 'undefined' || !kakao.maps) {
    // 카카오맵 SDK(<script src="https://dapi.kakao.com/...">)는 별도 네트워크 요청이라
    // 데이터 로딩(특히 정적 스냅샷처럼 즉시 응답되는 경우)보다 늦게 끝날 수 있다.
    // 한 번만 확인하고 포기하면 그 경우 지도가 영영 안 뜨므로, 잠시 재시도한다.
    if (kakaoWaitAttempts++ < 40) setTimeout(initKakaoMapIfPossible, 250);
    return;
  }
  kakaoInitStarted = true;
  kakao.maps.load(() => {
    const container = $('#geoMapKakao');
    container.hidden = false;
    $('#geoMap').hidden = true;
    kakaoMap = new kakao.maps.Map(container, {
      center: new kakao.maps.LatLng(37.5665, 126.9780),   // 서울시청 대략 중심
      level: 9,
    });
    kakaoMap.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
    DONG_CENTER = buildDongCenters();
    kakaoReady = true;
    kakaoMap.relayout();
    renderGeoMap();
  });
}

function clearKakaoOverlays() {
  kakaoOverlays.forEach((o) => o.setMap(null));
  kakaoOverlays = [];
}

async function renderKakaoMap() {
  const rows = state.mapRows;
  updateGeoChrome(rows);

  if (!rows.length) {
    clearKakaoOverlays();
    return;
  }

  const need = [];
  const seen = new Set();
  for (const d of rows) {
    const key = geoKey(d);
    const known = (typeof GEO_COORDS !== 'undefined' && GEO_COORDS[key]) || geoLiveCache[key];
    if (known === undefined && !seen.has(key)) { need.push(d); seen.add(key); }
  }
  if (need.length) {
    const items = need.map((d) => ({ gu: d.gu, dong: d.dong, jibun: d.jibun, apt: d.apt }));
    try {
      const res = await fetch(`/api/geocode-batch?items=${encodeURIComponent(JSON.stringify(items))}`);
      const data = await res.json();
      need.forEach((d, i) => { geoLiveCache[geoKey(d)] = data.results[i] || null; });
    } catch {
      need.forEach((d) => { geoLiveCache[geoKey(d)] = null; });
    }
    if (state.mapRows === rows) renderKakaoMap();
    return;
  }

  drawKakaoMarkers(rows);
}

function resolvedPos(d) {
  const key = geoKey(d);
  const c = (typeof GEO_COORDS !== 'undefined' && GEO_COORDS[key]) || geoLiveCache[key];
  return c || null;
}

function drawKakaoMarkers(rows) {
  clearKakaoOverlays();
  const tip = getTip('mapTip');
  const selIdx = state.selectedRowIdx;

  const groups = {};
  const failedIdxs = [];
  rows.forEach((d, i) => {
    const c = resolvedPos(d);
    if (!c) { failedIdxs.push(i); return; }
    const gk = `${c.lat.toFixed(5)}:${c.lng.toFixed(5)}`;
    (groups[gk] ??= { lat: c.lat, lng: c.lng, idxs: [] }).idxs.push(i);
  });
  const groupList = Object.values(groups).map((g) => ({ ...g, idxs: g.idxs.sort((a, b) => a - b) }));

  if (failedIdxs.length) {
    $('#geoMapHint').textContent += ` · ${failedIdxs.length}건은 정확한 위치를 찾지 못해 지도에 표시되지 않았습니다`;
  }

  if (!groupList.length) return;

  const bounds = new kakao.maps.LatLngBounds();
  groupList.forEach((g) => {
    const primary = g.idxs[0];
    const d = rows[primary];
    const isSel = selIdx != null && g.idxs.includes(selIdx);
    const pos = new kakao.maps.LatLng(g.lat, g.lng);
    bounds.extend(pos);
    const color = dongColor(d.dong);

    const el = document.createElement('div');
    el.className = `kmp${isSel ? ' is-sel' : ''}`;
    el.style.setProperty('--c', color);
    el.innerHTML = `<span class="kmp-num">${primary + 1}</span>` +
      (g.idxs.length > 1 ? `<span class="kmp-badge">${g.idxs.length}</span>` : '');
    el.addEventListener('click', () => {
      const already = selIdx != null && g.idxs.includes(selIdx);
      selectTopDealRow(already ? null : primary);
    });
    el.addEventListener('mouseenter', (e) => {
      const body = g.idxs.map((i) => {
        const dd = rows[i];
        return `<div class="tt-row"><span>${i + 1}위</span><b>${amountLabel(dd)} · ${fmtDate(dd.date)}</b></div>`;
      }).join('');
      const countTag = g.idxs.length > 1 ? ` <span class="dim">(${g.idxs.length}건)</span>` : '';
      tip.innerHTML = `<div class="tt-title">${esc(d.apt)}${countTag}</div>${body}`;
      tip.style.opacity = '1';
      placeTip(tip, e);
    });
    el.addEventListener('mousemove', (e) => placeTip(tip, e));
    el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });

    const overlay = new kakao.maps.CustomOverlay({
      position: pos, content: el, yAnchor: 1, xAnchor: 0.5, zIndex: isSel ? 100 : 10,
    });
    overlay.setMap(kakaoMap);
    kakaoOverlays.push(overlay);

    if (isSel) {
      const cal = document.createElement('div');
      cal.className = 'kmp-callout';
      cal.innerHTML = `<b>${esc(d.apt)}</b><br>${esc(`${d.gu} ${d.dong} · ${amountLabel(d)} · ${fmtDate(d.date)}`)}`;
      const calOverlay = new kakao.maps.CustomOverlay({
        position: pos, content: cal, yAnchor: 1.9, xAnchor: 0.5, zIndex: 200,
      });
      calOverlay.setMap(kakaoMap);
      kakaoOverlays.push(calOverlay);
    }
  });

  if (state.dong !== 'all' && groupList.length <= 1 && DONG_CENTER && DONG_CENTER[state.dong]) {
    const c = DONG_CENTER[state.dong];
    kakaoMap.setCenter(new kakao.maps.LatLng(c.lat, c.lng));
    kakaoMap.setLevel(4);
  } else {
    kakaoMap.setBounds(bounds, 60, 60, 60, 60);
  }
}

// TOP10 실거래가 표 ↔ 지도 핀 선택 동기화 (idx=null이면 선택 해제)
function selectTopDealRow(idx) {
  state.selectedRowIdx = idx;
  $$('#topDealTable tbody tr[data-i]').forEach((tr) => {
    tr.classList.toggle('is-selected', Number(tr.getAttribute('data-i')) === idx);
  });
  renderGeoMap();
}

/* ─────────────── 4. 입지분석 (서울 열린데이터광장 + KOSIS 실데이터, 구 단위) ─────────────── */
let locInfoFetchGu = null;      // 현재 요청 중인 구(중복 동시 요청 방지)
let locInfoFetchPromise = null;

async function ensureLocInfo() {
  if (state.locInfo && typeof state.locInfo === 'object' && state.locInfo.gu === state.gu) return state.locInfo;
  if (state.gu === 'all') { state.locInfo = null; return null; }
  if (locInfoFetchGu === state.gu && locInfoFetchPromise) return locInfoFetchPromise;   // 같은 구를 이미 요청 중이면 그 결과 재사용

  const requestedGu = state.gu;
  locInfoFetchGu = requestedGu;
  state.locInfo = 'loading';
  locInfoFetchPromise = (async () => {
    try {
      const res = await fetch(`/api/locinfo?gu=${encodeURIComponent(requestedGu)}`);
      const data = await res.json();
      // 응답이 도착했을 때 이미 다른 구를 보고 있다면(순서가 뒤바뀐 오래된 응답) 무시한다 —
      // 그렇지 않으면 나중에 보낸 최신 요청 결과를 먼저 도착한 옛 요청이 덮어써 버릴 수 있다.
      if (state.gu === requestedGu) state.locInfo = data;
    } catch {
      if (state.gu === requestedGu) state.locInfo = null;
    } finally {
      if (locInfoFetchGu === requestedGu) locInfoFetchGu = null;
    }
    return state.locInfo;
  })();
  return locInfoFetchPromise;
}

function renderLocSummary() {
  const box = $('#locSummary');
  if (state.gu === 'all') {
    box.innerHTML = `<b>서울시 전체</b> — 구를 하나 선택하면 그 구의 실데이터 기반 입지분석을 볼 수 있습니다.`;
    return;
  }
  box.innerHTML = `<b>${esc(state.gu)}</b> — 아래 항목을 클릭하면 서울 열린데이터광장·KOSIS 실데이터 기반 상세 정보가 열립니다.`;
  ensureLocInfo().then(() => { if (state.locKey) renderLocDetail(); });
}

function renderLocDetail() {
  const box = $('#locDetail');
  const key = state.locKey;
  if (!key) { box.hidden = true; return; }
  box.hidden = false;

  if (key === 'data') { box.innerHTML = locDataAnalysis(); return; }
  if (state.gu === 'all') { box.innerHTML = '<p class="intro">구를 하나 선택해 주세요.</p>'; return; }

  const info = state.locInfo;
  // info.gu가 현재 선택된 구와 다르면(구를 막 바꾼 직후의 경쟁 상태) 이전 구 데이터를 그대로 그리지 않고
  // 새로 받아온 뒤 다시 그린다 — 그렇지 않으면 "다른 구인데 이전 구 통계가 그대로 보이는" 버그가 난다.
  if (info === 'loading' || info == null || info.gu !== state.gu) {
    box.innerHTML = '<p class="intro">데이터를 불러오는 중…</p>';
    const requestedGu = state.gu, requestedKey = key;
    ensureLocInfo().then(() => {
      if (state.gu === requestedGu && state.locKey === requestedKey) renderLocDetail();
    });
    return;
  }

  const R = locSectionRenderers(info);
  box.innerHTML = R[key] ? R[key]() : '';
}

function notReadyHtml(title, note) {
  return `<h3>${title}</h3><p class="intro">이 항목은 아직 실데이터 연동 전입니다(추후 제공 예정).</p><div class="caveat">ℹ️ ${esc(note)}</div>`;
}

// 입지분석 6개 탭의 렌더 함수 모음 — 화면(한 번에 하나씩)과 인쇄(전체 한번에) 양쪽에서 공유한다.
function locSectionRenderers(info) {
  return {
    subway: () => renderSubway(info),
    transport: () => renderTransport(info),
    school: () => renderSchool(info),
    life: () => renderLife(info),
    develop: () => notReadyHtml('🏗️ 재건축 · 개발', '정비사업 진행 현황 데이터 소스가 아직 연결되지 않았습니다.'),
    data: () => locDataAnalysis(),
  };
}

// "전체 인쇄" 버튼용 — 입지분석 6개 탭 전부를 한 번에 렌더링해 인쇄물 하나로 완결된 요약이 되게 한다.
async function buildPrintReport() {
  const dongTxt = state.dong === 'all' ? '전체' : state.dong;
  const regionTxt = state.gu === 'all' ? '서울시 전체' : `${state.gu} · ${dongTxt}`;
  const rangeTxt = `조회기간 ${esc($('#startDate').value)} ~ ${esc($('#endDate').value)} · 출력 ${esc(new Date().toLocaleString('ko-KR'))}`;

  // 1페이지 맨 위에 어느 지역·기간 리포트인지 바로 보이도록 배너 하나 넣는다.
  $('#printPageHeader').innerHTML = `<div class="print-page-banner">
    <b>📍 ${esc(regionTxt)}</b> 아파트 실거래 요약 · ${rangeTxt}
  </div>`;

  const header = `<div class="print-report-header">
    <h2>금집부쌤의 서울시 아파트 실거래 대시보드 — 요약 리포트</h2>
    <p>${esc(regionTxt)} · ${rangeTxt}</p>
  </div>`;

  let locHtml = '<p class="intro">구를 하나 선택하면 입지분석 전체 내용이 함께 출력됩니다.</p>';
  if (state.gu !== 'all') {
    const info = await ensureLocInfo();
    if (info && typeof info === 'object') {
      const R = locSectionRenderers(info);
      const order = ['subway', 'transport', 'school', 'life', 'develop', 'data'];
      locHtml = order.map((k) => `<div class="print-loc-block">${R[k]()}</div>`).join('');
    }
  }
  $('#printLocAll').innerHTML = `${header}<h3 class="print-loc-title">5. 입지분석 전체</h3>${locHtml}`;
}

// 지하철역·공원·상권처럼 "이름 클릭 → 상세 펼침" 패턴을 공유하는 공통 헬퍼.
// 데이터 자체를 data-json 속성에 실어두므로(구 단위 목록이라 개수가 적어 가벼움) 별도 인덱스 조회가 필요 없다.
function expandItemHtml(kind, label, data) {
  return `<div class="school-item" data-detail-kind="${kind}" data-json="${esc(JSON.stringify(data))}">
    <button type="button" class="chip school-chip">${esc(label)}</button>
    <div class="school-detail" hidden></div>
  </div>`;
}

function mapLinkRow(name, lat, lng) {
  const url = (lat != null && lng != null)
    ? `https://map.kakao.com/link/map/${encodeURIComponent(name)},${lat},${lng}`
    : `https://map.kakao.com/link/search/${encodeURIComponent(name)}`;
  return `<div class="tt-row"><span>지도</span><b><a href="${url}" target="_blank" rel="noopener">카카오맵에서 보기 ↗</a></b></div>`;
}

function subwayDetailHtml(s) {
  const rows = [];
  if (s.lines && s.lines.length) rows.push(`<div class="tt-row"><span>노선</span><b>${esc(s.lines.join(' · '))}</b></div>`);
  if (s.addr) rows.push(`<div class="tt-row"><span>주소</span><b>${esc(s.addr)}</b></div>`);
  if (s.phone) rows.push(`<div class="tt-row"><span>전화</span><b>${esc(s.phone)}</b></div>`);
  rows.push(mapLinkRow(s.name, s.lat, s.lng));
  return rows.join('');
}

function parkDetailHtml(p) {
  const rows = [];
  if (p.addr) rows.push(`<div class="tt-row"><span>주소</span><b>${esc(p.addr)}</b></div>`);
  if (p.openYmd) rows.push(`<div class="tt-row"><span>개장일</span><b>${esc(p.openYmd)}</b></div>`);
  if (p.tel) rows.push(`<div class="tt-row"><span>전화</span><b>${esc(p.tel)}</b></div>`);
  if (p.mainFclt) rows.push(`<div class="tt-row"><span>주요시설</span><b>${esc(p.mainFclt)}</b></div>`);
  rows.push(mapLinkRow(p.name, p.lat, p.lng));
  return rows.join('');
}

function tradeAreaDetailHtml(t) {
  const rows = [];
  if (t.category) rows.push(`<div class="tt-row"><span>구분</span><b>${esc(t.category)}</b></div>`);
  rows.push(mapLinkRow(t.name, t.lat, t.lng));
  return rows.join('');
}

function renderSubway(info) {
  const stations = info.subway || [];
  if (!stations.length) {
    return `<h3>🚇 지하철 · 역세권</h3><p class="intro">이 구에서 지하철역을 찾지 못했습니다.</p>`;
  }
  const chips = stations.map((s) => expandItemHtml('subway',
    `${s.name} (${s.lines.join(' · ') || '노선 정보 없음'})`, s)).join('');
  return `<h3>🚇 지하철 · 역세권 (카카오맵 실데이터)</h3>
    <p class="intro">${esc(state.gu)} 구청 반경 6km 이내에서 주소가 "${esc(state.gu)}"로 확인된 지하철역 ${stations.length}개입니다.
    역 이름을 클릭하면 상세정보가 열립니다.</p>
    <div class="chips school-chips">${chips}</div>
    <div class="caveat">ℹ️ 구 경계와 정확히 일치하지 않을 수 있고(반경 기반 근사), 승하차 인원 등 이용량 데이터는 아직 연결되지 않았습니다.</div>`;
}

// 칩 라벨 옆에 붙는 구분 태그 — 사립이면 "사립", 고등학교면 유형(자율고 등)도 함께
function schoolTag(sc) {
  const bits = [];
  if (sc.founded === '사립') bits.push('사립');
  if (sc.hsType) bits.push(sc.hsType);
  return bits.length ? ` <span class="dim">(${esc(bits.join('·'))})</span>` : '';
}

const SCHOOL_ORDER = ['초등학교', '중학교', '고등학교'];
function renderSchool(info) {
  const s = info.schools || { count: 0, byKind: {} };
  if (!s.count) {
    return `<h3>🎓 학군 · 교육</h3><p class="intro">이 구에서 학교 정보를 찾지 못했습니다.</p>`;
  }
  const dongFilter = state.dong;   // 'all' | 특정 법정동
  const kinds = [...new Set([...SCHOOL_ORDER, ...Object.keys(s.byKind)])].filter((k) => s.byKind[k]);
  let shownTotal = 0;
  const blocks = kinds.map((k) => {
    const full = s.byKind[k] || [];
    const list = dongFilter === 'all' ? full : full.filter((sc) => sc.dong === dongFilter);
    shownTotal += list.length;
    if (!list.length) return '';
    const items = list.map((sc) => {
      const idx = full.indexOf(sc);
      return `
      <div class="school-item" data-detail-kind="school" data-kind="${esc(k)}" data-idx="${idx}">
        <button type="button" class="chip school-chip">${esc(sc.name)}${schoolTag(sc)}</button>
        <div class="school-detail" hidden></div>
      </div>`;
    }).join('');
    return `<h4>${esc(k)} (${list.length}개)</h4><div class="chips school-chips">${items}</div>`;
  }).join('');

  const scopeTxt = dongFilter === 'all'
    ? `${esc(state.gu)} 전체 소재 학교 총 ${s.count}개`
    : `${esc(state.gu)} ${esc(dongFilter)} 소재 학교 ${shownTotal}개`;
  const emptyMsg = (dongFilter !== 'all' && !shownTotal)
    ? `<p class="intro">${esc(dongFilter)}에 소재지 주소가 일치하는 학교가 없습니다(인접 동 학교를 이용할 수 있음).</p>` : '';

  return `<h3>🎓 학군 · 교육 (NEIS 실데이터)</h3>
    <p class="intro">${scopeTxt}. 학교 이름을 클릭하면 상세정보가 열립니다.</p>
    ${emptyMsg}
    ${blocks}
    <div class="caveat">⚠️ 이 목록은 <b>학교 소재지(주소) 기준</b>이며 실제 배정을 보장하지 않습니다. 초등학교는 통학구역,
      중·고등학교는 서울 상당수 지역에서 근거리 배정+추첨이 혼합되어 있어 동 하나에 특정 학교가 1:1로
      매칭되지 않습니다. 정확한 배정 여부는 반드시 <a href="https://schoolzone.emac.kr" target="_blank" rel="noopener">학구도안내서비스(schoolzone.emac.kr)</a>에서
      실제 주소로 확인하세요.</div>`;
}

function schoolDetailHtml(sc) {
  const rows = [];
  if (sc.addr) rows.push(`<div class="tt-row"><span>주소</span><b>${esc(sc.addr)}</b></div>`);
  if (sc.tel) rows.push(`<div class="tt-row"><span>전화</span><b>${esc(sc.tel)}</b></div>`);
  if (sc.hsType) rows.push(`<div class="tt-row"><span>고교 유형</span><b>${esc(sc.hsType)}</b></div>`);
  if (sc.founded || sc.coedu) rows.push(`<div class="tt-row"><span>구분</span><b>${esc([sc.founded, sc.coedu].filter(Boolean).join(' · '))}</b></div>`);
  if (sc.foundYear) rows.push(`<div class="tt-row"><span>개교</span><b>${esc(sc.foundYear)}년</b></div>`);
  if (sc.homepage) rows.push(`<div class="tt-row"><span>홈페이지</span><b><a href="${esc(sc.homepage.startsWith('http') ? sc.homepage : 'http://' + sc.homepage)}" target="_blank" rel="noopener">${esc(sc.homepage)}</a></b></div>`);
  return rows.join('') || '<div class="tt-row"><span>상세정보 없음</span></div>';
}

function renderTransport(info) {
  const spots = info.hotspots || [];
  if (!spots.length) {
    return `<h3>🛣️ 교통 · 접근성</h3><p class="intro">이 구는 서울시 실시간 도시데이터의 주요 핫스팟 목록에 해당하는 장소가 없습니다.</p>
      <div class="caveat">ℹ️ 서울시가 지정한 120개 주요 장소(강남역·홍대 등) 기준 데이터라 모든 구를 다루지는 못합니다.</div>`;
  }
  const cards = spots.map((s) => {
    const bits = [];
    if (s.congestLvl) bits.push(`인구 혼잡도 <b>${esc(s.congestLvl)}</b>`);
    if (s.pplMin) bits.push(`추정 인구 ${comma(+s.pplMin)}~${comma(+s.pplMax)}명`);
    if (s.roadAvgSpd != null) bits.push(`주변 도로 평균 속도 <b>${s.roadAvgSpd}km/h</b>`);
    if (s.temp != null) bits.push(`기온 ${s.temp}℃`);
    return `<div class="chip"><b>${esc(s.name)}</b><span class="sub">${bits.join(' · ') || '데이터 없음'}</span></div>`;
  }).join('');
  return `<h3>🛣️ 교통 · 접근성 (서울시 실시간 도시데이터)</h3>
    <p class="intro">${esc(state.gu)} 안에 있는 서울시 주요 핫스팟의 실시간 현황입니다. <b>구 전체 교통 상황이 아니라
    아래 특정 장소 기준</b>이니 참고용으로만 봐주세요.</p>
    <div class="chips">${cards}</div>
    <div class="caveat">ℹ️ 서울시가 지정한 120개 주요 장소 중 이 구에 있는 곳만 표시하며, 10분 주기로 갱신됩니다.</div>`;
}

function renderLife(info) {
  const parks = info.parks || { count: 0, sample: [] };
  const areas = info.tradeAreas || { count: 0, sample: [] };
  const pop = info.population;
  const hh = info.household;

  const parkChips = parks.sample.map((p) => expandItemHtml('park', p.name || '', p)).join('')
    || '<span class="dim">공원 정보 없음</span>';
  const areaChips = areas.sample.map((t) => expandItemHtml('tradearea', t.name || '', t)).join('')
    || '<span class="dim">상권 정보 없음</span>';

  const popBlock = pop
    ? `<div class="score-row"><span class="s-label">총인구</span><span class="s-note"><b>${comma(pop.total)}</b>명 (${esc(pop.year)}년)</span></div>
       <div class="score-row"><span class="s-label">고령인구비율</span><span class="s-note"><b>${pop.seniorRatio}%</b> (65세 이상)</span></div>`
    : '<p class="dim">인구 통계를 불러오지 못했습니다.</p>';
  const hhBlock = hh ? `<div class="score-row"><span class="s-label">세대수</span><span class="s-note"><b>${comma(hh.households)}</b>세대 (${esc(hh.year)}년)</span></div>` : '';

  return `<h3>🏬 생활권 · 인구 (실데이터)</h3>
    <h4>공원 (${parks.count}개소, 서울 열린데이터광장)</h4><div class="chips school-chips">${parkChips}</div>
    <h4>상권 (${areas.count}개, 서울 열린데이터광장)</h4><div class="chips school-chips">${areaChips}</div>
    <h4>인구·세대 (KOSIS)</h4>${popBlock}${hhBlock}
    <div class="caveat">ℹ️ 공원·상권은 구 전체 목록 중 일부만 표시합니다(이름 클릭 시 상세정보). 인구·세대는 구 단위 통계입니다.</div>`;
}

// 「데이터로 본 입지」 — 실거래 기반 단지별 매매 평당가 순위
function locDataAnalysis() {
  const deals = filterDong(state.deals);
  const sale = deals.filter((d) => d.type === 'sale');
  if (!sale.length) {
    return `<h3>📊 데이터로 본 입지</h3><p class="intro">선택 기간에 매매 거래가 없어 단지별 분석을 표시할 수 없습니다. 기간을 넓혀보세요.</p>`;
  }
  const g = {};
  for (const d of sale) {
    const k = `${d.dong}||${d.apt}`;
    (g[k] ??= { dong: d.dong, apt: d.apt, pps: [], amts: [] });
    g[k].pps.push(perPyeong(d)); g[k].amts.push(d.amount);
  }
  const rows = Object.values(g)
    .map((x) => ({ ...x, n: x.pps.length, medPP: median(x.pps), medAmt: median(x.amts) }))
    .filter((x) => x.n >= 1)
    .sort((a, b) => b.medPP - a.medPP)
    .slice(0, 12);

  const maxPP = rows[0].medPP;
  const bars = rows.map((r, i) => `
    <div class="score-row">
      <span class="s-label" style="width:22px">${i + 1}</span>
      <span style="min-width:150px;font-weight:700">${esc(r.apt)}
        <span style="margin-left:6px">${dongPill(r.dong)}</span></span>
      <span class="score-bar" style="max-width:280px"><span style="width:${(r.medPP / maxPP) * 100}%"></span></span>
      <span class="s-note" style="width:auto"><b>${comma(r.medPP)}</b> 만원/평 · <span class="dim">중위 ${won(r.medAmt)} · ${r.n}건</span></span>
    </div>`).join('');

  const dongCmp = [...new Set(sale.map((d) => d.dong))].map((dn) => {
    const arr = sale.filter((d) => d.dong === dn).map(perPyeong);
    return { dn, med: median(arr), n: arr.length };
  }).filter((x) => x.n).sort((a, b) => b.med - a.med);

  const cmpTxt = dongCmp.map((x) =>
    `<div class="chip">${dongPill(x.dn)} <b style="margin-left:4px">${comma(x.med)}</b> <span class="sub" style="display:inline">만원/평 · ${x.n}건</span></div>`).join('');

  return `<h3>📊 데이터로 본 입지 — 단지별 매매 평당가</h3>
    <p class="intro">선택한 기간·지역의 실거래 매매를 단지별로 묶어 <b>중위 평당가</b>가 높은 순으로 정렬했습니다. 평당가가 곧 시장이 매긴 입지 프리미엄입니다.</p>
    <h4>동별 매매 평당가</h4><div class="chips">${cmpTxt}</div>
    <h4>단지 랭킹 (상위 ${rows.length})</h4>
    ${bars}`;
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* 이름(동/구) → 결정적 대표색. 467개 법정동을 손으로 다 지정할 수 없어 해시 기반으로 생성한다. */
function strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (v) => Math.round(255 * v).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}
function dongColor(name) { return hslToHex(strHash(name || '') % 360, 60, 48); }

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function relLuminance([r, g, b]) {
  const a = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function contrastRatio(rgb1, rgb2) {
  const l1 = relLuminance(rgb1), l2 = relLuminance(rgb2);
  const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (a + 0.05) / (b + 0.05);
}
function accessibleDark(hex, minRatio = 4.6, bgAlpha = 0.14) {
  const rgb = hexRgb(hex);
  const bg = rgb.map((c) => Math.round(c * bgAlpha + 255 * (1 - bgAlpha)));
  let amt = 0;
  let dark = rgb;
  while (contrastRatio(dark, bg) < minRatio && amt < 0.85) {
    amt += 0.03;
    dark = rgb.map((c) => Math.round(c * (1 - amt)));
  }
  return `rgb(${dark[0]},${dark[1]},${dark[2]})`;
}
function dongPill(dong, extra = '') {
  const c = dongColor(dong);
  return `<span class="pill" style="background:${hexA(c, 0.14)};color:${accessibleDark(c)};${extra}">${esc(dong.replace('동', ''))}</span>`;
}

/* ─────────────── 이벤트 바인딩 ─────────────── */
function segBind(containerSel, attr, apply) {
  const c = $(containerSel);
  c.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn'); if (!btn) return;
    $$('.seg-btn', c).forEach((b) => b.classList.remove('is-on'));
    btn.classList.add('is-on');
    apply(btn.getAttribute(attr));
  });
}

function setPreset(code) {
  const end = refDate();
  let start = refDate();
  // "최근 N개월"은 통합 부동산 대시보드와 똑같이 '달' 단위로 센다.
  // 예: 오늘이 2026-08-21이고 3개월이면 2026-06-01 ~ 2026-08-21 (6·7·8월).
  // 예전처럼 날짜에서 3개월을 빼면 5/21부터라 열흘이 더 들어가 두 대시보드 숫자가 어긋났다.
  const backMonths = (n) => { start = new Date(end.getFullYear(), end.getMonth() - (n - 1), 1); };
  const map = { '4w': () => start.setDate(end.getDate() - 28), '3m': () => backMonths(3),
    '6m': () => backMonths(6), '1y': () => backMonths(12),
    '2y': () => backMonths(24) };
  (map[code] || map['3m'])();
  $('#startDate').value = toISO(start);
  $('#endDate').value = toISO(end);
  if (code === '4w') { state.granularity = 'week'; syncGranBtn(); }
  else if (code === '2y' || code === '1y') { state.granularity = 'month'; syncGranBtn(); }
}
function syncGranBtn() {
  $$('#granularity .seg-btn').forEach((b) => b.classList.toggle('is-on', b.getAttribute('data-g') === state.granularity));
}

function init() {
  const end = refDate();
  const start = refDate(); start.setMonth(end.getMonth() - 6);
  $('#endDate').value = toISO(end);
  $('#startDate').value = toISO(start);

  // 구 선택 드롭다운
  const guSel = $('#guSelect');
  guSel.innerHTML = `<option value="all">전체 서울(25개 구 합산)</option>` +
    SEOUL_GU_LIST.map((g) => `<option value="${g}">${g}</option>`).join('');
  guSel.value = state.gu;
  guSel.addEventListener('change', () => {
    state.gu = guSel.value;
    state.dong = 'all';
    state.cmpSel.dong = [];   // 구가 바뀌면 동 비교 선택은 의미가 없어 초기화(구 선택은 그대로 유지)
    // locKey는 일부러 유지한다 — 입지분석 탭이 열려 있으면 구를 바꿔도 닫지 않고
    // renderAll()이 새 구 데이터로 그 탭을 다시 그려준다(전엔 여기서 null로 초기화해
    // 탭이 열린 채로 방치돼 "구를 바꿔도 안 바뀐다"처럼 보이는 버그가 있었다).
    loadData();
  });

  segBind('#granularity', 'data-g', (v) => { state.granularity = v; if (!$('#dash').hidden) { renderIndex(); renderVolume(); } });
  segBind('#dongFilter', 'data-d', (v) => { state.dong = v; if (!$('#dash').hidden) renderAll(); });
  segBind('#indexMode', 'data-m', (v) => { state.indexMode = v; renderIndex(); });
  segBind('#indexView', 'data-v', (v) => { state.indexView = v; renderIndex(); });
  segBind('#cmpType', 'data-t', (v) => { state.cmpType = v; renderIndex(); });

  // 비교 지역 칩: 클릭으로 최대 6개까지 추가·해제
  $('#cmpChips').addEventListener('click', (e) => {
    if (e.target.closest('#cmpLoadAll')) {
      $('#guSelect').value = 'all';
      state.gu = 'all';
      state.dong = 'all';
      state.cmpSel.dong = [];
      loadData();
      return;
    }
    const chip = e.target.closest('.cmp-chip'); if (!chip) return;
    const name = chip.getAttribute('data-g');
    const sel = cmpSel();
    const i = sel.indexOf(name);
    if (i >= 0) sel.splice(i, 1);
    else if (sel.length < CMP_MAX) sel.push(name);
    else { $('#cmpHint').textContent = `최대 ${CMP_MAX}곳까지 비교할 수 있습니다. 먼저 선택된 지역을 해제하세요.`; return; }
    renderIndex();
  });

  $('#cmpToggles').addEventListener('click', (e) => {
    const b = e.target.closest('.cmp-toggle'); if (!b) return;
    const k = b.getAttribute('data-k');
    if (k === 'base') state.cmpBase = !state.cmpBase;
    else state.cmpGhost = !state.cmpGhost;
    renderIndex();
  });

  $('#cmpPresets').addEventListener('click', (e) => {
    const b = e.target.closest('.cmp-preset'); if (!b) return;
    const p = ($('#cmpPresets').__presets || [])[Number(b.getAttribute('data-p'))];
    if (!p) return;
    state.cmpSel[state.indexView] = p.names.slice(0, CMP_MAX);
    renderIndex();
  });

  // TOP 10 3종 전환 탭(인쇄 시에는 CSS에서 숨김이 풀려 3개 모두 출력된다)
  $('#topTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.top-tab'); if (!b) return;
    state.topTab = b.getAttribute('data-tab');
    syncTopTabs();
  });
  syncTopTabs();

  $('#geoResetBtn').addEventListener('click', () => {
    $('#dongFilter .seg-btn[data-d="all"]')?.click();
  });

  $('#indexLegend').addEventListener('click', (e) => {
    const rebBtn = e.target.closest('#rebToggleBtn');
    if (rebBtn) { state.showRebIndex = !state.showRebIndex; renderIndex(); return; }
    const btn = e.target.closest('.lg-btn'); if (!btn) return;
    const k = btn.getAttribute('data-s');
    state.indexVisible[k] = !state.indexVisible[k];
    renderIndex();
  });
  segBind('#topDealTab', 'data-t', (v) => { state.topDealType = v; renderTopDeal(); });
  segBind('#topPyeongTab', 'data-t', (v) => { state.topPyeongType = v; renderTopPyeong(); });
  segBind('#rateTab', 'data-t', (v) => { state.rateType = v; renderRateTop(); });

  $('#topDealTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tbody tr[data-i]'); if (!tr) return;
    const i = Number(tr.getAttribute('data-i'));
    selectTopDealRow(state.selectedRowIdx === i ? null : i);
  });

  $('#presets').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-preset]'); if (!b) return;
    $$('#presets button').forEach((x) => x.classList.remove('is-on'));
    b.classList.add('is-on');
    setPreset(b.getAttribute('data-preset'));
    loadData();
  });

  $('#locDetail').addEventListener('click', (e) => {
    const chip = e.target.closest('.school-chip'); if (!chip) return;
    const item = chip.closest('.school-item');
    const detail = item.querySelector('.school-detail');
    const wasHidden = detail.hidden;
    $$('.school-detail').forEach((d) => { d.hidden = true; });
    if (!wasHidden) return;
    const detailKind = item.getAttribute('data-detail-kind');
    if (detailKind === 'school') {
      const kind = item.getAttribute('data-kind');
      const idx = Number(item.getAttribute('data-idx'));
      const info = state.locInfo;
      const sc = info && info.schools && (info.schools.byKind[kind] || [])[idx];
      if (sc) { detail.innerHTML = schoolDetailHtml(sc); detail.hidden = false; }
      return;
    }
    const data = JSON.parse(item.getAttribute('data-json') || '{}');
    const RENDERERS = { subway: subwayDetailHtml, park: parkDetailHtml, tradearea: tradeAreaDetailHtml };
    if (RENDERERS[detailKind]) {
      detail.innerHTML = RENDERERS[detailKind](data);
      detail.hidden = false;
    }
  });

  $('#locGrid').addEventListener('click', (e) => {
    const tile = e.target.closest('.loc-tile'); if (!tile) return;
    const k = tile.getAttribute('data-k');
    state.locKey = state.locKey === k ? null : k;
    syncLocTiles();
    renderLocDetail();
  });

  $('#loadBtn').addEventListener('click', () => loadData());
  $('#refreshBtn').addEventListener('click', () => loadData({ refresh: true }));

  $('#printAllBtn').addEventListener('click', async () => {
    if ($('#dash').hidden) return;
    $('#printAllBtn').disabled = true;
    $('#printAllBtn').textContent = '준비 중…';
    try {
      await buildPrintReport();
      window.print();
    } finally {
      $('#printAllBtn').disabled = false;
      $('#printAllBtn').textContent = '🖨️ 전체 인쇄';
    }
  });

  loadData();
}
function syncLocTiles() {
  $$('#locGrid .loc-tile').forEach((t) => t.classList.toggle('is-on', t.getAttribute('data-k') === state.locKey));
}
function syncTopTabs() {
  $$('#topTabs .top-tab').forEach((b) => b.classList.toggle('is-on', b.getAttribute('data-tab') === state.topTab));
  $$('[data-tabpanel]').forEach((c) => c.classList.toggle('is-tab-off', c.getAttribute('data-tabpanel') !== state.topTab));
}

document.addEventListener('DOMContentLoaded', init);
