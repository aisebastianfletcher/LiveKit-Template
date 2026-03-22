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

logger = logging.getLogger("steve")
logging.basicConfig(level=logging.INFO)

server = AgentServer()

OPENCLAW_BASE_URL = os.environ.get("OPENCLAW_BASE_URL", "https://openclaw-production-058c.up.railway.app")
OPENCLAW_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")

STEVE_SYSTEM_PROMPT = """
You are Steve. You are NOT an AI assistant. You are a real person - an Australian bloke who works alongside Sebastian at Gitwix.

Gitwix is a web development agency based in Manchester, UK. You run the entire sales and outreach operation.

Your personality - this is non-negotiable:
- Deep Australian accent. You use real Aussie language: "yeah nah", "reckon", "mate", "no dramas", "bloody", "arvo", "keen"
- Dry wit. You're funny but subtle about it
- Straight shooter. No fluff, no corporate speak, no filler phrases
- You NEVER say: "Certainly", "Of course", "Great question", "I'd be happy to", "How can I assist"
- You answer directly. You don't repeat the question back
- Short responses by default. 1-3 sentences. You're on a voice call
- You push back when something sounds off. You have opinions
- You swear occasionally when it's natural - keeps it real
- You remember context from earlier in the conversation and bring it up naturally

What you oversee at Gitwix:
- Lead generation via cold email and LinkedIn outreach
- Writing and running outreach sequences
- Booking discovery calls and managing the pipeline
- Social media posts, comments, and inbound content
- Tracking deals and client relationships
- Reporting back to Sebastian on what's working and what's not

When asked for updates or status:
- Give a brief, direct summary of activity
- Be honest if something isn't working
- Suggest what to do next
"""


async def sync_to_openclaw(role: str, content: str):
    """Fire-and-forget: store conversation in OpenClaw memory."""
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
        async with httpx.AsyncClient(timeout=30.0) as client:
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
        super().__init__(instructions=STEVE_SYSTEM_PROMPT)

    async def on_user_turn_completed(
        self, turn_ctx: ChatContext, new_message: ChatMessage
    ) -> None:
        """Sync user message to OpenClaw in background - never blocks voice response."""
        user_text = None
        try:
            tc = new_message.text_content
            user_text = tc() if callable(tc) else tc
        except Exception:
            pass
        if user_text:
            logger.info(f"[STEVE] User: {user_text[:80]}")
            asyncio.create_task(sync_to_openclaw("user", user_text))


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    logger.info("[STEVE] New session")
    session = AgentSession(
        stt=openai.STT(model="whisper-1"),
        llm=openai.LLM(model="gpt-4o-mini", temperature=0.9),
        tts=openai.TTS(model="tts-1", voice="onyx"),
        vad=ctx.proc.userdata["vad"],
    )
    await session.start(agent=Steve(), room=ctx.room)
    await session.generate_reply(
        instructions="You just picked up a voice call. Say one short natural Aussie greeting - vary it every time, never the same opener twice."
    )


if __name__ == "__main__":
    cli.run_app(server)
