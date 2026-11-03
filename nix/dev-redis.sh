#!/usr/bin/env bash
# Repo-local Redis shared by every devenv shell. It replaces the Docker Redis
# from compose.dev.yml with the same ephemeral settings. Node's Redis client
# only accepts TCP URLs, so it listens on 127.0.0.1 at a free port the OS picks
# on first start. The port is kept in devenv's state directory, so REDIS_URL
# stays the same across restarts and reboots and never lands on a system Redis.
# `start` reuses the running server or starts one; `stop` shuts it down; `url`
# prints the REDIS_URL for it.
set -eu

data="$DEVENV_STATE/overtchat-redis"
run="$DEVENV_RUNTIME/overtchat-redis"
port_file="$data/port"
pid_file="$run/redis.pid"

port() {
  cat "$port_file" 2>/dev/null
}

# The server accepts connections on its port.
ready() {
  [ -s "$port_file" ] || return 1
  redis-cli -h 127.0.0.1 -p "$(port)" ping >/dev/null 2>&1
}

# A server from this checkout is alive, reachable or not.
running() {
  [ -s "$pid_file" ] || return 1
  pid="$(cat "$pid_file")"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" >/dev/null 2>&1
}

# Prints $1 if it is free on 127.0.0.1, otherwise a free port from the OS.
free_port() {
  node -e '
    const net = require("node:net");
    const listen = (port, fallback) => {
      const server = net.createServer();
      server.once("error", () => (fallback ? listen(0, false) : process.exit(1)));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        console.log(server.address().port);
        server.close();
      });
    };
    listen(Number(process.argv[1] || 0), true);
  ' "${1:-}"
}

start() {
  mkdir -p "$data" "$run"
  chmod 700 "$run"

  # Serialize startup across shells. The lock is released when this script
  # exits, so nothing started below may inherit fd 9.
  exec 9>"$run/lock"
  if ! flock -w 30 9; then
    echo "Timed out waiting for the OvertChat dev Redis startup lock" >&2
    echo "If no other shell is starting, run overtchat-redis-stop and try again." >&2
    exit 1
  fi

  if running && ready; then
    return 0
  fi
  # Alive but not answering on its port: restart it.
  if running; then
    stop
  fi

  previous="$(port || true)"
  next="$(free_port "$previous")"
  echo "$next" >"$port_file"
  if [ -n "$previous" ] && [ "$previous" != "$next" ]; then
    echo "Port $previous is taken; the OvertChat dev Redis moved to $next. Reload other open shells." >&2
  fi

  # Redis detaches itself. direnv captures hook output on extra file
  # descriptors: close them so the daemon cannot keep `direnv export` alive.
  redis-server \
    --bind 127.0.0.1 \
    --port "$next" \
    --dir "$run" \
    --daemonize yes \
    --pidfile "$pid_file" \
    --logfile "$run/redis.log" \
    --save "" \
    --appendonly no \
    --maxmemory 64mb \
    --maxmemory-policy allkeys-lru \
    3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&-

  for _ in $(seq 50); do
    if ready; then
      return 0
    fi
    sleep 0.1
  done
  echo "The OvertChat dev Redis did not become ready; see $run/redis.log" >&2
  exit 1
}

stop() {
  if running; then
    kill "$pid"
    for _ in $(seq 50); do
      kill -0 "$pid" >/dev/null 2>&1 || return 0
      sleep 0.1
    done
    echo "The OvertChat dev Redis (PID $pid) did not stop" >&2
    exit 1
  fi
}

url() {
  [ -s "$port_file" ] || {
    echo "The OvertChat dev Redis has no port yet; run overtchat-redis start" >&2
    exit 1
  }
  echo "redis://127.0.0.1:$(port)"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  url) url ;;
  *)
    echo "usage: overtchat-redis start|stop|url" >&2
    exit 2
    ;;
esac
