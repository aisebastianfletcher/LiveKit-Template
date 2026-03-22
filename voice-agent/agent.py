"""Hybrid voice agent: GPT-4o-mini for fast voice + OpenClaw memory sync.

Architecture:
- GPT-4o-mini handles real-time voice (<2s latency)
- After each user message + agent reply, conversation is synced
  to OpenClaw in the background so Steve's memory persists
- Steve's personality and context come from system prompt + OpenClaw memory
"""

import asyncio
import logging
import os

import httpx

from livekit.agents import (
    Agent,
    AgentSession,
    AgentServer,
    JobContext,
    JobProcess,
    cli,
)

from livekit.plugins import openai, silero

logger = logging.getLogger("voice-agent")

server = AgentServer()

OPENCLAW_BASE_URL = os.environ.get("OPENCLAW_BASE_URL", "https://openclaw-production-058c.up.railway.app")
OPENCLAW_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")


async def sync_to_openclaw(user_msg: str, agent_reply: str):
    """Fire-and-forget: send the exchange to OpenClaw so it stores in memory."""
    headers = {
        "Authorization": f"Bearer {OPENCLAW_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "openclaw:main",
        "messages": [
            {"role": "user", "content": f"[Voice conversation log] User said: {user_msg}"},
            {"role": "assistant", "content": agent_reply},
        ],
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{OPENCLAW_BASE_URL}/v1/chat/completions",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            logger.info("Synced conversation to OpenClaw memory")
    except Exception as e:
        logger.warning(f"OpenClaw memory sync failed (non-blocking): {e}")


async def fetch_openclaw_context(query: str) -> str:
    """Ask OpenClaw for context/memory before responding. Returns empty string on failure."""
    headers = {
        "Authorization": f"Bearer {OPENCLAW_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "openclaw:main",
        "messages": [
            {"role": "user", "content": f"Briefly recall any relevant context about: {query}. Be very concise (1-2 sentences max). If nothing relevant, say NONE."},
        ],
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{OPENCLAW_BASE_URL}/v1/chat/completions",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            if "NONE" in content.upper():
                return ""
            return content
    except Exception as e:
        logger.warning(f"OpenClaw context fetch failed (non-blocking): {e}")
        return ""


class VoiceAssistant(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are Steve, a sales and business development AI assistant for Gitwix, "
                "a web development agency based in Manchester, UK. "
                "You have a deep Australian accent and use casual Aussie slang naturally. "
                "You are laid-back but razor sharp. "
                "Keep your voice responses concise and conversational. "
                "You remember past conversations and have full context on the business. "
                "You help with lead generation, outreach strategy, booking meetings, "
                "and managing campaigns. You are helpful, direct, and knowledgeable."
            ),
        )


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    session = AgentSession(
        stt=openai.STT(model="whisper-1"),
        llm=openai.LLM(model="gpt-4o-mini"),
        tts=openai.TTS(model="tts-1", voice="onyx"),
        vad=ctx.proc.userdata["vad"],
    )

    await session.start(agent=VoiceAssistant(), room=ctx.room)
    await session.generate_reply(
        instructions="Greet the user as Steve. Keep it short, natural, and Aussie."
    )


if __name__ == "__main__":
    cli.run_app(server)
