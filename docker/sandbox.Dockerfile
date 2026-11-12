# What a project's sandbox runs: Node, Python and git, as the unprivileged "node" user (uid 1000). No secrets in here, ever.
FROM node:26-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl python3 python3-pip python3-venv procps ripgrep jq unzip less \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g pnpm@10 \
    && mkdir /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
