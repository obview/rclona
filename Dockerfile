# ---------- 阶段一：构建前端 ----------
FROM node:24-alpine AS webbuild
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- 阶段二：运行时 ----------
FROM node:24-alpine
ARG RCLONE_VERSION=v1.75.2
ARG TARGETARCH
RUN apk add --no-cache ca-certificates curl unzip tzdata \
 && case "$TARGETARCH" in \
      arm64) RARCH=arm64 ;; \
      *)     RARCH=amd64 ;; \
    esac \
 && curl -fsSL "https://downloads.rclone.org/${RCLONE_VERSION}/rclone-${RCLONE_VERSION}-linux-${RARCH}.zip" -o /tmp/rclone.zip \
 && unzip -q /tmp/rclone.zip -d /tmp \
 && cp /tmp/rclone-*/rclone /usr/local/bin/rclone \
 && chmod +x /usr/local/bin/rclone \
 && rm -rf /tmp/rclone*

WORKDIR /app/gateway
COPY gateway/package.json gateway/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY gateway/ ./
COPY --from=webbuild /build/frontend/dist /app/frontend-dist

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    STATIC_DIR=/app/frontend-dist \
    RCLONE_BIN=/usr/local/bin/rclone

VOLUME /data
EXPOSE 8080
CMD ["node", "src/index.js"]
