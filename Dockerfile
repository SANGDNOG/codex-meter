FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node lib ./lib

RUN mkdir -p /data && chown node:node /data

USER node
ENV CODEX_METER_HOST=0.0.0.0 \
    CODEX_METER_PORT=8787 \
    CODEX_METER_STATE=/data/state.json
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bin/server.js"]
