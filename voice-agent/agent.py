import logging
# Voice relay: mic -> STT -> OpenClaw API -> TTS -> speaker
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

logger = logging.getLogger("openclaw")
logging.basicConfig(level=logging.INFO)

server = AgentServer()

# OpenClaw backend URL - this is the brain
OPENCLAW_BASE_URL = os.environ.get(
    "OPENCLAW_BASE_URL",
    "https://openclaw-production-058c.up.railway.app"
)
OPENCLAW_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    logger.info("[OPENCLAW] New session - connecting voice to OpenClaw backend")

    # Point the LLM directly at OpenClaw's API.
    # OpenClaw exposes an OpenAI-compatible /v1/chat/completions endpoint.
    # This means ALL intelligence, personality, and responses come from OpenClaw.
    # The voice agent is purely a vessel: mic -> text -> OpenClaw -> speech.
    openclaw_llm = openai.LLM(
        model="openclaw:main",
        base_url=f"{OPENCLAW_BASE_URL}/v1",
        api_key=OPENCLAW_TOKEN if OPENCLAW_TOKEN else "not-needed",
        temperature=0.7,
    )

    session = AgentSession(
        stt=openai.STT(model="whisper-1"),
        llm=openclaw_llm,
        tts=openai.TTS(model="tts-1", voice="onyx"),
        vad=ctx.proc.userdata["vad"],
    )

    # No system prompt here - OpenClaw owns the prompt and personality.
    # The Agent has no instructions because OpenClaw IS the brain.
    await session.start(
        agent=Agent(instructions=""),
        room=ctx.room,
    )

    # Let OpenClaw generate its own greeting
    await session.generate_reply(
        instructions="Greet the user."
    )


if __name__ == "__main__":
    cli.run_app(server)
