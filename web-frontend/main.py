"""Web frontend for LiveKit voice agent — serves React SPA + token API."""
import os
import uuid
import json
import time
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from livekit import api
import httpx

app = FastAPI(title="LiveKit Voice Agent")

LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "secret")

# OpenClaw config for text chat
OPENCLAW_BASE_URL = os.environ.get("OPENCLAW_BASE_URL", "https://openclaw-production-058c.up.railway.app")
OPENCLAW_GATEWAY_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")

DIST_DIR = os.path.join(os.path.dirname(__file__), "dist")

# In-memory stores
tasks: list[dict] = []
agents: list[dict] = []

# --- API ---

@app.post("/api/token")
async def create_token(request: Request):
    body = await request.json()
    room_name = body.get("room", f"test-room-{uuid.uuid4().hex[:8]}")
    identity = body.get("identity", f"user-{uuid.uuid4().hex[:6]}")
    token = (
        api.AccessToken(api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(identity)
        .with_grants(api.VideoGrants(room_join=True, room=room_name))
        .to_jwt()
    )
    return {
        "token": token,
        "url": LIVEKIT_URL,
        "room": room_name,
        "identity": identity,
    }

@app.post("/api/openclaw/chat")
async def proxy_openclaw_chat(request: Request):
    """Proxy text chat requests through OpenClaw's OpenAI-compatible API."""
    body = await request.json()
    messages = body.get("messages", [])

    # Build the chat completions URL
    base = OPENCLAW_BASE_URL.rstrip("/")
    url = f"{base}/v1/chat/completions"

    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            resp = await client.post(
                url,
                json={"model": "openclaw", "messages": messages},
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {OPENCLAW_GATEWAY_TOKEN}",
                },
            )
            data = resp.json()
            if resp.status_code != 200:
                return JSONResponse(content=data, status_code=resp.status_code)
            reply = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            return JSONResponse(content={"reply": reply})
        except Exception as e:
            return JSONResponse(content={"error": str(e)}, status_code=500)

# --- Tasks API ---

@app.get("/api/tasks")
async def get_tasks():
    return JSONResponse(content=tasks)

@app.post("/api/tasks")
async def create_task(request: Request):
    body = await request.json()
    task = {
        "id": uuid.uuid4().hex[:8],
        "title": body.get("title", "Untitled task"),
        "status": body.get("status", "pending"),
        "created_at": time.time(),
        "updated_at": time.time(),
        "source": body.get("source", "user"),
    }
    tasks.append(task)
    return JSONResponse(content=task, status_code=201)

@app.patch("/api/tasks/{task_id}")
async def update_task(task_id: str, request: Request):
    body = await request.json()
    for task in tasks:
        if task["id"] == task_id:
            if "status" in body:
                task["status"] = body["status"]
            if "title" in body:
                task["title"] = body["title"]
            task["updated_at"] = time.time()
            return JSONResponse(content=task)
    return JSONResponse(content={"error": "Task not found"}, status_code=404)

@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str):
    global tasks
    tasks = [t for t in tasks if t["id"] != task_id]
    return JSONResponse(content={"ok": True})

# --- Agents API ---

@app.get("/api/agents")
async def get_agents():
    return JSONResponse(content=agents)

@app.post("/api/agents")
async def create_agent(request: Request):
    body = await request.json()
    agent = {
        "id": uuid.uuid4().hex[:8],
        "name": body.get("name", "unnamed"),
        "type": body.get("type", "general"),
        "status": body.get("status", "active"),
        "created_at": time.time(),
    }
    agents.append(agent)
    return JSONResponse(content=agent, status_code=201)

@app.patch("/api/agents/{agent_id}")
async def update_agent(agent_id: str, request: Request):
    body = await request.json()
    for agent in agents:
        if agent["id"] == agent_id:
            if "status" in body:
                agent["status"] = body["status"]
            if "name" in body:
                agent["name"] = body["name"]
            return JSONResponse(content=agent)
    return JSONResponse(content={"error": "Agent not found"}, status_code=404)

@app.delete("/api/agents/{agent_id}")
async def delete_agent(agent_id: str):
    global agents
    agents = [a for a in agents if a["id"] != agent_id]
    return JSONResponse(content={"ok": True})

# --- SPA static files ---

if os.path.isdir(os.path.join(DIST_DIR, "assets")):
    app.mount("/assets", StaticFiles(directory=os.path.join(DIST_DIR, "assets")), name="assets")

@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    """Catch-all: serve index.html for client-side routing."""
    return FileResponse(os.path.join(DIST_DIR, "index.html"))

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
