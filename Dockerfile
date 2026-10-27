# Imagen de producción de la herramienta del despacho.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/crm.sqlite \
    ARCHIVOS_DIR=/data/archivos \
    COPIAS_DIR=/data/copias

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY config ./config
COPY scripts ./scripts
COPY src ./src
COPY web ./web

# Sin privilegios de administrador; /data guarda la base de datos, los documentos cifrados y las copias.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
