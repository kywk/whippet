FROM golang:1.27.4-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -o /out/whippet-manager ./cmd/manager

FROM alpine:3.23.2
RUN apk add --no-cache ca-certificates docker-cli
COPY --from=build /out/whippet-manager /usr/local/bin/whippet-manager
WORKDIR /var/lib/whippet
ENV WORK_DIR=/var/lib/whippet MAX_WORKERS=1
ENTRYPOINT ["whippet-manager"]
