FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim
# OpenClaw voice relay with Redis memory

RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies - resolve fresh since lockfile may be stale
COPY pyproject.toml ./
RUN uv sync --no-install-project

# Download Silero VAD model files
RUN uv run python -c "from livekit.plugins.silero import VAD; VAD.load()" || true

# Copy agent source
COPY . .
RUN uv sync

# Run the OpenClaw voice relay agent
CMD ["uv", "run", "python", "agent.py", "start"]
