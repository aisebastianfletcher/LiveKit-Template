"""Hybrid voice agent: GPT-4o-mini for fast voice + OpenClaw memory sync.
# v2 - force deploy

Architecture:
- GPT-4o-mini handles real-time voice (<2s latency)
- on_user_turn_completed: fetches context from OpenClaw before replying
- Syncs each user message to OpenClaw in background
- Steve's memory persists across sessions via OpenClaw
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


async def sync_to_openclaw(user_msg: str):
    """Fire-and-forget: send the user message to OpenClaw so it stores in memory."""
    logger.info(f"[OPENCLAW SYNC] Sending user message to OpenClaw: {user_msg[:80]}")
    headers = {
        "Authorization": f"Bearer {OPENCLAW_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "openclaw:main",
        "messages": [
            {"role": "user", "content": user_msg},
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
            logger.info(f"[OPENCLAW SYNC] Success! Status: {resp.status_code}")
    except Exception as e:
        logger.error(f"[OPENCLAW SYNC] Failed: {e}")


async def fetch_openclaw_context(query: str) -> str:
    """Ask OpenClaw for context/memory relevant to user query."""
    logger.info(f"[OPENCLAW FETCH] Fetching context for: {query[:80]}")
    headers = {
        "Authorization": f"Bearer {OPENCLAW_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "openclaw:main",
        "messages": [
            {
                "role": "user",
                "content": f"Briefly recall any relevant context about: {query}. 1-2 sentences max. Say NONE if nothing relevant.",
            },
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
            logger.info(f"[OPENCLAW FETCH] Got response: {content[:100]}")
            if "NONE" in content.upper() or len(content.strip()) < 5:
                return ""
            return content
    except Exception as e:
        logger.error(f"[OPENCLAW FETCH] Failed: {e}")
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
                "and managing campaigns. You are helpful, direct, and knowledgeable. "
                "When context from your memory is injected, use it naturally in your response."
            ),
        )

    async def on_user_turn_completed(
        self, turn_ctx: ChatContext, new_message: ChatMessage
    ) -> None:
        """Before agent replies: fetch context from OpenClaw and inject it."""
        logger.info("[HOOK] on_user_turn_completed fired!")
        # Handle both property and method access for text_content
        user_text = None
        try:
            tc = new_message.text_content
            if callable(tc):
                user_text = tc()
            else:
                user_text = tc
        except Exception as e:
            logger.error(f"[HOOK] Error getting text_content: {e}")

        logger.info(f"[HOOK] User said: {user_text}")

        if user_text:
            # Fetch context from OpenClaw (with timeout protection)
            try:
                context = await asyncio.wait_for(
                    fetch_openclaw_context(user_text), timeout=8.0
                )
                if context:
                    turn_ctx.add_message(
                        role="assistant",
                        content=f"[Memory context: {context}]"
                    )
                    logger.info(f"[HOOK] Injected memory context into turn")
            except asyncio.TimeoutError:
                logger.warning("[HOOK] OpenClaw context fetch timed out")
            except Exception as e:
                logger.error(f"[HOOK] Context fetch error: {e}")

            # Fire-and-forget: sync this user message to OpenClaw
            asyncio.create_task(sync_to_openclaw(user_text))


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    logger.info("[ENTRYPOINT] New session starting")
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
