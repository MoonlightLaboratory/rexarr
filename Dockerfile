# syntax=docker/dockerfile:1.7
# Rexarr – remux-first transcoding companion for the *arr stack
#
#   docker build -t Rexarr .
#   docker run -d -p 3939:3939 -e PUID=1000 -e PGID=1000 \
#     -v ./config:/config -v /path/to/media:/data/media Rexarr
#
# Runtime: Node 22 on Alpine with the distro ffmpeg (x264, x265, SVT-AV1, libaom, VP9, Opus, VAAPI) and fre:ac
# for music (FLAC, LAME MP3, Opus, Vorbis; this build has no WavPack / Monkey's Audio encoder).
# Disc ripping needs makemkvcon, which MakeMKV does not package: use docker/Dockerfile.makemkv for that.

# ---------- build ----------
# Pure JavaScript output (no native modules), so it is built once on the build machine's platform, not under emulation
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN --mount=type=cache,target=/root/.npm npm ci
COPY shared ./shared
COPY server ./server
COPY client ./client
RUN npm run build \
 && npm prune --omit=dev \
 && rm -rf server/src client/src client/node_modules server/node_modules

# ---------- runtime ----------
FROM node:22-alpine
ARG REXARR_VERSION=0.1.5.0
LABEL org.opencontainers.image.title="Rexarr" \
      org.opencontainers.image.description="Remux-first transcoding, music and disc ripping companion for Radarr, Sonarr and Lidarr" \
      org.opencontainers.image.source="https://github.com/MoonlightLaboratory/rexarr" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.version="${REXARR_VERSION}"
# Core runtime deps. Intel VAAPI / QuickSync drivers only exist for x86_64. AMD VAAPI needs mesa, which drags
# in ~200 MB of LLVM, so it is opt-in: --build-arg WITH_AMD_VAAPI=1
ARG WITH_AMD_VAAPI=0
# fre:ac (music profiles, audio CD ripping, cue splitting); leave it out with --build-arg WITH_FREAC=0
ARG WITH_FREAC=1
RUN apk add --no-cache ffmpeg su-exec tini libva \
 && if [ "$WITH_FREAC" = "1" ]; then apk add --no-cache freac gsettings-desktop-schemas && freaccmd --help 2>/dev/null | head -1; fi \
 && if [ "$(apk --print-arch)" = "x86_64" ]; then apk add --no-cache libva-intel-driver intel-media-driver; fi \
 && if [ "$WITH_AMD_VAAPI" = "1" ]; then apk add --no-cache mesa-va-gallium; fi \
 && ffmpeg -version | head -1 && tini --version && su-exec 2>&1 | head -1
# Free uid/gid 1000 (the image's default "node" user) so PUID/PGID=1000 maps cleanly.
RUN deluser --remove-home node || true
ENV NODE_ENV=production \
    REXARR_PORT=3939 \
    REXARR_HOST=0.0.0.0 \
    REXARR_DATA_DIR=/config \
    PUID=1000 PGID=1000 UMASK=002 \
    LIBVA_DRIVER_NAME=iHD
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/shared ./shared
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /config
VOLUME ["/config"]
EXPOSE 3939
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${REXARR_PORT}/api/health" >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD ["node", "server/dist/server/src/index.js"]
