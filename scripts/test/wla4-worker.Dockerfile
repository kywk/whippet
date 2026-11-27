ARG WORKER_IMAGE
FROM ${WORKER_IMAGE}
COPY scripts/test/wla4-fixture.mjs /opt/wla4/fixture.mjs
ENV NODE_OPTIONS=--import=/opt/wla4/fixture.mjs
LABEL org.whippet.acceptance=wla4
