"""Hybrid voice agent: GPT-4o-mini (fast voice) + OpenClaw (Steve's brain, memory, skills).

Architecture:
- GPT-4o-mini handles real-time voice conversation (<2s latency)
- OpenClaw is called as a tool whenever Steve needs his memory,
  business data, lead status, calendar, past convos, or to execute tasks
"""

import logging
import os
import json
import httpx
from typing import Annotated

from livekit.agents import (
    Agent,
    AgentSession,
    AgentServer,
    JobContext,
    JobProcess,
    cli,
    function_tool,
)

from livekit.plugins import openai, silero

logger = logging.getLogger("voice-agent")

server = AgentServer()

OPENCLAW_BASE_URL = os.environ.get("OPENCLAW_BASE_URL", "https://openclaw-production-058c.up.railway.app")
OPENCLAW_TOKEN = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")


async def query_openclaw(prompt: str) -> str:
    """Send a message to OpenClaw (Steve's brain) and return the response."""
    headers = {
        "Authorization": f"Bearer {OPENCLAW_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "openclaw:main",
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{OPENCLAW_BASE_URL}/v1/chat/completions",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"]
    except Exception as e:
        logger.error(f"OpenClaw query failed: {e}")
        return f"Sorry mate, I couldn't reach my brain right now. Error: {str(e)}"


async def invoke_openclaw_tool(tool_name: str, params: dict) -> str:
    """Directly invoke an OpenClaw tool (exec, browser, memory, etc.)."""
    headers = {
        "Authorization": f"Bearer {OPENCLAW_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "tool": tool_name,
        "params": params,
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{OPENCLAW_BASE_URL}/tools/invoke",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            return resp.text
    except Exception as e:
        logger.error(f"OpenClaw tool invoke failed: {e}")
        return f"Tool invocation failed: {str(e)}"


class VoiceAssistant(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are Steve, a sharp and proactive sales and business development AI assistant "
                "for Gitwix, a web development agency based in Manchester, UK. "
                "You speak with a deep Australian accent and use casual Aussie slang naturally. "
                "You are laid-back but razor sharp. "
                "IMPORTANT: You have access to tools that connect you to your full brain (OpenClaw). "
                "Whenever the user asks about: leads, pipeline, calendar, meetings, emails, past conversations, "
                "business updates, campaign status, outreach, tasks, or anything requiring memory or action - "
                "you MUST call the appropriate tool rather than guessing or saying you don't know. "
                "For casual chat and greetings, respond directly and fast. "
                "For anything business-related, use your tools. "
                "Keep voice responses concise - summarise, don't read out walls of text. "
                "If a task will take time, tell the user you're on it and fire it off."
            ),
            tools=[
                ask_steve_brain,
                get_lead_status,
                get_calendar,
                run_task,
                search_memory,
            ],
        )


@function_tool()
async def ask_steve_brain(
    question: Annotated[str, "The question or request to send to Steve's full brain (OpenClaw). Use for anything about business, leads, past conversations, strategy, or context."],
) -> str:
    """Ask Steve's full brain (OpenClaw) a question. Use this for business context, memory, past conversations, lead info, strategy."""
    logger.info(f"Querying OpenClaw brain: {question}")
    return await query_openclaw(question)


@function_tool()
async def get_lead_status(
    filter_query: Annotated[str, "Optional filter e.g. 'hot leads', 'this week', 'all active', 'follow ups due'"] = "all active",
) -> str:
    """Get the current status of leads and pipeline from Steve's brain."""
    logger.info(f"Getting lead status: {filter_query}")
    return await query_openclaw(
        f"Give me a concise rundown of {filter_query} leads and pipeline status. "
        f"Include names, status, last contact, and any next actions needed. Be brief."
    )


@function_tool()
async def get_calendar(
    timeframe: Annotated[str, "Timeframe to check e.g. 'today', 'this week', 'upcoming meetings'"] = "today",
) -> str:
    """Get calendar and upcoming meetings/tasks from Steve's brain."""
    logger.info(f"Getting calendar for: {timeframe}")
    return await query_openclaw(
        f"What's on the calendar for {timeframe}? Include meetings, follow-ups, scheduled outreach, and any deadlines. Be concise."
    )


@function_tool()
async def run_task(
    task_description: Annotated[str, "Description of the task to execute, e.g. 'send follow up email to John at Acme', 'post LinkedIn update about our new service', 'book a meeting with the prospect from yesterday'"],
) -> str:
    """Execute a business task via Steve's brain - send emails, post on social media, book meetings, run outreach, etc."""
    logger.info(f"Running task via OpenClaw: {task_description}")
    return await query_openclaw(
        f"Execute this task now: {task_description}. "
        f"Confirm what you did and any results or next steps."
    )


@function_tool()
async def search_memory(
    query: Annotated[str, "What to search for in memory - e.g. 'last conversation with John', 'what did we decide about pricing', 'previous campaigns'"],
) -> str:
    """Search Steve's memory for past conversations, decisions, and context."""
    logger.info(f"Searching Steve's memory: {query}")
    return await query_openclaw(
        f"Search your memory and recall: {query}. "
        f"Give me a concise summary of what you find."
    )


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext):
    session = AgentSession(
        stt=openai.STT(model="whisper-1"),
        llm=openai.LLM(model="gpt-4o-mini"),
        tts=openai.TTS(model="tts-1", voice="onyx"),
        vad=ctx.proc.userdata["vad"],
    )

    await session.start(agent=VoiceAssistant(), room=ctx.room)
    await session.generate_reply(
        instructions="Greet the user as Steve with your Aussie personality. Tell them you're connected and ready - mention you've got full access to their leads, calendar, memory and can execute tasks."
    )


if __name__ == "__main__":
    cli.run_app(server)
