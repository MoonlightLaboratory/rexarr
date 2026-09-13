#!/bin/sh
# LinuxServer-style PUID/PGID/UMASK handling so files written to your media share are owned by you.
set -e
PUID=${PUID:-1000}
PGID=${PGID:-1000}
UMASK=${UMASK:-002}
umask "$UMASK"

if [ "$(id -u)" = "0" ]; then
  if ! getent group rexarr >/dev/null 2>&1; then addgroup -g "$PGID" rexarr 2>/dev/null || addgroup rexarr; fi
  if ! id rexarr >/dev/null 2>&1; then adduser -D -H -u "$PUID" -G rexarr rexarr 2>/dev/null || adduser -D -H -G rexarr rexarr; fi
  mkdir -p "${REXARR_DATA_DIR:-/config}"
  chown -R rexarr:rexarr "${REXARR_DATA_DIR:-/config}" 2>/dev/null || true
  # Let the app open the optical drive / GPU render node if they are passed through.
  for dev in /dev/sr0 /dev/sr1 /dev/dri/renderD128; do
    [ -e "$dev" ] && chmod a+rw "$dev" 2>/dev/null || true
  done
  exec su-exec rexarr "$@"
fi
exec "$@"
