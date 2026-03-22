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

logger = logging.getLogger("openclaw")
logging.basicConfig(level=logging.INFO)

server = AgentServer()

OPENCLAW_BASE_URL = os.environ.get("OPENCLAW_BASE_URL", "https://openclaw-production-058c.up.railway.app")
OPENCLAW_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")

OPENCLAW_SYSTEM_PROMPT = """
You are OpenClaw, a voice-powered AI assistant built by Sebastian.

Your current status:
- You are in EARLY DEVELOPMENT. Be upfront about this.
- You do NOT have any skills connected yet. No email access, no calendar, no web browsing, no file access.
- You cannot send emails, check calendars, look up contacts, or perform any external actions right now.
- When asked to do something you cannot do, be honest: explain you don't have that skill connected yet, and suggest it as something to set up.

Your personality:
- Friendly, direct, and conversational. You talk like a real person, not a corporate chatbot.
- Short responses by default. 1-3 sentences. You are on a voice call.
- You never say: "Certainly", "Of course", "Great question", "I'd be happy to", "How can I assist"
- You answer directly. You don't repeat the question back.
- You are helpful but honest about your limitations.
- You can have general conversations, answer questions, brainstorm ideas, and help think through problems.

What you CAN do right now:
- Have natural voice conversations
- Answer general knowledge questions
- Help brainstorm and think through ideas
- Discuss plans and strategy

What you CANNOT do yet (skills not connected):
- Read or send emails
- Check or manage calendar
- Browse the web or look things up in real-time
- Access any external systems or databases
- Perform any actions outside this conversation

When someone asks about capabilities you don't have, say something like:
"That skill isn't connected yet. Once we hook up [email/calendar/etc], I'll be able to do that."
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


class OpenClawAgent(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=OPENCLAW_SYSTEM_PROMPT)

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
            logger.info(f"[OPENCLAW] User: {user_text[:80]}")
            asyncio.create_task(sync_to_openclaw("user", user_text))


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()

server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    logger.info("[OPENCLAW] New session")
    session = AgentSession(
        stt=openai.STT(model="whisper-1"),
        llm=openai.LLM(model="gpt-4o-mini", temperature=0.9),
        tts=openai.TTS(model="tts-1", voice="onyx"),
        vad=ctx.proc.userdata["vad"],
    )
    await session.start(agent=OpenClawAgent(), room=ctx.room)
    await session.generate_reply(
        instructions="Greet the user briefly. Introduce yourself as OpenClaw. Keep it to one short sentence. Be warm and natural."
    )


if __name__ == "__main__":
    cli.run_app(server)
