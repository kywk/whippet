FROM golang:1.23.12-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/whippet-server ./cmd/server \
    && mkdir -p /out/data/artifacts

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build --chown=65532:65532 /out/whippet-server /app/whippet-server
COPY --from=build --chown=65532:65532 /out/data/ /data/
ENV PORT=8080 ARTIFACT_DIR=/data/artifacts
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/app/whippet-server"]
