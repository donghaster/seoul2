# -*- coding: utf-8 -*-
"""
GitHub Pages 배포용 정적 스냅샷 빌더.

server.py의 함수(collect/build_locinfo/fetch_price_index)를 그대로 재사용해 지정한 기간의
서울 25개 구 실거래·입지분석·공식지수를 전부 모아 하나의 JS 데이터 파일로 굽고,
web/ 내용을 통째로 docs/ 에 복사해 서버 없이 GitHub Pages에서 바로 열람 가능한
정적 사이트를 만든다(브라우저 fetch를 가로채는 web/static-shim.js가 핵심).

  python build_static.py [YYYY-MM-DD YYYY-MM-DD]

기본 기간: 오늘로부터 약 3개월 전 ~ 오늘(스냅샷이라 기간이 길수록 용량·빌드 시간이 늘어남).
API 키는 .env(또는 환경변수)에 설정되어 있어야 한다 — server.py와 동일.

생성물: docs/  (GitHub 저장소 설정에서 Pages 소스로 이 폴더를 지정하면 됨)
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import server  # 같은 폴더의 server.py 재사용

BASE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(BASE, "web")
DOCS = os.path.join(BASE, "docs")


def default_range() -> tuple[date, date]:
    """오늘을 종료일로 하는 롤링 구간. MONTHS 환경변수로 길이를 바꾼다(기본 6개월)."""
    months = int(os.environ.get("MONTHS", "6"))
    today = date.today()
    return today - timedelta(days=round(months * 30.44)), today


# ---------------------------------------------------------------- 거래 압축
# 원본 JSON은 한 건에 약 217바이트(긴 키 이름과 동·단지명이 매번 반복)라
# 6개월치면 24MB가 넘는다. 사전(dictionary) + 배열로 접어 약 1/4로 줄인다.
# 되돌리는 쪽은 web/static-shim.js의 decodeDeals().

def encode_deals(result: dict, start: date) -> dict:
    types: list[str] = []
    dongs: list[str] = []
    apts: list[str] = []
    idx_t: dict[str, int] = {}
    idx_d: dict[str, int] = {}
    idx_a: dict[str, int] = {}

    def put(table: list[str], index: dict[str, int], value: str) -> int:
        v = value or ""
        if v not in index:
            index[v] = len(table)
            table.append(v)
        return index[v]

    rows = []
    for d in result["deals"]:
        day = (date.fromisoformat(d["date"]) - start).days
        rows.append([
            put(types, idx_t, d["type"]),
            put(dongs, idx_d, d.get("dong", "")),
            put(apts, idx_a, d.get("apt", "")),
            day,
            d["area"],
            d["floor"],
            d["buildYear"],
            d["amount"],
            d["deposit"],
            d["rent"],
            d.get("jibun", ""),
        ])

    return {
        "start": result["start"], "end": result["end"], "gus": result["gus"],
        "months": result["months"], "count": result["count"],
        "errors": result["errors"], "fetchedAt": result["fetchedAt"],
        # 압축 본체 — enc=1이면 shim이 풀어서 app.js에 넘긴다
        "enc": 1, "base": start.isoformat(),
        "t": types, "d": dongs, "a": apts, "r": rows,
    }


def build_gu_snapshot(gu: str, start: date, end: date) -> dict:
    deals_result = server.collect([gu], start, end)
    locinfo = server.build_locinfo(gu)
    price_index = server.fetch_price_index(gu)
    print(f"      [{gu}] 실거래 {deals_result['count']:,}건 · 입지분석 {'OK' if locinfo else '실패'} · 공식지수 {'OK' if price_index else '없음'}")
    return {"deals": encode_deals(deals_result, start), "locinfo": locinfo, "priceIndex": price_index}


def main():
    # 윈도우 기본 콘솔은 cp949라 진행 메시지의 —·… 같은 문자에서 UnicodeEncodeError로
    # 죽는다(데이터는 이미 다 만든 뒤라 더 억울하다). 출력 인코딩만 UTF-8로 바꿔 막는다.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if len(sys.argv) >= 3:
        start = date.fromisoformat(sys.argv[1])
        end = date.fromisoformat(sys.argv[2])
    else:
        start, end = default_range()

    missing = [k for k, v in server._REQUIRED_KEYS.items() if not v]
    if missing:
        sys.exit(f"[오류] API 키가 설정되지 않았습니다: {', '.join(missing)} (.env 파일을 확인하세요)")

    gus = list(server.SEOUL_GU)

    # 공원·상권·학교는 서울 전체가 공유하는 자료라 구마다 다시 받을 필요가 없다.
    # 병렬 수집에 들어가기 전에 한 번만 받아 캐시에 채워 둔다
    # (안 그러면 25개 스레드가 같은 파일을 동시에 쓰다 충돌한다).
    print("[0/3] 서울 공통 자료(공원·상권·학교) 준비")
    for label, fn in (("공원", server.fetch_parks_all),
                      ("상권", server.fetch_trade_areas_all),
                      ("학교", server.fetch_schools_all)):
        try:
            print(f"      {label} {len(fn()):,}건")
        except Exception as exc:
            print(f"      ! {label} 실패: {exc}")

    print(f"[1/3] {len(gus)}개 구 스냅샷 수집: {start} ~ {end}")

    snapshot: dict[str, dict | None] = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(build_gu_snapshot, gu, start, end): gu for gu in gus}
        for fut in futures:
            gu = futures[fut]
            try:
                snapshot[gu] = fut.result()
            except Exception as exc:
                print(f"      ! {gu} 실패: {exc}")
                snapshot[gu] = None

    ok = sum(1 for v in snapshot.values() if v)
    print(f"      {ok}/{len(gus)}개 구 수집 완료")

    print("[2/3] docs/ 폴더 생성")
    if os.path.isdir(DOCS):
        shutil.rmtree(DOCS)
    shutil.copytree(WEB, DOCS)

    built_at = time.strftime("%Y-%m-%d %H:%M")
    payload = {"builtAt": built_at, "start": start.isoformat(), "end": end.isoformat(), "gus": snapshot}
    data_js = "window.STATIC_DATA = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";"
    with open(os.path.join(DOCS, "static-data.js"), "w", encoding="utf-8") as fh:
        fh.write(data_js)

    idx_path = os.path.join(DOCS, "index.html")
    with open(idx_path, "r", encoding="utf-8") as fh:
        html = fh.read()
    if "static-data.js" not in html:
        # 스냅샷 파일명은 그대로라 주소에 빌드 시각을 붙여둔다.
        # 안 붙이면 갱신 후에도 브라우저가 캐시된 옛 데이터를 계속 써서 "갱신이 안 된다"처럼 보인다.
        stamp = built_at.replace("-", "").replace(":", "").replace(" ", "")
        inject = (f'<script src="static-data.js?v={stamp}"></script>\n'
                  '  <script src="static-shim.js"></script>\n  ')
        html = html.replace('<script src="app.js', inject + '<script src="app.js', 1)
    with open(idx_path, "w", encoding="utf-8") as fh:
        fh.write(html)

    size_mb = os.path.getsize(os.path.join(DOCS, "static-data.js")) / (1024 * 1024)
    print(f"[3/3] 완료 — docs/static-data.js ({size_mb:.2f} MB, 기준 {built_at})")
    print("      GitHub 저장소 Settings > Pages > Source 에서 'docs' 폴더를 지정하세요.")


if __name__ == "__main__":
    main()
