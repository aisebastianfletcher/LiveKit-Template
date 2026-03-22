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

If memory context is provided at the start of a message in [Memory: ...], use that naturally - don't mention or read out the memory tag.
"""


async def fetch_openclaw_context(query: str) -> str:
    """Fetch relevant task/memory context from OpenClaw - with strict timeout."""
    if not OPENCLAW_TOKEN:
        return ""
    headers = {
        "Authorization": f"Bearer {OPENCLAW_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "openclaw:main",
        "messages": [
            {
                "role": "user",
                "content": f"In 1-2 sentences max, recall any relevant tasks, updates, or context about: {query}. Reply NONE if nothing relevant."
            }
        ],
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{OPENCLAW_BASE_URL}/v1/chat/completions",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()
            if "NONE" in content.upper() or len(content) < 5:
                return ""
            logger.info(f"[OPENCLAW] Context: {content[:80]}")
            return content
    except Exception as e:
        logger.warning(f"[OPENCLAW] Context fetch skipped: {e}")
        return ""


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
        user_text = None
        try:
            tc = new_message.text_content
            user_text = tc() if callable(tc) else tc
        except Exception:
            pass

        if not user_text:
            return

        logger.info(f"[STEVE] User: {user_text}")

        # Try to pull relevant OpenClaw context (non-blocking, 5s max)
        try:
            context = await asyncio.wait_for(
                fetch_openclaw_context(user_text),
                timeout=5.0
            )
            if context:
                turn_ctx.add_message(
                    role="system",
                    content=f"[Memory: {context}]"
                )
        except asyncio.TimeoutError:
            pass

        # Sync to OpenClaw in background
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
        instructions="You just picked up. Say something short - a natural Aussie greeting. Vary it every time. Don't be predictable. No more than one sentence."
    )


if __name__ == "__main__":
    cli.run_app(server)
