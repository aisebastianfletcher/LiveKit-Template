"""
OpenClaw Voice Agent
Fixes applied:
  - Fix 5: After session ends, extract profile facts + new tasks from transcript
           and write them back to memory/profile.md and memory/tasks.md
"""

import logging
import os
import json
import base64
import asyncio
from datetime import datetime, timezone
import httpx
from livekit.agents import (
    Agent, AgentSession, AgentServer, JobContext, JobProcess, cli,
)
from livekit.plugins import openai, silero

logger = logging.getLogger("openclaw")
logging.basicConfig(level=logging.INFO)
server = AgentServer()

# ── Environment ────────────────────────────────────────────────────────────────
GITHUB_TOKEN       = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO        = os.environ.get("GITHUB_REPO", "aisebastianfletcher/LiveKit-Template")
GITHUB_BRANCH      = "main"
MEMORY_FILES       = [
    "memory/profile.md",
    "memory/tasks.md",
    "memory/conversations.md",
    "memory/automations.md",
]

OPENCLAW_BASE_URL      = os.environ.get("OPENCLAW_BASE_URL", "https://openclaw-production-058c.up.railway.app")
OPENCLAW_GATEWAY_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")
OPENCLAW_API_BASE      = f"{OPENCLAW_BASE_URL.rstrip('/')}/v1"

# ── Shared prompt ──────────────────────────────────────────────────────────────
BASE_INSTRUCTIONS = """You are OpenClaw, a stateful voice AI assistant with persistent memory.
Keep responses short (1-2 sentences) unless asked for detail.
You remember everything across sessions because your memory is stored in files.
When the user tells you something important (name, preferences, tasks, etc), acknowledge you will remember it.
You can manage tasks, track automations, and learn about the user over time.
Never pretend you have skills you don't have yet (email, calendar, web). Be honest.
"""

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
            else:
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
            else:
                logger.error(f"Failed to write {path}: {resp.status_code} {resp.text}")
                return False
        except Exception as e:
            logger.error(f"Error writing {path}: {e}")
            return False


# ── Memory loading ─────────────────────────────────────────────────────────────
async def load_memory() -> str:
    sections = []
    for path in MEMORY_FILES:
        content = await read_github_file(path)
        if content:
            sections.append(content)
    return "\n\n---\n\n".join(sections) if sections else "(no memory loaded)"


# ── Conversation summary ───────────────────────────────────────────────────────
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


# ── Fix 5: profile fact extraction ────────────────────────────────────────────
async def extract_facts_from_transcript(transcript: str) -> dict:
    """
    Ask OpenClaw to pull structured facts from the session transcript.
    Returns a dict with keys: name, preferences, key_facts, new_tasks.
    """
    system_prompt = (
        "Extract personal information from this conversation transcript. "
        "Return ONLY a valid JSON object — no markdown fences, no preamble:\n"
        "{\n"
        '  "name": "the user\'s name, or null if not mentioned",\n'
        '  "preferences": ["list of preferences the user expressed"],\n'
        '  "key_facts": ["list of personal facts about the user"],\n'
        '  "new_tasks": ["list of tasks or todos the user mentioned"]\n'
        "}\n"
        "Only include items EXPLICITLY stated. Use null or empty lists if nothing was found."
    )
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
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": transcript},
                    ],
                    "max_tokens": 400,
                },
            )
        data = resp.json()
        raw = data["choices"][0]["message"]["content"].strip()

        # Strip markdown fences in case the model adds them anyway
        if raw.startswith("```"):
            lines = raw.splitlines()
            raw = "\n".join(
                l for l in lines
                if not l.strip().startswith("```")
            ).strip()

        return json.loads(raw)
    except Exception as e:
        logger.error(f"Failed to extract facts: {e}")
        return {}


async def update_profile_from_facts(facts: dict) -> None:
    """Merge extracted facts into memory/profile.md."""
    if not facts:
        return

    name       = facts.get("name")
    preferences = facts.get("preferences") or []
    key_facts   = facts.get("key_facts") or []

    if not name and not preferences and not key_facts:
        return  # nothing to write

    profile = await read_github_file("memory/profile.md")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    changed: list[str] = []

    # ── Name ──────────────────────────────────────────────────────────────────
    if name:
        if "Name: (learned from conversations)" in profile:
            profile = profile.replace(
                "Name: (learned from conversations)",
                f"Name: {name}",
            )
            changed.append("name")
        elif f"Name: {name}" not in profile:
            # Name is already set to something; don't overwrite
            pass

    # ── Preferences ───────────────────────────────────────────────────────────
    if preferences:
        prefs_block = "\n".join(f"- {p}" for p in preferences)
        if "Preferences: (learned from conversations)" in profile:
            profile = profile.replace(
                "Preferences: (learned from conversations)",
                f"Preferences:\n{prefs_block}",
            )
            changed.append("preferences")
        else:
            profile += f"\n\n## Preferences (updated {now})\n{prefs_block}\n"
            changed.append("preferences")

    # ── Key facts ─────────────────────────────────────────────────────────────
    if key_facts:
        facts_block = "\n".join(f"- {f}" for f in key_facts)
        if "(OpenClaw will populate this as it learns)" in profile:
            profile = profile.replace(
                "- (OpenClaw will populate this as it learns)",
                facts_block,
            )
            changed.append("key_facts")
        else:
            profile += f"\n\n## Additional Facts (updated {now})\n{facts_block}\n"
            changed.append("key_facts")

    # ── Timestamp ─────────────────────────────────────────────────────────────
    profile = profile.replace(
        "*Last updated: Not yet - OpenClaw will update this file automatically.*",
        f"*Last updated: {now}*",
    )
    # If that placeholder is already gone, update the existing timestamp line
    if f"*Last updated: {now}*" not in profile:
        import re
        profile = re.sub(
            r"\*Last updated:.*?\*",
            f"*Last updated: {now}*",
            profile,
        )

    if changed:
        await write_github_file(
            "memory/profile.md",
            profile,
            f"OpenClaw: update profile ({', '.join(changed)})",
        )
        logger.info(f"[OPENCLAW] Profile updated: {changed}")


async def update_tasks_from_facts(facts: dict) -> None:
    """Append AI-extracted tasks to memory/tasks.md (human-readable section only)."""
    new_tasks = facts.get("new_tasks") or []
    if not new_tasks:
        return

    tasks_content = await read_github_file("memory/tasks.md")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    new_entries = "\n".join(f"- [ ] {t} *(voice, {now})*" for t in new_tasks)

    # Append to existing section or create it
    if "## AI-Extracted Tasks" in tasks_content:
        # Insert after the section header
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
    logger.info(f"[OPENCLAW] Added {len(new_tasks)} tasks to tasks.md")


# ── VAD prewarm ───────────────────────────────────────────────────────────────
def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


# ── Main session entrypoint ───────────────────────────────────────────────────
@server.rtc_session()
async def entrypoint(ctx: JobContext):
    logger.info("[OPENCLAW] New voice session started")
    logger.info(f"[OPENCLAW] Routing LLM through OpenClaw at {OPENCLAW_API_BASE}")

    memory_context = await load_memory()
    logger.info(f"[OPENCLAW] Loaded {len(memory_context)} chars of memory")

    full_instructions = (
        BASE_INSTRUCTIONS
        + "\n\n--- YOUR MEMORY FILES ---\n\n"
        + memory_context
    )

    session = AgentSession(
        stt=openai.STT(model="whisper-1"),
        tts=openai.TTS(model="tts-1", voice="onyx"),
        vad=ctx.proc.userdata["vad"],
        llm=openai.LLM(
            model="openclaw",
            temperature=0.7,
            base_url=OPENCLAW_API_BASE,
            api_key=OPENCLAW_GATEWAY_TOKEN,
        ),
    )

    transcript_lines: list[str] = []

    @session.on("user_speech_committed")
    def on_user_speech(msg):
        text = msg.get("text", "") if isinstance(msg, dict) else str(msg)
        if text:
            transcript_lines.append(f"User: {text}")

    @session.on("agent_speech_committed")
    def on_agent_speech(msg):
        text = msg.get("text", "") if isinstance(msg, dict) else str(msg)
        if text:
            transcript_lines.append(f"OpenClaw: {text}")

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

    @ctx.room.on("disconnected")
    def on_disconnect():
              asyncio.create_task(_handle_disconnect())

      async def _handle_disconnect():
        if not transcript_lines:
            return

        logger.info(
            f"[OPENCLAW] Session ended with {len(transcript_lines)} turns"
        )
        transcript = "\n".join(transcript_lines[-30:])

        # ── Step 1: Generate summary ──────────────────────────────────────────
        summary: str = ""
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
                                    "Summarize this conversation in 2-3 sentences. "
                                    "Note any tasks, preferences, or facts the user shared. "
                                    "Be concise."
                                ),
                            },
                            {"role": "user", "content": transcript},
                        ],
                        "max_tokens": 200,
                    },
                )
            data = resp.json()
            summary = data["choices"][0]["message"]["content"]
            await save_conversation_summary(summary)
        except Exception as e:
            logger.error(f"Failed to summarize: {e}")
            fallback = "\n".join(transcript_lines[-5:])
            await save_conversation_summary(f"(raw) {fallback}")

        # ── Fix 5: Extract profile facts + tasks ─────────────────────────────
        try:
            facts = await extract_facts_from_transcript(transcript)
            logger.info(f"[OPENCLAW] Extracted facts: {facts}")
            # Run both writes concurrently to save time
            await asyncio.gather(
                update_profile_from_facts(facts),
                update_tasks_from_facts(facts),
            )
        except Exception as e:
            logger.error(f"[OPENCLAW] Failed to update profile/tasks: {e}")


if __name__ == "__main__":
    cli.run_app(server)
