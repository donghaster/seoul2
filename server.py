# -*- coding: utf-8 -*-
"""
금집부쌤의 서울시 아파트 실거래 대시보드 - 로컬 API 프록시 + 정적 서버

여러 공공 API를 브라우저가 직접 호출할 수 없어(CORS 미지원 + 인증키 노출 문제)
이 서버가 중계 역할을 한다.

  GET /api/deals?gu=강남구&start=YYYY-MM-DD&end=YYYY-MM-DD[&refresh=1]
      -> 기간 내 해당 구 아파트 매매·전세·월세 실거래 원본 리스트(JSON)
  GET /api/geocode-batch?items=[...]
      -> 카카오 지오코딩(주소->좌표), 서버에서만 REST 키 사용
  GET /api/locinfo?gu=강남구
      -> 공원·상권(서울 열린데이터광장) + 인구·세대·고령화(KOSIS) 입지분석 데이터
  GET /api/price-index?gu=강남구
      -> 한국부동산원 공동주택 매매 실거래가격지수(구 단위, 분기별, KOSIS 경유)

표준 라이브러리만 사용한다. 실행: python server.py
"""
from __future__ import annotations

import json
import os
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------- 설정


def _load_dotenv(path: str) -> None:
    """외부 패키지(python-dotenv) 없이 .env를 읽어 os.environ에 채운다(이미 설정된 값은 안 덮어씀)."""
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

SERVICE_KEY = os.environ.get("DATA_GO_KR_KEY", "")

# 카카오 로컬(지오코딩) API — REST API 키. 브라우저에는 절대 노출하지 않고 서버에서만 사용한다.
KAKAO_REST_KEY = os.environ.get("KAKAO_REST_KEY", "")

# 서울 열린데이터광장(공원·상권) — 일반 오픈API 키, 별도 승인 없이 바로 사용 가능
SEOUL_OPEN_DATA_KEY = os.environ.get("SEOUL_OPEN_DATA_KEY", "")

# KOSIS(국가통계포털) — 인구·세대·고령화 + 한국부동산원 공동주택 실거래가격지수(ORG_ID 408, KOSIS가 REB 자료를 유통)
KOSIS_KEY = os.environ.get("KOSIS_KEY", "")

# 나이스 교육정보 개방포털(NEIS) — 학교 기본정보(학군)
NEIS_KEY = os.environ.get("NEIS_KEY", "")
NEIS_SEOUL_OFCDC = "B10"   # 서울특별시교육청

_REQUIRED_KEYS = {
    "DATA_GO_KR_KEY": SERVICE_KEY,
    "KAKAO_REST_KEY": KAKAO_REST_KEY,
    "SEOUL_OPEN_DATA_KEY": SEOUL_OPEN_DATA_KEY,
    "KOSIS_KEY": KOSIS_KEY,
    "NEIS_KEY": NEIS_KEY,
}


def _warn_missing_keys() -> None:
    missing = [name for name, val in _REQUIRED_KEYS.items() if not val]
    if missing:
        print("[경고] 다음 API 키가 환경변수로 설정되지 않았습니다 — 해당 기능은 동작하지 않습니다:")
        for name in missing:
            print(f"        {name}")
        print("        (.env.example 참고, 환경변수로 설정 후 다시 실행하세요)")
_DONG_IN_PAREN_RE = re.compile(r"\(([^,()]+)[,)]")   # NEIS ORG_RDNDA "(반포동,반포고등학교)" 또는 콤마 없이 "(방배동)"만 있는 경우 모두 추출

# 서울시 25개 자치구 -> 법정동코드(LAWD_CD). RTMS 실거래가 API용. (전수 검증 완료)
SEOUL_GU = {
    "종로구": "11110", "중구": "11140", "용산구": "11170", "성동구": "11200", "광진구": "11215",
    "동대문구": "11230", "중랑구": "11260", "성북구": "11290", "강북구": "11305", "도봉구": "11320",
    "노원구": "11350", "은평구": "11380", "서대문구": "11410", "마포구": "11440", "양천구": "11470",
    "강서구": "11500", "구로구": "11530", "금천구": "11545", "영등포구": "11560", "동작구": "11590",
    "관악구": "11620", "서초구": "11650", "강남구": "11680", "송파구": "11710", "강동구": "11740",
}
# 위 SEOUL_GU와 정확히 같은 순서로 매겨진 한국부동산원 KOSIS 지역코드(10001~10025) — 실제 호출로 검증됨
REB_GU_CODE = {gu: f"{10001 + i:05d}" for i, gu in enumerate(SEOUL_GU)}

CACHE_VER = "v1"
PORT = int(os.environ.get("PORT", "8766"))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
CACHE_DIR = os.path.join(BASE_DIR, ".cache")

API_TRADE = "1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade"   # 아파트 매매
API_RENT = "1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent"      # 아파트 전월세

# 진행 중인 달(현재월)은 신고가 계속 추가되므로 캐시를 짧게 유지한다.
CACHE_TTL_CURRENT_MONTH = 60 * 30       # 30분
LOCINFO_TTL = 60 * 60 * 24 * 7          # 입지분석(공원·상권·인구)은 자주 안 바뀌므로 7일
PAGE_SIZE = 1000

_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE     # 일부 환경에서 인증서 체인 검증 실패 회피

_fetch_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    """같은 (API, 연월) 조합을 동시에 여러 번 내려받지 않도록."""
    with _locks_guard:
        return _fetch_locks.setdefault(key, threading.Lock())


# ---------------------------------------------------------------- 파싱 유틸

def _num(text: str | None) -> float | None:
    """'470,000' -> 470000.0 / 공백·빈값 -> None"""
    if text is None:
        return None
    t = text.strip().replace(",", "")
    if not t:
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _txt(item: ET.Element, tag: str) -> str:
    v = item.findtext(tag)
    return v.strip() if v else ""


def month_range(start: date, end: date) -> list[str]:
    """['202501', '202502', ...] — start/end가 걸친 모든 연월."""
    out, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        out.append(f"{y:04d}{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


# ---------------------------------------------------------------- 디스크 캐시 공통

def _cache_get(name: str, ttl: float | None) -> dict | list | None:
    path = os.path.join(CACHE_DIR, name)
    if not os.path.exists(path):
        return None
    if ttl is not None and time.time() - os.path.getmtime(path) > ttl:
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


def _cache_put(name: str, data) -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, name)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    os.replace(tmp, path)


# ---------------------------------------------------------------- 카카오 지오코딩

GEOCODE_CACHE_PATH = os.path.join(CACHE_DIR, "geocode-cache.json")
_geocode_cache: dict | None = None
_geocode_cache_lock = threading.Lock()


def _load_geocode_cache() -> dict:
    global _geocode_cache
    if _geocode_cache is not None:
        return _geocode_cache
    if os.path.exists(GEOCODE_CACHE_PATH):
        try:
            with open(GEOCODE_CACHE_PATH, "r", encoding="utf-8") as fh:
                _geocode_cache = json.load(fh)
                return _geocode_cache
        except (OSError, json.JSONDecodeError):
            pass
    _geocode_cache = {}
    return _geocode_cache


def _save_geocode_cache() -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = GEOCODE_CACHE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(_geocode_cache, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, GEOCODE_CACHE_PATH)


def _kakao_get(url: str, params: dict) -> dict:
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(
        f"{url}?{qs}",
        headers={"Authorization": f"KakaoAK {KAKAO_REST_KEY}", "User-Agent": "Mozilla/5.0"},
    )
    with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode("utf-8"))


def geocode_one(gu: str, dong: str, jibun: str, apt: str) -> dict | None:
    """(구, 법정동, 지번, 단지명) -> {"lat","lng","src"} 또는 None. 디스크 캐시로 재호출을 막는다."""
    key = f"{gu}|{dong}|{apt}"
    cache = _load_geocode_cache()
    with _geocode_cache_lock:
        if key in cache:
            return cache[key]

    result = None
    if jibun:
        try:
            data = _kakao_get(
                "https://dapi.kakao.com/v2/local/search/address.json",
                {"query": f"서울 {gu} {dong} {jibun}"},
            )
            docs = data.get("documents") or []
            if docs:
                result = {"lat": float(docs[0]["y"]), "lng": float(docs[0]["x"]), "src": "address"}
        except Exception:
            pass
    if result is None and apt:
        try:
            data = _kakao_get(
                "https://dapi.kakao.com/v2/local/search/keyword.json",
                {"query": f"서울 {gu} {dong} {apt}"},
            )
            docs = data.get("documents") or []
            if docs:
                result = {"lat": float(docs[0]["y"]), "lng": float(docs[0]["x"]), "src": "keyword"}
        except Exception:
            pass

    with _geocode_cache_lock:
        cache[key] = result
        _save_geocode_cache()
    return result


def _kakao_geocode_point(query: str) -> tuple[float, float] | None:
    for url in (
        "https://dapi.kakao.com/v2/local/search/address.json",
        "https://dapi.kakao.com/v2/local/search/keyword.json",
    ):
        try:
            data = _kakao_get(url, {"query": query})
            docs = data.get("documents") or []
            if docs:
                return float(docs[0]["y"]), float(docs[0]["x"])
        except Exception:
            continue
    return None


def _kakao_reverse_dong(lat: float, lng: float) -> str:
    """좌표 -> 법정동(B) 이름. NEIS 주소 필드 파싱이 실패한 학교의 동을 구하는 최종 수단."""
    try:
        data = _kakao_get("https://dapi.kakao.com/v2/local/geo/coord2regioncode.json", {"x": lng, "y": lat})
        for doc in data.get("documents") or []:
            if doc.get("region_type") == "B":
                return doc.get("region_3depth_name") or ""
    except Exception:
        pass
    return ""


def _resolve_school_dong(gu: str, name: str, addr: str) -> str:
    """NEIS 주소 필드에서 동을 못 뽑았을 때: 주소를 좌표로 변환 후 역지오코딩으로 법정동을 구한다."""
    cache_name = f"school-dong-{gu}-{name}.json".replace("/", "_").replace(" ", "_")
    cached = _cache_get(cache_name, None)   # 학교 위치는 안 바뀌므로 영구 캐시
    if cached is not None:
        return cached
    dong = ""
    point = _kakao_geocode_point(addr) if addr else None
    if point:
        dong = _kakao_reverse_dong(point[0], point[1])
    _cache_put(cache_name, dong)
    return dong


_LINE_SUFFIX_RE = re.compile(
    r"\s*(수도권)?\d+호선$|\s*(신분당선|경의중앙선|수인분당선|공항철도|우이신설선|서해선|경춘선|GTX-A)$"
)


# 서울시 실시간 도시데이터(citydata)의 "주요 120장소" 중, 실제 호출로 존재를 확인한 장소만
# 구별로 매핑해 둔다(구 전체 교통 상황이 아니라 "이 구 안의 특정 핫스팟" 실시간 현황이라는 점을 프론트에서 명시).
# 중랑구·노원구는 대응하는 핫스팟을 찾지 못해 의도적으로 비워둔다.
GU_HOTSPOTS = {
    "종로구": ["광화문·덕수궁", "익선동"],
    "중구": ["명동 관광특구"],
    "용산구": ["이태원 관광특구", "이태원 앤틱가구거리"],
    "성동구": ["성수카페거리", "서울숲공원"],
    "광진구": ["건대입구역"],
    "동대문구": ["동대문 관광특구"],
    "성북구": ["성신여대입구역"],
    "강북구": ["수유역", "미아사거리역"],
    "도봉구": ["쌍문역"],
    "은평구": ["연신내역"],
    "서대문구": ["신촌·이대역"],
    "마포구": ["홍대 관광특구", "합정역"],
    "양천구": ["신정네거리역"],
    "강서구": ["발산역"],
    "구로구": ["구로디지털단지역", "신도림역", "구로역"],
    "금천구": ["가산디지털단지역"],
    "영등포구": ["여의도", "영등포 타임스퀘어"],
    "동작구": ["사당역", "보라매공원"],
    "관악구": ["서울대입구역", "신림역"],
    "서초구": ["고속터미널역", "교대역"],
    "강남구": ["강남역", "압구정로데오거리", "청담동 명품거리"],
    "송파구": ["잠실 관광특구"],
    "강동구": ["고덕역"],
}
HOTSPOT_TTL = 60 * 10   # 실시간성이 있는 데이터라 캐시를 짧게(10분) 유지


def fetch_hotspots(gu: str) -> list[dict]:
    names = GU_HOTSPOTS.get(gu) or []
    out = []
    for name in names:
        cache_name = f"hotspot-{name}.json".replace("/", "_")
        cached = _cache_get(cache_name, HOTSPOT_TTL)
        if cached is not None:
            if cached:
                out.append(cached)
            continue
        summary = None
        try:
            enc = urllib.parse.quote(name)
            req = urllib.request.Request(
                f"http://openapi.seoul.go.kr:8088/{SEOUL_OPEN_DATA_KEY}/json/citydata/1/1/{enc}",
                headers={"User-Agent": "Mozilla/5.0"},
            )
            with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            city = data.get("CITYDATA") or {}
            ppltn_list = city.get("LIVE_PPLTN_STTS") or [{}]
            pop = ppltn_list[0] if ppltn_list and isinstance(ppltn_list[0], dict) else {}
            roads = city.get("ROAD_TRAFFIC_STTS") or []
            spds = [r["SPD"] for r in roads if isinstance(r, dict) and isinstance(r.get("SPD"), (int, float))]
            weather_list = city.get("WEATHER_STTS") or [{}]
            weather = weather_list[0] if weather_list and isinstance(weather_list[0], dict) else {}
            summary = {
                "name": name,
                "congestLvl": pop.get("AREA_CONGEST_LVL"),
                "congestMsg": pop.get("AREA_CONGEST_MSG"),
                "pplMin": pop.get("AREA_PPLTN_MIN"),
                "pplMax": pop.get("AREA_PPLTN_MAX"),
                "roadAvgSpd": round(sum(spds) / len(spds), 1) if spds else None,
                "temp": weather.get("TEMP"),
                "pcpMsg": weather.get("PCP_MSG"),
            }
        except Exception:
            summary = None
        _cache_put(cache_name, summary)
        if summary:
            out.append(summary)
    return out


def _resolve_point(cache_key: str, *queries: str) -> dict | None:
    """여러 검색어를 순서대로 시도해 좌표를 구하고, 구·미구 여부와 무관하게 결과를 캐싱한다."""
    cache_name = f"place-{cache_key}.json".replace("/", "_").replace(" ", "_")
    cached = _cache_get(cache_name, LOCINFO_TTL)
    if cached is not None:
        return cached
    result = None
    for q in queries:
        if not q:
            continue
        pt = _kakao_geocode_point(q)
        if pt:
            result = {"lat": pt[0], "lng": pt[1]}
            break
    _cache_put(cache_name, result)
    return result


def fetch_subway_stations(gu: str) -> list[dict]:
    """카카오 장소 카테고리 검색(SW8=지하철역)으로 구 내 지하철역·노선을 가져온다."""
    cache_name = f"subway-{SEOUL_GU[gu]}.json"
    cached = _cache_get(cache_name, LOCINFO_TTL)
    if cached is not None:
        return cached

    center = _kakao_geocode_point(f"서울 {gu}청") or _kakao_geocode_point(f"서울 {gu}")
    if not center:
        _cache_put(cache_name, [])
        return []
    lat, lng = center

    seen: dict[str, dict] = {}
    for page in range(1, 4):
        try:
            data = _kakao_get("https://dapi.kakao.com/v2/local/search/category.json", {
                "category_group_code": "SW8", "x": lng, "y": lat,
                "radius": 6000, "size": 15, "page": page, "sort": "distance",
            })
        except Exception:
            break
        for d in data.get("documents") or []:
            addr = d.get("address_name") or d.get("road_address_name") or ""
            if gu not in addr:
                continue
            name = _LINE_SUFFIX_RE.sub("", d.get("place_name", "")).strip()
            line = (d.get("category_name") or "").split(">")[-1].strip()
            if not name:
                continue
            entry = seen.setdefault(name, {
                "lines": set(), "addr": addr, "phone": d.get("phone") or "",
                "lat": float(d["y"]) if d.get("y") else None, "lng": float(d["x"]) if d.get("x") else None,
                "placeUrl": d.get("place_url") or "",
            })
            entry["lines"].add(line)
        if (data.get("meta") or {}).get("is_end", True):
            break

    result = sorted(
        ({"name": n, **{**v, "lines": sorted(v["lines"])}} for n, v in seen.items()),
        key=lambda x: x["name"],
    )
    _cache_put(cache_name, result)
    return result


# ---------------------------------------------------------------- 공공데이터 호출 (RTMS 실거래가)

def _request_xml(api_path: str, lawd_cd: str, ym: str, page: int) -> ET.Element:
    qs = urllib.parse.urlencode({
        "serviceKey": SERVICE_KEY,
        "LAWD_CD": lawd_cd,
        "DEAL_YMD": ym,
        "pageNo": page,
        "numOfRows": PAGE_SIZE,
    })
    url = f"https://apis.data.go.kr/{api_path}?{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "*/*"})

    last_err: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=40, context=_SSL_CTX) as resp:
                return ET.fromstring(resp.read())
        except (urllib.error.URLError, urllib.error.HTTPError, ET.ParseError, TimeoutError) as exc:
            last_err = exc
            time.sleep(0.6 * (attempt + 1))
    raise RuntimeError(f"{api_path} {ym} p{page} 호출 실패: {last_err}")


def _fetch_all_items(api_path: str, lawd_cd: str, ym: str) -> list[ET.Element]:
    """해당 연월·구의 전체 거래를 페이지 끝까지 수집."""
    root = _request_xml(api_path, lawd_cd, ym, 1)

    code = root.findtext(".//resultCode") or ""
    if code not in ("000", "00"):
        msg = root.findtext(".//resultMsg") or root.findtext(".//returnAuthMsg") or "unknown"
        raise RuntimeError(f"공공데이터포털 오류 [{code}] {msg}")

    items = root.findall(".//item")
    total = int(root.findtext(".//totalCount") or len(items))

    page = 2
    while len(items) < total and page <= 40:
        more = _request_xml(api_path, lawd_cd, ym, page).findall(".//item")
        if not more:
            break
        items.extend(more)
        page += 1
    return items


def _parse_trade(item: ET.Element, gu: str, ym: str) -> dict | None:
    """매매 1건 -> dict. 구는 LAWD_CD로 이미 특정되었으므로 API가 주는 동(umdNm)을 그대로 신뢰한다."""
    amount = _num(item.findtext("dealAmount"))       # 만원
    area = _num(item.findtext("excluUseAr"))         # 전용면적 m2
    day = _num(item.findtext("dealDay"))
    if not amount or not area or not day:
        return None
    if _txt(item, "cdealType") == "O":                # 해제된 거래(계약해제) 제외
        return None
    return {
        "type": "sale",
        "gu": gu,
        "dong": _txt(item, "umdNm"),
        "apt": _txt(item, "aptNm"),
        "jibun": _txt(item, "jibun"),
        "date": f"{ym[:4]}-{ym[4:]}-{int(day):02d}",
        "area": area,
        "floor": int(_num(item.findtext("floor")) or 0),
        "buildYear": int(_num(item.findtext("buildYear")) or 0),
        "amount": amount,        # 매매가(만원)
        "deposit": 0.0,
        "rent": 0.0,
        "method": _txt(item, "dealingGbn"),
    }


def _parse_rent(item: ET.Element, gu: str, ym: str) -> dict | None:
    """전월세 1건 -> dict. monthlyRent == 0 이면 전세, 아니면 월세."""
    deposit = _num(item.findtext("deposit"))         # 보증금(만원)
    rent = _num(item.findtext("monthlyRent")) or 0.0  # 월세(만원)
    area = _num(item.findtext("excluUseAr"))
    day = _num(item.findtext("dealDay"))
    if deposit is None or not area or not day:
        return None
    return {
        "type": "jeonse" if rent == 0 else "monthly",
        "gu": gu,
        "dong": _txt(item, "umdNm"),
        "apt": _txt(item, "aptNm"),
        "jibun": _txt(item, "jibun"),
        "date": f"{ym[:4]}-{ym[4:]}-{int(day):02d}",
        "area": area,
        "floor": int(_num(item.findtext("floor")) or 0),
        "buildYear": int(_num(item.findtext("buildYear")) or 0),
        "amount": 0.0,
        "deposit": deposit,
        "rent": rent,
        "method": _txt(item, "contractType"),
    }


# ---------------------------------------------------------------- 월 단위 캐시

def _cache_path(kind: str, lawd_cd: str, ym: str) -> str:
    return os.path.join(CACHE_DIR, f"{kind}-{lawd_cd}-{ym}-{CACHE_VER}.json")


def _is_current_or_future(ym: str) -> bool:
    today = date.today()
    return ym >= f"{today.year:04d}{today.month:02d}"


def load_month(gu: str, kind: str, ym: str, refresh: bool = False) -> list[dict]:
    """kind: 'sale'(매매) | 'rent'(전월세)."""
    lawd_cd = SEOUL_GU[gu]
    path = _cache_path(kind, lawd_cd, ym)

    if not refresh and os.path.exists(path):
        age = time.time() - os.path.getmtime(path)
        if not _is_current_or_future(ym) or age < CACHE_TTL_CURRENT_MONTH:
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    return json.load(fh)
            except (OSError, json.JSONDecodeError):
                pass  # 캐시 손상 -> 재수집

    with _lock_for(f"{gu}:{kind}:{ym}"):
        if not refresh and os.path.exists(path):
            age = time.time() - os.path.getmtime(path)
            if not _is_current_or_future(ym) or age < CACHE_TTL_CURRENT_MONTH:
                try:
                    with open(path, "r", encoding="utf-8") as fh:
                        return json.load(fh)
                except (OSError, json.JSONDecodeError):
                    pass

        api = API_TRADE if kind == "sale" else API_RENT
        parse = _parse_trade if kind == "sale" else _parse_rent
        rows = [d for d in (parse(it, gu, ym) for it in _fetch_all_items(api, lawd_cd, ym)) if d]

        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False)
        os.replace(tmp, path)
        return rows


def collect(gus: list[str], start: date, end: date, refresh: bool = False) -> dict:
    """gus: 수집할 구 이름 리스트(보통 1개, '전체 서울'이면 25개 전부)."""
    months = month_range(start, end)
    jobs = [(gu, kind, ym) for gu in gus for ym in months for kind in ("sale", "rent")]

    errors: list[str] = []
    deals: list[dict] = []

    def work(job):
        gu, kind, ym = job
        try:
            return load_month(gu, kind, ym, refresh)
        except Exception as exc:  # 한 건 실패가 전체를 막지 않도록
            errors.append(f"{gu} {ym} {'매매' if kind == 'sale' else '전월세'}: {exc}")
            return []

    workers = min(12, max(4, len(jobs)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for rows in pool.map(work, jobs):
            deals.extend(rows)

    lo, hi = start.isoformat(), end.isoformat()
    deals = [d for d in deals if lo <= d["date"] <= hi]
    deals.sort(key=lambda d: d["date"])

    return {
        "start": lo,
        "end": hi,
        "gus": gus,
        "months": months,
        "count": len(deals),
        "deals": deals,
        "errors": errors,
        "fetchedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


# ---------------------------------------------------------------- 서울 열린데이터광장 (입지분석용)

def _seoul_open_data_get(service: str, start_idx: int, end_idx: int, extra: str = "") -> list[dict]:
    path = f"/{SEOUL_OPEN_DATA_KEY}/json/{service}/{start_idx}/{end_idx}/{extra}"
    url = f"http://openapi.seoul.go.kr:8088{path}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15, context=_SSL_CTX) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    body = data.get(service) or {}
    result = body.get("RESULT") or {}
    if result.get("CODE") not in (None, "INFO-000"):
        raise RuntimeError(f"{service}: {result.get('CODE')} {result.get('MESSAGE')}")
    return body.get("row") or []


def _seoul_open_data_all(service: str, page_size: int = 1000, max_pages: int = 5) -> list[dict]:
    """전체 서울분을 페이지네이션으로 모두 받아온다(구별 필터는 호출 측에서 수행)."""
    out: list[dict] = []
    for p in range(max_pages):
        start, end = p * page_size + 1, (p + 1) * page_size
        rows = _seoul_open_data_get(service, start, end)
        if not rows:
            break
        out.extend(rows)
        if len(rows) < page_size:
            break
    return out


def fetch_parks_all() -> list[dict]:
    cached = _cache_get("seoul-parks.json", LOCINFO_TTL)
    if cached is not None:
        return cached
    rows = _seoul_open_data_all("SearchParkInfoService")
    _cache_put("seoul-parks.json", rows)
    return rows


def fetch_trade_areas_all() -> list[dict]:
    cached = _cache_get("seoul-tradeareas.json", LOCINFO_TTL)
    if cached is not None:
        return cached
    rows = _seoul_open_data_all("TbgisTrdarRelm", page_size=1000, max_pages=3)
    _cache_put("seoul-tradeareas.json", rows)
    return rows


# ---------------------------------------------------------------- NEIS (학교 기본정보)

def _neis_get(service: str, params: dict) -> list[dict]:
    qs = urllib.parse.urlencode({"KEY": NEIS_KEY, "Type": "json", **params})
    url = f"https://open.neis.go.kr/hub/{service}?{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15, context=_SSL_CTX) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    body = data.get(service)
    if not body:
        return []
    head = body[0].get("head") if isinstance(body[0], dict) else None
    if head:
        result = head[1].get("RESULT") if len(head) > 1 else None
        if result and result.get("CODE") not in (None, "INFO-000"):
            raise RuntimeError(f"{service}: {result.get('CODE')} {result.get('MESSAGE')}")
    for part in body:
        if isinstance(part, dict) and "row" in part:
            return part["row"]
    return []


def fetch_schools_all() -> list[dict]:
    cached = _cache_get("neis-schools.json", LOCINFO_TTL)
    if cached is not None:
        return cached
    out: list[dict] = []
    for page in range(1, 4):
        try:
            rows = _neis_get("schoolInfo", {
                "pIndex": page, "pSize": 1000, "ATPT_OFCDC_SC_CODE": NEIS_SEOUL_OFCDC,
            })
        except Exception:
            break
        if not rows:
            break
        out.extend(rows)
        if len(rows) < 1000:
            break
    _cache_put("neis-schools.json", out)
    return out


# ---------------------------------------------------------------- KOSIS (인구·세대·공식 가격지수)

def _kosis_get(params: dict) -> list[dict]:
    p = {"method": "getList", "apiKey": KOSIS_KEY, "format": "json", "jsonVD": "Y", **params}
    qs = urllib.parse.urlencode(p)
    url = f"https://kosis.kr/openapi/Param/statisticsParameterData.do?{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15, context=_SSL_CTX) as resp:
        raw = resp.read().decode("utf-8")
    # KOSIS는 키를 따옴표로 감싸지 않은 비표준 JSON을 내려줄 때가 있어 정규식으로 보정한다.
    fixed = re.sub(r'([{,])([A-Za-z0-9_]+):', r'\1"\2":', raw)
    data = json.loads(fixed)
    if isinstance(data, dict) and data.get("err"):
        if data.get("err") == "30":     # "데이터가 존재하지 않습니다" — 해당 기간 데이터 없음(정상 케이스)
            return []
        raise RuntimeError(f"KOSIS 오류 [{data.get('err')}] {data.get('errMsg')}")
    return data if isinstance(data, list) else []


def _kosis_get_retry(params: dict, attempts: int = 3) -> list[dict]:
    """KOSIS가 가끔 일시적으로 실패(타임아웃 등)하는 경우가 있어, 바로 포기하지 않고 짧게 재시도한다."""
    last_exc: Exception | None = None
    for i in range(attempts):
        try:
            return _kosis_get(params)
        except Exception as exc:
            last_exc = exc
            time.sleep(0.5 * (i + 1))
    raise last_exc


def fetch_population(gu: str) -> dict | None:
    """구 단위 총인구·고령인구비율. 5세 단위 연령 구간을 합산해 계산한다."""
    lawd = SEOUL_GU[gu]
    year = str(date.today().year)
    try:
        rows = _kosis_get_retry({
            "orgId": "101", "tblId": "DT_1B04005N",
            "objL1": lawd, "objL2": "ALL", "itmId": "T2",
            "prdSe": "Y", "startPrdDe": year, "endPrdDe": year,
        })
        if not rows:
            year = str(date.today().year - 1)
            rows = _kosis_get_retry({
                "orgId": "101", "tblId": "DT_1B04005N",
                "objL1": lawd, "objL2": "ALL", "itmId": "T2",
                "prdSe": "Y", "startPrdDe": year, "endPrdDe": year,
            })
        total = 0
        senior = 0  # 65세 이상
        for r in rows:
            c2 = r.get("C2")
            n = _num(r.get("DT")) or 0
            if c2 == "0":
                total = int(n)
                continue
            age_lo = _num((r.get("C2_NM") or "").split(" ")[0].replace("+", ""))
            if age_lo is not None and age_lo >= 65:
                senior += int(n)
        if not total:
            return None
        return {
            "year": rows[0].get("PRD_DE") if rows else year,
            "total": total,
            "seniorRatio": round(senior / total * 100, 1),
        }
    except Exception:
        return None


def fetch_household(gu: str) -> dict | None:
    lawd = SEOUL_GU[gu]
    year = str(date.today().year)
    try:
        rows = _kosis_get_retry({
            "orgId": "101", "tblId": "DT_1B040B3",
            "objL1": lawd, "itmId": "T1", "prdSe": "Y",
            "startPrdDe": year, "endPrdDe": year,
        })
        if not rows:
            year = str(date.today().year - 1)
            rows = _kosis_get_retry({
                "orgId": "101", "tblId": "DT_1B040B3",
                "objL1": lawd, "itmId": "T1", "prdSe": "Y",
                "startPrdDe": year, "endPrdDe": year,
            })
        if not rows:
            return None
        n = _num(rows[0].get("DT"))
        return {"year": rows[0].get("PRD_DE"), "households": int(n)} if n else None
    except Exception:
        return None


def fetch_price_index(gu: str) -> dict | None:
    """한국부동산원 공동주택 매매 실거래가격지수(시군구·분기별, 2017.4Q=100) — KOSIS 경유."""
    reb_code = REB_GU_CODE.get(gu)
    if not reb_code:
        return None
    try:
        this_year = date.today().year
        rows = _kosis_get({
            "orgId": "408", "tblId": "DT_KAB_11672_S5",
            "objL1": reb_code, "itmId": "T1", "prdSe": "Q",
            "startPrdDe": f"{this_year - 3}1", "endPrdDe": f"{this_year}4",
        })
        points = []
        for r in rows:
            v = _num(r.get("DT"))
            prd = r.get("PRD_DE")  # 예: "202501" = 2025년 1분기
            if v is None or not prd or len(prd) != 6:
                continue
            points.append({"period": f"{prd[:4]}Q{prd[4:]}", "value": round(v, 2)})
        points.sort(key=lambda p: p["period"])
        return {"gu": gu, "unit": "2017.4Q=100", "points": points} if points else None
    except Exception:
        return None


def _build_park_sample(gu: str, parks: list[dict]) -> list[dict]:
    out = []
    for p in parks:
        name = p.get("PARK_NM") or ""
        lat, lng = _num(p.get("YCRD")), _num(p.get("XCRD"))
        if lat is None or lng is None:
            primary, secondary = _split_paren(name)
            queries = [p.get("PARK_ADDR"), f"서울 {gu} {name}"]
            if secondary:
                queries += [f"서울 {gu} {primary}", secondary, primary]
            pt = _resolve_point(f"park-{name}", *queries)
            if pt:
                lat, lng = pt["lat"], pt["lng"]
        out.append({
            "name": name, "addr": p.get("PARK_ADDR"), "lat": lat, "lng": lng,
            "tel": p.get("TELNO") or "", "openYmd": p.get("OPEN_YMD") or "",
            "mainFclt": (p.get("MAIN_FCLT") or "")[:150],
        })
    return out


_PAREN_SPLIT_RE = re.compile(r"^(.*?)\(([^)]+)\)\s*$")


def _split_paren(name: str) -> tuple[str, str]:
    """"서울나래학교(염곡어린이공원)" -> ("서울나래학교", "염곡어린이공원").
    합쳐진 문자열 전체로는 지도 검색이 실패해도 둘 중 하나만으로는 찾아지는 경우가 많다."""
    m = _PAREN_SPLIT_RE.match(name or "")
    return (m.group(1).strip(), m.group(2).strip()) if m else (name, "")


def _build_tradearea_sample(gu: str, trade_areas: list[dict]) -> list[dict]:
    seen: dict[str, dict] = {}
    for t in trade_areas:
        name = t.get("TRDAR_CD_NM")
        if not name or name in seen:
            continue
        dong = t.get("ADSTRD_CD_NM") or ""
        primary, secondary = _split_paren(name)
        queries = [f"서울 {gu} {dong} {name}", f"서울 {gu} {name}"]
        if secondary:
            queries += [f"서울 {gu} {dong} {primary}", f"서울 {gu} {primary}", secondary, primary]
        pt = _resolve_point(f"trade-{gu}-{name}", *queries)
        seen[name] = {
            "name": name, "category": t.get("TRDAR_SE_CD_NM") or "",
            "lat": pt["lat"] if pt else None, "lng": pt["lng"] if pt else None,
        }
        if len(seen) >= 8:
            break
    return list(seen.values())


def build_locinfo(gu: str) -> dict:
    cache_name = f"locinfo-{SEOUL_GU[gu]}.json"
    cached = _cache_get(cache_name, LOCINFO_TTL)
    if cached is not None:
        # hotspots는 실시간성이 있어 locinfo의 7일 캐시와 별도로 매번 새로 받는다(자체 10분 캐시 보유).
        cached["hotspots"] = fetch_hotspots(gu)
        # KOSIS 호출이 드물게 일시 실패해 population/household가 None으로 캐싱되면 7일간 그대로
        # 굳어버리므로, None이면 매번 재시도한다(성공하면 그 결과로 캐시 파일도 갱신).
        retried = False
        if cached.get("population") is None:
            cached["population"] = fetch_population(gu)
            retried = True
        if cached.get("household") is None:
            cached["household"] = fetch_household(gu)
            retried = True
        if retried:
            _cache_put(cache_name, cached)   # hotspots는 다음 읽을 때 어차피 다시 덮어써지므로 그대로 저장해도 무방
        return cached

    parks = [p for p in fetch_parks_all() if (p.get("RGN") or "") == gu]
    trade_areas = [t for t in fetch_trade_areas_all() if (t.get("SIGNGU_CD_NM") or "") == gu]
    schools = [s for s in fetch_schools_all() if gu in (s.get("ORG_RDNMA") or "")]
    school_by_kind: dict[str, list[dict]] = {}
    for s in schools:
        kind = s.get("SCHUL_KND_SC_NM") or "기타"
        fond_ymd = s.get("FOND_YMD") or ""
        name = s.get("SCHUL_NM") or ""
        addr = s.get("ORG_RDNMA") or ""
        dong_m = _DONG_IN_PAREN_RE.search(s.get("ORG_RDNDA") or "")
        dong = dong_m.group(1).strip() if dong_m else ""
        if not dong:
            # NEIS 주소 필드 파싱 실패 시 좌표 역지오코딩으로 최종 확인(세화여자고등학교 등)
            dong = _resolve_school_dong(gu, name, addr)
        school_by_kind.setdefault(kind, []).append({
            "name": name,
            "dong": dong,
            "addr": addr,
            "tel": s.get("ORG_TELNO") or "",
            "homepage": s.get("HMPG_ADRES") or "",
            "coedu": s.get("COEDU_SC_NM") or "",
            "founded": s.get("FOND_SC_NM") or "",
            "hsType": s.get("HS_SC_NM") or "",   # 고등학교만 해당(일반고/자율고/특목고/특성화고 등)
            "foundYear": fond_ymd[:4] if len(fond_ymd) >= 4 else "",
        })

    result = {
        "gu": gu,
        "parks": {"count": len(parks), "sample": _build_park_sample(gu, parks[:8])},
        "tradeAreas": {"count": len(trade_areas), "sample": _build_tradearea_sample(gu, trade_areas)},
        "population": fetch_population(gu),
        "household": fetch_household(gu),
        "subway": fetch_subway_stations(gu),
        "hotspots": fetch_hotspots(gu),
        "schools": {
            "count": len(schools),
            "byKind": {k: sorted(v, key=lambda x: x["name"]) for k, v in school_by_kind.items()},
        },
        "builtAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    _cache_put(cache_name, result)
    return result


# ---------------------------------------------------------------- HTTP

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB_DIR, **kw)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            sys.stderr.write(f"  [api] {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}\n")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/api/deals":
            gu = (q.get("gu") or ["all"])[0]
            s = (q.get("start") or [""])[0]
            e = (q.get("end") or [""])[0]

            if gu != "all" and gu not in SEOUL_GU:
                return self._json(400, {"error": f"알 수 없는 구: {gu}"})
            if not DATE_RE.match(s) or not DATE_RE.match(e):
                return self._json(400, {"error": "start/end는 YYYY-MM-DD 형식이어야 합니다."})

            try:
                start, end = date.fromisoformat(s), date.fromisoformat(e)
            except ValueError:
                return self._json(400, {"error": "존재하지 않는 날짜입니다."})

            if start > end:
                start, end = end, start
            max_days = 1200 if gu != "all" else 730   # 전체 서울은 25배 무거우니 기간을 더 좁게 제한
            if end - start > timedelta(days=max_days):
                return self._json(400, {"error": f"조회 기간은 최대 약 {max_days // 365}년까지 지원합니다."})

            refresh = (q.get("refresh") or ["0"])[0] == "1"
            gus = list(SEOUL_GU) if gu == "all" else [gu]
            try:
                return self._json(200, collect(gus, start, end, refresh))
            except Exception as exc:
                return self._json(502, {"error": f"공공데이터 조회 실패: {exc}"})

        if parsed.path == "/api/geocode-batch":
            raw = (q.get("items") or ["[]"])[0]
            try:
                items = json.loads(raw)
            except json.JSONDecodeError:
                return self._json(400, {"error": "items는 JSON 배열이어야 합니다."})
            out = []
            for it in items[:60]:
                gu = str(it.get("gu", ""))[:20]
                dong = str(it.get("dong", ""))[:20]
                jibun = str(it.get("jibun", ""))[:30]
                apt = str(it.get("apt", ""))[:40]
                try:
                    out.append(geocode_one(gu, dong, jibun, apt))
                except Exception:
                    out.append(None)
            return self._json(200, {"results": out})

        if parsed.path == "/api/locinfo":
            gu = (q.get("gu") or [""])[0]
            if gu not in SEOUL_GU:
                return self._json(400, {"error": f"알 수 없는 구: {gu}"})
            try:
                return self._json(200, build_locinfo(gu))
            except Exception as exc:
                return self._json(502, {"error": f"입지분석 데이터 조회 실패: {exc}"})

        if parsed.path == "/api/price-index":
            gu = (q.get("gu") or [""])[0]
            if gu not in SEOUL_GU:
                return self._json(400, {"error": f"알 수 없는 구: {gu}"})
            idx = fetch_price_index(gu)
            return self._json(200, idx or {"gu": gu, "available": False})

        if parsed.path == "/api/health":
            return self._json(200, {"ok": True, "gus": list(SEOUL_GU)})

        return super().do_GET()


def main():
    if not os.path.isdir(WEB_DIR):
        sys.exit(f"web 폴더를 찾을 수 없습니다: {WEB_DIR}")

    _warn_missing_keys()

    url = f"http://localhost:{PORT}/"
    print("=" * 58)
    print("  금집부쌤의 서울시 아파트 실거래 대시보드")
    print("  데이터: 국토교통부 실거래가 · 서울 열린데이터광장 · KOSIS · 카카오")
    print(f"  주소:   {url}")
    print("  종료:   Ctrl+C")
    print("=" * 58)

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")
        server.shutdown()


if __name__ == "__main__":
    main()
