# -*- coding: utf-8 -*-
"""
한국부동산원 공식 가격지수를 data/price-index.json으로 저장한다(저장소에 커밋).

KOSIS는 GitHub Actions 같은 해외 러너에서 응답하지 않아(urlopen timed out),
자동 갱신 때마다 25개 구가 통째로 비는 문제가 있었다. 분기 단위 통계라
거의 변하지 않으므로, 국내에서 한 번 받아 저장소에 두고 CI는 그 값을 쓴다.

분기가 바뀌어 새 값이 나오면(1·4·7·10월경) 국내에서 다시 실행해 커밋하면 된다.

실행:  py tools/dump_price_index.py
"""
from __future__ import annotations

import json
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)
os.chdir(BASE)

import server  # noqa: E402


def main() -> None:
    out, failed = {}, []
    for gu in server.SEOUL_GU:
        try:
            pi = server.fetch_price_index(gu)
        except Exception as exc:
            print(f"  ! {gu}: {exc}")
            pi = None
        if pi and pi.get("points"):
            out[gu] = pi
            print(f"  {gu:6s} {pi['points'][-1]['period']} {pi['points'][-1]['value']}")
        else:
            failed.append(gu)

    if failed:
        print(f"\n! 실패 {len(failed)}곳: {', '.join(failed)}")
    if not out:
        sys.exit("한 곳도 받지 못해 저장하지 않습니다.")

    path = server.PRICE_INDEX_SEED
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(f"\n저장 완료: {os.path.relpath(path, BASE)}  ({len(out)}/25개 구, "
          f"{os.path.getsize(path) / 1024:.0f} KB)")
    print("이 파일을 커밋해야 CI에서도 지수가 나옵니다.")


if __name__ == "__main__":
    main()
