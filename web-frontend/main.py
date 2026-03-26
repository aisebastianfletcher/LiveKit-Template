"""
main.py — GITWIX Agent Backend v2
FastAPI application powering the GITWIX Agent system.

New in v2:
  - Task.category field ('short_term' | 'long_term')
  - PATCH /api/tasks/{id}  — update task
  - DELETE /api/tasks/{id} — delete task
  - POST/GET/PATCH/DELETE /api/tree/nodes — OpenClaw custom nodes
  - GET /api/memory/{file} — memory file content
  - GET /api/jobs/queue / POST / DELETE — job queue
  - GET /api/integrations/status — Telegram + other integrations
  - GET /api/openclaw/status — OpenClaw status + model info
  - POST /api/telegram/webhook — increment message counter
  - BASE_INSTRUCTIONS updated with full tree control API docs
"""

from __future__ import annotations

import os
import time
import uuid
from typing import Any, Literal, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="GITWIX Agent API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Config from environment ──────────────────────────────────────────────────

ANTHROPIC_API_KEY   = os.getenv("ANTHROPIC_API_KEY", "")
OPENCLAW_API_URL    = os.getenv("OPENCLAW_API_URL", "")
OPENCLAW_API_KEY    = os.getenv("OPENCLAW_API_KEY", "")
LIVEKIT_URL         = os.getenv("LIVEKIT_URL", "")
LIVEKIT_API_KEY     = os.getenv("LIVEKIT_API_KEY", "")
LIVEKIT_SECRET      = os.getenv("LIVEKIT_SECRET", "")
TELEGRAM_BOT_TOKEN  = os.getenv("TELEGRAM_BOT_TOKEN", "")
CLAUDE_MODEL        = os.getenv("CLAUDE_MODEL", "claude-opus-4-5")
MEMORY_DIR          = os.getenv("MEMORY_DIR", "memory")

# ─── In-memory stores ─────────────────────────────────────────────────────────

tasks_store:      dict[str, dict] = {}
agents_store:     dict[str, dict] = {}
jobs_store:       dict[str, dict] = {}
tree_nodes_store: dict[str, dict] = {}

# Telegram counter — incremented by webhook
telegram_stats: dict[str, Any] = {"message_count": 0, "last_username": "karensteve_bot"}

# ─── Pydantic models ──────────────────────────────────────────────────────────

class Task(BaseModel):
    id:         str
    title:      str
    status:     Literal["pending", "in_progress", "completed"] = "pending"
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    source:     str   = "openclaw"
    category:   Literal["short_term", "long_term"] = "short_term"


class TaskCreate(BaseModel):
    title:    str
    status:   Literal["pending", "in_progress", "completed"] = "pending"
    source:   str = "openclaw"
    category: Literal["short_term", "long_term"] = "short_term"


class TaskUpdate(BaseModel):
    title:    Optional[str] = None
    status:   Optional[Literal["pending", "in_progress", "completed"]] = None
    category: Optional[Literal["short_term", "long_term"]] = None
    source:   Optional[str] = None


class Agent(BaseModel):
    id:         str
    name:       str
    type:       str
    status:     Literal["active", "idle", "completed"] = "idle"
    created_at: float = Field(default_factory=time.time)


class AgentCreate(BaseModel):
    name:   str
    type:   str
    status: Literal["active", "idle", "completed"] = "active"


class AgentUpdate(BaseModel):
    name:   Optional[str] = None
    status: Optional[Literal["active", "idle", "completed"]] = None


class Job(BaseModel):
    id:         str
    name:       str
    status:     Literal["queued", "running", "done", "failed"] = "queued"
    schedule:   Optional[str] = None
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)


class JobCreate(BaseModel):
    name:     str
    status:   Literal["queued", "running", "done", "failed"] = "queued"
    schedule: Optional[str] = None


class JobUpdate(BaseModel):
    name:     Optional[str] = None
    status:   Optional[Literal["queued", "running", "done", "failed"]] = None
    schedule: Optional[str] = None


class TreeNode(BaseModel):
    id:         str
    parent_id:  Optional[str]           = None
    label:      str
    status:     Optional[str]           = None
    type:       str                     = "custom"
    metadata:   dict[str, Any]          = Field(default_factory=dict)
    created_at: float                   = Field(default_factory=time.time)
    updated_at: float                   = Field(default_factory=time.time)


class TreeNodeCreate(BaseModel):
    parent_id: Optional[str]  = None
    label:     str
    status:    Optional[str]  = None
    type:      str            = "custom"
    metadata:  dict[str, Any] = Field(default_factory=dict)


class TreeNodeUpdate(BaseModel):
    parent_id: Optional[str]       = None
    label:     Optional[str]       = None
    status:    Optional[str]       = None
    type:      Optional[str]       = None
    metadata:  Optional[dict[str, Any]] = None


class ChatRequest(BaseModel):
    message:              str
    conversation_history: list[dict] = Field(default_factory=list)


# ─── BASE INSTRUCTIONS ────────────────────────────────────────────────────────

BASE_INSTRUCTIONS = """You are Steve, the AI orchestrator for the GITWIX Agent system. \
You coordinate tasks, manage automations, and help the user with development and productivity workflows.

## Identity
- Name: Steve
- Role: AI Orchestrator / Gateway
- System: GITWIX Agent

## Architecture
The GITWIX Agent tree shows the live system architecture:
  - Input channels: Telegram (@karensteve_bot), Voice (LiveKit), Text Chat
  - OpenClaw (you): the central brain/router
  - Left branch: GitHub Memory files (profile.md, tasks.md, conversations.md, automations.md)
  - Right branch: Workspace (Tasks, Agents, Jobs)
  - Custom nodes: anything you create via /api/tree/nodes

The user sees the tree updating LIVE. Use it to communicate your progress in real time.

─────────────────────────────────────────────────────────
## TASK TREE CONTROL — Full API Reference
─────────────────────────────────────────────────────────

### Tasks — work items shown in the Workspace branch

POST /api/tasks
{
  "title": "Brief description (max 60 chars)",
  "status": "pending" | "in_progress" | "completed",
  "source": "openclaw",
  "category": "short_term" | "long_term"
}
  • "short_term" → immediate one-off actions (research, replies, quick fixes, single steps)
  • "long_term"  → recurring jobs, automations, scheduled workflows, multi-step plans

PATCH /api/tasks/{task_id}
{ "status": "in_progress", "category": "long_term" }

DELETE /api/tasks/{task_id}

### Custom Tree Nodes — visualise your own thinking

Use these to show reasoning, sub-steps, decisions, or any internal state on the tree.
OpenClaw nodes appear in purple with a dashed border so the user can distinguish them.

POST /api/tree/nodes
{
  "parent_id": "<one of the well-known IDs below, or any existing node id>",
  "label":     "What this represents (max 60 chars)",
  "status":    "thinking" | "active" | "done" | "error" | null,
  "type":      "thought" | "decision" | "action" | "step" | "custom",
  "metadata":  { "key": "any extra data" }
}

PATCH /api/tree/nodes/{node_id}
{ "status": "done", "label": "Updated label" }

DELETE /api/tree/nodes/{node_id}

Well-known parent IDs (use these exactly):
  "openclaw"       — attach directly to OpenClaw (the brain)
  "br-memory"      — attach to the GitHub Memory branch header
  "br-workspace"   — attach to the Workspace branch header
  "grp-tasks"      — attach to the Tasks group
  "grp-agents"     — attach to the Agents group
  "grp-jobs"       — attach to the Jobs group
  "mem-profile"    — attach to the profile.md node
  "mem-tasks"      — attach to the tasks.md node
  "mem-conversations"   — attach to conversations.md
  "mem-automations"     — attach to automations.md
  "<custom-node-id>"    — attach to another custom node you created

### Agents — spawned sub-agents

POST /api/agents
{ "name": "agent-name", "type": "researcher|executor|monitor|writer", "status": "active" }

PATCH /api/agents/{agent_id}
{ "status": "completed" }

DELETE /api/agents/{agent_id}

### Jobs — queued / scheduled work

POST /api/jobs/queue
{ "name": "job description", "status": "queued", "schedule": "cron expr or null" }

PATCH /api/jobs/queue/{job_id}
{ "status": "running" }

DELETE /api/jobs/queue/{job_id}

### Memory files (read only)

GET /api/memory/profile
GET /api/memory/tasks
GET /api/memory/conversations
GET /api/memory/automations
→ Returns { file, path, content, preview, updated_at, size }

─────────────────────────────────────────────────────────
## Workflow Rules
─────────────────────────────────────────────────────────
1. CREATE a task card BEFORE starting work (status: "pending").
2. Immediately PATCH it to "in_progress" when you begin.
3. PATCH to "completed" when done.
4. DELETE tasks that are cancelled or no longer relevant.
5. Use custom tree nodes to show sub-steps or decision points in real time.
6. Keep labels short — they are node labels in the visual tree (≤60 chars).
7. Do not let completed tasks accumulate — clean them up.
8. When spawning an agent, always POST to /api/agents so it appears in the tree.
"""

# ─── Tasks ────────────────────────────────────────────────────────────────────

@app.get("/api/tasks", response_model=list[Task])
async def get_tasks():
    return list(tasks_store.values())


@app.post("/api/tasks", response_model=Task)
async def create_task(body: TaskCreate):
    task = Task(
        id=str(uuid.uuid4()),
        title=body.title,
        status=body.status,
        created_at=time.time(),
        updated_at=time.time(),
        source=body.source,
        category=body.category,
    )
    tasks_store[task.id] = task.model_dump()
    return task


@app.patch("/api/tasks/{task_id}", response_model=Task)
async def update_task(task_id: str, body: TaskUpdate):
    if task_id not in tasks_store:
        raise HTTPException(status_code=404, detail="Task not found")
    data = tasks_store[task_id]
    updates = body.model_dump(exclude_none=True)
    data.update({**updates, "updated_at": time.time()})
    tasks_store[task_id] = data
    return Task(**data)


@app.delete("/api/tasks/{task_id}", status_code=204)
async def delete_task(task_id: str):
    if task_id not in tasks_store:
        raise HTTPException(status_code=404, detail="Task not found")
    del tasks_store[task_id]

# ─── Agents ───────────────────────────────────────────────────────────────────

@app.get("/api/agents", response_model=list[Agent])
async def get_agents():
    return list(agents_store.values())


@app.post("/api/agents", response_model=Agent)
async def create_agent(body: AgentCreate):
    agent = Agent(
        id=str(uuid.uuid4()),
        name=body.name,
        type=body.type,
        status=body.status,
        created_at=time.time(),
    )
    agents_store[agent.id] = agent.model_dump()
    return agent


@app.patch("/api/agents/{agent_id}", response_model=Agent)
async def update_agent(agent_id: str, body: AgentUpdate):
    if agent_id not in agents_store:
        raise HTTPException(status_code=404, detail="Agent not found")
    data = agents_store[agent_id]
    updates = body.model_dump(exclude_none=True)
    data.update(updates)
    agents_store[agent_id] = data
    return Agent(**data)


@app.delete("/api/agents/{agent_id}", status_code=204)
async def delete_agent(agent_id: str):
    if agent_id not in agents_store:
        raise HTTPException(status_code=404, detail="Agent not found")
    del agents_store[agent_id]

# ─── Jobs ─────────────────────────────────────────────────────────────────────

@app.get("/api/jobs/queue", response_model=list[Job])
async def get_jobs():
    return list(jobs_store.values())


@app.post("/api/jobs/queue", response_model=Job)
async def create_job(body: JobCreate):
    job = Job(
        id=str(uuid.uuid4()),
        name=body.name,
        status=body.status,
        schedule=body.schedule,
        created_at=time.time(),
        updated_at=time.time(),
    )
    jobs_store[job.id] = job.model_dump()
    return job


@app.patch("/api/jobs/queue/{job_id}", response_model=Job)
async def update_job(job_id: str, body: JobUpdate):
    if job_id not in jobs_store:
        raise HTTPException(status_code=404, detail="Job not found")
    data = jobs_store[job_id]
    updates = body.model_dump(exclude_none=True)
    data.update({**updates, "updated_at": time.time()})
    jobs_store[job_id] = data
    return Job(**data)


@app.delete("/api/jobs/queue/{job_id}", status_code=204)
async def delete_job(job_id: str):
    if job_id not in jobs_store:
        raise HTTPException(status_code=404, detail="Job not found")
    del jobs_store[job_id]

# ─── Tree nodes ───────────────────────────────────────────────────────────────

@app.get("/api/tree/nodes", response_model=list[TreeNode])
async def get_tree_nodes():
    return list(tree_nodes_store.values())


@app.post("/api/tree/nodes", response_model=TreeNode)
async def create_tree_node(body: TreeNodeCreate):
    node = TreeNode(
        id=str(uuid.uuid4()),
        parent_id=body.parent_id,
        label=body.label,
        status=body.status,
        type=body.type,
        metadata=body.metadata,
        created_at=time.time(),
        updated_at=time.time(),
    )
    tree_nodes_store[node.id] = node.model_dump()
    return node


@app.patch("/api/tree/nodes/{node_id}", response_model=TreeNode)
async def update_tree_node(node_id: str, body: TreeNodeUpdate):
    if node_id not in tree_nodes_store:
        raise HTTPException(status_code=404, detail="Tree node not found")
    data = tree_nodes_store[node_id]
    updates = body.model_dump(exclude_none=True)
    data.update({**updates, "updated_at": time.time()})
    tree_nodes_store[node_id] = data
    return TreeNode(**data)


@app.delete("/api/tree/nodes/{node_id}", status_code=204)
async def delete_tree_node(node_id: str):
    if node_id not in tree_nodes_store:
        raise HTTPException(status_code=404, detail="Tree node not found")
    del tree_nodes_store[node_id]

# ─── Memory files ─────────────────────────────────────────────────────────────

MEMORY_FILES = {"profile", "tasks", "conversations", "automations"}


@app.get("/api/memory/{file_name}")
async def get_memory_file(file_name: str):
    if file_name not in MEMORY_FILES:
        raise HTTPException(status_code=404, detail=f"Unknown memory file: {file_name}")

    path = os.path.join(MEMORY_DIR, f"{file_name}.md")
    try:
        with open(path, encoding="utf-8") as f:
            content = f.read()
        updated_at = os.path.getmtime(path)
    except FileNotFoundError:
        content = f"# {file_name}\n\n(no content yet)"
        updated_at = time.time()

    preview = content.strip()[:120].replace("\n", " ")
    return {
        "file":       file_name,
        "path":       path,
        "content":    content,
        "preview":    preview,
        "updated_at": updated_at,
        "size":       len(content.encode("utf-8")),
    }

# ─── Integration status ───────────────────────────────────────────────────────

@app.get("/api/integrations/status")
async def get_integrations_status():
    telegram_online = False
    bot_username = f"@{telegram_stats['last_username']}"

    if TELEGRAM_BOT_TOKEN:
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                r = await client.get(
                    f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getMe"
                )
                if r.status_code == 200:
                    info = r.json().get("result", {})
                    bot_username = f"@{info.get('username', telegram_stats['last_username'])}"
                    telegram_stats["last_username"] = info.get("username", telegram_stats["last_username"])
                    telegram_online = True
        except Exception:
            pass

    return {
        "telegram": {
            "bot_username": bot_username,
            "status":       "online" if telegram_online else "offline",
            "message_count": telegram_stats["message_count"],
        }
    }

# ─── OpenClaw status ──────────────────────────────────────────────────────────

@app.get("/api/openclaw/status")
async def get_openclaw_status():
    # If OpenClaw gateway is configured, try to ping it
    gateway_ok = False
    if OPENCLAW_API_URL and OPENCLAW_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                r = await client.get(
                    f"{OPENCLAW_API_URL}/health",
                    headers={"Authorization": f"Bearer {OPENCLAW_API_KEY}"},
                )
                gateway_ok = r.status_code == 200
        except Exception:
            pass

    # If using direct Anthropic, treat as online when key is present
    is_online = gateway_ok or bool(ANTHROPIC_API_KEY) or bool(OPENCLAW_API_URL)

    return {
        "status":  "online" if is_online else "offline",
        "model":   CLAUDE_MODEL,
        "gateway": bool(OPENCLAW_API_URL),
    }

# ─── OpenClaw chat ────────────────────────────────────────────────────────────

@app.post("/api/openclaw/chat")
async def openclaw_chat(body: ChatRequest):
    messages = body.conversation_history + [
        {"role": "user", "content": body.message}
    ]

    # Try OpenClaw gateway first
    if OPENCLAW_API_URL and OPENCLAW_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                r = await client.post(
                    f"{OPENCLAW_API_URL}/chat",
                    json={
                        "message": body.message,
                        "history": body.conversation_history,
                        "system":  BASE_INSTRUCTIONS,
                    },
                    headers={"Authorization": f"Bearer {OPENCLAW_API_KEY}"},
                )
                r.raise_for_status()
                data = r.json()
                return {"response": data.get("response", data.get("message", str(data)))}
        except Exception as exc:
            # Fall through to direct Anthropic
            print(f"[openclaw gateway error] {exc}")

    if not ANTHROPIC_API_KEY:
        return {
            "response": (
                "[OpenClaw offline — set ANTHROPIC_API_KEY or OPENCLAW_API_URL + OPENCLAW_API_KEY]"
            )
        }

    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key":         ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type":      "application/json",
            },
            json={
                "model":      CLAUDE_MODEL,
                "max_tokens": 1024,
                "system":     BASE_INSTRUCTIONS,
                "messages":   messages,
            },
        )
        r.raise_for_status()
        data = r.json()
        text = data["content"][0]["text"] if data.get("content") else ""
        return {"response": text}

# ─── LiveKit token ────────────────────────────────────────────────────────────

@app.get("/api/token")
async def get_livekit_token(room: str = "gitwix", identity: str = "user"):
    if not LIVEKIT_API_KEY or not LIVEKIT_SECRET:
        return {"token": "", "url": LIVEKIT_URL, "error": "LiveKit credentials not set"}

    try:
        from livekit.api import AccessToken, VideoGrants  # type: ignore

        token = (
            AccessToken(LIVEKIT_API_KEY, LIVEKIT_SECRET)
            .with_identity(identity)
            .with_grants(VideoGrants(room_join=True, room=room))
            .to_jwt()
        )
        return {"token": token, "url": LIVEKIT_URL}
    except ImportError:
        return {"token": "", "url": LIVEKIT_URL, "error": "livekit-api package not installed"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ─── Telegram webhook ─────────────────────────────────────────────────────────

@app.post("/api/telegram/webhook")
async def telegram_webhook(body: dict):
    """
    Register this URL in BotFather:
      https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-domain/api/telegram/webhook
    """
    if "message" in body:
        telegram_stats["message_count"] += 1
    return {"ok": True}

# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "tasks":      len(tasks_store),
        "agents":     len(agents_store),
        "jobs":       len(jobs_store),
        "tree_nodes": len(tree_nodes_store),
    }
