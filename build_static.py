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
    today = date.today()
    return today - timedelta(days=90), today


def build_gu_snapshot(gu: str, start: date, end: date) -> dict:
    deals_result = server.collect([gu], start, end)
    locinfo = server.build_locinfo(gu)
    price_index = server.fetch_price_index(gu)
    print(f"      [{gu}] 실거래 {deals_result['count']:,}건 · 입지분석 {'OK' if locinfo else '실패'} · 공식지수 {'OK' if price_index else '없음'}")
    return {"deals": deals_result, "locinfo": locinfo, "priceIndex": price_index}


def main():
    if len(sys.argv) >= 3:
        start = date.fromisoformat(sys.argv[1])
        end = date.fromisoformat(sys.argv[2])
    else:
        start, end = default_range()

    missing = [k for k, v in server._REQUIRED_KEYS.items() if not v]
    if missing:
        sys.exit(f"[오류] API 키가 설정되지 않았습니다: {', '.join(missing)} (.env 파일을 확인하세요)")

    gus = list(server.SEOUL_GU)
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
        inject = '<script src="static-data.js"></script>\n  <script src="static-shim.js"></script>\n  '
        html = html.replace('<script src="app.js', inject + '<script src="app.js', 1)
    with open(idx_path, "w", encoding="utf-8") as fh:
        fh.write(html)

    size_mb = os.path.getsize(os.path.join(DOCS, "static-data.js")) / (1024 * 1024)
    print(f"[3/3] 완료 — docs/static-data.js ({size_mb:.2f} MB, 기준 {built_at})")
    print("      GitHub 저장소 Settings > Pages > Source 에서 'docs' 폴더를 지정하세요.")


if __name__ == "__main__":
    main()
