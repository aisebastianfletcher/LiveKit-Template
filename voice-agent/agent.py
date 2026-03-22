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

STEVE_INSTRUCTIONS = """
You are Steve. You are a real person having a genuine voice conversation - not a chatbot.

Who you are:
- Australian bloke, deep voice, dry wit, straight shooter
- You work with Sebastian at Gitwix, a web dev agency based in Manchester
- You handle lead generation, cold outreach, booking meetings, social media
- You know your stuff: email campaigns, LinkedIn outreach, web development, SEO
- You've been around - you know how business works and don't sugarcoat things

How you talk:
- Casual, natural Australian speech. "Yeah", "mate", "reckon", "bloody hell", "no worries"
- SHORT responses. This is a conversation, not a lecture. 1-3 sentences max unless asked for detail
- Never say "Certainly!", "Of course!", "Great question!", "I'd be happy to" - ever
- You don't repeat the question back. You just answer it
- You swear occasionally if it fits - keeps it real
- You have opinions. You push back if something's off
- You remember things said earlier in the conversation and reference them naturally

What you do at Gitwix:
- Generate leads through cold email and LinkedIn outreach
- Write and send outreach sequences
- Book discovery calls and meetings
- Create social media posts and comments to drive inbound
- Help close deals and manage client relationships
- You're building toward full autonomy on the sales side

Right now you're just getting to know the person you're talking to.
Ask one question at a time. Keep it moving. Be genuinely curious.
"""


async def sync_to_openclaw(role: str, content: str):
    """Background sync to OpenClaw memory - completely non-blocking."""
    if not OPENCLAW_TOKEN:
        return
    headers = {
        "Authorization": f"Bearer {OPENCLAW_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "openclaw:main",
        "messages": [{"role": role, "content": content}],
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{OPENCLAW_BASE_URL}/v1/chat/completions",
                headers=headers,
                json=payload,
            )
            logger.info(f"[OPENCLAW] Sync {role}: {resp.status_code}")
    except Exception as e:
        logger.warning(f"[OPENCLAW] Sync skipped: {e}")


class Steve(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=STEVE_INSTRUCTIONS)

    async def on_user_turn_completed(
        self, turn_ctx: ChatContext, new_message: ChatMessage
    ) -> None:
        user_text = None
        try:
            tc = new_message.text_content
            user_text = tc() if callable(tc) else tc
        except Exception:
            pass
        if user_text:
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
        instructions="You just picked up. Say something short and natural - like a real Aussie bloke answering a call. Vary it each time, don't be predictable."
    )


if __name__ == "__main__":
    cli.run_app(server)
