# -*- coding: utf-8 -*-
"""
.cache/*.json 에 쌓인 실거래 데이터에서 (구, 법정동, 단지명) 조합을 모두 모아
카카오 지오코딩으로 좌표를 구하고 web/geo-coords.js 를 생성한다.

한 번 구한 좌표는 .cache/geocode-cache.json 에 영구 저장되므로, 이후 재실행 시
새로 나타난 단지만 추가로 조회한다(=API 호출을 최소화).

실행: python geocode_build.py
"""
from __future__ import annotations

import glob
import json
import os
import time
from collections import Counter

import server  # KAKAO_REST_KEY, geocode_one(), 캐시 경로 재사용

WEB_DIR = os.path.join(server.BASE_DIR, "web")
OUT_PATH = os.path.join(WEB_DIR, "geo-coords.js")


def collect_pairs() -> dict[tuple[str, str, str], str]:
    """.cache 안의 모든 매매/전월세 캐시를 읽어 (구, 동, 단지명) -> 가장 흔한 지번."""
    jibun_votes: dict[tuple[str, str, str], Counter] = {}
    files = glob.glob(os.path.join(server.CACHE_DIR, "*.json"))
    for f in files:
        base = os.path.basename(f)
        if base == "geocode-cache.json" or base.startswith("locinfo-") or base.startswith("seoul-"):
            continue
        try:
            rows = json.load(open(f, encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(rows, list):
            continue
        for d in rows:
            if not isinstance(d, dict):
                continue
            gu, dong, apt, jibun = d.get("gu"), d.get("dong"), d.get("apt"), d.get("jibun")
            if not gu or not dong or not apt:
                continue
            key = (gu, dong, apt)
            jibun_votes.setdefault(key, Counter())[jibun or ""] += 1

    return {k: v.most_common(1)[0][0] for k, v in jibun_votes.items()}


def main():
    pairs = collect_pairs()
    print(f"고유 (구, 동, 단지명) 조합: {len(pairs)}개")

    coords: dict[str, dict] = {}
    resolved, failed = 0, []

    for i, ((gu, dong, apt), jibun) in enumerate(sorted(pairs.items()), 1):
        key = f"{gu}|{dong}|{apt}"
        result = server.geocode_one(gu, dong, jibun, apt)
        if result:
            coords[key] = {"lat": result["lat"], "lng": result["lng"]}
            resolved += 1
        else:
            failed.append(key)
        if i % 200 == 0:
            print(f"  진행 {i}/{len(pairs)}")

    lines = [
        "// 자동 생성 파일 — geocode_build.py 로 생성됩니다. 직접 수정하지 마세요.",
        f"// 생성 시각: {time.strftime('%Y-%m-%d %H:%M:%S')} · 좌표 {len(coords)}개 (카카오 지오코딩 결과)",
        "const GEO_COORDS = {",
    ]
    for key in sorted(coords):
        c = coords[key]
        esc_key = key.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'  "{esc_key}": {{ lat: {c["lat"]:.6f}, lng: {c["lng"]:.6f} }},')
    lines.append("};")

    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    print(f"완료: {resolved}개 좌표 확보, {len(failed)}개 실패")
    if failed:
        print(f"실패 {len(failed)}건(주소를 못 찾음) — 처음 20개만 표시:")
        for k in failed[:20]:
            print(f"  - {k}")
    print(f"-> {OUT_PATH} 작성 완료")


if __name__ == "__main__":
    main()
