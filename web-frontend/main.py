"""
Web frontend for OpenClaw - FastAPI server + React SPA.
Autonomous agent architecture with background loop, GitHub workspace,
code execution via function-bun, and Redis job queue.
"""

import asyncio
import base64
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from livekit import api
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

try:
    import redis.asyncio as aioredis
    HAS_REDIS = True
except ImportError:
    HAS_REDIS = False

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# -- App -----------------------------------------------------------------------
app = FastAPI(title="OpenClaw Web")

# -- Environment ---------------------------------------------------------------
LIVEKIT_URL        = os.environ.get("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY    = os.environ.get("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "secret")

OPENCLAW_BASE_URL      = os.environ.get("OPENCLAW_BASE_URL", "https://openclaw-production-058c.up.railway.app")
OPENCLAW_GATEWAY_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")
OPENCLAW_API_BASE      = f"{OPENCLAW_BASE_URL.rstrip('/')}/v1"

ACCESS_TOKEN = os.environ.get("OPENCLAW_ACCESS_TOKEN", "")

GITHUB_TOKEN  = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO   = os.environ.get("GITHUB_REPO", "aisebastianfletcher/LiveKit-Template")
GITHUB_BRANCH = "main"
GH_HEADERS = {
    "Authorization": f"token {GITHUB_TOKEN}",
    "Accept": "application/vnd.github.v3+json",
}

MEMORY_FILES = [
    "memory/profile.md",
    "memory/tasks.md",
    "memory/conversations.md",
    "memory/automations.md",
]

FUNCTION_BUN_URL   = os.environ.get("FUNCTION_BUN_URL", "http://function-bun.railway.internal:3000")
FUNCTION_BUN_TOKEN = os.environ.get("FUNCTION_BUN_TOKEN", "")
REDIS_URL          = os.environ.get("REDIS_URL", "")
LOOP_INTERVAL      = int(os.environ.get("LOOP_INTERVAL_SECONDS", "60"))
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL   = os.environ.get("OPENROUTER_MODEL", "google/gemini-flash-1.5")

DIST_DIR = os.path.join(os.path.dirname(__file__), "dist")

_TASKS_BEGIN = "<!--TASKS_JSON_BEGIN-->"
_TASKS_END   = "<!--TASKS_JSON_END-->"

logger.info(f"OpenClaw base URL: {OPENCLAW_BASE_URL}")
logger.info(f"Auth enabled: {bool(ACCESS_TOKEN)}")

redis_client = None

# -- Phase 5: Self-aware system prompt ----------------------------------------
BASE_INSTRUCTIONS = """You are OpenClaw, a stateful autonomous AI assistant.

## Your capabilities
- **Memory**: You have persistent memory stored in GitHub (aisebastianfletcher/LiveKit-Template).
  Files in memory/ are loaded at every session. You can read/write ANY file in the repo.
- **Code execution**: You can run JavaScript/TypeScript via the function-bun service.
  To queue code: tell the user you'll run it and POST to /api/exec.
- **Background work**: You have a background loop that runs every 60 seconds.
  You can queue jobs that run even when no user is present.
- **Self-improvement**: You write reflections to workspace/reflections/ and can update
  your own prompts by writing to workspace/prompts/.
- **Task tracking**: Pending tasks are in memory/tasks.md. You check these autonomously.

## Your memory structure
- memory/profile.md - who the user is, preferences, facts
- memory/tasks.md - tasks and todos
- memory/conversations.md - session summaries
- memory/automations.md - recurring automations
- workspace/ - your working area: code, results, reflections, status

## Channels
You run simultaneously as a voice agent (LiveKit) and a text chat interface.
Both channels share the same GitHub memory. Anything you learn in one channel
is available in the other.

## Behaviour
- Be honest about what you can and can't do yet.
- When you learn something important about the user, say you'll remember it - and you will.
- Keep voice responses short (1-2 sentences). Text responses can be longer.
- You run background jobs in your free time. You can tell the user what you did.
"""

# -- Auth middleware ------------------------------------------------------------
class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if ACCESS_TOKEN and request.url.path.startswith("/api/"):
            auth_header = request.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token = auth_header[len("Bearer "):]
            else:
                token = ""
            if token != ACCESS_TOKEN:
                return Response(
                    content='{"error":"Unauthorized"}',
                    status_code=401,
                    media_type="application/json",
                )
        return await call_next(request)

app.add_middleware(AuthMiddleware)

# -- GitHub helpers ------------------------------------------------------------
async def read_github_file(path: str) -> str:
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}?ref={GITHUB_BRANCH}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.get(url, headers=GH_HEADERS)
            if resp.status_code == 200:
                data = resp.json()
                return base64.b64decode(data["content"]).decode("utf-8")
            logger.warning(f"Failed to read {path}: {resp.status_code}")
            return ""
        except Exception as e:
            logger.error(f"Error reading {path}: {e}")
            return ""

async def write_github_file(path: str, content: str, message: str) -> bool:
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.get(url + f"?ref={GITHUB_BRANCH}", headers=GH_HEADERS)
            sha = resp.json().get("sha", "") if resp.status_code == 200 else ""
            payload = {
                "message": message,
                "content": base64.b64encode(content.encode("utf-8")).decode("utf-8"),
                "branch": GITHUB_BRANCH,
            }
            if sha:
                payload["sha"] = sha
            resp = await client.put(url, headers=GH_HEADERS, json=payload)
            if resp.status_code in (200, 201):
                logger.info(f"Wrote {path}: {message}")
                return True
            logger.error(f"Failed to write {path}: {resp.status_code} {resp.text}")
            return False
        except Exception as e:
            logger.error(f"Error writing {path}: {e}")
            return False

async def load_memory() -> str:
    sections = []
    for path in MEMORY_FILES:
        content = await read_github_file(path)
        if content:
            sections.append(content)
    return "\n\n---\n\n".join(sections) if sections else "(no memory loaded)"

# -- Conversation summary ------------------------------------------------------
async def save_chat_summary(user_message: str, assistant_reply: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{OPENCLAW_API_BASE}/chat/completions",
                headers={"Authorization": f"Bearer {OPENCLAW_GATEWAY_TOKEN}", "Content-Type": "application/json"},
                json={"model": "openclaw", "messages": [
                    {"role": "system", "content": "Summarize this exchange in 1-2 sentences. Note any tasks, preferences, or facts. Be very concise."},
                    {"role": "user", "content": f"User: {user_message}\n\nAssistant: {assistant_reply}"},
                ], "max_tokens": 150},
            )
            data = resp.json()
            summary = data["choices"][0]["message"]["content"]
    except Exception as e:
        logger.error(f"Failed to generate chat summary: {e}")
        summary = f"(raw) User: {user_message[:100]}"
    convos = await read_github_file("memory/conversations.md")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    entry = f"\n### {now} (text chat)\n{summary}\n"
    if "## Session Log" in convos:
        convos = convos.replace("(no sessions yet)", "")
        idx = convos.rfind("---")
        if idx > 0:
            convos = convos[:idx] + entry + "\n" + convos[idx:]
        else:
            convos += entry
    else:
        convos += entry
    await write_github_file("memory/conversations.md", convos, f"OpenClaw: text chat summary {now}")

# -- Task persistence ----------------------------------------------------------
_tasks: list = []
_tasks_lock = asyncio.Lock()

async def _read_tasks_from_github() -> list:
    content = await read_github_file("memory/tasks.md")
    if _TASKS_BEGIN in content and _TASKS_END in content:
        start = content.index(_TASKS_BEGIN) + len(_TASKS_BEGIN)
        end = content.index(_TASKS_END)
        try:
            return json.loads(content[start:end].strip())
        except json.JSONDecodeError:
            return []
    return []

async def _write_tasks_to_github(task_list: list) -> None:
    content = await read_github_file("memory/tasks.md")
    json_blob = json.dumps(task_list, indent=2)
    new_block = f"{_TASKS_BEGIN}\n{json_blob}\n{_TASKS_END}"
    if _TASKS_BEGIN in content and _TASKS_END in content:
        start = content.index(_TASKS_BEGIN)
        end = content.index(_TASKS_END) + len(_TASKS_END)
        content = content[:start] + new_block + content[end:]
    else:
        content += f"\n\n{new_block}\n"
    await write_github_file("memory/tasks.md", content, "OpenClaw: sync tasks")

# -- LLM helper for autonomous loop --------------------------------------------
async def call_openclaw_llm(prompt: str, system: str = "") -> str:
    memory = await load_memory()
    messages = [{"role": "system", "content": system or (BASE_INSTRUCTIONS + "\n\n" + memory)}]
    messages.append({"role": "user", "content": prompt})
    # Try OpenClaw gateway first, fall back to OpenRouter
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{OPENCLAW_API_BASE}/chat/completions",
                headers={"Authorization": f"Bearer {OPENCLAW_GATEWAY_TOKEN}", "Content-Type": "application/json"},
                json={"model": "openclaw", "messages": messages},
            )
            if resp.status_code == 200:
                return resp.json()["choices"][0]["message"]["content"]
    except Exception:
        pass
    # Fallback to OpenRouter direct
    if OPENROUTER_API_KEY:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}", "Content-Type": "application/json", "HTTP-Referer": "https://openclaw.app", "X-Title": "OpenClaw"},
                json={"model": OPENROUTER_MODEL, "messages": messages},
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
    return "(LLM unavailable)"

# -- Startup -------------------------------------------------------------------
@app.on_event("startup")
async def _startup() -> None:
    global _tasks, redis_client
    try:
        _tasks = await _read_tasks_from_github()
        logger.info(f"Loaded {len(_tasks)} tasks from GitHub")
    except Exception as e:
        logger.error(f"Could not load tasks on startup: {e}")
        _tasks = []
    # Redis + autonomous loop
    if HAS_REDIS and REDIS_URL:
        try:
            redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)
            logger.info("Redis connected")
        except Exception as e:
            logger.error(f"Redis connection failed: {e}")
    asyncio.create_task(autonomous_loop())
    logger.info("Autonomous loop started")

# -- LiveKit token -------------------------------------------------------------
@app.post("/api/token")
async def create_token(request: Request):
    body = await request.json()
    room_name = body.get("room", f"test-room-{uuid.uuid4().hex[:8]}")
    identity = body.get("identity", f"user-{uuid.uuid4().hex[:6]}")
    token = (
        api.AccessToken(api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
        .with_identity(identity).with_name(identity)
        .with_grants(api.VideoGrants(room_join=True, room=room_name))
        .to_jwt()
    )
    return {"token": token, "url": LIVEKIT_URL, "room": room_name, "identity": identity}

@app.post("/api/livekit/token")
async def livekit_token(request: Request):
    body = await request.json()
    room_name = body.get("room_name", f"test-room-{uuid.uuid4().hex[:8]}")
    participant_name = body.get("participant_name", f"user-{uuid.uuid4().hex[:6]}")
    token = (
        api.AccessToken(api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
        .with_identity(participant_name).with_name(participant_name)
        .with_grants(api.VideoGrants(room_join=True, room=room_name))
        .to_jwt()
    )
    return {"token": token, "url": LIVEKIT_URL}

# -- Text chat with memory -----------------------------------------------------
@app.post("/api/openclaw/chat")
async def proxy_openclaw_chat(request: Request):
    body = await request.json()
        messages = body.get("messages", [])
        last_user = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
        try:
            reply = await call_openclaw_llm(last_user)
            if last_user and reply:
                asyncio.create_task(save_chat_summary(last_user, reply))
            return JSONResponse(content={"reply": reply})
        except Exception as e:
            return JSONResponse(content={"error": str(e)}, status_code=500)
    return JSONResponse(content=_tasks)

@app.post("/api/tasks")
async def create_task(request: Request):
    global _tasks
    body = await request.json()
    task = {"id": uuid.uuid4().hex[:8], "title": body.get("title", "Untitled task"),
            "status": body.get("status", "pending"), "created_at": time.time(),
            "updated_at": time.time(), "source": body.get("source", "user")}
    async with _tasks_lock:
        _tasks.append(task)
        await _write_tasks_to_github(list(_tasks))
    return JSONResponse(content=task, status_code=201)

@app.patch("/api/tasks/{task_id}")
async def update_task(task_id: str, request: Request):
    global _tasks
    body = await request.json()
    async with _tasks_lock:
        for task in _tasks:
            if task["id"] == task_id:
                if "status" in body: task["status"] = body["status"]
                if "title" in body: task["title"] = body["title"]
                task["updated_at"] = time.time()
                await _write_tasks_to_github(list(_tasks))
                return JSONResponse(content=task)
    return JSONResponse(content={"error": "Task not found"}, status_code=404)

@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str):
    global _tasks
    async with _tasks_lock:
        _tasks = [t for t in _tasks if t["id"] != task_id]
        await _write_tasks_to_github(list(_tasks))
    return JSONResponse(content={"ok": True})

# -- Agents (in-memory) --------------------------------------------------------
_agents: list = []

@app.get("/api/agents")
async def get_agents():
    return JSONResponse(content=_agents)

@app.post("/api/agents")
async def create_agent(request: Request):
    body = await request.json()
    agent = {"id": uuid.uuid4().hex[:8], "name": body.get("name", "unnamed"),
             "type": body.get("type", "general"), "status": body.get("status", "active"),
             "created_at": time.time()}
    _agents.append(agent)
    return JSONResponse(content=agent, status_code=201)

# -- Memory read routes --------------------------------------------------------
@app.get("/api/memory/conversations")
async def get_memory_conversations():
    content = await read_github_file("memory/conversations.md")
    return {"content": content}

@app.get("/api/memory/profile")
async def get_memory_profile():
    content = await read_github_file("memory/profile.md")
    return {"content": content}

@app.get("/api/memory/tasks")
async def get_memory_tasks():
    content = await read_github_file("memory/tasks.md")
    return {"content": content}

# -- Phase 1: Generic GitHub workspace API -------------------------------------
@app.get("/api/workspace/files")
async def list_workspace_files(path: str = ""):
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}?ref={GITHUB_BRANCH}"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url, headers=GH_HEADERS)
        if resp.status_code != 200:
            return JSONResponse(status_code=resp.status_code, content={"detail": resp.text})
        items = [{"name": i["name"], "path": i["path"], "type": i["type"], "size": i.get("size")} for i in resp.json()]
        return {"files": items}

@app.get("/api/workspace/file")
async def read_workspace_file(path: str):
    content = await read_github_file(path)
    return {"path": path, "content": content}

class WriteFileRequest(BaseModel):
    path: str
    content: str
    message: str = ""

@app.post("/api/workspace/file")
async def write_workspace_file(req: WriteFileRequest):
    msg = req.message or f"OpenClaw: update {req.path}"
    ok = await write_github_file(req.path, req.content, msg)
    return {"ok": ok}

@app.delete("/api/workspace/file")
async def delete_workspace_file(path: str, message: str = ""):
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url + f"?ref={GITHUB_BRANCH}", headers=GH_HEADERS)
        sha = resp.json().get("sha", "")
        del_resp = await client.delete(url, headers=GH_HEADERS, json={
            "message": message or f"OpenClaw: delete {path}", "sha": sha, "branch": GITHUB_BRANCH})
        return {"ok": del_resp.status_code in (200, 204)}

# -- Phase 2: Code execution via function-bun ----------------------------------
class ExecRequest(BaseModel):
    code: str
    input: dict = {}
    timeout_ms: int = 10000

@app.post("/api/exec")
async def exec_code(req: ExecRequest):
    async with httpx.AsyncClient(timeout=req.timeout_ms / 1000 + 5) as client:
        resp = await client.post(
            FUNCTION_BUN_URL,
            headers={"Authorization": f"Bearer {FUNCTION_BUN_TOKEN}"},
            json={"code": req.code, "input": req.input, "timeout_ms": req.timeout_ms},
        )
        return resp.json()

# -- Phase 3: Redis job queue --------------------------------------------------
class EnqueueRequest(BaseModel):
    job_type: str
    payload: dict
    priority: int = 5

@app.post("/api/jobs/enqueue")
async def enqueue_job(req: EnqueueRequest):
    if not redis_client:
        return JSONResponse(status_code=503, content={"detail": "Redis not available"})
    job = {"type": req.job_type, "payload": req.payload, "queued_at": datetime.utcnow().isoformat()}
    await redis_client.lpush("openclaw:jobs", json.dumps(job))
    return {"queued": True}

@app.get("/api/jobs/queue")
async def list_queue():
    if not redis_client:
        return {"jobs": [], "length": 0}
    jobs = await redis_client.lrange("openclaw:jobs", 0, -1)
    return {"jobs": [json.loads(j) for j in jobs], "length": len(jobs)}

# -- Phase 4: Autonomous background loop ---------------------------------------
async def autonomous_loop():
    await asyncio.sleep(10)  # let FastAPI finish starting
    logger.info("[LOOP] Autonomous loop running")
    while True:
        try:
            await run_loop_tick()
        except Exception as e:
            logger.error(f"[LOOP] Tick error: {e}")
        await asyncio.sleep(LOOP_INTERVAL)

async def run_loop_tick():
    # 1. Drain job queue (up to 5 per tick)
    if redis_client:
        for _ in range(5):
            raw = await redis_client.rpop("openclaw:jobs")
            if not raw:
                break
            job = json.loads(raw)
            logger.info(f"[LOOP] Running job: {job['type']}")
            await dispatch_job(job)
    # 2. Scheduled autonomous work
    now = datetime.utcnow()
    if now.minute % 10 == 0:
        await autonomous_task_check()
    if now.minute == 0:
        await autonomous_reflect()
    if now.hour == 3 and now.minute == 0:
        await autonomous_reorganise()

async def dispatch_job(job: dict):
    jtype = job.get("type")
    payload = job.get("payload", {})
    if jtype == "exec_code":
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                resp = await client.post(
                    FUNCTION_BUN_URL,
                    headers={"Authorization": f"Bearer {FUNCTION_BUN_TOKEN}"},
                    json=payload,
                )
                result = resp.json()
            path = f"workspace/job_results/{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.json"
            await write_github_file(path, json.dumps(result, indent=2), f"OpenClaw: job result {jtype}")
        except Exception as e:
            logger.error(f"[LOOP] exec_code job failed: {e}")
    elif jtype == "write_file":
        await write_github_file(payload["path"], payload["content"], payload.get("message", "OpenClaw: autonomous write"))
    elif jtype == "reflect":
        await autonomous_reflect()
    elif jtype == "llm_task":
        response = await call_openclaw_llm(payload["prompt"])
        if payload.get("write_to"):
            await write_github_file(payload["write_to"], response, payload.get("message", "OpenClaw: autonomous LLM task"))

async def autonomous_task_check():
    tasks_md = await read_github_file("memory/tasks.md")
    pending = [l for l in tasks_md.splitlines() if l.strip().startswith("- [ ]")]
    if not pending:
        return
    logger.info(f"[LOOP] {len(pending)} pending tasks found")
    status = {"checked_at": datetime.utcnow().isoformat(), "pending_count": len(pending), "pending": pending[:20]}
    await write_github_file("workspace/status/tasks_status.json", json.dumps(status, indent=2), "OpenClaw: task status check")
    # Sync pending items into the in-memory _tasks list so the UI sees them
    existing_titles = {t["title"].strip().lower() for t in _tasks}
    for line in pending[:20]:
        title = line.strip().lstrip("- [ ]").strip()
        if not title or title.lower() in existing_titles:
            continue
        new_task = {
            "id": uuid.uuid4().hex[:8],
            "title": title,
            "status": "pending",
            "source": "autonomous",
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        _tasks.append(new_task)
        existing_titles.add(title.lower())
        logger.info(f"[LOOP] Surfaced task to UI: {title}")

async def autonomous_reflect():
    logger.info("[LOOP] Running autonomous reflection")
    # Create a visible task so the UI shows the agent is working
    _reflect_task = {"id": uuid.uuid4().hex[:8], "title": f"Self-reflection ({datetime.utcnow().strftime('%H:%M UTC')})", "status": "in_progress", "source": "autonomous", "created_at": time.time(), "updated_at": time.time()}
    _tasks.append(_reflect_task)
    try:
        prompt = ("You are reviewing your own memory files. Identify: "
              "1) Any contradictions or outdated information. "
              "2) Patterns in the user's behaviour or preferences you should remember better. "
              "3) Any tools or capabilities you wish you had. "
              "4) One concrete improvement you could make to your own prompts or knowledge structure. "
              "Write a short reflection (max 300 words) in markdown.")
        reflection = await call_openclaw_llm(prompt, system="You are OpenClaw performing self-reflection.")
        now = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
        path = f"workspace/reflections/{datetime.utcnow().strftime('%Y%m%d')}.md"
        await write_github_file(path, f"# Reflection {now}\n\n{reflection}\n", f"OpenClaw: autonomous reflection {now}")
        _reflect_task["status"] = "completed"
        _reflect_task["updated_at"] = time.time()
    except Exception as e:
        _reflect_task["status"] = "failed"
        _reflect_task["updated_at"] = time.time()
        logger.error(f"[LOOP] Reflection failed: {e}")

async def autonomous_reorganise():
    logger.info("[LOOP] Running daily knowledge reorganisation")
    memory = await load_memory()
    prompt = ("Review all your memory files below and rewrite memory/profile.md "
              "with any new facts consolidated, duplicates removed, and structure improved. "
              "Return ONLY the new markdown content for profile.md, nothing else.\n\n" + memory)
    new_profile = await call_openclaw_llm(prompt, system="You are OpenClaw reorganising your knowledge base.")
    await write_github_file("memory/profile.md", new_profile, f"OpenClaw: daily knowledge reorganisation {datetime.utcnow().strftime('%Y-%m-%d')}")

# -- SPA static files ----------------------------------------------------------
if os.path.isdir(os.path.join(DIST_DIR, "assets")):
    app.mount("/assets", StaticFiles(directory=os.path.join(DIST_DIR, "assets")), name="assets")

@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    return FileResponse(os.path.join(DIST_DIR, "index.html"))

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
