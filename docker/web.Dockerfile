FROM node:22-bookworm-slim

WORKDIR /app/web

# `npm ci` rather than `npm install`: it installs exactly the committed lockfile
# and fails if package.json and the lockfile disagree, instead of quietly
# resolving something new. The lockfile is committed, so it is not optional.
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund \
 && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.dither-ork-lock-hash

# This install seeds the node_modules named volume on first `up`; the entrypoint
# reinstalls whenever the lockfile stops matching what the volume holds.
COPY docker/web-entrypoint.sh /usr/local/bin/web-entrypoint.sh
RUN chmod +x /usr/local/bin/web-entrypoint.sh

EXPOSE 5173
ENTRYPOINT ["/usr/local/bin/web-entrypoint.sh"]
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
