"""Web frontend for LiveKit voice agent — serves React SPA + token API."""
import os
import uuid
import json

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from livekit import api
import httpx

app = FastAPI(title="LiveKit Voice Agent")

LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "secret")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "google/gemini-2.0-flash-001")
DIST_DIR = os.path.join(os.path.dirname(__file__), "dist")

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
    """Proxy text chat requests directly to OpenRouter API."""
    body = await request.json()
    # Map to OpenRouter format
    messages = body.get("messages", [])
    model = OPENROUTER_MODEL
    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                json={"model": model, "messages": messages},
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                },
            )
            raw = resp.text
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                data = {"error": f"Non-JSON response (status {resp.status_code}): {raw[:500]}"}
            return JSONResponse(content=data, status_code=resp.status_code)
        except Exception as e:
            return JSONResponse(
                content={"error": f"Proxy error: {type(e).__name__}: {str(e)}"},
                status_code=502,
            )

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
