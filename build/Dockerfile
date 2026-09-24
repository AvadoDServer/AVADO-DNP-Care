# AVADO Care package image.
#
# Build context is the repository root (docker-compose.yml: context ".",
# dockerfile "build/Dockerfile"), so the image can read the package version
# from dappnode_package.json. See /.dockerignore for what is sent.

# Base images, pinned by digest (the multi-arch index digest). The tag is only
# a label; the digest decides. Update tag and digest together: get the digest
# with `docker buildx imagetools inspect node:<tag>` (the "Digest:" line).
# Same pins as AVADO-DNP-Rocketpool, checked 2026-09-24.
ARG NODE_IMAGE=node:22.23.2-bookworm@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844
ARG NODE_SLIM_IMAGE=node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

########## Service: install, type-check, test, build
FROM --platform=linux/amd64 ${NODE_IMAGE} AS service
WORKDIR /usr/src/service
COPY build/service/package.json build/service/yarn.lock ./
RUN yarn install --frozen-lockfile
COPY build/service/ ./
# A failing check or test fails the image build, so a release can never be
# built on a red suite. (The Admin sync test is skipped here: no DNP_ADMIN
# checkout in the build context. The hash check of the vendored files runs.)
RUN yarn lint && yarn test
# Only what the runtime needs goes into /out.
RUN yarn build \
    && yarn install --frozen-lockfile --production --ignore-scripts --prefer-offline \
    && mkdir -p /out \
    && cp -a package.json dist public node_modules /out/

########## Runtime
FROM --platform=linux/amd64 ${NODE_SLIM_IMAGE}

COPY --from=service /out /usr/src/service

# Package version, read from the manifest so an `avadosdk increase` bump can
# never leave it stale.
COPY dappnode_package.json /tmp/dappnode_package.json
RUN node -e 'const v = require("/tmp/dappnode_package.json").version; \
        if (!/^[0-9A-Za-z.+-]+$/.test(v || "")) { console.error("bad package version"); process.exit(1); } \
        require("fs").writeFileSync("/usr/src/service/package-version", v + "\n");' \
    && rm /tmp/dappnode_package.json \
    && test -f /usr/src/service/dist/server.js \
    && test -f /usr/src/service/dist/admin/health/engine.js \
    && test -f /usr/src/service/public/index.html \
    && mkdir -p /data && chown node:node /data

# No root needed: Docker (20.10+) lets containers bind port 80 unprivileged
# (net.ipv4.ip_unprivileged_port_start=0), and /data is owned by `node`, so a
# new volume starts out owned by it too.
USER node
ENV NODE_ENV=production \
    STATE_DIR=/data \
    PUBLIC_DIR=/usr/src/service/public \
    PORT=80
WORKDIR /usr/src/service
EXPOSE 80
CMD ["node", "dist/server.js"]
