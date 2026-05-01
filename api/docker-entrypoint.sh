#!/bin/sh
set -e

# Fix /data ownership in case the host bind-mount belongs to a different UID.
# Runs as root, then drops to the unprivileged 'app' user before exec'ing the app.
chown -R app:app /data 2>/dev/null || true

exec su-exec app "$@"
