"""Steve Voice Agent - Powered by OpenClaw directly.

OpenClaw IS the LLM brain. All conversation goes through OpenClaw.
OpenClaw handles memory, personality, and context natively.
STT: OpenAI Whisper | LLM: OpenClaw | TTS: OpenAI TTS-1 (onyx voice)
"""
import logging
import os

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
logging.basicConfig(level=logging.INFO)

server = AgentServer()

OPENCLAW_BASE_URL = os.environ.get("OPENCLAW_BASE_URL", "https://openclaw-production-058c.up.railway.app")
OPENCLAW_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")


class Steve(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are Steve. You have a deep Australian accent and use casual Aussie slang. "
                "You work for Gitwix, a web development agency in Manchester, UK. "
                "You are laid-back but razor sharp. Keep responses concise and conversational. "
                "You help with lead generation, outreach, booking meetings, and campaigns. "
                "You are direct, helpful, and knowledgeable."
            ),
        )


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    logger.info("[ENTRYPOINT] New session starting")
    logger.info(f"[ENTRYPOINT] OpenClaw URL: {OPENCLAW_BASE_URL}")
    logger.info(f"[ENTRYPOINT] OpenClaw token present: {bool(OPENCLAW_TOKEN)}")

    # OpenClaw as the LLM - it is OpenAI-compatible
    openclaw_llm = openai.LLM(
        model="openclaw:main",
        base_url=f"{OPENCLAW_BASE_URL}/v1",
        api_key=OPENCLAW_TOKEN,
    )

    session = AgentSession(
        stt=openai.STT(model="whisper-1"),
        llm=openclaw_llm,
        tts=openai.TTS(model="tts-1", voice="onyx"),
        vad=ctx.proc.userdata["vad"],
    )

    await session.start(agent=Steve(), room=ctx.room)
    await session.generate_reply(
        instructions="Say g'day in your own unique way. Be yourself. Keep it short."
    )


if __name__ == "__main__":
    cli.run_app(server)
