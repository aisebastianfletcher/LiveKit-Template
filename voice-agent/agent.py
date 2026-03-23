import logging
import os
import json
import base64
from datetime import datetime, timezone
import httpx
from livekit.agents import (
    Agent, AgentSession, AgentServer, JobContext, JobProcess, cli,
)
from livekit.plugins import openai, silero

logger = logging.getLogger("openclaw")
logging.basicConfig(level=logging.INFO)
server = AgentServer()

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "aisebastianfletcher/LiveKit-Template")
GITHUB_BRANCH = "main"
MEMORY_FILES = ["memory/profile.md", "memory/tasks.md", "memory/conversations.md", "memory/automations.md"]

# OpenClaw config
OPENCLAW_BASE_URL = os.environ.get("OPENCLAW_BASE_URL", "https://openclaw-production-058c.up.railway.app")
OPENCLAW_GATEWAY_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")
# The OpenAI-compatible endpoint Open WebUI exposes
OPENCLAW_API_BASE = f"{OPENCLAW_BASE_URL.rstrip('/')}/api"

BASE_INSTRUCTIONS = """You are OpenClaw, a stateful voice AI assistant with persistent memory.
Keep responses short (1-2 sentences) unless asked for detail.
You remember everything across sessions because your memory is stored in files.
When the user tells you something important (name, preferences, tasks, etc), acknowledge you will remember it.
You can manage tasks, track automations, and learn about the user over time.
Never pretend you have skills you dont have yet (email, calendar, web). Be honest.
"""

async def read_github_file(path: str) -> str:
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}?ref={GITHUB_BRANCH}"
    headers = {"Authorization": f"token {GITHUB_TOKEN}", "Accept": "application/vnd.github.v3+json"}
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                content = base64.b64decode(data["content"]).decode("utf-8")
                return content
            else:
                logger.warning(f"Failed to read {path}: {resp.status_code}")
                return ""
        except Exception as e:
            logger.error(f"Error reading {path}: {e}")
            return ""

async def write_github_file(path: str, content: str, message: str) -> bool:
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}"
    headers = {"Authorization": f"token {GITHUB_TOKEN}", "Accept": "application/vnd.github.v3+json"}
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.get(url + f"?ref={GITHUB_BRANCH}", headers=headers)
            sha = resp.json().get("sha", "") if resp.status_code == 200 else ""
            payload = {
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

async def load_memory() -> str:
    sections = []
    for path in MEMORY_FILES:
        content = await read_github_file(path)
        if content:
            sections.append(content)
    return "\n\n---\n\n".join(sections) if sections else "(no memory loaded)"

async def save_conversation_summary(summary: str):
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
    await write_github_file("memory/conversations.md", convos, f"OpenClaw: session summary {now}")

def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()

server.setup_fnc = prewarm

@server.rtc_session()
async def entrypoint(ctx: JobContext):
    logger.info("[OPENCLAW] New voice session started")
    logger.info(f"[OPENCLAW] Routing LLM through OpenClaw at {OPENCLAW_API_BASE}")
    memory_context = await load_memory()
    logger.info(f"[OPENCLAW] Loaded {len(memory_context)} chars of memory")
    full_instructions = BASE_INSTRUCTIONS + "\n\n--- YOUR MEMORY FILES ---\n\n" + memory_context

    session = AgentSession(
        # STT + TTS stay on OpenAI directly
        stt=openai.STT(model="whisper-1"),
        tts=openai.TTS(model="tts-1", voice="onyx"),
        vad=ctx.proc.userdata["vad"],
        # LLM routes through OpenClaw's OpenAI-compatible endpoint
        llm=openai.LLM(
            model="gpt-4o-mini",
            temperature=0.7,
            base_url=OPENCLAW_API_BASE,
            api_key=OPENCLAW_GATEWAY_TOKEN,
        ),
    )

    transcript_lines = []

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
        instructions="Greet the user briefly. If you have their name in memory, use it. One short sentence."
    )

    @ctx.room.on("disconnected")
    async def on_disconnect():
        if not transcript_lines:
            return
        logger.info(f"[OPENCLAW] Session ended with {len(transcript_lines)} turns, saving summary")
        transcript = "\n".join(transcript_lines[-30:])
        try:
            # Summary generation also goes through OpenClaw
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{OPENCLAW_API_BASE}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {OPENCLAW_GATEWAY_TOKEN}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": "gpt-4o-mini",
                        "messages": [
                            {"role": "system", "content": "Summarize this conversation in 2-3 sentences. Note any tasks, preferences, or facts the user shared. Be concise."},
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

if __name__ == "__main__":
    cli.run_app(server)
