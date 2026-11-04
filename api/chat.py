"""공개 채팅 엔드포인트 (Vercel Python 서버리스 함수).

site/data/digests.json (과거 브리핑 본문)과 site/data/graph.json (지식그래프:
기업·리포트·재무정보·DART 검증 관계)을 읽기 전용으로 참고해서, Claude가 도구
호출로 필요한 데이터를 찾아 답한다. 둘 다 build_site.py가 배포 때마다 같이
굽는 공개 스냅샷이라, 이 함수는 비공개 데이터(API 키 등)에 접근하지 않는다.

IP당 하루 메시지 수를 Upstash Redis REST API로 제한한다 (ANTHROPIC_API_KEY로
요청마다 과금되므로, 무제한 스팸을 막기 위함). Upstash 환경변수가 없으면
제한 없이 통과시킨다 (로컬 테스트용).
"""
import json
import os
from datetime import date
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import requests
import anthropic

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DAILY_LIMIT = 20
MODEL = "claude-sonnet-5-5"

SYSTEM_PROMPT = """너는 한국 증권사 리서치 리포트를 매일 수집·요약하는 '리서치 브리핑'
사이트의 질문 답변 도우미다.

규칙:
- 제공된 도구로 조회한 내용에 근거해서만 답해라. 모르면 모른다고 해라.
- 투자 판단·전망·추천은 하지 마라. 과거에 어떤 리포트가 뭐라고 했는지,
  공시·재무제표 수치가 어땠는지를 사실 중심으로 정리해라.
- 날짜·수치를 인용할 땐 어느 날짜 브리핑인지 꼭 밝혀라.
- 간결하게 답해라."""

TOOLS = [
    {
        "name": "get_daily_briefing",
        "description": "특정 날짜의 데일리 브리핑(매크로/채권/섹터/투자전략) 전체 내용을 가져온다.",
        "input_schema": {
            "type": "object",
            "properties": {"date": {"type": "string", "description": "YYYY-MM-DD"}},
            "required": ["date"],
        },
    },
    {
        "name": "search_briefings",
        "description": "키워드로 과거 브리핑 제목·본문을 검색해서, 일치하는 날짜와 섹션 제목 목록을 반환한다.",
        "input_schema": {
            "type": "object",
            "properties": {
                "keyword": {"type": "string"},
                "limit": {"type": "integer", "description": "최대 결과 수 (기본 8)"},
            },
            "required": ["keyword"],
        },
    },
    {
        "name": "company_lookup",
        "description": "기업명으로 최근 언급된 리포트 날짜·제목, 쌓인 재무정보, DART 공시 검증 이력을 조회한다.",
        "input_schema": {
            "type": "object",
            "properties": {"company_name": {"type": "string"}},
            "required": ["company_name"],
        },
    },
]


def _load_json(name: str):
    path = DATA_DIR / name
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


_DIGESTS = _load_json("digests.json") or {}
_GRAPH = _load_json("graph.json") or {"nodes": [], "edges": []}
_NODES_BY_ID = {n["id"]: n for n in _GRAPH.get("nodes", [])}


def tool_get_daily_briefing(args: dict) -> str:
    d = _DIGESTS.get(args.get("date", ""))
    if not d:
        return f"'{args.get('date')}' 브리핑을 찾지 못함"
    parts = [f"# {d['date']} ({d.get('headline', '')})"]
    for tab in d.get("tabs", []):
        parts.append(f"\n## {tab['title']}\n{tab['md'][:3000]}")
    return "\n".join(parts)


def tool_search_briefings(args: dict) -> str:
    keyword = args.get("keyword", "")
    limit = args.get("limit", 8)
    if not keyword:
        return "검색어가 비어있음"
    hits = []
    for d, digest in sorted(_DIGESTS.items(), reverse=True):
        for tab in digest.get("tabs", []):
            if keyword in tab["title"] or keyword in tab["md"]:
                idx = tab["md"].find(keyword)
                snippet = tab["md"][max(0, idx - 60): idx + 120].replace("\n", " ") if idx >= 0 else tab["title"]
                hits.append(f"- [{d}] {tab['title']}: ...{snippet}...")
                if len(hits) >= limit:
                    break
        if len(hits) >= limit:
            break
    return "\n".join(hits) if hits else f"'{keyword}' 관련 내용을 찾지 못함"


def tool_company_lookup(args: dict) -> str:
    name = args.get("company_name", "")
    company_node = None
    for n in _GRAPH.get("nodes", []):
        if n.get("kind") == "Company" and n.get("name") == name:
            company_node = n
            break
    if not company_node:
        for n in _GRAPH.get("nodes", []):
            if n.get("kind") == "Company" and name in n.get("name", ""):
                company_node = n
                break
    if not company_node:
        return f"'{name}' 기업을 찾지 못함"

    cid = company_node["id"]
    mentions, periods, verified = [], [], []
    for e in _GRAPH.get("edges", []):
        if e.get("target") == cid and e.get("kind") == "MENTIONS":
            src = _NODES_BY_ID.get(e["source"], {})
            mentions.append(f"{src.get('date')} [{src.get('broker')}] {src.get('title')}")
        if e.get("target") == cid and e.get("kind") == "HAS_PERIOD":
            pass
        if e.get("source") == cid and e.get("kind") == "HAS_PERIOD":
            p = _NODES_BY_ID.get(e["target"], {})
            periods.append(p)
        if e.get("target") == cid and e.get("kind") == "VERIFIED":
            src = _NODES_BY_ID.get(e["source"], {})
            verified.append(src.get("date", ""))

    lines = [f"[{name}] corp_code={company_node.get('corp_code')} stock_code={company_node.get('stock_code')}"]
    if mentions:
        lines.append(f"\n최근 언급 리포트 ({len(mentions)}건 중 최근 10건):")
        lines += [f"- {m}" for m in sorted(mentions, reverse=True)[:10]]
    if periods:
        lines.append("\n재무정보 (쌓인 기간):")
        for p in sorted(periods, key=lambda p: (p.get("year", ""), p.get("order", 9))):
            lines.append(
                f"- {p.get('year')} reprt={p.get('reprt_code')}: 매출액 {p.get('매출액')}, "
                f"영업이익 {p.get('영업이익')}, 당기순이익 {p.get('당기순이익')}"
            )
    if verified:
        lines.append(f"\nDART 공시 검증된 날짜: {', '.join(sorted(set(verified), reverse=True))}")
    return "\n".join(lines)


TOOL_FUNCS = {
    "get_daily_briefing": tool_get_daily_briefing,
    "search_briefings": tool_search_briefings,
    "company_lookup": tool_company_lookup,
}


def check_rate_limit(ip: str) -> bool:
    url = os.environ.get("UPSTASH_REDIS_REST_URL")
    token = os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    if not url or not token:
        return True
    key = f"chat_rate:{ip}:{date.today().isoformat()}"
    try:
        resp = requests.post(f"{url}/incr/{key}", headers={"Authorization": f"Bearer {token}"}, timeout=5)
        count = resp.json().get("result", 0)
        if count == 1:
            requests.post(f"{url}/expire/{key}/86400", headers={"Authorization": f"Bearer {token}"}, timeout=5)
        return count <= DAILY_LIMIT
    except Exception:
        return True  # rate limit 서비스 장애로 전체 기능이 죽으면 안 됨


def run_chat(user_message: str, history: list[dict]) -> str:
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    messages = history + [{"role": "user", "content": user_message}]

    for _ in range(6):  # 도구 호출 루프 최대 6회 (무한루프 방지)
        resp = client.messages.create(
            model=MODEL, max_tokens=1200, system=SYSTEM_PROMPT, tools=TOOLS, messages=messages,
        )
        if resp.stop_reason != "tool_use":
            return "".join(b.text for b in resp.content if b.type == "text")

        messages.append({"role": "assistant", "content": resp.content})
        tool_results = []
        for block in resp.content:
            if block.type != "tool_use":
                continue
            func = TOOL_FUNCS.get(block.name)
            result = func(block.input) if func else f"알 수 없는 도구: {block.name}"
            tool_results.append({"type": "tool_result", "tool_use_id": block.id, "content": result})
        messages.append({"role": "user", "content": tool_results})

    return "답변 생성이 너무 길어져서 중단했어요. 질문을 조금 더 구체적으로 해주세요."


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        ip = self.headers.get("x-forwarded-for", self.client_address[0]).split(",")[0].strip()
        length = int(self.headers.get("content-length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "잘못된 요청"})

        message = (body.get("message") or "").strip()
        if not message:
            return self._send(400, {"error": "message가 비어있음"})
        if len(message) > 500:
            return self._send(400, {"error": "메시지가 너무 깁니다 (500자 이하)"})
        if not check_rate_limit(ip):
            return self._send(429, {"error": f"하루 질문 한도({DAILY_LIMIT}건)를 넘었어요. 내일 다시 시도해주세요."})

        history = body.get("history") or []
        try:
            answer = run_chat(message, history[-10:])
        except Exception as e:
            return self._send(500, {"error": f"답변 생성 실패: {e}"})
        self._send(200, {"answer": answer})

    def _send(self, status: int, payload: dict):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
