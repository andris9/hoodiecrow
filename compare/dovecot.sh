#!/usr/bin/env bash
set -euo pipefail

# Manages the Dovecot reference server used by compare/compare.js. The container
# keeps running between comparisons; every comparison logs in as a new user, so
# runs never see each other's mail.
#
# Usage: compare/dovecot.sh start|stop|restart|status|logs
#
# Environment overrides:
#   IMAPKIT_DOVECOT_IMAGE     image to run (default dovecot/dovecot:2.4.4)
#   IMAPKIT_DOVECOT_PLATFORM  e.g. linux/amd64; defaults to the host platform.
#                                Forcing linux/amd64 on Apple Silicon does not
#                                work, Rosetta cannot start Dovecot's login processes.
#   IMAPKIT_DOVECOT_PORT      host port for plain IMAP (default 32143)

CONTAINER_NAME="imapkit-dovecot"
IMAGE="${IMAPKIT_DOVECOT_IMAGE:-dovecot/dovecot:2.4.4}"
PORT="${IMAPKIT_DOVECOT_PORT:-32143}"
PLATFORM_ARG="${IMAPKIT_DOVECOT_PLATFORM:+--platform=$IMAPKIT_DOVECOT_PLATFORM}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

is_running() {
    [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)" = "true" ]
}

wait_ready() {
    echo "Waiting for Dovecot to accept IMAP connections on port $PORT..."
    for _ in $(seq 1 30); do
        if node -e "
            const net = require('net');
            const socket = net.connect(Number(process.argv[1]), '127.0.0.1');
            const bail = code => { socket.destroy(); process.exit(code); };
            socket.on('data', chunk => bail(chunk.toString().startsWith('* OK') ? 0 : 1));
            socket.on('error', () => bail(1));
            setTimeout(() => bail(1), 2000);
        " "$PORT" 2>/dev/null; then
            echo "Dovecot is ready on 127.0.0.1:$PORT"
            return 0
        fi
        sleep 1
    done
    echo "Dovecot container did not become ready" >&2
    docker logs "$CONTAINER_NAME" >&2 || true
    exit 1
}

start() {
    if is_running; then
        echo "Dovecot is already running on 127.0.0.1:$PORT (container $CONTAINER_NAME)"
        return 0
    fi
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

    # `docker run` silently reuses a local image even when it was pulled for another
    # architecture, and Dovecot then fails with confusing emulation errors
    if [ -z "${IMAPKIT_DOVECOT_PLATFORM:-}" ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
        image_arch="$(docker image inspect --format '{{.Architecture}}' "$IMAGE" 2>/dev/null || true)"
        host_arch="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || true)"
        if [ -n "$image_arch" ] && [ -n "$host_arch" ] && [ "$image_arch" != "$host_arch" ]; then
            echo "Local $IMAGE image is $image_arch but the Docker host is $host_arch, re-pulling for linux/$host_arch..."
            docker pull --platform "linux/$host_arch" "$IMAGE"
        fi
    fi

    docker run ${PLATFORM_ARG:+"$PLATFORM_ARG"} -d --name "$CONTAINER_NAME" \
        -e USER_PASSWORD=pass \
        -v "$SCRIPT_DIR/dovecot.conf:/etc/dovecot/conf.d/99-imapkit-compare.conf:ro" \
        -p "127.0.0.1:$PORT:31143" \
        "$IMAGE" >/dev/null

    wait_ready
}

stop() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    echo "Dovecot stopped"
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    restart)
        stop
        start
        ;;
    status)
        if is_running; then
            echo "Dovecot is running on 127.0.0.1:$PORT (container $CONTAINER_NAME)"
        else
            echo "Dovecot is not running"
            exit 1
        fi
        ;;
    logs) docker logs "$CONTAINER_NAME" ;;
    *)
        echo "Usage: $0 start|stop|restart|status|logs" >&2
        exit 2
        ;;
esac
