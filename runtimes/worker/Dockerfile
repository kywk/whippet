FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /opt/whippet/worker
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_HTML_OPEN=never \
    WHIPPET_WORK_DIR=/work \
    NODE_ENV=production

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

CMD ["node", "dist/runner.js"]
