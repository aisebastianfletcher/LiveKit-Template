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

import json
import os
import re
import time
import uuid
from typing import Any, Literal, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
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

ANTHROPIC_API_KEY   = os.getenv("ANTHROPIC_API_KEY", os.getenv("OPENROUTER_API_KEY", ""))
OPENCLAW_API_URL    = os.getenv("OPENCLAW_BASE_URL", os.getenv("OPENCLAW_API_URL", ""))
OPENCLAW_API_KEY    = os.getenv("OPENCLAW_ACCESS_TOKEN", os.getenv("OPENCLAW_GATEWAY_TOKEN", os.getenv("OPENCLAW_API_KEY", "")))
LIVEKIT_URL         = os.getenv("LIVEKIT_URL", "")
LIVEKIT_API_KEY     = os.getenv("LIVEKIT_API_KEY", "")
LIVEKIT_SECRET      = os.getenv("LIVEKIT_API_SECRET", os.getenv("LIVEKIT_SECRET", ""))
TELEGRAM_BOT_TOKEN  = os.getenv("TELEGRAM_BOT_TOKEN", "")
CLAUDE_MODEL        = os.getenv("CLAUDE_MODEL", os.getenv("OPENROUTER_MODEL", "claude-opus-4-5"))
MEMORY_DIR          = os.getenv("MEMORY_DIR", "memory")

# ─── In-memory stores ─────────────────────────────────────────────────────────

tasks_store:      dict[str, dict] = {}
agents_store:     dict[str, dict] = {}
jobs_store:       dict[str, dict] = {}
tree_nodes_store: dict[str, dict] = {}

# Telegram counter — incremented by webhook
telegram_stats: dict[str, Any] = {"message_count": 0, "last_username": "karenkaty_bot"}

# ─── Internal action executor ─────────────────────────────────────────────────

_ACTION_RE = re.compile(r"<action>(.*?)</action>", re.DOTALL | re.IGNORECASE)


def _execute_action(raw: str) -> str:
    """Execute a single JSON action dict against the in-memory stores.
    Returns a human-readable result string."""
    try:
        data = json.loads(raw.strip())
    except json.JSONDecodeError as exc:
        return f"⚠ Invalid action JSON: {exc}"

    endpoint: str = data.get("endpoint", "")
    body: dict = data.get("body", {})

    parts  = endpoint.split()
    if len(parts) < 2:
        return f"⚠ Malformed endpoint: {endpoint!r}"
    method = parts[0].upper()
    path   = parts[1]

    # ── POST /api/tasks ──────────────────────────────────────────────────────
    if method == "POST" and path == "/api/tasks":
        task_id = str(uuid.uuid4())
        now = time.time()
        task = {
            "id":         task_id,
            "title":      body.get("title", "Untitled task")[:60],
            "status":     body.get("status", "pending"),
            "created_at": now,
            "updated_at": now,
            "source":     body.get("source", "openclaw"),
            "category":   body.get("category", "short_term"),
        }
        tasks_store[task_id] = task
        return f"✅ Created task: {task['title']} (id: {task_id})"

    # ── PATCH /api/tasks/{id} ────────────────────────────────────────────────
    if method == "PATCH" and re.match(r"^/api/tasks/[^/]+$", path):
        task_id = path.split("/")[-1]
        if task_id not in tasks_store:
            return f"⚠ Task not found: {task_id}"
        allowed = {k: v for k, v in body.items() if k in {"title", "status", "category", "source"}}
        tasks_store[task_id].update({**allowed, "updated_at": time.time()})
        return f"✅ Updated task {task_id}: {allowed}"

    # ── DELETE /api/tasks/{id} ───────────────────────────────────────────────
    if method == "DELETE" and re.match(r"^/api/tasks/[^/]+$", path):
        task_id = path.split("/")[-1]
        if task_id in tasks_store:
            del tasks_store[task_id]
            return f"✅ Deleted task {task_id}"
        return f"⚠ Task not found: {task_id}"

    # ── POST /api/agents ─────────────────────────────────────────────────────
    if method == "POST" and path == "/api/agents":
        agent_id = str(uuid.uuid4())
        now = time.time()
        agent = {
            "id":         agent_id,
            "name":       body.get("name", "agent")[:60],
            "type":       body.get("type", "custom"),
            "status":     body.get("status", "active"),
            "created_at": now,
        }
        agents_store[agent_id] = agent
        return f"✅ Created agent: {agent['name']} (id: {agent_id})"

    # ── PATCH /api/agents/{id} ───────────────────────────────────────────────
    if method == "PATCH" and re.match(r"^/api/agents/[^/]+$", path):
        agent_id = path.split("/")[-1]
        if agent_id not in agents_store:
            return f"⚠ Agent not found: {agent_id}"
        allowed = {k: v for k, v in body.items() if k in {"name", "status"}}
        agents_store[agent_id].update({**allowed, "updated_at": time.time()})
        return f"✅ Updated agent {agent_id}: {allowed}"

    # ── DELETE /api/agents/{id} ──────────────────────────────────────────────
    if method == "DELETE" and re.match(r"^/api/agents/[^/]+$", path):
        agent_id = path.split("/")[-1]
        if agent_id in agents_store:
            del agents_store[agent_id]
            return f"✅ Deleted agent {agent_id}"
        return f"⚠ Agent not found: {agent_id}"

    # ── POST /api/jobs/queue ─────────────────────────────────────────────────
    if method == "POST" and path == "/api/jobs/queue":
        job_id = str(uuid.uuid4())
        now = time.time()
        job = {
            "id":         job_id,
            "name":       body.get("name", "job")[:60],
            "status":     body.get("status", "queued"),
            "schedule":   body.get("schedule"),
            "created_at": now,
            "updated_at": now,
        }
        jobs_store[job_id] = job
        return f"✅ Created job: {job['name']} (id: {job_id})"

    # ── PATCH /api/jobs/queue/{id} ───────────────────────────────────────────
    if method == "PATCH" and re.match(r"^/api/jobs/queue/[^/]+$", path):
        job_id = path.split("/")[-1]
        if job_id not in jobs_store:
            return f"⚠ Job not found: {job_id}"
        allowed = {k: v for k, v in body.items() if k in {"name", "status", "schedule"}}
        jobs_store[job_id].update({**allowed, "updated_at": time.time()})
        return f"✅ Updated job {job_id}: {allowed}"

    # ── DELETE /api/jobs/queue/{id} ──────────────────────────────────────────
    if method == "DELETE" and re.match(r"^/api/jobs/queue/[^/]+$", path):
        job_id = path.split("/")[-1]
        if job_id in jobs_store:
            del jobs_store[job_id]
            return f"✅ Deleted job {job_id}"
        return f"⚠ Job not found: {job_id}"

    # ── POST /api/tree/nodes ─────────────────────────────────────────────────
    if method == "POST" and path == "/api/tree/nodes":
        node_id = str(uuid.uuid4())
        now = time.time()
        node = {
            "id":         node_id,
            "parent_id":  body.get("parent_id"),
            "label":      body.get("label", "node")[:60],
            "status":     body.get("status"),
            "type":       body.get("type", "custom"),
            "metadata":   body.get("metadata", {}),
            "created_at": now,
            "updated_at": now,
        }
        tree_nodes_store[node_id] = node
        return f"✅ Created tree node: {node['label']} (id: {node_id})"

    # ── PATCH /api/tree/nodes/{id} ───────────────────────────────────────────
    if method == "PATCH" and re.match(r"^/api/tree/nodes/[^/]+$", path):
        node_id = path.split("/")[-1]
        if node_id not in tree_nodes_store:
            return f"⚠ Tree node not found: {node_id}"
        allowed = {k: v for k, v in body.items() if k in {"parent_id", "label", "status", "type", "metadata"}}
        tree_nodes_store[node_id].update({**allowed, "updated_at": time.time()})
        return f"✅ Updated tree node {node_id}: {allowed}"

    # ── DELETE /api/tree/nodes/{id} ──────────────────────────────────────────
    if method == "DELETE" and re.match(r"^/api/tree/nodes/[^/]+$", path):
        node_id = path.split("/")[-1]
        if node_id in tree_nodes_store:
            del tree_nodes_store[node_id]
            return f"✅ Deleted tree node {node_id}"
        return f"⚠ Tree node not found: {node_id}"

    return f"⚠ Unknown endpoint: {endpoint}"


def execute_actions(text: str) -> tuple[str, list[str]]:
    """Parse and execute all <action>…</action> blocks in *text*.

    Returns:
        cleaned_text  — response with all <action> tags stripped
        results       — list of human-readable result strings, one per action
    """
    results: list[str] = []
    actions = _ACTION_RE.findall(text)
    for raw in actions:
        result = _execute_action(raw)
        results.append(result)
    cleaned = _ACTION_RE.sub("", text).strip()
    return cleaned, results

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

BASE_INSTRUCTIONS = """You are Katy, the AI orchestrator for the GITWIX Agent system. \
You coordinate tasks, manage automations, and help the user with development and productivity workflows.

## Identity
- Name: Katy
- Role: AI Orchestrator / Gateway
- System: GITWIX Agent

## Architecture
The GITWIX Agent tree shows the live system architecture:
  - Input channels: Telegram (@karenkaty_bot), Voice (LiveKit), Text Chat
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
## HOW TO CALL APIS — CRITICAL, READ CAREFULLY
─────────────────────────────────────────────────────────

You CANNOT make HTTP requests yourself. Instead, embed API calls as <action> tags
anywhere in your response text. The system will execute them server-side BEFORE
sending your reply to the user.

### Format
<action>{"endpoint": "METHOD /api/path", "body": {...}}</action>

For PATCH and DELETE that need an id, put it in the path:
<action>{"endpoint": "PATCH /api/tasks/TASK_ID_HERE", "body": {"status": "in_progress"}}</action>

You cannot know the generated UUID in advance for PATCH/DELETE immediately after POST,
so chain actions only when you already have a real id.

### Examples

Create a task:
<action>{"endpoint": "POST /api/tasks", "body": {"title": "Write poem about stars", "status": "pending", "category": "short_term"}}</action>

Create a tree node:
<action>{"endpoint": "POST /api/tree/nodes", "body": {"parent_id": "openclaw", "label": "Thinking…", "status": "thinking", "type": "thought"}}</action>

Create an agent:
<action>{"endpoint": "POST /api/agents", "body": {"name": "researcher-1", "type": "researcher", "status": "active"}}</action>

Create a job:
<action>{"endpoint": "POST /api/jobs/queue", "body": {"name": "Daily report generation", "status": "queued"}}</action>

### Supported endpoints
POST   /api/tasks
PATCH  /api/tasks/{id}
DELETE /api/tasks/{id}
POST   /api/agents
PATCH  /api/agents/{id}
DELETE /api/agents/{id}
POST   /api/jobs/queue
PATCH  /api/jobs/queue/{id}
DELETE /api/jobs/queue/{id}
POST   /api/tree/nodes
PATCH  /api/tree/nodes/{id}
DELETE /api/tree/nodes/{id}

─────────────────────────────────────────────────────────
## Workflow Rules
─────────────────────────────────────────────────────────
1. ALWAYS create a task when the user asks you to do something — even creative tasks.
2. Create the task with status "in_progress" directly — you cannot know the UUID before
   it is created, so do not try to POST then immediately PATCH to in_progress.
3. PATCH to "completed" once the work described is done (you may do this in a follow-up
   message if needed, using the task id from the ✅ confirmation in your context).
4. DELETE tasks that are cancelled or no longer relevant.
5. Use custom tree nodes to show sub-steps or decision points in real time.
6. Keep labels short — they are node labels in the visual tree (≤60 chars).
7. Do not let completed tasks accumulate — clean them up.
8. When spawning an agent, always emit a POST /api/agents action so it appears in the tree.
9. NEVER show raw JSON in your reply — use <action> tags only, they are stripped automatically.
10. You may chain multiple <action> tags in a single response (they execute left to right).
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

    raw_text: str = ""

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
                raw_text = data.get("response", data.get("message", str(data)))
        except Exception as exc:
            # Fall through to direct Anthropic
            print(f"[openclaw gateway error] {exc}")

    if not raw_text:
        if not ANTHROPIC_API_KEY:
            return {
                "response": (
                    "[OpenClaw offline — set ANTHROPIC_API_KEY or OPENCLAW_API_URL + OPENCLAW_API_KEY]"
                )
            }

        # Try OpenRouter first (ANTHROPIC_API_KEY is loaded from OPENROUTER_API_KEY env var; key often starts with 'sk-or-')
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                r = await client.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {ANTHROPIC_API_KEY}",
                        "HTTP-Referer":  "https://gitwix.agent",
                        "content-type":  "application/json",
                    },
                    json={
                        "model":      CLAUDE_MODEL,
                        "max_tokens": 1024,
                        "messages":   [{"role": "system", "content": BASE_INSTRUCTIONS}] + messages,
                    },
                )
                r.raise_for_status()
                data = r.json()
                raw_text = data["choices"][0]["message"]["content"]
        except Exception as exc:
            print(f"[openrouter error] {exc}")

    if not raw_text:
        # Fallback: direct Anthropic API (for native Anthropic keys)
        try:
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
                raw_text = data["content"][0]["text"] if data.get("content") else ""
        except Exception as exc:
            print(f"[anthropic error] {exc}")
            raise HTTPException(status_code=502, detail=str(exc))

    # Execute any <action>…</action> blocks embedded by the AI
    cleaned_text, action_results = execute_actions(raw_text)

    # Append a compact summary of executed actions (if any)
    if action_results:
        summary = "\n".join(action_results)
        response_text = f"{cleaned_text}\n\n{summary}".strip()
    else:
        response_text = cleaned_text

    return {"response": response_text}

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

# --- Static files (React build) ---
DIST_DIR = os.path.join(os.path.dirname(__file__), "dist")
if os.path.isdir(DIST_DIR):
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        file_path = os.path.join(DIST_DIR, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(DIST_DIR, "index.html"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
