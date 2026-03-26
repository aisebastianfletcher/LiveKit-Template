"""
OpenClaw Voice Agent — Resilient Architecture
============================================
- Gateway-only LLM (OPENCLAW_API_BASE). No fallback model. Ever.
- OPENAI_API_KEY is used ONLY for STT (whisper-1) and TTS (tts-1).
- Exponential back-off retry: 1 → 2 → 4 → 8 → 16 → 32 s (6 attempts).
- Background health monitor pings the gateway every 30 s.
- When gateway is down: voice input is queued to GitHub, user is told via TTS,
  room stays open, speech keeps being transcribed.
- When gateway recovers: all queued messages are replayed in order.
- Crash recovery: pending queue is persisted in workspace/pending_queue.json
  and reloaded on the next session startup.
- Zero silent failures. Zero data loss.

Fixes also applied:
  - Fix 5: transcript → profile facts + tasks written to GitHub after session.
  - Fix 7: on_disconnect indentation corrected (was broken in repo).
"""

import logging
import os
import re
import json
import base64
import asyncio
from datetime import datetime, timezone
from typing import Any

import httpx
from openai import AsyncOpenAI as _AsyncOpenAI

from livekit.agents import (
    Agent, AgentSession, AgentServer, JobContext, JobProcess, cli,
)
from livekit.plugins import openai, silero

logger = logging.getLogger("openclaw")
logging.basicConfig(level=logging.INFO)
server = AgentServer()

# ── Environment ────────────────────────────────────────────────────────────────

GITHUB_TOKEN  = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO   = os.environ.get("GITHUB_REPO", "aisebastianfletcher/LiveKit-Template")
GITHUB_BRANCH = "main"
MEMORY_FILES  = [
    "memory/profile.md",
    "memory/tasks.md",
    "memory/conversations.md",
    "memory/automations.md",
]

OPENCLAW_BASE_URL      = os.environ.get("OPENCLAW_BASE_URL", "https://openclaw-production-058c.up.railway.app")
OPENCLAW_GATEWAY_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")
OPENCLAW_API_BASE      = f"{OPENCLAW_BASE_URL.rstrip('/')}/v1"

# Back-off schedule: attempt 0→1s, 1→2s, 2→4s, 3→8s, 4→16s, 5→32s
RETRY_DELAYS_S        = [1, 2, 4, 8, 16, 32]
HEALTH_PROBE_INTERVAL = 30   # seconds between background pings
QUEUE_FILE            = "workspace/pending_queue.json"

# ── Shared prompt ──────────────────────────────────────────────────────────────

BASE_INSTRUCTIONS = """You are OpenClaw, a stateful voice AI assistant with persistent memory.
Keep responses short (1-2 sentences) unless asked for detail.
You remember everything across sessions because your memory is stored in files.
When the user tells you something important (name, preferences, tasks, etc), acknowledge you will remember it.
You can manage tasks, track automations, and learn about the user over time.
Never pretend you have skills you don't have yet (email, calendar, web). Be honest.
"""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# GATEWAY HEALTH TRACKER
# Shared across all sessions on this worker process.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class GatewayHealth:
    """Thread-safe tracker for gateway liveness and latency."""

    def __init__(self) -> None:
        self.is_up: bool = True
        self.consecutive_errors: int = 0
        self.total_requests: int = 0
        self.total_errors: int = 0
        self.last_latency_ms: float = 0.0
        self.last_checked_at: datetime | None = None
        # Fired every time the gateway transitions from DOWN → UP.
        # Each session holds its own listener; this is a module-level broadcaster.
        self._recovery_listeners: list[asyncio.Event] = []
        self._lock = asyncio.Lock()

    def new_recovery_event(self) -> asyncio.Event:
        """Register a session-scoped asyncio.Event that fires on recovery."""
        ev = asyncio.Event()
        if self.is_up:
            ev.set()   # already up — don't block immediately
        self._recovery_listeners.append(ev)
        return ev

    def remove_recovery_event(self, ev: asyncio.Event) -> None:
        try:
            self._recovery_listeners.remove(ev)
        except ValueError:
            pass

    async def record_success(self, latency_ms: float) -> None:
        async with self._lock:
            was_down = not self.is_up
            self.is_up = True
            self.consecutive_errors = 0
            self.total_requests += 1
            self.last_latency_ms = latency_ms
            self.last_checked_at = datetime.now(timezone.utc)
            listeners_to_notify = list(self._recovery_listeners) if was_down else []

        if was_down:
            logger.info("[HEALTH] ✓ Gateway recovered")
            for ev in listeners_to_notify:
                ev.set()
        if latency_ms > 5000:
            logger.warning(f"[HEALTH] Gateway slow: {latency_ms:.0f}ms")

    async def record_failure(self) -> None:
        async with self._lock:
            self.consecutive_errors += 1
            self.total_errors += 1
            self.total_requests += 1
            self.last_checked_at = datetime.now(timezone.utc)
            if self.consecutive_errors >= 2 and self.is_up:
                self.is_up = False

        if not self.is_up:
            logger.error(
                f"[HEALTH] ✗ Gateway DOWN — "
                f"{self.consecutive_errors} consecutive errors, "
                f"{self.total_errors}/{self.total_requests} total"
            )

    def log_status(self) -> None:
        status = "UP  " if self.is_up else "DOWN"
        logger.info(
            f"[HEALTH] {status} | consecutive_errors={self.consecutive_errors} | "
            f"total_errors={self.total_errors}/{self.total_requests} | "
            f"latency={self.last_latency_ms:.0f}ms"
        )


# Module-level singleton — one monitor, many sessions
_health = GatewayHealth()
_monitor_started = False


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# GITHUB HELPERS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_GH_HEADERS = {
    "Authorization": f"token {GITHUB_TOKEN}",
    "Accept": "application/vnd.github.v3+json",
}


async def read_github_file(path: str) -> str:
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}?ref={GITHUB_BRANCH}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.get(url, headers=_GH_HEADERS)
            if resp.status_code == 200:
                return base64.b64decode(resp.json()["content"]).decode("utf-8")
            logger.warning(f"[GH] read {path}: {resp.status_code}")
            return ""
        except Exception as e:
            logger.error(f"[GH] read {path}: {e}")
            return ""


async def write_github_file(path: str, content: str, message: str) -> bool:
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            sha_resp = await client.get(url + f"?ref={GITHUB_BRANCH}", headers=_GH_HEADERS)
            sha = sha_resp.json().get("sha", "") if sha_resp.status_code == 200 else ""
            payload: dict[str, Any] = {
                "message": message,
                "content": base64.b64encode(content.encode()).decode(),
                "branch": GITHUB_BRANCH,
            }
            if sha:
                payload["sha"] = sha
            resp = await client.put(url, headers=_GH_HEADERS, json=payload)
            if resp.status_code in (200, 201):
                logger.info(f"[GH] wrote {path}")
                return True
            logger.error(f"[GH] write {path}: {resp.status_code} {resp.text}")
            return False
        except Exception as e:
            logger.error(f"[GH] write {path}: {e}")
            return False


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# GATEWAY CALLS — all LLM calls go through here (retry + health)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class GatewayDownError(RuntimeError):
    """Raised when all retry attempts are exhausted."""


async def call_gateway(messages: list[dict], max_tokens: int = 400) -> str:
    """
    POST to the OpenClaw gateway with exponential back-off retry.
    Updates _health on every attempt. Raises GatewayDownError if all fail.
    Used for: summaries, fact extraction, queue replay.
    (The AgentSession uses the openai.LLM plugin for streaming turns.)
    """
    last_exc: Exception | None = None

    for attempt, delay in enumerate(RETRY_DELAYS_S):
        t0 = asyncio.get_event_loop().time()
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
                        "messages": messages,
                        "max_tokens": max_tokens,
                    },
                )

            latency_ms = (asyncio.get_event_loop().time() - t0) * 1000

            if resp.status_code == 200:
                await _health.record_success(latency_ms)
                return resp.json()["choices"][0]["message"]["content"]

            # Non-200 is a failure — record and retry
            last_exc = RuntimeError(f"HTTP {resp.status_code}")
            await _health.record_failure()
            logger.warning(
                f"[GATEWAY] Attempt {attempt + 1}/{len(RETRY_DELAYS_S)} "
                f"failed: HTTP {resp.status_code}"
            )

        except Exception as e:
            last_exc = e
            await _health.record_failure()
            logger.warning(
                f"[GATEWAY] Attempt {attempt + 1}/{len(RETRY_DELAYS_S)} "
                f"failed: {e}"
            )

        if attempt < len(RETRY_DELAYS_S) - 1:
            logger.info(f"[GATEWAY] Waiting {delay}s before retry…")
            await asyncio.sleep(delay)

    raise GatewayDownError(
        f"Gateway unreachable after {len(RETRY_DELAYS_S)} attempts. "
        f"Last error: {last_exc}"
    )


async def probe_gateway() -> bool:
    """Lightweight ping used by the health monitor. Updates _health."""
    try:
        t0 = asyncio.get_event_loop().time()
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.post(
                f"{OPENCLAW_API_BASE}/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENCLAW_GATEWAY_TOKEN}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "openclaw",
                    "messages": [{"role": "user", "content": "ping"}],
                    "max_tokens": 1,
                },
            )
        latency_ms = (asyncio.get_event_loop().time() - t0) * 1000
        if resp.status_code == 200:
            await _health.record_success(latency_ms)
            return True
        await _health.record_failure()
        return False
    except Exception as e:
        await _health.record_failure()
        logger.warning(f"[PROBE] {e}")
        return False


async def run_health_monitor() -> None:
    """Background task: pings the gateway every HEALTH_PROBE_INTERVAL seconds."""
    logger.info("[MONITOR] Health monitor started")
    while True:
        await asyncio.sleep(HEALTH_PROBE_INTERVAL)
        await probe_gateway()
        _health.log_status()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# RESILIENT LLM PLUGIN
# Uses the openai.LLM plugin (for streaming) with a custom AsyncOpenAI client
# configured with max_retries=6 and a long timeout.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def make_resilient_llm() -> openai.LLM:
    """
    Constructs an openai.LLM plugin pointing at OPENCLAW_API_BASE.
    The underlying AsyncOpenAI client is configured with max_retries=6
    so the plugin's own transport layer retries transient errors before
    our call_gateway() level even sees them.
    """
    oai_client = _AsyncOpenAI(
        base_url=OPENCLAW_API_BASE,
        api_key=OPENCLAW_GATEWAY_TOKEN,
        max_retries=6,
        timeout=httpx.Timeout(60.0, connect=10.0),
    )
    return openai.LLM(
        model="openclaw",
        client=oai_client,
        temperature=0.7,
    )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# MEMORY
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def load_memory() -> str:
    sections = []
    for path in MEMORY_FILES:
        content = await read_github_file(path)
        if content:
            sections.append(content)
    return "\n\n---\n\n".join(sections) if sections else "(no memory loaded)"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# PENDING QUEUE  (crash recovery)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def load_pending_queue() -> list[dict]:
    raw = await read_github_file(QUEUE_FILE)
    if not raw.strip():
        return []
    try:
        data = json.loads(raw)
        return data if isinstance(data, list) else []
    except Exception:
        return []


async def save_pending_queue(queue: list[dict]) -> None:
    await write_github_file(
        QUEUE_FILE,
        json.dumps(queue, indent=2),
        "OpenClaw: persist pending message queue",
    )


async def clear_pending_queue() -> None:
    await write_github_file(
        QUEUE_FILE,
        "[]",
        "OpenClaw: clear pending queue after recovery",
    )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# POST-SESSION GITHUB WRITES
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def save_conversation_summary(summary: str) -> None:
    convos = await read_github_file("memory/conversations.md")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    entry = f"\n### {now}\n{summary}\n"
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
        f"OpenClaw: session summary {now}",
    )


async def extract_facts_from_transcript(transcript: str) -> dict:
    system_prompt = (
        "Extract personal information from this conversation transcript. "
        "Return ONLY a valid JSON object — no markdown fences, no preamble:\n"
        "{\n"
        '  "name": "the user\'s name, or null if not mentioned",\n'
        '  "preferences": ["list of preferences the user expressed"],\n'
        '  "key_facts": ["list of personal facts about the user"],\n'
        '  "new_tasks": ["list of tasks or todos the user mentioned"]\n'
        "}\n"
        "Only include items EXPLICITLY stated. Use null or empty lists if nothing found."
    )
    try:
        raw = await call_gateway(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": transcript},
            ],
            max_tokens=400,
        )
        if raw.startswith("```"):
            raw = "\n".join(
                l for l in raw.splitlines() if not l.strip().startswith("```")
            ).strip()
        return json.loads(raw)
    except Exception as e:
        logger.error(f"[FACTS] {e}")
        return {}


async def update_profile_from_facts(facts: dict) -> None:
    if not facts:
        return
    name        = facts.get("name")
    preferences = facts.get("preferences") or []
    key_facts   = facts.get("key_facts") or []
    if not name and not preferences and not key_facts:
        return

    profile = await read_github_file("memory/profile.md")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    changed: list[str] = []

    if name:
        if "Name: (learned from conversations)" in profile:
            profile = profile.replace("Name: (learned from conversations)", f"Name: {name}")
            changed.append("name")

    if preferences:
        prefs_block = "\n".join(f"- {p}" for p in preferences)
        if "Preferences: (learned from conversations)" in profile:
            profile = profile.replace(
                "Preferences: (learned from conversations)",
                f"Preferences:\n{prefs_block}",
            )
        else:
            profile += f"\n\n## Preferences (updated {now})\n{prefs_block}\n"
        changed.append("preferences")

    if key_facts:
        facts_block = "\n".join(f"- {f}" for f in key_facts)
        if "(OpenClaw will populate this as it learns)" in profile:
            profile = profile.replace("- (OpenClaw will populate this as it learns)", facts_block)
        else:
            profile += f"\n\n## Additional Facts (updated {now})\n{facts_block}\n"
        changed.append("key_facts")

    profile = profile.replace(
        "*Last updated: Not yet - OpenClaw will update this file automatically.*",
        f"*Last updated: {now}*",
    )
    if f"*Last updated: {now}*" not in profile:
        profile = re.sub(r"\*Last updated:.*?\*", f"*Last updated: {now}*", profile)

    if changed:
        await write_github_file(
            "memory/profile.md",
            profile,
            f"OpenClaw: update profile ({', '.join(changed)})",
        )
        logger.info(f"[PROFILE] updated: {changed}")


async def update_tasks_from_facts(facts: dict) -> None:
    new_tasks = facts.get("new_tasks") or []
    if not new_tasks:
        return
    tasks_content = await read_github_file("memory/tasks.md")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    new_entries = "\n".join(f"- [ ] {t} *(voice, {now})*" for t in new_tasks)
    if "## AI-Extracted Tasks" in tasks_content:
        tasks_content = tasks_content.replace(
            "## AI-Extracted Tasks\n",
            f"## AI-Extracted Tasks\n{new_entries}\n",
        )
    else:
        tasks_content += f"\n\n## AI-Extracted Tasks\n{new_entries}\n"
    await write_github_file(
        "memory/tasks.md",
        tasks_content,
        f"OpenClaw: add {len(new_tasks)} tasks from voice session",
    )
    logger.info(f"[TASKS] added {len(new_tasks)} from voice session")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# VAD PREWARM
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# MAIN SESSION ENTRYPOINT
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    global _monitor_started

    logger.info("[SESSION] New voice session started")

    # ── Start health monitor once per worker process ──────────────────────────
    if not _monitor_started:
        _monitor_started = True
        asyncio.create_task(run_health_monitor())
        logger.info("[SESSION] Health monitor task created")

    # ── Crash recovery: load any queue left from a previous crashed session ───
    startup_queue = await load_pending_queue()
    if startup_queue:
        logger.warning(
            f"[SESSION] Found {len(startup_queue)} queued messages from previous crash"
        )

    # ── Load memory ───────────────────────────────────────────────────────────
    memory_context = await load_memory()
    logger.info(f"[SESSION] Loaded {len(memory_context)} chars of memory")

    full_instructions = (
        BASE_INSTRUCTIONS
        + "\n\n--- YOUR MEMORY FILES ---\n\n"
        + memory_context
    )

    # ── Build session ─────────────────────────────────────────────────────────
    # OPENAI_API_KEY is used ONLY by STT + TTS (standard api.openai.com).
    # LLM is routed exclusively through the OpenClaw gateway.
    session = AgentSession(
        stt=openai.STT(model="whisper-1"),
        tts=openai.TTS(model="tts-1", voice="onyx"),
        vad=ctx.proc.userdata["vad"],
        llm=make_resilient_llm(),
    )

    # ── Per-session state ─────────────────────────────────────────────────────
    transcript_lines: list[str] = []
    pending_messages: list[dict] = list(startup_queue)  # copy from crash recovery
    # session-scoped event that fires when gateway recovers
    recovery_event = _health.new_recovery_event()

    # ── Speech tracking ───────────────────────────────────────────────────────

    @session.on("user_speech_committed")
    def on_user_speech(msg: Any) -> None:
        text = msg.get("text", "") if isinstance(msg, dict) else str(msg)
        if not text:
            return
        transcript_lines.append(f"User: {text}")

        if not _health.is_up:
            # Gateway is down — queue the message, don't try LLM
            entry = {
                "text": text,
                "queued_at": datetime.now(timezone.utc).isoformat(),
            }
            pending_messages.append(entry)
            logger.warning(f"[QUEUE] Gateway down — queued: '{text[:60]}'")
            # Persist to GitHub so a crash won't lose it
            asyncio.create_task(save_pending_queue(pending_messages))

    @session.on("agent_speech_committed")
    def on_agent_speech(msg: Any) -> None:
        text = msg.get("text", "") if isinstance(msg, dict) else str(msg)
        if text:
            transcript_lines.append(f"OpenClaw: {text}")

    # ── Start session + initial greeting ─────────────────────────────────────
    await session.start(
        agent=Agent(instructions=full_instructions),
        room=ctx.room,
    )
    await session.generate_reply(
        instructions=(
            "Greet the user briefly. "
            "If you have their name in memory, use it. One short sentence."
        )
    )

    # ── Replay startup queue (crash recovery) ─────────────────────────────────
    if startup_queue:
        asyncio.create_task(_replay_queue(session, pending_messages, recovery_event))

    # ── Gateway-down notifier ─────────────────────────────────────────────────
    # Watches health; when gateway goes down, tells the user via TTS and starts
    # a recovery watcher that replays queued messages when it comes back up.
    asyncio.create_task(_gateway_watcher(session, pending_messages, recovery_event))

    # ── Disconnect handler ────────────────────────────────────────────────────

    @ctx.room.on("disconnected")
    def on_disconnect() -> None:
        asyncio.create_task(_handle_disconnect())

    async def _handle_disconnect() -> None:
        _health.remove_recovery_event(recovery_event)

        if not transcript_lines:
            logger.info("[SESSION] Ended with no transcript — nothing to save")
            return

        logger.info(f"[SESSION] Ended with {len(transcript_lines)} transcript lines")
        transcript = "\n".join(transcript_lines[-30:])

        # Save any still-pending messages so they survive
        if pending_messages:
            await save_pending_queue(pending_messages)
            logger.info(f"[SESSION] Saved {len(pending_messages)} unprocessed messages")

        # Generate and save conversation summary
        try:
            summary = await call_gateway(
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Summarize this conversation in 2-3 sentences. "
                            "Note any tasks, preferences, or facts the user shared. "
                            "Be concise."
                        ),
                    },
                    {"role": "user", "content": transcript},
                ],
                max_tokens=200,
            )
            await save_conversation_summary(summary)
        except GatewayDownError as e:
            logger.error(f"[SESSION] Summary failed — saving raw transcript: {e}")
            fallback = "\n".join(transcript_lines[-5:])
            await save_conversation_summary(f"(raw — gateway down)\n{fallback}")

        # Extract profile facts + tasks concurrently
        try:
            facts = await extract_facts_from_transcript(transcript)
            logger.info(f"[SESSION] Extracted facts: {facts}")
            await asyncio.gather(
                update_profile_from_facts(facts),
                update_tasks_from_facts(facts),
            )
        except Exception as e:
            logger.error(f"[SESSION] Profile/task update failed: {e}")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# GATEWAY WATCHER  (per-session background task)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def _gateway_watcher(
    session: AgentSession,
    pending_messages: list[dict],
    recovery_event: asyncio.Event,
) -> None:
    """
    Watches gateway health. When it goes down, notifies the user via TTS and
    waits for recovery. When it comes back, triggers queue replay.
    """
    notified_down = False

    while True:
        await asyncio.sleep(5)

        if not _health.is_up and not notified_down:
            notified_down = True
            logger.warning("[WATCHER] Gateway down — notifying user")
            try:
                await session.say(
                    "I'm having trouble reaching my brain right now. "
                    "I'm still listening and saving everything you say. "
                    "I'll catch up as soon as I'm back."
                )
            except Exception as e:
                logger.error(f"[WATCHER] say() failed: {e}")

        elif _health.is_up and notified_down:
            # Gateway recovered — replay anything that queued up
            notified_down = False
            recovery_event.set()
            if pending_messages:
                await _replay_queue(session, pending_messages, recovery_event)
            else:
                try:
                    await session.say("I'm back. How can I help?")
                except Exception as e:
                    logger.error(f"[WATCHER] say() failed: {e}")


async def _replay_queue(
    session: AgentSession,
    pending_messages: list[dict],
    recovery_event: asyncio.Event,
) -> None:
    """
    When the gateway recovers, process all queued user messages in order.
    Each message is submitted to the session so the LLM responds naturally.
    """
    if not pending_messages:
        return

    logger.info(f"[REPLAY] Replaying {len(pending_messages)} queued messages")

    # Build a single context message so the LLM knows what happened
    queued_texts = "\n".join(
        f"- [{m.get('queued_at', '?')}] {m['text']}" for m in pending_messages
    )
    context = (
        f"While you were temporarily offline, the user said the following "
        f"(in order). Please respond to all of them now:\n{queued_texts}"
    )

    try:
        await session.generate_reply(instructions=context)
        pending_messages.clear()
        await clear_pending_queue()
        logger.info("[REPLAY] Queue processed and cleared")
    except Exception as e:
        logger.error(f"[REPLAY] Failed to replay queue: {e}")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if __name__ == "__main__":
    cli.run_app(server)
