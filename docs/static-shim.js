/*
 * GitHub Pages(정적 호스팅)용 API 가로채기 shim.
 * build_static.py가 만든 docs/index.html에만 삽입되며, 일반 서버 모드(web/index.html)에는
 * 포함되지 않는다. window.STATIC_DATA(=static-data.js가 채움)가 없으면 아무 동작도 하지 않아
 * app.js는 서버 모드/정적 모드 구분 없이 그대로 동작한다.
 */
(function () {
  if (typeof window.STATIC_DATA === 'undefined') return;
  const DATA = window.STATIC_DATA;

  function jsonResponse(obj) {
    return Promise.resolve(new Response(JSON.stringify(obj), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const rawUrl = typeof input === 'string' ? input : input.url;
    const u = new URL(rawUrl, location.href);

    if (u.pathname === '/api/deals') {
      const gu = u.searchParams.get('gu') || 'all';
      if (gu === 'all') {
        const allDeals = [];
        const errors = [];
        for (const g of Object.keys(DATA.gus)) {
          const snap = DATA.gus[g];
          if (snap && snap.deals) allDeals.push(...snap.deals.deals);
          else errors.push(`${g}: 스냅샷 없음`);
        }
        allDeals.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        return jsonResponse({
          start: DATA.start, end: DATA.end, gus: Object.keys(DATA.gus),
          count: allDeals.length, deals: allDeals, errors, fetchedAt: DATA.builtAt,
        });
      }
      const snap = DATA.gus[gu];
      if (!snap || !snap.deals) {
        return jsonResponse({ start: DATA.start, end: DATA.end, gus: [gu], count: 0, deals: [], errors: [`${gu}: 스냅샷 데이터 없음`], fetchedAt: DATA.builtAt });
      }
      return jsonResponse(snap.deals);
    }

    if (u.pathname === '/api/locinfo') {
      const gu = u.searchParams.get('gu');
      const snap = DATA.gus[gu];
      return jsonResponse(snap && snap.locinfo ? snap.locinfo : null);
    }

    if (u.pathname === '/api/price-index') {
      const gu = u.searchParams.get('gu');
      const snap = DATA.gus[gu];
      return jsonResponse(snap && snap.priceIndex ? snap.priceIndex : { available: false });
    }

    if (u.pathname === '/api/geocode-batch') {
      // 정적 스냅샷에서는 실시간 지오코딩이 불가능 — 이미 구운 geo-coords.js 좌표만 사용된다.
      return jsonResponse({ results: [] });
    }

    return realFetch(input, init);
  };

  // app.js의 init()도 DOMContentLoaded에서 날짜 입력을 "기본 6개월"로 세팅하므로,
  // 그보다 반드시 나중에 실행되도록 window의 load 이벤트(문서 파싱+모든 동기 리스너 이후)에서 덮어쓴다.
  window.addEventListener('load', () => {
    const startEl = document.getElementById('startDate');
    const endEl = document.getElementById('endDate');
    const refreshBtn = document.getElementById('refreshBtn');
    const presets = document.getElementById('presets');
    if (startEl) { startEl.value = DATA.start; startEl.disabled = true; }
    if (endEl) { endEl.value = DATA.end; endEl.disabled = true; }
    if (refreshBtn) refreshBtn.style.display = 'none';
    if (presets) presets.style.display = 'none';

    const note = document.createElement('div');
    note.style.cssText = 'font-size:11px;color:#8a6a1f;background:#fbf3e2;border:1px solid #f0dfb3;'
      + 'border-radius:8px;padding:6px 10px;margin:10px 26px 0;';
    note.textContent = `정적 스냅샷 버전입니다(기준 ${DATA.builtAt} 생성, 기간 ${DATA.start} ~ ${DATA.end} 고정) — 실시간 조회가 아닙니다.`;
    const controls = document.querySelector('.controls');
    if (controls) controls.insertAdjacentElement('afterend', note);
  });
})();
