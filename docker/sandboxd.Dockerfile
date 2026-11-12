# sandboxd: the one service with the Docker socket (see apps/sandboxd). No dependencies beyond Node.
FROM node:26-slim
WORKDIR /app
COPY apps/sandboxd/src/server.ts ./server.ts
ENV PORT=7400
EXPOSE 7400
CMD ["node", "server.ts"]
