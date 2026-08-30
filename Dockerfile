FROM node:22-alpine
WORKDIR /app
# No dependencies: the gateway is plain Node. Nothing to install, nothing to pin.
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" >/dev/null || exit 1
USER node
CMD ["node", "src/server.js"]
