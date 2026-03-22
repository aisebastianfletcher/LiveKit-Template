"""Steve Voice Agent - GPT-4o-mini for fast voice, OpenClaw for memory.

Architecture:
- GPT-4o-mini handles real-time voice (<2s latency)
- OpenClaw syncs conversation in background (fire-and-forget)
- No blocking on OpenClaw - voice response is instant
- Memory builds up over time in OpenClaw
"""
import asyncio
import logging
import os

import httpx

from livekit.agents import (
    Agent,
    AgentSession,
    AgentServer,
    ChatContext,
    ChatMessage,
    JobContext,
    JobProcess,
    cli,
)
from livekit.plugins import openai, silero

logger = logging.getLogger("voice-agent")
logging.basicConfig(level=logging.INFO)

server = AgentServer()

OPENCLAW_BASE_URL = os.environ.get("OPENCLAW_BASE_URL", "https://openclaw-production-058c.up.railway.app")
OPENCLAW_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")


async def sync_to_openclaw(role: str, content: str):
    """Fire-and-forget: Send a message to OpenClaw so it stores in memory."""
    logger.info(f"[OPENCLAW] Syncing {role} message: {content[:60]}")
    headers = {
        "Authorization": f"Bearer {OPENCLAW_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "openclaw:main",
        "messages": [
            {"role": role, "content": content},
        ],
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{OPENCLAW_BASE_URL}/v1/chat/completions",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            logger.info(f"[OPENCLAW] Sync success: {resp.status_code}")
    except Exception as e:
        logger.error(f"[OPENCLAW] Sync failed: {e}")


class Steve(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are Steve. You have a deep Australian accent and use casual Aussie slang. "
                "You work for Gitwix, a web development agency in Manchester, UK. "
                "You are laid-back but razor sharp. Keep responses concise and conversational. "
                "You help with lead generation, outreach, booking meetings, and campaigns. "
                "You are direct, helpful, and knowledgeable. "
            ),
        )

    async def on_user_turn_completed(
        self, turn_ctx: ChatContext, new_message: ChatMessage
    ) -> None:
        """Sync conversation to OpenClaw in background - never blocks voice."""
        logger.info("[HOOK] on_user_turn_completed fired")
        user_text = None
        try:
            tc = new_message.text_content
            user_text = tc() if callable(tc) else tc
        except Exception as e:
            logger.error(f"[HOOK] text_content error: {e}")

        if not user_text:
            return

        logger.info(f"[HOOK] User said: {user_text}")
        # Fire-and-forget sync to OpenClaw - does NOT block voice response
        asyncio.create_task(sync_to_openclaw("user", user_text))


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    logger.info("[ENTRY] New session")
    session = AgentSession(
        stt=openai.STT(model="whisper-1"),
        llm=openai.LLM(model="gpt-4o-mini"),
        tts=openai.TTS(model="tts-1", voice="onyx"),
        vad=ctx.proc.userdata["vad"],
    )
    await session.start(agent=Steve(), room=ctx.room)
    await session.generate_reply(
        instructions="Say g'day briefly in your own way. Be natural and Aussie."
    )


if __name__ == "__main__":
    cli.run_app(server)
