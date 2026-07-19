#!/usr/bin/env bash
set -euo pipefail

socket="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/piss/tailscaled.sock"
tailscale_bin="${TAILSCALE_BIN:-tailscale}"
web_port="${PISS_DEV_WEB_PORT:-5173}"
production_unit="piss.service"
serve_unit="piss-tailscale-serve.service"

if ! systemctl --user is-active --quiet "$production_unit"; then
  echo "The production PISS user service must be active before entering tailnet development mode." >&2
  echo "Start it with: systemctl --user start $production_unit $serve_unit" >&2
  exit 1
fi
if [[ ! -S "$socket" ]]; then
  echo "The dedicated PISS Tailscale socket is unavailable: $socket" >&2
  exit 1
fi

service_environment="$(systemctl --user show "$production_unit" --property=Environment --value)"
backend_port="${PISS_PORT:-}"
if [[ -z "$backend_port" || -z "${PISS_ALLOWED_USERS+x}" ]]; then
  for assignment in $service_environment; do
    case "$assignment" in
      PISS_PORT=*)
        [[ -n "$backend_port" ]] || backend_port="${assignment#PISS_PORT=}"
        ;;
      PISS_ALLOWED_USERS=*)
        if [[ -z "${PISS_ALLOWED_USERS+x}" ]]; then
          export PISS_ALLOWED_USERS="${assignment#PISS_ALLOWED_USERS=}"
        fi
        ;;
    esac
  done
fi
backend_port="${backend_port:-4317}"

if [[ ! "$backend_port" =~ ^[0-9]+$ || ! "$web_port" =~ ^[0-9]+$ ]] ||
  (( backend_port < 1 || backend_port > 65535 || web_port < 1 || web_port > 65535 )); then
  echo "PISS_PORT and PISS_DEV_WEB_PORT must be valid TCP ports." >&2
  exit 1
fi
if [[ "$backend_port" == "$web_port" ]]; then
  echo "The backend and Vite development server must use different ports." >&2
  exit 1
fi

status_json="$("$tailscale_bin" --socket="$socket" status --json)"
backend_state="$(jq -r '.BackendState // ""' <<<"$status_json")"
dns_name="$(jq -r '.Self.DNSName // ""' <<<"$status_json")"
dns_name="${dns_name%.}"
if [[ "$backend_state" != "Running" || -z "$dns_name" ]]; then
  echo "The dedicated PISS Tailscale node is not connected." >&2
  exit 1
fi

export NODE_ENV=development
export PISS_HOST=127.0.0.1
export PISS_PORT="$backend_port"
export PISS_DEV_HOST="$dns_name"
export PISS_DEV_WEB_PORT="$web_port"
unset PISS_DEV_BYPASS_AUTH

if [[ -z "${PISS_ALLOWED_USERS:-}" ]]; then
  echo "Warning: no PISS_ALLOWED_USERS value was found; tailnet policy will be the only user restriction." >&2
fi

restored=0
restore_production() {
  local status=$?
  if (( restored )); then return; fi
  restored=1
  trap - EXIT INT TERM

  echo
  echo "Restoring the immutable PISS service…"
  if ! systemctl --user start "$production_unit"; then
    echo "Failed to restart $production_unit" >&2
  fi
  if ! systemctl --user start "$serve_unit"; then
    echo "Failed to restore $serve_unit; retry with:" >&2
    echo "  systemctl --user restart $serve_unit" >&2
  fi
  exit "$status"
}
trap restore_production EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Stopping the immutable PISS service…"
systemctl --user stop "$serve_unit" "$production_unit"

echo "Routing https://$dns_name to Vite on 127.0.0.1:$web_port…"
"$tailscale_bin" --socket="$socket" serve --bg --yes "http://127.0.0.1:$web_port"

echo
echo "Tailnet development mode is active: https://$dns_name"
echo "Frontend edits use Vite HMR; server edits restart automatically."
echo "Press Ctrl-C to restore the production service."
echo

npm run dev:tailnet:run
