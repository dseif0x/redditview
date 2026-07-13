# ---- frontend build (arch-independent, runs on the build host) ----
FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- backend build (cross-compiles on the build host) ----
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS backend
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY backend/go.mod ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -ldflags="-s -w" -o /redditview .

# ---- runtime ----
FROM alpine:3.21
RUN apk add --no-cache ca-certificates && adduser -D -H app
COPY --from=backend /redditview /usr/local/bin/redditview
COPY --from=frontend /src/dist /app/static
ENV STATIC_DIR=/app/static PORT=8080
EXPOSE 8080
USER app
ENTRYPOINT ["redditview"]
