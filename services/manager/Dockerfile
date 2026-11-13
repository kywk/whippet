FROM golang:1.27.4-alpine AS build
WORKDIR /src
COPY services/manager/go.mod services/manager/go.sum ./
RUN go mod download
COPY services/manager/cmd ./cmd
COPY services/manager/internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -o /out/whippet-manager ./cmd/manager

FROM alpine:3.23.2
RUN apk add --no-cache ca-certificates docker-cli
COPY --from=build /out/whippet-manager /usr/local/bin/whippet-manager
COPY contracts/tools/registry.json /app/contracts/tools/registry.json
WORKDIR /var/lib/whippet
ENV WORK_DIR=/var/lib/whippet MAX_WORKERS=1 WHIPPET_TOOL_REGISTRY_PATH=/app/contracts/tools/registry.json
ENTRYPOINT ["whippet-manager"]
