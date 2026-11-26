ARG WORKER_IMAGE=whippet-worker:adm14
FROM ${WORKER_IMAGE}
COPY provider.mjs /opt/whippet/adm-fixture-provider.mjs
ENV NODE_OPTIONS=--import=/opt/whippet/adm-fixture-provider.mjs
