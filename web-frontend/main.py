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

import asyncio
import base64
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
from fastapi.responses import FileResponse, Response
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

# GitHub memory config
GITHUB_TOKEN         = os.getenv("GITHUB_TOKEN", "")
GITHUB_REPO          = os.getenv("GITHUB_REPO", "")
GITHUB_MEMORY_BRANCH = os.getenv("GITHUB_MEMORY_BRANCH", "main")

# ─── In-memory stores ─────────────────────────────────────────────────────────

tasks_store:      dict[str, dict] = {}
agents_store:     dict[str, dict] = {}
jobs_store:       dict[str, dict] = {}
tree_nodes_store: dict[str, dict] = {}
skills_store:     dict[str, dict] = {}
outputs_store:    dict[str, dict] = {}
activity_log:     list[dict]      = []

# Queue of GitHub memory writes to be drained async after each request.
# Each item: {"path": str, "content": str, "message": str, "mode": "write"|"append"}
_memory_write_queue: list[dict] = []

# Telegram counter — incremented by webhook
telegram_stats: dict[str, Any] = {"message_count": 0, "last_username": "karenkaty_bot"}

# ─── Internal action executor ─────────────────────────────────────────────────

_ACTION_RE = re.compile(r"<action>(.*?)</action>", re.DOTALL | re.IGNORECASE)
_CODE_BLOCK_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)

_ACTION_STATUS_MAP = {"POST": "created", "PATCH": "updated", "DELETE": "deleted"}
_LEARN_ALLOWED     = {"branding", "profile", "automations", "conversations"}


def _extract_json_object(text: str) -> str:
    """Extract the first complete, brace-balanced JSON object from *text*.

    The regex-based ``<action>`` parser uses a non-greedy ``.*?`` match up to
    the first ``</action>``.  When a JSON string *value* contains the literal
    substring ``</action>`` (e.g. agent instructions that demonstrate action-tag
    syntax), the regex stops too early and yields truncated, invalid JSON.
    This function re-parses the raw text character-by-character, properly
    honouring JSON string boundaries and escape sequences, so it always returns
    the correctly terminated object regardless of what the string values contain.
    """
    start = text.find("{")
    if start == -1:
        raise ValueError("No JSON object found in text")
    depth = 0
    in_string = False
    escape = False
    for i, ch in enumerate(text[start:], start):
        if escape:
            escape = False
            continue
        if ch == "\\" and in_string:
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
        elif not in_string:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return text[start : i + 1]
    raise ValueError("Unterminated JSON object in text")


def _log_activity(action_type: str, label: str, status: str = "action") -> None:
    """Append an entry to the activity log (capped at 50 items)."""
    entry: dict = {
        "id":          str(uuid.uuid4()),
        "timestamp":   time.time(),
        "action_type": action_type,
        "label":       label[:60],
        "status":      status,
    }
    activity_log.append(entry)
    if len(activity_log) > 50:
        activity_log.pop(0)


# ─── GitHub memory helpers ────────────────────────────────────────────────────

_GH_HEADERS = {
    "Accept":               "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


async def github_read_memory(path: str) -> str | None:
    """Fetch a file from GitHub memory. Returns decoded string or None."""
    if not GITHUB_TOKEN or not GITHUB_REPO:
        return None
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}"
    headers = {**_GH_HEADERS, "Authorization": f"Bearer {GITHUB_TOKEN}"}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url, headers=headers, params={"ref": GITHUB_MEMORY_BRANCH})
            if r.status_code != 200:
                return None
            encoded = r.json().get("content", "").replace("\n", "")
            return base64.b64decode(encoded).decode("utf-8")
    except Exception as exc:
        print(f"[github_read_memory error] {exc}")
        return None


async def github_write_memory(path: str, content: str, message: str) -> bool:
    """Create or update a file in GitHub memory. Returns True on success."""
    if not GITHUB_TOKEN or not GITHUB_REPO:
        return False
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}"
    headers = {**_GH_HEADERS, "Authorization": f"Bearer {GITHUB_TOKEN}"}
    try:
        sha: str | None = None
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url, headers=headers, params={"ref": GITHUB_MEMORY_BRANCH})
            if r.status_code == 200:
                sha = r.json().get("sha")
        put_body: dict = {
            "message": message,
            "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
            "branch":  GITHUB_MEMORY_BRANCH,
        }
        if sha:
            put_body["sha"] = sha
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.put(url, headers=headers, json=put_body)
            return r.status_code in (200, 201)
    except Exception as exc:
        print(f"[github_write_memory error] {exc}")
        return False


async def _process_memory_write_item(item: dict) -> None:
    """Execute a queued memory write: append or replace, then persist to GitHub + local."""
    path: str    = item["path"]
    content: str = item["content"]
    message: str = item.get("message", "Katy memory update")
    mode: str    = item.get("mode", "write")
    try:
        if mode == "append":
            existing = await github_read_memory(path) or _read_local_memory(path) or ""
            # Rotate: never exceed 500 lines for append-mode files
            lines = existing.splitlines(keepends=True)
            if len(lines) > 480:
                lines = lines[len(lines) - 480:]
            final_content = "".join(lines) + content
        else:
            final_content = content

        await github_write_memory(path, final_content, message)

        # Mirror locally so /api/memory/{file} works without GitHub
        local_rel  = path[len("memory/"):] if path.startswith("memory/") else path
        local_path = os.path.join(MEMORY_DIR, local_rel)
        os.makedirs(os.path.dirname(os.path.abspath(local_path)), exist_ok=True)
        with open(local_path, "w", encoding="utf-8") as f:
            f.write(final_content)
    except Exception as exc:
        print(f"[_process_memory_write_item error] path={path}: {exc}")


def _read_local_memory(path: str) -> str | None:
    """Read a file from the local memory directory. Returns content or None."""
    local_rel  = path[len("memory/"):] if path.startswith("memory/") else path
    local_path = os.path.join(MEMORY_DIR, local_rel)
    try:
        with open(local_path, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return None


def _queue_memory_write(path: str, content: str, message: str, mode: str = "write") -> None:
    """Enqueue a GitHub memory write (drained after each chat request)."""
    _memory_write_queue.append({"path": path, "content": content, "message": message, "mode": mode})


# ─── Memory content formatters ────────────────────────────────────────────────

def _format_tasks_md() -> str:
    now = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    lines = [f"# Tasks Memory\n_Last updated: {now}_\n\n"]
    if not tasks_store:
        lines.append("_No tasks currently._\n")
    else:
        icons = {"pending": "⏳", "in_progress": "🔄", "completed": "✅"}
        for task in sorted(tasks_store.values(), key=lambda t: t.get("created_at", 0)):
            icon = icons.get(task["status"], "•")
            dt   = time.strftime("%Y-%m-%d", time.gmtime(task.get("created_at", 0)))
            lines.append(
                f"- {icon} **{task['title']}** "
                f"`{task['status']}` / `{task.get('category', 'short_term')}` _{dt}_\n"
            )
    return "".join(lines)


def _format_activity_log_md() -> str:
    now = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    lines = [f"# Activity Log\n_Last updated: {now}_\n\n"]
    for entry in activity_log[-500:]:
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(entry["timestamp"]))
        lines.append(
            f"- `{ts}` **{entry['action_type']}** — {entry['label']} ({entry['status']})\n"
        )
    return "".join(lines)


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

    print('[ACTION FIRED]')
    _log_activity(
        action_type=f"{method} {path}",
        label=body.get("title") or body.get("name") or body.get("label") or path,
        status=_ACTION_STATUS_MAP.get(method, "action"),
    )

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
        _queue_memory_write("memory/tasks.md", _format_tasks_md(), f"Task created: {task['title']}")
        _queue_memory_write("memory/activity_log.md", _format_activity_log_md(), "Activity log update")
        return f"✅ Created task: {task['title']} (id: {task_id})"

    # ── PATCH /api/tasks/{id} ────────────────────────────────────────────────
    if method == "PATCH" and re.match(r"^/api/tasks/[^/]+$", path):
        task_id = path.split("/")[-1]
        if task_id not in tasks_store:
            return f"⚠ Task not found: {task_id}"
        allowed = {k: v for k, v in body.items() if k in {"title", "status", "category", "source"}}
        tasks_store[task_id].update({**allowed, "updated_at": time.time()})
        _queue_memory_write("memory/tasks.md", _format_tasks_md(), f"Task updated: {task_id}")
        _queue_memory_write("memory/activity_log.md", _format_activity_log_md(), "Activity log update")
        return f"✅ Updated task {task_id}: {allowed}"

    # ── DELETE /api/tasks/{id} ───────────────────────────────────────────────
    if method == "DELETE" and re.match(r"^/api/tasks/[^/]+$", path):
        task_id = path.split("/")[-1]
        if task_id in tasks_store:
            del tasks_store[task_id]
            _queue_memory_write("memory/tasks.md", _format_tasks_md(), f"Task deleted: {task_id}")
            _queue_memory_write("memory/activity_log.md", _format_activity_log_md(), "Activity log update")
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
        _queue_memory_write("memory/activity_log.md", _format_activity_log_md(), "Activity log update")
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
        _queue_memory_write("memory/activity_log.md", _format_activity_log_md(), "Activity log update")
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

    # ── POST /api/outputs ────────────────────────────────────────────────────
    if method == "POST" and path == "/api/outputs":
        output_id = str(uuid.uuid4())
        now = time.time()
        output = {
            "id":         output_id,
            "task_id":    body.get("task_id"),
            "title":      body.get("title", "Untitled output")[:80],
            "content":    body.get("content", ""),
            "format":     body.get("format", "text"),
            "created_at": now,
        }
        outputs_store[output_id] = output
        # Persist to GitHub memory/outputs/
        ts        = time.strftime("%Y-%m-%d-%H%M%S", time.gmtime(now))
        safe_name = re.sub(r"[^a-zA-Z0-9_\-]", "", output["title"].replace(" ", "-"))[:30]
        out_path  = f"memory/outputs/{ts}-{safe_name or 'output'}.md"
        _queue_memory_write(out_path, output["content"], f"Output: {output['title']}")
        _queue_memory_write("memory/activity_log.md", _format_activity_log_md(), "Activity log update")
        return f"✅ Created output: {output['title']} (id: {output_id})"

    # ── POST /api/memory/learn ───────────────────────────────────────────────
    if method == "POST" and path == "/api/memory/learn":
        file_name = body.get("file", "")
        if file_name not in _LEARN_ALLOWED:
            return f"⚠ memory/learn: file must be one of {sorted(_LEARN_ALLOWED)}"
        content   = body.get("content", "")
        now_str   = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
        append_md = f"\n\n---\n_Learned: {now_str}_\n\n{content}\n"
        _queue_memory_write(
            f"memory/{file_name}.md", append_md,
            f"Katy learned: {file_name}", mode="append",
        )
        return f"✅ Queued memory update for {file_name}.md"

    # ── POST /api/memory/write ───────────────────────────────────────────────
    if method == "POST" and path == "/api/memory/write":
        file_name = body.get("file", "").lstrip("/").replace("..", "")
        if not file_name:
            return "⚠ memory/write: 'file' is required"
        content = body.get("content", "")
        message = body.get("message", "Katy memory write")
        _queue_memory_write(f"memory/{file_name}", content, message)
        return f"✅ Queued memory write for {file_name}"

    return f"⚠ Unknown endpoint: {endpoint}"


def execute_actions(text: str) -> tuple[str, list[str]]:
    """Parse and execute all <action>…</action> blocks in *text*.

    Also falls back to parsing ```json code blocks that contain 'title' or
    'endpoint' keys (in case the model wraps actions in code fences instead).

    Returns:
        cleaned_text  — response with all <action> tags and matched code blocks stripped
        results       — list of human-readable result strings, one per action
    """
    results: list[str] = []

    # Primary path: <action>…</action> tags.
    #
    # We use finditer (not findall) so that when the regex-captured content is
    # truncated — which happens when a JSON string *value* contains the literal
    # substring "</action>" (e.g. agent-instruction output that demonstrates
    # action-tag syntax) — we can recover the complete JSON object by
    # brace-counting from the match's start position in the original text.
    #
    # consumed_up_to tracks the end of the last properly-processed action block
    # (including any extra text consumed during brace-count recovery).  Any
    # subsequent regex match that starts before this offset is a spurious
    # "<action>" tag found *inside* a previously-consumed JSON string value and
    # must be skipped.
    consumed_up_to: int = 0
    for m in _ACTION_RE.finditer(text):
        if m.start() < consumed_up_to:
            continue  # this match is inside an already-consumed action block
        raw = m.group(1)
        try:
            json.loads(raw.strip())
            consumed_up_to = m.end()
        except json.JSONDecodeError:
            # The regex stopped at a "</action>" that was *inside* a JSON string
            # value.  Re-extract using brace-counting from the original text.
            try:
                raw = _extract_json_object(text[m.start(1):])
                # Advance consumed_up_to past the real closing </action> tag.
                json_start_off = text[m.start(1):].find("{")
                if json_start_off == -1:
                    consumed_up_to = m.end()
                else:
                    json_end       = m.start(1) + json_start_off + len(raw)
                    close_m        = re.search(r"</action>", text[json_end:], re.IGNORECASE)
                    consumed_up_to = json_end + (close_m.end() if close_m else 0)
            except ValueError:
                consumed_up_to = m.end()
        result = _execute_action(raw)
        results.append(result)

    # Fallback: ```json … ``` code blocks — only if JSON has an 'endpoint' key
    fallback_blocks: list[str] = []
    for m in _CODE_BLOCK_RE.finditer(text):
        raw = m.group(1)
        try:
            data = json.loads(raw)
            if isinstance(data, dict) and "endpoint" in data:
                result = _execute_action(raw)
                results.append(result)
                fallback_blocks.append(m.group(0))
        except json.JSONDecodeError:
            pass

    # Strip all action tags and matched code-block fallbacks from the reply
    cleaned = _ACTION_RE.sub("", text).strip()
    for block in fallback_blocks:
        cleaned = cleaned.replace(block, "").strip()
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
    active_skills:        list[str]  = Field(default_factory=list)


class SkillRegister(BaseModel):
    id:          str
    name:        str
    category:    str
    credentials: dict[str, str] = Field(default_factory=dict)


class Output(BaseModel):
    id:         str
    task_id:    Optional[str]  = None
    title:      str
    content:    str
    format:     str            = "text"
    created_at: float          = Field(default_factory=time.time)


class OutputCreate(BaseModel):
    task_id: Optional[str] = None
    title:   str
    content: str
    format:  str           = "text"


class MemoryWriteRequest(BaseModel):
    file:    str
    content: str
    message: str = "Katy memory update"


class MemoryLearnRequest(BaseModel):
    file:    str
    content: str
    message: str = "Katy learned new information"


# ─── BASE INSTRUCTIONS ────────────────────────────────────────────────────────

BASE_INSTRUCTIONS = """You are Katy, the AI orchestrator for the GITWIX Agent hive dashboard.

═══════════════════════════════════════════════════════════
CORE RULES — NEVER BREAK THESE (violations = broken product)
═══════════════════════════════════════════════════════════

1. NEVER output generated content (documents, reports, poems, code, plans, lists,
   CSV, markdown, HTML, JSON data, etc.) in the chat message. ZERO exceptions.
   ALL content of any kind goes exclusively to POST /api/outputs.

2. Keep EVERY chat reply SHORT — maximum 3 sentences. You are a DOER, not a talker.
   One-liners are better than paragraphs. If you find yourself writing more than
   3 sentences in chat, STOP — put the content in /api/outputs instead.

3. ALWAYS use <action>…</action> XML tags to call APIs. Never use backticks, code
   fences, or raw JSON in your reply. The tags are stripped server-side before the
   user sees your message.

4. ALWAYS survey your active skills before starting any content-generating work.
   If active skills are listed above, acknowledge them and ask ONE clarifying
   question: "What format would you like? (text / markdown / json / csv / html)"
   Do not generate anything until the user confirms a format.

5. When asked to "create a task for yourself", ALWAYS pick a tangible, deliverable
   task — something that produces a real output the user can read or use.
   Good examples: "Write a 7-day content calendar", "Draft a brand positioning doc",
   "Generate a competitor analysis report", "Create an email welcome sequence".
   Bad examples (FORBIDDEN): "Review system logs", "Monitor performance", "Check status".

6. After saving any output to /api/outputs, your entire chat reply must be exactly:
   "Done — check your Outputs panel." Nothing more.

═══════════════════════════════════════════════════════════
IDENTITY & ARCHITECTURE
═══════════════════════════════════════════════════════════

- Name: Katy | Role: AI Orchestrator | System: GITWIX Agent hive
- Input channels: Telegram (@karenkaty_bot), Voice (LiveKit), Text Chat
- You are the OpenClaw brain/router at the centre of the tree
- Left branch: GitHub Memory (profile.md, tasks.md, conversations.md, automations.md)
- Right branch: Workspace (Tasks, Agents, Jobs, Outputs)
- Custom nodes: anything you create via /api/tree/nodes

The user sees the tree updating LIVE. Create tree nodes to show your progress.

═══════════════════════════════════════════════════════════
HOW TO CALL APIS — CRITICAL
═══════════════════════════════════════════════════════════

The ONLY correct format:
<action>{"endpoint": "METHOD /api/path", "body": {...}}</action>

Rules:
• NEVER use markdown code blocks (``` or ```json) for actions
• NEVER use backticks around action JSON
• NEVER paste raw JSON into the chat reply
• You MAY chain multiple <action> tags in one response (execute left-to-right)
• For PATCH/DELETE with an id, embed it in the path:
  <action>{"endpoint": "PATCH /api/tasks/TASK_ID_HERE", "body": {"status": "completed"}}</action>

═══════════════════════════════════════════════════════════
TASK TREE CONTROL — Full API Reference
═══════════════════════════════════════════════════════════

### Tasks — work items shown in the Workspace branch

POST /api/tasks
{
  "title": "Brief description (max 60 chars)",
  "status": "in_progress",
  "source": "openclaw",
  "category": "short_term" | "long_term"
}
  • "short_term" → immediate one-off actions (research, replies, quick fixes, single steps)
  • "long_term"  → recurring jobs, automations, scheduled workflows, multi-step plans
  • Always create with status "in_progress" — never "pending" then patch.

PATCH /api/tasks/{task_id}
{ "status": "completed" }

DELETE /api/tasks/{task_id}

### Custom Tree Nodes — visualise your thinking

Use these to show reasoning, sub-steps, decisions on the live tree.
OpenClaw nodes appear in purple with a dashed border.

POST /api/tree/nodes
{
  "parent_id": "<well-known ID or existing node id>",
  "label":     "What this represents (max 60 chars)",
  "status":    "thinking" | "active" | "done" | "error" | null,
  "type":      "thought" | "decision" | "action" | "step" | "custom",
  "metadata":  {}
}

PATCH /api/tree/nodes/{node_id}
{ "status": "done", "label": "Updated label" }

DELETE /api/tree/nodes/{node_id}

Well-known parent IDs:
  "openclaw"            — attach directly to OpenClaw
  "br-memory"           — GitHub Memory branch header
  "br-workspace"        — Workspace branch header
  "grp-tasks"           — Tasks group
  "grp-agents"          — Agents group
  "grp-jobs"            — Jobs group
  "mem-profile"         — profile.md node
  "mem-tasks"           — tasks.md node
  "mem-conversations"   — conversations.md
  "mem-automations"     — automations.md
  "<custom-node-id>"    — another custom node you created

### Agents — spawned sub-agents

POST /api/agents
{ "name": "agent-name", "type": "researcher|executor|monitor|writer", "status": "active" }

PATCH /api/agents/{agent_id}   { "status": "completed" }
DELETE /api/agents/{agent_id}

### Jobs — queued / scheduled work

POST /api/jobs/queue
{ "name": "job description", "status": "queued", "schedule": "cron expr or null" }

PATCH /api/jobs/queue/{job_id}   { "status": "running" }
DELETE /api/jobs/queue/{job_id}

### Outputs — THE ONLY PLACE FOR GENERATED CONTENT

Every document, report, poem, plan, code snippet, list, CSV, or any text you generate
MUST go here. Never in chat. This is non-negotiable.

POST /api/outputs
{
  "title":   "Descriptive output title (max 80 chars)",
  "content": "The full generated content as a string",
  "format":  "text" | "markdown" | "json" | "csv" | "html",
  "task_id": "<id of the related task — include this whenever possible>"
}

After saving an output → reply: "Done — check your Outputs panel."

### Memory files (read only)

GET /api/memory/profile | /api/memory/tasks | /api/memory/conversations | /api/memory/automations
→ Returns { file, path, content, preview, updated_at, size }

═══════════════════════════════════════════════════════════
Supported action endpoints
═══════════════════════════════════════════════════════════
POST   /api/tasks              PATCH  /api/tasks/{id}         DELETE /api/tasks/{id}
POST   /api/agents             PATCH  /api/agents/{id}        DELETE /api/agents/{id}
POST   /api/jobs/queue         PATCH  /api/jobs/queue/{id}    DELETE /api/jobs/queue/{id}
POST   /api/tree/nodes         PATCH  /api/tree/nodes/{id}    DELETE /api/tree/nodes/{id}
POST   /api/outputs
POST   /api/memory/learn       POST   /api/memory/write

═══════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════

Create a task (always in_progress, never pending):
<action>{"endpoint": "POST /api/tasks", "body": {"title": "Write 7-day content calendar", "status": "in_progress", "category": "short_term"}}</action>

Create a thinking node (show progress on the live tree):
<action>{"endpoint": "POST /api/tree/nodes", "body": {"parent_id": "openclaw", "label": "Drafting content calendar…", "status": "thinking", "type": "thought"}}</action>

Save an output — THE RIGHT WAY (NEVER paste content into chat):
<action>{"endpoint": "POST /api/outputs", "body": {"title": "7-Day Content Calendar", "content": "# Monday\n...", "format": "markdown", "task_id": "TASK_ID_HERE"}}</action>

Mark a task completed after saving output:
<action>{"endpoint": "PATCH /api/tasks/TASK_ID_HERE", "body": {"status": "completed"}}</action>

Save brand info to memory:
<action>{"endpoint": "POST /api/memory/learn", "body": {"file": "branding", "content": "Brand: Acme. Tone: friendly, bold. Colour: #d97706."}}</action>

Create an agent:
<action>{"endpoint": "POST /api/agents", "body": {"name": "writer-1", "type": "writer", "status": "active"}}</action>

Self-task example (tangible, deliverable — NOT "review system logs"):
User: "Create a task for yourself"
→ You pick something concrete, e.g.:
<action>{"endpoint": "POST /api/tasks", "body": {"title": "Draft brand positioning one-pager", "status": "in_progress", "category": "short_term"}}</action>
Then ask: "I've queued a brand positioning doc — what format would you like? (text / markdown / html)"

═══════════════════════════════════════════════════════════
GITHUB MEMORY — Your Persistent Brain
═══════════════════════════════════════════════════════════

Memory survives restarts. Key files:
  memory/tasks.md       — auto-synced on every task change
  memory/activity_log.md — auto-appended on every action
  memory/branding.md    — brand voice, colours, tone
  memory/profile.md     — user preferences, goals, context
  memory/automations.md — workflows and scheduled jobs
  memory/conversations.md — key summaries and decisions
  memory/outputs/       — every generated output is auto-saved here

To save learned context:
<action>{"endpoint": "POST /api/memory/learn", "body": {"file": "branding", "content": "..."}}</action>
Available files: branding, profile, automations, conversations

At session start: briefly summarise what you remember about the user (1–2 sentences).

═══════════════════════════════════════════════════════════
WORKFLOW RULES
═══════════════════════════════════════════════════════════
1. ALWAYS create a task (in_progress) when the user asks you to do something.
2. PATCH to "completed" once the work is done; use the task id from the ✅ confirmation.
3. DELETE tasks that are cancelled or no longer relevant.
4. Use custom tree nodes to show sub-steps and decision points in real time.
5. Keep all labels ≤60 chars (they are visual tree node labels).
6. Do not let completed tasks accumulate — clean them up promptly.
7. When spawning an agent, always POST /api/agents so it appears in the tree.
8. When users share brand, business, or personal context — save it to memory immediately.
9. Content goes to /api/outputs. Chat replies stay short. These rules are absolute.

═══════════════════════════════════════════════════════════
OUTPUT GENERATION RULE — NON-NEGOTIABLE
═══════════════════════════════════════════════════════════

When the user has confirmed an output format, your ENTIRE next response must contain ALL of these actions with NO gaps:

Step 1 — Create task:
<action>{"endpoint": "POST /api/tasks", "body": {"title": "<task title>", "status": "in_progress", "category": "short_term"}}</action>

Step 2 — Create thinking node:
<action>{"endpoint": "POST /api/tree/nodes", "body": {"parent_id": "openclaw", "label": "<progress label>", "status": "thinking", "type": "thought"}}</action>

Step 3 — POST THE ACTUAL OUTPUT (write the FULL real content directly in the JSON — not a placeholder, the complete document):
<action>{"endpoint": "POST /api/outputs", "body": {"title": "<output title>", "content": "<THE FULL REAL CONTENT — minimum 200 words for reports/articles>", "format": "<confirmed format>", "task_id": "<task id from Step 1>"}}</action>

Step 4 — Create output node:
<action>{"endpoint": "POST /api/tree/nodes", "body": {"parent_id": "openclaw", "label": "<output ready label>", "status": "done", "type": "action"}}</action>

Step 5 — Mark task completed (removes the gold glow from the task node):
<action>{"endpoint": "PATCH /api/tasks/TASK_ID_FROM_STEP_1", "body": {"status": "completed"}}</action>

Step 6 — Delete the thinking node (it served its purpose — the output node is the permanent deliverable):
<action>{"endpoint": "DELETE /api/tree/nodes/THINKING_NODE_ID_FROM_STEP_2", "body": {}}</action>

Step 7 — Set agent idle if you spawned one (removes the green glow so it goes dormant):
<action>{"endpoint": "PATCH /api/agents/AGENT_ID_HERE", "body": {"status": "idle"}}</action>

Then say (MAX 2 sentences): "Done! [Title] is ready — download card appeared above."

CLEANUP RULES (CRITICAL — dashboard stays clean):
- ALWAYS fire Steps 5 and 6 immediately after creating the output. No exceptions.
- Step 7 is required only if you created an agent (POST /api/agents) during this task.
- The output node (type: "action", status: "done") stays PERMANENTLY — it is the deliverable.
- The thinking node (type: "thought") MUST be deleted — it is temporary scaffolding.
- The task node fades off the dashboard once marked "completed".
- The agent node stays on the tree but goes dim/idle — ready to be reused.

YOU MUST NOT:
- Stop after Step 1 or Step 2 waiting for something
- Use a placeholder like "[content here]" in the content field
- Split this into multiple conversation turns
- Create sub-tasks for data gathering before generating
- Leave the task, thinking node, or agent in an active/glowing state after the output is saved

YOU MUST:
- Write the complete actual document content in the "content" field of POST /api/outputs
- Complete all steps (1–6, plus 7 if applicable) in one single response
- The content must be substantial (at minimum 200 words for reports/articles)
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

# ─── Skills ───────────────────────────────────────────────────────────────────

@app.get("/api/skills/active")
async def get_active_skills():
    return list(skills_store.values())


@app.post("/api/skills/register")
async def register_skill(body: SkillRegister):
    skills_store[body.id] = body.model_dump()
    return {"ok": True, "id": body.id}

# ─── Outputs ──────────────────────────────────────────────────────────────────

@app.get("/api/outputs", response_model=list[Output])
async def get_outputs():
    return list(outputs_store.values())


@app.post("/api/outputs", response_model=Output)
async def create_output(body: OutputCreate):
    output = Output(
        id=str(uuid.uuid4()),
        task_id=body.task_id,
        title=body.title,
        content=body.content,
        format=body.format,
        created_at=time.time(),
    )
    outputs_store[output.id] = output.model_dump()
    return output


@app.get("/api/outputs/{output_id}/download")
async def download_output(output_id: str):
    if output_id not in outputs_store:
        raise HTTPException(status_code=404, detail="Output not found")
    out = outputs_store[output_id]
    ext_map = {"markdown": "md", "json": "json", "csv": "csv", "html": "html", "text": "txt"}
    ext = ext_map.get(out["format"], "txt")
    safe_title = re.sub(r"[^a-zA-Z0-9_\- ]", "", out["title"])[:40].strip().replace(" ", "_")
    filename = f"{safe_title or 'output'}.{ext}"
    return Response(
        content=out["content"],
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

# ─── Activity log ─────────────────────────────────────────────────────────────

@app.get("/api/activity")
async def get_activity():
    return list(reversed(activity_log))[:20]

# ─── Memory files ─────────────────────────────────────────────────────────────

MEMORY_FILES = {"profile", "tasks", "conversations", "automations", "branding"}


@app.get("/api/memory/{file_name}")
async def get_memory_file(file_name: str):
    if file_name not in MEMORY_FILES:
        raise HTTPException(status_code=404, detail=f"Unknown memory file: {file_name}")

    local_path  = os.path.join(MEMORY_DIR, f"{file_name}.md")
    content:    str | None = None
    updated_at: float | None = None

    # Try local first
    try:
        with open(local_path, encoding="utf-8") as f:
            content = f.read()
        updated_at = os.path.getmtime(local_path)
    except FileNotFoundError:
        pass

    # Fallback to GitHub if not found locally
    if content is None:
        gh_content = await github_read_memory(f"memory/{file_name}.md")
        if gh_content:
            content    = gh_content
            updated_at = time.time()
            # Cache locally for future requests
            try:
                os.makedirs(MEMORY_DIR, exist_ok=True)
                with open(local_path, "w", encoding="utf-8") as f:
                    f.write(content)
            except Exception:
                pass

    if content is None:
        content    = f"# {file_name}\n\n(no content yet)"
        updated_at = time.time()

    preview = content.strip()[:120].replace("\n", " ")
    return {
        "file":       file_name,
        "path":       local_path,
        "content":    content,
        "preview":    preview,
        "updated_at": updated_at,
        "size":       len(content.encode("utf-8")),
    }


@app.post("/api/memory/write")
async def write_memory_endpoint(body: MemoryWriteRequest):
    """Write arbitrary content to a memory file (GitHub + local mirror)."""
    safe_file = body.file.lstrip("/").replace("..", "").strip()
    if not safe_file:
        raise HTTPException(status_code=400, detail="'file' path is required")
    path = f"memory/{safe_file}"
    ok   = await github_write_memory(path, body.content, body.message)
    # Mirror locally
    local_path = os.path.join(MEMORY_DIR, safe_file)
    try:
        os.makedirs(os.path.dirname(os.path.abspath(local_path)), exist_ok=True)
        with open(local_path, "w", encoding="utf-8") as f:
            f.write(body.content)
    except Exception as exc:
        print(f"[memory write local error] {exc}")
    return {"ok": ok, "path": path}


@app.post("/api/memory/learn")
async def learn_memory(body: MemoryLearnRequest):
    """Append learned context to a named memory file (GitHub + local mirror)."""
    if body.file not in _LEARN_ALLOWED:
        raise HTTPException(
            status_code=400,
            detail=f"'file' must be one of: {sorted(_LEARN_ALLOWED)}",
        )
    path      = f"memory/{body.file}.md"
    now_str   = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())

    # Read existing content (local first, then GitHub)
    local_path = os.path.join(MEMORY_DIR, f"{body.file}.md")
    existing: str = _read_local_memory(path) or ""
    if not existing:
        gh = await github_read_memory(path)
        existing = gh or f"# {body.file.capitalize()}\n\n"

    new_content = existing.rstrip() + f"\n\n---\n_Learned: {now_str}_\n\n{body.content}\n"
    ok = await github_write_memory(path, new_content, body.message)
    try:
        with open(local_path, "w", encoding="utf-8") as f:
            f.write(new_content)
    except Exception as exc:
        print(f"[learn memory local error] {exc}")
    return {"ok": ok, "file": path}

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

    # Build skills context if active skills are provided
    if body.active_skills:
        skill_names = [
            skills_store.get(sid, {}).get("name", sid)
            for sid in body.active_skills
        ]
        skills_context = (
            "\n\n═══════════════════════════════════════════════════════════\n"
            "ACTIVE SKILLS — MANDATORY PRE-FLIGHT CHECK\n"
            "═══════════════════════════════════════════════════════════\n"
            "The user has these skills connected: "
            + ", ".join(skill_names)
            + "\n\n"
            "BEFORE generating any content you MUST:\n"
            "  1. In your first reply, list the connected skills in one sentence.\n"
            "  2. Ask EXACTLY ONE question: "
            "\"What format would you like? (text / markdown / json / csv / html)\"\n"
            "  3. Do NOT generate any content until the user confirms a format.\n"
            "     Once they confirm, generate the full content and save it to "
            "POST /api/outputs immediately — do not say 'I will…', just do it.\n"
        )
        system_prompt = BASE_INSTRUCTIONS + skills_context
    else:
        system_prompt = BASE_INSTRUCTIONS

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
                        "system":  system_prompt,
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
                        "messages":   [{"role": "system", "content": system_prompt}] + messages,
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
                        "system":     system_prompt,
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

    # Drain memory write queue — deduplicate 'write' entries per path, then fire async
    if _memory_write_queue:
        pending_writes = _memory_write_queue[:]
        _memory_write_queue.clear()
        deduped: dict[str, dict] = {}
        for item in pending_writes:
            if item.get("mode", "write") == "write":
                deduped[item["path"]] = item          # keep latest write per path
            else:
                deduped[f"{item['path']}:{id(item)}"] = item   # append: always run
        for item in deduped.values():
            asyncio.create_task(_process_memory_write_item(item))

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
        "status":        "ok",
        "tasks":         len(tasks_store),
        "agents":        len(agents_store),
        "jobs":          len(jobs_store),
        "tree_nodes":    len(tree_nodes_store),
        "skills":        len(skills_store),
        "outputs":       len(outputs_store),
        "github_memory": bool(GITHUB_TOKEN and GITHUB_REPO),
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
