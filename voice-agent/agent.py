"""Hybrid voice agent: GPT-4o-mini for fast voice + OpenClaw memory sync.

Architecture:
- GPT-4o-mini handles real-time voice (<2s latency)
- on_user_turn_completed: fetches context from OpenClaw before replying
- conversation_item_added event: syncs each exchange to OpenClaw in background
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
            logger.info("Synced user message to OpenClaw memory")
    except Exception as e:
        logger.warning(f"OpenClaw memory sync failed (non-blocking): {e}")


async def fetch_openclaw_context(query: str) -> str:
    """Ask OpenClaw for context/memory. Returns empty string on failure or timeout."""
    headers = {
        "Authorization": f"Bearer {OPENCLAW_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "openclaw:main",
        "messages": [
            {"role": "user", "content": f"[INTERNAL CONTEXT REQUEST - do not speak this aloud] Briefly recall any relevant context about: {query}. 1-2 sentences max. Say NONE if nothing relevant."},
        ],
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.post(
                f"{OPENCLAW_BASE_URL}/v1/chat/completions",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            if "NONE" in content.upper() or len(content.strip()) < 5:
                return ""
            return content
    except Exception as e:
        logger.warning(f"OpenClaw context fetch failed: {e}")
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
        user_text = new_message.text_content
        if user_text:
            context = await fetch_openclaw_context(user_text)
            if context:
                turn_ctx.add_message(
                    role="assistant",
                    content=f"[Memory context: {context}]"
                )
            # Fire-and-forget: sync this user message to OpenClaw
            asyncio.create_task(sync_to_openclaw(user_text, ""))


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
