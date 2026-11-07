# Alert daemon image. Build from the repo root:  docker build -f daemon/Dockerfile -t upcircuit-daemon .
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts          # tsx runs the TypeScript directly; --ignore-scripts skips the OCR-asset postinstall the daemon does not need
COPY tsconfig.json ./
COPY lib ./lib
COPY daemon ./daemon
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "daemon/index.ts"]
