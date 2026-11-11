# Aelvyril: one container = gateway + built web app + pi.  State lives in /data.
FROM node:26-slim AS build
RUN npm i -g pnpm@10.34.7
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/ui-schema/package.json packages/ui-schema/
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:26-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g pnpm@10.34.7
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/ui-schema/ packages/ui-schema/
COPY apps/gateway/ apps/gateway/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --prod --filter @aelvyril/gateway... \
    && mkdir /data && chown node:node /data
COPY --from=build /app/apps/web/dist apps/web/dist
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# pi comes from the gateway's own pinned dependency (one copy: the CLI and the SDK match).
ENV PATH=/app/apps/gateway/node_modules/.bin:$PATH \
    AELVYRIL_DATA=/data \
    XDG_CONFIG_HOME=/data/config \
    PI_CODING_AGENT_DIR=/data/pi \
    AELVYRIL_WEB=/app/apps/web/dist \
    PORT=3000 HOST=0.0.0.0
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "apps/gateway/src/index.ts"]
