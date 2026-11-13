FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /opt/whippet/worker
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_HTML_OPEN=never \
    WHIPPET_WORK_DIR=/work \
    WHIPPET_TOOL_REGISTRY_PATH=/app/contracts/tools/registry.json \
    WHIPPET_SKILLS_PATH=/opt/whippet/worker/skills \
    NODE_ENV=production

COPY runtimes/worker/package.json runtimes/worker/package-lock.json runtimes/worker/tsconfig.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY runtimes/worker/src ./src
COPY runtimes/worker/skills ./skills
COPY contracts/tools/registry.json /app/contracts/tools/registry.json
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

CMD ["node", "dist/runner.js"]
