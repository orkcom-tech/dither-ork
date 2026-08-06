FROM node:22-bookworm-slim

WORKDIR /app/web

# Dependencies install into the named volume on first `up`; this layer only
# needs to exist so the image has npm available.
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
