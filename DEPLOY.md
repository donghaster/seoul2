# GitHub 배포 가이드

이 프로젝트는 Python 서버(실거래 수집·KOSIS 연동)가 있어서, GitHub Pages 같은 정적 호스팅에서는
서버 기능이 그대로 동작하지 않습니다. 그래서 배포는 **"빌드 시점에 데이터를 구운 정적 스냅샷"**을
GitHub Pages로 올리는 방식입니다 — 실시간 조회는 아니고, 스냅샷 생성 시점의 데이터를 보여줍니다.

API 키(카카오 REST, NEIS, 서울 열린데이터광장, KOSIS, 공공데이터포털)는 스냅샷을 만들 때만 쓰이고
배포물(`docs/`)에는 들어가지 않습니다. 유일하게 배포물에 포함되는 키는 카카오맵 **JS 키**인데,
이건 원래 브라우저에 노출되는 게 정상인 키입니다(도메인 제한으로 보호).

## 1. 로컬에서 정적 스냅샷 만들기

```bash
python build_static.py                    # 기본: 오늘로부터 3개월 전 ~ 오늘
python build_static.py 2025-01-01 2025-07-01   # 기간 직접 지정
```

`.env` 파일(또는 환경변수)에 API 키가 설정되어 있어야 합니다 — `.env.example` 참고.
완료되면 `docs/` 폴더가 생성/갱신됩니다(서울 25개 구 전체 데이터가 `docs/static-data.js`에 포함).

## 2. Git 저장소 초기화 & 커밋

```bash
git init
git add .
git commit -m "Initial commit"
```

`.gitignore`가 `.env`, `.cache/`를 자동으로 제외하므로 비밀 키나 캐시 파일은 커밋되지 않습니다.

## 3. GitHub에 저장소 만들고 푸시

이 환경에는 `gh` CLI가 없어서 웹에서 직접 만들어야 합니다.

1. https://github.com/new 접속 → 저장소 이름 입력(예: `seoul-apt-dashboard`) → **Public** 선택
   (Public이어야 무료 요금제에서 GitHub Pages를 쓸 수 있습니다) → "Create repository"
2. 생성된 저장소 페이지에 나오는 안내대로 원격 연결 후 푸시:
   ```bash
   git remote add origin https://github.com/<사용자명>/<저장소명>.git
   git branch -M main
   git push -u origin main
   ```

## 4. GitHub Pages 활성화

저장소 페이지 → **Settings** → **Pages** → "Build and deployment" 섹션에서:
- Source: **Deploy from a branch**
- Branch: **main** / 폴더: **/docs**
- Save

몇 분 후 `https://<사용자명>.github.io/<저장소명>/` 에서 열람 가능합니다.

## 5. 카카오맵 도메인 허용 목록에 추가

카카오 디벨로퍼스(https://developers.kakao.com) → 내 애플리케이션 → 반포114/금집부쌤 앱 →
플랫폼 → Web → 사이트 도메인에 `https://<사용자명>.github.io` 를 추가해야 지도가 뜹니다
(안 하면 지도 부분만 빈 화면으로 나옵니다).

## 스냅샷 갱신하기

데이터가 오래되면 `python build_static.py`를 다시 실행하고, 변경된 `docs/`를 다시 커밋·푸시하면
됩니다:

```bash
python build_static.py
git add docs/
git commit -m "Update snapshot"
git push
```
