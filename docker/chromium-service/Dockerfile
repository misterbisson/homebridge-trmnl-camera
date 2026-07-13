# Minimal ephemeral headless-Chromium screenshot service for Mode B rendering.
# See server.js for why this exists as a separate container.
FROM alpine:3.20

RUN apk add --no-cache chromium nodejs

WORKDIR /app
COPY server.js .

ENV CHROMIUM_PATH=/usr/bin/chromium-browser
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
