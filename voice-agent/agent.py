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

logger = logging.getLogger("openclaw")
logging.basicConfig(level=logging.INFO)

server = AgentServer()

INSTRUCTIONS = """You are OpenClaw, a voice AI assistant. Keep responses very short (1-2 sentences). You are in early development. You do NOT have any skills connected yet - no email, no calendar, no web access. Be honest about this. You can only have voice conversations right now. Never pretend you have done tasks or have access to systems you don't."""


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    logger.info("[OPENCLAW] New voice session started")

    session = AgentSession(
        stt=openai.STT(model="whisper-1"),
        llm=openai.LLM(model="gpt-4o-mini", temperature=0.7),
        tts=openai.TTS(model="tts-1", voice="onyx"),
        vad=ctx.proc.userdata["vad"],
    )

    await session.start(
        agent=Agent(instructions=INSTRUCTIONS),
        room=ctx.room,
    )

    await session.generate_reply(
        instructions="Say hello briefly. One short sentence."
    )


if __name__ == "__main__":
    cli.run_app(server)
