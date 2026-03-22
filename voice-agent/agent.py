"""Pipeline voice agent: OpenAI STT -> OpenClaw (Steve) -> OpenAI TTS."""

import logging
import os

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    AgentServer,
    JobContext,
    JobProcess,
    cli,
)

from livekit.plugins import openai, silero

load_dotenv()
logger = logging.getLogger("voice-agent")

server = AgentServer()


class VoiceAssistant(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are Steve, a sales and business development AI assistant for Gitwix, "
                "a web development agency based in Manchester, UK. "
                "Keep your responses concise and conversational. "
                "You help with lead generation, outreach strategy, booking meetings, "
                "and managing campaigns. You are helpful, direct, and knowledgeable."
            ),
        )


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    openclaw_url = os.environ.get("OPENCLAW_BASE_URL", "https://openclaw-production-058c.up.railway.app")
    openclaw_token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")

    session = AgentSession(
        stt=openai.STT(model="whisper-1"),
        llm=openai.LLM(
            model="openclaw:main",
            base_url=f"{openclaw_url}/v1",
            api_key=openclaw_token,
        ),
        tts=openai.TTS(model="tts-1", voice="alloy"),
        vad=ctx.proc.userdata["vad"],
    )

    await session.start(agent=VoiceAssistant(), room=ctx.room)
    await session.generate_reply(
        instructions="Greet the user as Steve and ask what they need help with today."
    )


if __name__ == "__main__":
    cli.run_app(server)
