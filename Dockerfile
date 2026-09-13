# syntax=docker/dockerfile:1
# rexarr – remux-first transcoding companion for the *arr stack
#
#   docker build -t rexarr .
#   docker run -p 7878:7878 -v ./config:/config -v /path/to/media:/data/media rexarr
#
# The runtime image is Alpine with the distro ffmpeg (x264, x265, SVT-AV1, libaom, VP9, Opus, VAAPI).
# For NVENC use an ffmpeg build with CUDA on the host and point Settings → FFmpeg at it, or swap the
# base image for one that ships a CUDA-enabled ffmpeg. Disc ripping needs makemkvcon, which MakeMKV does
# not distribute as a package; run rexarr on the host for that, or bake makemkv into a derived image.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY shared ./shared
COPY server ./server
COPY client ./client
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache ffmpeg su-exec tini libva libva-intel-driver intel-media-driver mesa-va-gallium \
 && rm -rf /var/cache/apk/*
ENV NODE_ENV=production \
    REXARR_PORT=7878 \
    REXARR_HOST=0.0.0.0 \
    REXARR_DATA_DIR=/config \
    PUID=1000 PGID=1000 UMASK=002
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
COPY docker/entrypoint.sh /entrypoint.sh
VOLUME ["/config"]
EXPOSE 7878
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${REXARR_PORT}/api/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD ["node", "server/dist/server/src/index.js"]
