# Outer agent runner: only agent/ is mounted from the host.
FROM node:22.13-bookworm-slim

RUN useradd -m -u 10001 trench \
  && mkdir -p /workspace/agent \
  && chown -R trench:trench /workspace

USER trench
WORKDIR /workspace/agent

# Immutable image content only; host mounts ./agent -> /workspace/agent
ENV HOME=/home/trench
ENV TMPDIR=/workspace/agent/.tmp-denied
# Tool env must be scrubbed by the supervisor; no secrets in the image.

CMD ["sleep", "infinity"]
