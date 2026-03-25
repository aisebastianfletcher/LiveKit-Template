"""
Web frontend for OpenClaw – FastAPI server + React SPA.

Fixes applied:
  Fix 1 – /api/openclaw/chat now loads memory from GitHub and injects it
           as a system message; saves a conversation summary after each reply.
  Fix 2 – Tasks are persisted to memory/tasks.md via GitHub API.
           The list survives redeployments. Agents remain in-memory
           (they're ephemeral by nature and easily recreated).
  Fix 3 – Text chat and voice use the same memory files and same summary
           format, so both channels contribute to shared context.
  Fix 4 – All /api/* routes require a Bearer token matching
           the OPENCLAW_ACCESS_TOKEN environment variable.
           Set OPENCLAW_ACCESS_TOKEN="" to disable auth (dev mode).
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
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── App ────────────────────────────────────────────────────────────────────────
app = FastAPI(title="OpenClaw Web")

# ── Environment ────────────────────────────────────────────────────────────────
LIVEKIT_URL        = os.environ.get("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY    = os.environ.get("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "secret")

OPENCLAW_BASE_URL      = os.environ.get("OPENCLAW_BASE_URL", "https://openclaw-production-058c.up.railway.app")
OPENCLAW_GATEWAY_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")
OPENCLAW_API_BASE      = f"{OPENCLAW_BASE_URL.rstrip('/')}/v1"

# Fix 4 – access token (empty string = auth disabled)
ACCESS_TOKEN = os.environ.get("OPENCLAW_ACCESS_TOKEN", "")

GITHUB_TOKEN  = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO   = os.environ.get("GITHUB_REPO", "aisebastianfletcher/LiveKit-Template")
GITHUB_BRANCH = "main"
MEMORY_FILES  = [
    "memory/profile.md",
    "memory/tasks.md",
    "memory/conversations.md",
    "memory/automations.md",
]

DIST_DIR = os.path.join(os.path.dirname(__file__), "dist")

# Markers for embedded JSON inside tasks.md
_TASKS_BEGIN = "<!-- API_TASKS_BEGIN -->"
_TASKS_END   = "<!-- API_TASKS_END -->"

logger.info(f"OpenClaw base URL: {OPENCLAW_BASE_URL}")
logger.info(f"Auth enabled: {bool(ACCESS_TOKEN)}")

# ── Shared prompt (kept in sync with agent.py) ────────────────────────────────
BASE_INSTRUCTIONS = """You are OpenClaw, a stateful AI assistant with persistent memory.
Keep responses concise unless asked for detail.
You remember everything across sessions because your memory is stored in files.
When the user tells you something important (name, preferences, tasks, etc), acknowledge you will remember it.
You can manage tasks, track automations, and learn about the user over time.
Never pretend you have skills you don't have yet (email, calendar, web). Be honest.
"""

# ── Fix 4: Auth middleware ─────────────────────────────────────────────────────
class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Only protect /api/ routes; let the SPA and static assets through
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


# ── GitHub helpers ─────────────────────────────────────────────────────────────
async def read_github_file(path: str) -> str:
    url = (
        f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}"
        f"?ref={GITHUB_BRANCH}"
    )
    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.get(url, headers=headers)
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
    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.get(url + f"?ref={GITHUB_BRANCH}", headers=headers)
            sha = resp.json().get("sha", "") if resp.status_code == 200 else ""
            payload: dict = {
                "message": message,
                "content": base64.b64encode(content.encode("utf-8")).decode("utf-8"),
                "branch": GITHUB_BRANCH,
            }
            if sha:
                payload["sha"] = sha
            resp = await client.put(url, headers=headers, json=payload)
            if resp.status_code in (200, 201):
                logger.info(f"Wrote {path}: {message}")
                return True
            logger.error(f"Failed to write {path}: {resp.status_code} {resp.text}")
            return False
        except Exception as e:
            logger.error(f"Error writing {path}: {e}")
            return False


# ── Fix 1: Memory loading ──────────────────────────────────────────────────────
async def load_memory() -> str:
    sections = []
    for path in MEMORY_FILES:
        content = await read_github_file(path)
        if content:
            sections.append(content)
    return "\n\n---\n\n".join(sections) if sections else "(no memory loaded)"


# ── Fix 1: Conversation summary (text-chat version) ───────────────────────────
async def save_chat_summary(user_message: str, assistant_reply: str) -> None:
    """Generate and persist a summary after each text-chat exchange."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{OPENCLAW_API_BASE}/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENCLAW_GATEWAY_TOKEN}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "openclaw",
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "Summarize this exchange in 1-2 sentences. "
                                "Note any tasks, preferences, or facts the user shared. "
                                "Be very concise."
                            ),
                        },
                        {
                            "role": "user",
                            "content": (
                                f"User: {user_message}\n\nAssistant: {assistant_reply}"
                            ),
                        },
                    ],
                    "max_tokens": 150,
                },
            )
        data = resp.json()
        summary = data["choices"][0]["message"]["content"]
    except Exception as e:
        logger.error(f"Failed to generate chat summary: {e}")
        summary = f"(raw) User: {user_message[:100]}…"

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

    await write_github_file(
        "memory/conversations.md",
        convos,
        f"OpenClaw: text chat summary {now}",
    )


# ── Fix 2: Task persistence via GitHub ────────────────────────────────────────

# In-memory cache (loaded from GitHub at startup)
_tasks: list[dict] = []
_tasks_lock = asyncio.Lock()


async def _read_tasks_from_github() -> list[dict]:
    content = await read_github_file("memory/tasks.md")
    if _TASKS_BEGIN in content and _TASKS_END in content:
        start = content.index(_TASKS_BEGIN) + len(_TASKS_BEGIN)
        end   = content.index(_TASKS_END)
        try:
            return json.loads(content[start:end].strip())
        except json.JSONDecodeError:
            logger.warning("tasks.md JSON block is malformed; starting fresh")
    return []


async def _write_tasks_to_github(task_list: list[dict]) -> None:
    content = await read_github_file("memory/tasks.md")
    json_blob = json.dumps(task_list, indent=2)
    new_block = f"{_TASKS_BEGIN}\n{json_blob}\n{_TASKS_END}"

    if _TASKS_BEGIN in content and _TASKS_END in content:
        start = content.index(_TASKS_BEGIN)
        end   = content.index(_TASKS_END) + len(_TASKS_END)
        content = content[:start] + new_block + content[end:]
    else:
        # Append the JSON block if not present yet
        content += f"\n\n{new_block}\n"

    await write_github_file("memory/tasks.md", content, "OpenClaw: sync tasks")


@app.on_event("startup")
async def _startup() -> None:
    global _tasks
    try:
        _tasks = await _read_tasks_from_github()
        logger.info(f"Loaded {len(_tasks)} tasks from GitHub")
    except Exception as e:
        logger.error(f"Could not load tasks on startup: {e}")
        _tasks = []


# ── LiveKit token ──────────────────────────────────────────────────────────────
@app.post("/api/token")
async def create_token(request: Request):
    body       = await request.json()
    room_name  = body.get("room", f"test-room-{uuid.uuid4().hex[:8]}")
    identity   = body.get("identity", f"user-{uuid.uuid4().hex[:6]}")
    token = (
        api.AccessToken(api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(identity)
        .with_grants(api.VideoGrants(room_join=True, room=room_name))
        .to_jwt()
    )
    return {"token": token, "url": LIVEKIT_URL, "room": room_name, "identity": identity}


# ── Fix 1 + 3: Text chat with memory ──────────────────────────────────────────
@app.post("/api/openclaw/chat")
async def proxy_openclaw_chat(request: Request):
    body     = await request.json()
    messages: list[dict] = body.get("messages", [])

    # Load memory and build a system message identical to what the voice agent uses
    memory_context = await load_memory()
    system_msg = {
        "role": "system",
        "content": BASE_INSTRUCTIONS + "\n\n--- YOUR MEMORY FILES ---\n\n" + memory_context,
    }
    full_messages = [system_msg] + messages

    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            resp = await client.post(
                                    f"{OPENCLAW_API_BASE}/chat/completions",
                                    json={"model": "openclaw", "messages": full_messages},
                headers={
                    "Content-Type": "application/json",
                                            "Authorization": f"Bearer {OPENCLAW_GATEWAY_TOKEN}",
                },
            )
            raw_text = resp.text
            if not raw_text.strip():
                return JSONResponse(
                    content={"error": "Empty response from OpenClaw"},
                    status_code=502,
                )
            try:
                data = resp.json()
            except Exception:
                return JSONResponse(
                    content={"error": f"Non-JSON response: {raw_text[:200]}"},
                    status_code=502,
                )
            if resp.status_code != 200:
                return JSONResponse(content=data, status_code=resp.status_code)

            reply = (
                data.get("choices", [{}])[0]
                .get("message", {})
                .get("content", "")
            )

            # Save summary to conversations.md in the background (non-blocking)
            if reply and messages:
                last_user_msg = next(
                    (m["content"] for m in reversed(messages) if m.get("role") == "user"),
                    "",
                )
                asyncio.create_task(save_chat_summary(last_user_msg, reply))

            return JSONResponse(content={"reply": reply})

        except Exception as e:
            return JSONResponse(content={"error": str(e)}, status_code=500)


# ── Fix 2: Task endpoints (GitHub-backed) ────────────────────────────────────
@app.get("/api/tasks")
async def get_tasks():
    return JSONResponse(content=_tasks)


@app.post("/api/tasks")
async def create_task(request: Request):
    global _tasks
    body = await request.json()
    task = {
        "id":         uuid.uuid4().hex[:8],
        "title":      body.get("title", "Untitled task"),
        "status":     body.get("status", "pending"),
        "created_at": time.time(),
        "updated_at": time.time(),
        "source":     body.get("source", "user"),
    }
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
                if "status" in body:
                    task["status"] = body["status"]
                if "title" in body:
                    task["title"] = body["title"]
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


# ── Agents (in-memory – ephemeral by design) ──────────────────────────────────
_agents: list[dict] = []


@app.get("/api/agents")
async def get_agents():
    return JSONResponse(content=_agents)


@app.post("/api/agents")
async def create_agent(request: Request):
    body  = await request.json()
    agent = {
        "id":         uuid.uuid4().hex[:8],
        "name":       body.get("name", "unnamed"),
        "type":       body.get("type", "general"),
        "status":     body.get("status", "active"),
        "created_at": time.time(),
    }
    _agents.append(agent)
    return JSONResponse(content=agent, status_code=201)



# -- Memory read routes (frontend api.ts) ----------------------------------------

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


# -- LiveKit token alias (frontend calls /api/livekit/token) ---------------------

@app.post("/api/livekit/token")
async def livekit_token(request: Request):
    body = await request.json()
    room_name = body.get("room_name", f"test-room-{uuid.uuid4().hex[:8]}")
    participant_name = body.get("participant_name", f"user-{uuid.uuid4().hex[:6]}")
    token = (
        api.AccessToken(api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
        .with_identity(participant_name)
        .with_name(participant_name)
        .with_grants(api.VideoGrants(room_join=True, room=room_name))
        .to_jwt()
    )
    return {"token": token, "url": LIVEKIT_URL}


# ── SPA static files ──────────────────────────────────────────────────────────
if os.path.isdir(os.path.join(DIST_DIR, "assets")):
    app.mount(
        "/assets",
        StaticFiles(directory=os.path.join(DIST_DIR, "assets")),
        name="assets",
    )


@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    return FileResponse(os.path.join(DIST_DIR, "index.html"))


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
