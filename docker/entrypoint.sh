#!/bin/sh
# Rexarr container entrypoint: LinuxServer-style PUID / PGID / UMASK handling.
# Runs the app as an unprivileged user that owns /config and whatever it writes to your media shares.
set -e
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
UMASK="${UMASK:-002}"
DATA_DIR="${REXARR_DATA_DIR:-/config}"
umask "$UMASK"

if [ "$(id -u)" = "0" ]; then
  # Reuse an existing group / user with the requested ids, otherwise create "rexarr".
  GROUP="$(awk -F: -v gid="$PGID" '$3 == gid { print $1; exit }' /etc/group || true)"
  if [ -z "$GROUP" ]; then
    addgroup -g "$PGID" rexarr
    GROUP=rexarr
  fi
  USER="$(awk -F: -v uid="$PUID" '$3 == uid { print $1; exit }' /etc/passwd || true)"
  if [ -z "$USER" ]; then
    adduser -D -H -u "$PUID" -G "$GROUP" rexarr
    USER=rexarr
  fi
  mkdir -p "$DATA_DIR"
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true
  # Optical drives / GPU render nodes passed through with --device need to be usable by that user.
  for dev in /dev/sr[0-9]* /dev/sg[0-9]* /dev/cdrom /dev/dvd /dev/bluray /dev/dri/renderD[0-9]*; do
    [ -e "$dev" ] && chmod a+rw "$dev" 2>/dev/null || true
  done
  echo "rexarr: running as $USER ($PUID:$PGID), umask $UMASK, data in $DATA_DIR"
  # su-exec sets HOME to the user's (non-existent) home; fre:ac and GLib want a writable one
  exec su-exec "$PUID:$PGID" env HOME="$DATA_DIR" "$@"
fi
exec "$@"
