/*
 * 정적 호스팅(Vercel/GitHub Pages)용 API 가로채기 shim.
 * build_static.py가 만든 docs/index.html에만 삽입되며, 일반 서버 모드(web/index.html)에는
 * 포함되지 않는다. window.STATIC_DATA(=static-data.js가 채움)가 없으면 아무 동작도 하지 않아
 * app.js는 서버 모드/정적 모드 구분 없이 그대로 동작한다.
 *
 * 스냅샷은 매일 자동으로 다시 구워져 종료일이 항상 "어제~오늘"이다.
 * 그 안에서 사용자가 시작일·종료일과 빠른 기간(최근 4주/3개월/6개월)을 자유롭게 고를 수 있다.
 */
(function () {
  if (typeof window.STATIC_DATA === 'undefined') return;
  const DATA = window.STATIC_DATA;

  // app.js의 "최근 N개월" 기준일을 스냅샷 종료일(≈오늘)로 맞춘다.
  // 이 스크립트는 app.js보다 먼저 로드되므로 init()도 이 값을 쓴다.
  window.__REF_DATE__ = DATA.end;

  function jsonResponse(obj) {
    return Promise.resolve(new Response(JSON.stringify(obj), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  /* ── 압축 해제 ──
     build_static.py의 encode_deals()가 접어 둔 배열을 app.js가 기대하는 객체로 되돌린다.
     구마다 한 번만 풀고 캐시해 재조회가 빨라지게 한다. */
  const decoded = new Map();

  function decodeDeals(gu, snap) {
    if (decoded.has(gu)) return decoded.get(gu);
    if (!snap || !snap.enc) {                       // 옛 형식(비압축) 스냅샷도 그대로 지원
      const legacy = (snap && snap.deals) || [];
      decoded.set(gu, legacy);
      return legacy;
    }
    const base = new Date(snap.base + 'T00:00:00');
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const out = new Array(snap.r.length);
    for (let i = 0; i < snap.r.length; i++) {
      const r = snap.r[i];
      const dt = new Date(base.getTime() + r[3] * 86400000);
      out[i] = {
        type: snap.t[r[0]],
        gu: gu,
        dong: snap.d[r[1]],
        apt: snap.a[r[2]],
        date: dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()),
        area: r[4],
        floor: r[5],
        buildYear: r[6],
        amount: r[7],
        deposit: r[8],
        rent: r[9],
        jibun: r[10],
      };
    }
    decoded.set(gu, out);
    return out;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function dealsResponse(gu, start, end) {
    const lo = clamp(start || DATA.start, DATA.start, DATA.end);
    const hi = clamp(end || DATA.end, DATA.start, DATA.end);
    const inRange = (d) => d.date >= lo && d.date <= hi;

    const gus = gu === 'all' ? Object.keys(DATA.gus) : [gu];
    const deals = [];
    const errors = [];
    for (const g of gus) {
      const snap = DATA.gus[g];
      if (!snap || !snap.deals) { errors.push(`${g}: 스냅샷 없음`); continue; }
      for (const d of decodeDeals(g, snap.deals)) if (inRange(d)) deals.push(d);
    }
    deals.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    return jsonResponse({
      start: lo, end: hi, gus, count: deals.length, deals, errors, fetchedAt: DATA.builtAt,
    });
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const rawUrl = typeof input === 'string' ? input : input.url;
    const u = new URL(rawUrl, location.href);

    // file:// 로 직접 열면 '/api/deals'가 '/C:/api/deals'처럼 드라이브를 달고 나온다.
    // 앞부분을 무시하고 끝의 API 이름만 보고 판단한다.
    const hit = u.pathname.match(/\/api\/([a-z-]+)$/);
    const api = hit ? hit[1] : '';

    if (api === 'deals') {
      return dealsResponse(
        u.searchParams.get('gu') || 'all',
        u.searchParams.get('start'),
        u.searchParams.get('end'),
      );
    }

    if (api === 'locinfo') {
      const snap = DATA.gus[u.searchParams.get('gu')];
      return jsonResponse(snap && snap.locinfo ? snap.locinfo : null);
    }

    if (api === 'price-index') {
      const snap = DATA.gus[u.searchParams.get('gu')];
      return jsonResponse(snap && snap.priceIndex ? snap.priceIndex : { available: false });
    }

    if (api === 'geocode-batch') {
      // 정적 스냅샷에서는 실시간 지오코딩이 불가능 — 이미 구운 geo-coords.js 좌표만 사용된다.
      return jsonResponse({ results: [] });
    }

    return realFetch(input, init);
  };

  /* ── 조회 조건 UI ──
     app.js의 init()도 DOMContentLoaded에서 날짜를 세팅하므로 반드시 그보다 나중에
     실행되도록 window의 load 이벤트에서 조정한다. */
  window.addEventListener('load', () => {
    const startEl = document.getElementById('startDate');
    const endEl = document.getElementById('endDate');
    const refreshBtn = document.getElementById('refreshBtn');

    // 스냅샷 범위 밖으로는 못 고르게 막되, 그 안에서는 자유롭게 고를 수 있다.
    if (startEl) { startEl.min = DATA.start; startEl.max = DATA.end; }
    if (endEl) { endEl.min = DATA.start; endEl.max = DATA.end; }
    // 새로고침(공공데이터 재수집)은 정적 버전에서 의미가 없다.
    if (refreshBtn) refreshBtn.style.display = 'none';

    // 스냅샷 길이를 넘는 빠른 기간 버튼은 눌러도 소용없으니 꺼 둔다.
    const spanDays = Math.round(
      (new Date(DATA.end + 'T00:00:00') - new Date(DATA.start + 'T00:00:00')) / 86400000);
    const NEED = { '4w': 28, '3m': 90, '6m': 182, '1y': 365, '2y': 730 };
    document.querySelectorAll('#presets button[data-preset]').forEach((b) => {
      const need = NEED[b.getAttribute('data-preset')];
      if (need && need > spanDays + 3) {
        b.disabled = true;
        b.style.opacity = '0.4';
        b.style.cursor = 'not-allowed';
        b.title = `스냅샷이 ${Math.round(spanDays / 30.44)}개월치라 선택할 수 없습니다`;
      }
    });

    // 기본값: 스냅샷 종료일(≈오늘) 기준 최근 3개월
    const end = DATA.end;
    const s = new Date(end + 'T00:00:00');
    s.setMonth(s.getMonth() - 3);
    const startWanted = s.toISOString().slice(0, 10);
    if (startEl) startEl.value = startWanted < DATA.start ? DATA.start : startWanted;
    if (endEl) endEl.value = end;
    const btn3m = document.querySelector('#presets button[data-preset="3m"]');
    if (btn3m && !btn3m.disabled) {
      document.querySelectorAll('#presets button').forEach((x) => x.classList.remove('is-on'));
      btn3m.classList.add('is-on');
    }

    // 안내 문구 — 며칠 전 자료인지 바로 알 수 있게
    const daysOld = Math.round((Date.now() - new Date(DATA.end + 'T00:00:00')) / 86400000);
    const fresh = daysOld <= 1 ? '오늘 기준' : `${daysOld}일 전 기준`;
    const note = document.createElement('div');
    note.style.cssText = 'font-size:11.5px;color:#35569e;background:#eef2fb;border:1px solid #cfdcf6;'
      + 'border-radius:8px;padding:7px 12px;margin:10px 26px 0;line-height:1.6;';
    note.innerHTML = `자료 수록 기간 <b>${DATA.start} ~ ${DATA.end}</b> (${fresh}) · 매일 자동 갱신됩니다. `
      + `이 범위 안에서 시작일·종료일과 빠른 기간을 자유롭게 바꿔 보실 수 있습니다.`;
    const controls = document.querySelector('.controls');
    if (controls) controls.insertAdjacentElement('afterend', note);

    // app.js가 이미 그린 화면을 새 기본값(최근 3개월)으로 다시 그린다.
    const loadBtn = document.getElementById('loadBtn');
    if (loadBtn) loadBtn.click();
  });
})();
