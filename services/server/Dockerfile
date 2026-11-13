FROM golang:1.23.12-bookworm AS build
WORKDIR /src
COPY services/server/go.mod services/server/go.sum ./
RUN go mod download
COPY services/server/ .
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/whippet-server ./cmd/server \
    && mkdir -p /out/data/artifacts

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build --chown=65532:65532 /out/whippet-server /app/whippet-server
COPY --from=build --chown=65532:65532 /out/data/ /data/
COPY --chown=65532:65532 contracts/tools/registry.json /app/contracts/tools/registry.json
COPY --chown=65532:65532 runtimes/worker/skills/ /opt/whippet/worker/skills/
ENV PORT=8080 ARTIFACT_DIR=/data/artifacts WHIPPET_TOOL_REGISTRY_PATH=/app/contracts/tools/registry.json WHIPPET_SKILLS_PATH=/opt/whippet/worker/skills
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/app/whippet-server"]
