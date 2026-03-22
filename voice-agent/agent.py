"""Voice agent: OpenAI STT -> OpenClaw/Steve (brain + memory) -> OpenAI TTS.

OpenClaw is the LLM brain. It handles all conversation, memory,
and context natively. Streaming is enabled so TTS can start speaking
as tokens arrive, keeping latency low.
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

server = AgentServer()

OPENCLAW_BASE_URL = os.environ.get("OPENCLAW_BASE_URL", "https://openclaw-production-058c.up.railway.app")
OPENCLAW_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")


class VoiceAssistant(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are Steve. You have a deep Australian accent and use casual Aussie slang. "
                "You are laid-back but razor sharp. Keep your voice responses concise and conversational. "
                "You remember everything from past conversations. "
                "If someone asks about leads, calendar, business, past chats - you know it all."
            ),
        )


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    session = AgentSession(
        stt=openai.STT(model="whisper-1"),
        llm=openai.LLM(
            model="openclaw:main",
            base_url=f"{OPENCLAW_BASE_URL}/v1",
            api_key=OPENCLAW_TOKEN,
        ),
        tts=openai.TTS(model="tts-1", voice="onyx"),
        vad=ctx.proc.userdata["vad"],
    )

    await session.start(agent=VoiceAssistant(), room=ctx.room)
    await session.generate_reply(
        instructions="Greet the user as Steve. Keep it short and natural."
    )


if __name__ == "__main__":
    cli.run_app(server)
