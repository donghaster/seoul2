# -*- coding: utf-8 -*-
"""
매일 자동 갱신(.github/workflows/refresh-snapshot.yml)에 필요한 키를
GitHub 저장소 시크릿으로 등록하고, 원하면 갱신을 즉시 한 번 돌린다.

키 값은 .env에서 읽어 `gh secret set`에 **표준입력으로** 흘려보낸다.
화면·로그·명령행 어디에도 값이 남지 않는다.

실행:
  py setup_secrets.py            # 등록 + 즉시 갱신 실행 여부 확인
  py setup_secrets.py --check    # 준비 상태만 점검(키를 건드리지 않음)
  py setup_secrets.py --no-run   # 등록만 하고 갱신은 돌리지 않음
"""
from __future__ import annotations

import os
import subprocess
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get("GH_REPO", "donghaster/seoul2")
WORKFLOW = "refresh-snapshot.yml"

# server.py의 _REQUIRED_KEYS와 같은 목록. 하나라도 없으면 빌드가 중단되므로 전부 필수.
NEEDED = [
    ("DATA_GO_KR_KEY", "국토교통부 실거래가"),
    ("KAKAO_REST_KEY", "카카오 지오코딩"),
    ("SEOUL_OPEN_DATA_KEY", "서울 열린데이터광장(공원·상권)"),
    ("KOSIS_KEY", "KOSIS(인구·부동산원 지수)"),
    ("NEIS_KEY", "NEIS(학교)"),
]


def read_keys() -> tuple[dict[str, str], str | None]:
    """.env에서 키를 읽는다. 값은 절대 출력하지 않는다."""
    path = os.path.join(BASE_DIR, ".env")
    if not os.path.exists(path):
        return {}, None
    found: dict[str, str] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if v.strip():
                found[k.strip()] = v.strip()
    return found, path


def run(args: list[str], stdin_text: str | None = None) -> tuple[int, str]:
    p = subprocess.run(
        args, input=stdin_text, text=True, encoding="utf-8",
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    return p.returncode, (p.stdout or "").strip()


def main() -> int:
    check_only = "--check" in sys.argv
    no_run = "--no-run" in sys.argv

    print(f"저장소: {REPO}\n")

    code, out = run(["gh", "auth", "status"])
    if code != 0:
        print("  ! GitHub CLI 로그인이 안 돼 있습니다. 먼저 `gh auth login`을 실행하세요.")
        return 1
    for line in out.splitlines():
        if "Logged in to" in line:
            print(f"  GitHub CLI: {line.strip()}")
            break

    code, out = run(["gh", "repo", "view", REPO, "--json", "name", "-q", ".name"])
    if code != 0:
        print(f"  ! 저장소에 접근할 수 없습니다: {out}")
        return 1
    print("  저장소 접근 OK")

    keys, path = read_keys()
    if not keys:
        print(f"  ! .env를 찾지 못했습니다: {os.path.join(BASE_DIR, '.env')}")
        return 1
    print(f"  키 파일: {path}\n")

    missing = []
    for name, label in NEEDED:
        have = name in keys
        print(f"    {name:22s} {'있음' if have else '없음'}   ({label})")
        if not have:
            missing.append(name)
    if missing:
        print(f"\n  ! 다음 키가 .env에 없습니다: {', '.join(missing)}")
        print("    5개 모두 있어야 자동 갱신이 동작합니다.")
        return 1

    if check_only:
        print("\n점검만 했습니다. 실제 등록은 --check 없이 다시 실행하세요.")
        return 0

    print("\n시크릿 등록 중… (값은 표준입력으로만 전달됩니다)")
    for name, _ in NEEDED:
        code, out = run(["gh", "secret", "set", name, "--repo", REPO], stdin_text=keys[name])
        if code != 0:
            print(f"    {name} 등록 실패: {out}")
            return 1
        print(f"    {name} 등록 완료")

    print("\n등록된 시크릿:")
    _, out = run(["gh", "secret", "list", "--repo", REPO])
    print("    " + (out.replace("\n", "\n    ") if out else "(없음)"))

    if no_run:
        print("\n등록만 마쳤습니다. 매일 새벽 5시에 자동으로 갱신됩니다.")
        return 0

    print("\n지금 바로 갱신을 한 번 돌려볼까요? (10~30분 걸립니다)")
    try:
        answer = input("  실행하려면 y, 건너뛰려면 Enter: ").strip().lower()
    except EOFError:
        answer = ""
    if answer != "y":
        print("\n건너뛰었습니다. 매일 새벽 5시에 자동으로 갱신됩니다.")
        return 0

    code, out = run(["gh", "workflow", "run", WORKFLOW, "--repo", REPO])
    if code != 0:
        print(f"  ! 실행 실패: {out}")
        return 1
    print("  갱신을 시작했습니다. 진행 상황은 아래에서 볼 수 있습니다:")
    print(f"    https://github.com/{REPO}/actions")
    print(f"    또는  gh run watch --repo {REPO}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
