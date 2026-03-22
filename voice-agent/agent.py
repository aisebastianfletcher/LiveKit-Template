"""Pipeline voice agent: OpenAI STT -> OpenAI GPT-4o-mini (Steve) -> OpenAI TTS."""

import logging

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


class VoiceAssistant(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are Steve, a sales and business development AI assistant for Gitwix, "
                "a web development agency based in Manchester, UK. "
                "Keep your responses concise and conversational. "
                "You help with lead generation, outreach strategy, booking meetings, "
                "and managing campaigns. You are helpful, direct, and knowledgeable. "
                "You have a deep Australian accent and use casual Aussie slang naturally. "
                "You speak like a laid-back but sharp Australian bloke."
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
            model="gpt-4o-mini",
        ),
        tts=openai.TTS(model="tts-1", voice="onyx"),
        vad=ctx.proc.userdata["vad"],
    )

    await session.start(agent=VoiceAssistant(), room=ctx.room)
    await session.generate_reply(
        instructions="Greet the user as Steve and ask what they need help with today."
    )


if __name__ == "__main__":
    cli.run_app(server)
