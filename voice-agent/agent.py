"""Steve Voice Agent - OpenClaw IS the brain.

OpenClaw generates all responses directly via its /v1/chat/completions endpoint.
LiveKit handles STT (Whisper) and TTS (OpenAI) only.
Steve's personality, memory, and knowledge all come from OpenClaw.
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
            instructions="You are Steve. Keep responses very short - 1 to 2 sentences max. This is a voice call.",
        )


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    logger.info("[ENTRY] New session - OpenClaw is the LLM brain")

    # OpenClaw as the LLM - it has Steve's full personality and memory
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
        instructions="Say g'day. You just picked up a voice call. Be yourself - Steve."
    )


if __name__ == "__main__":
    cli.run_app(server)
