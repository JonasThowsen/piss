# PISS development recipes.
#
# `just` is a small command runner: https://github.com/casey/just
# Run `just` with no arguments to list every recipe.
#
# Conventions:
#   * `just build` builds every OCaml artifact and the Melange browser bundle.
#   * `just serve` and `just worker` start the components locally with
#     sensible defaults rooted under `.piss/`.
#   * `just check` is the one command to run before pushing a change.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# OCaml compiler version for the local opam switch.
ocaml_version := "5.5.0"

# Local state directory (mirrors the systemd StateDirectory).
state_dir := env_var_or_default("PISS_STATE_DIR", ".piss")

# Default loopback port for the control plane.
port := env_var_or_default("PISS_PORT", "4318")

# Default harness when running locally.
harness := env_var_or_default("PISS_HARNESS", "mock")

# List every recipe.
default:
    @just --list --unsorted

# ──────────────────────────────── Setup ───────────────────────────────────

# Create the local opam switch and install every OCaml dependency.
# Re-run after editing dune-project or any *.opam file.
switch:
    @if [ ! -d .opam ]; then \
        opam switch create . ocaml-base-compiler.{{ocaml_version}} --no-install; \
    fi
    opam install --deps-only --with-test --with-doc .

# Refresh installed deps without recreating the switch.
deps:
    opam install --deps-only --with-test --with-doc .

# Drop the local opam switch and its build directory.
clean-switch:
    opam switch remove . --yes || true
    rm -rf .opam _build

# ──────────────────────────────── Build ───────────────────────────────────

# Build every OCaml artifact: native binaries, tests, and the Melange bundle.
build:
    dune build @all @web-bundle

# Build only the native OCaml components (no Melange bundle).
build-native:
    dune build @all

# Build only the Melange browser bundle under _build/default/web/app.js.
build-web:
    dune build @web-bundle

# Watch the source tree and rebuild on change. Polls the filesystem so it
# works on macOS where inotify is not available.
watch:
    dune build @all @web-bundle -w

# Remove every build artifact.
clean:
    dune clean

# ──────────────────────────────── Test ────────────────────────────────────

# Run the Alcotest unit suite.
test:
    dune build @runtest
    dune exec src/test/core_test.exe

# Run the shell-driven integration tests (interaction, isolation, mention,
# replaceability). Each one boots the full control + worker stack against the
# deterministic mock agent.
test-integration: build
    dune build @interaction-test @mention-browser-test @replaceability-test @session-isolation-test

# Format, build, and run every test. The single command to run before
# opening a pull request.
check: format-check build test test-integration

# ────────────────────────────── Format ────────────────────────────────────

# Auto-format every OCaml and Reason source.
format:
    dune fmt

# Verify formatting without modifying any files (for CI).
format-check:
    dune build @fmt

# ──────────────────────────────── Doc ─────────────────────────────────────

# Build the API documentation under _build/default/_doc.
doc:
    dune build @doc

# Open the generated documentation in the default browser.
doc-open: doc
    python3 -m webtool open _build/default/_doc/index.html || xdg-open _build/default/_doc/index.html

# ─────────────────────────── Local runtime ────────────────────────────────

# Print the on-disk path for a built executable (used by the other recipes).
[private]
binary-path target:
    @dune build {{target}} >/dev/null 2>&1
    @echo "_build/default/{{target}}"

# Run the deterministic mock ACP agent on stdio. The control plane and the
# worker both speak to it as a fixture.
mock-agent:
    dune exec src/mock_agent/main.exe

# Run the harness-neutral MCP server that other workers call for
# inter-session collaboration.
session-mcp:
    dune exec src/session_mcp/main.exe

# Run the pissd control plane with sensible local defaults. State lives
# under {{state_dir}}, the browser bundle is served from _build/default/web,
# and Tailscale auth is bypassed (loopback only).
serve *extra_args:
    @mkdir -p {{state_dir}}
    dune exec src/control/main.exe -- \
        --port {{port}} \
        --registry {{state_dir}}/registry.sqlite3 \
        --session-state-root {{state_dir}}/state \
        --session-runtime-root {{state_dir}}/runtime \
        --session-launcher "$(just binary-path src/worker/main.exe)" \
        --session-stopper "true" \
        --available-harness {{harness}} \
        --default-harness {{harness}} \
        --workspace-spec "deployed|deployed|$PWD" \
        --workspace-discovery-root "$PWD" \
        --max-active-sessions 1 \
        --public web/public \
        --app-js _build/default/web/app.js \
        --generation dev \
        --allowed-user local-dev \
        --dev-bypass-auth \
        {{extra_args}}

# Run one session worker pointed at the mock agent. Useful for poking at the
# worker protocol without bringing up the whole stack.
worker *extra_args:
    @mkdir -p {{state_dir}}
    dune exec src/worker/main.exe -- \
        --socket {{state_dir}}/worker.sock \
        --database {{state_dir}}/worker.sqlite3 \
        --session dev-session \
        --worker dev-worker \
        --generation dev \
        --workspace "$PWD" \
        --harness "$(just binary-path src/mock_agent/main.exe)" \
        --session-mcp "" \
        --broker-url http://127.0.0.1:{{port}} \
        --broker-token "" \
        --curl-command curl \
        {{extra_args}}

# Build the browser bundle, run the control plane, and open the PWA in the
# default browser. Stops with Ctrl-C.
dev: build
    @if command -v xdg-open >/dev/null; then xdg-open http://127.0.0.1:{{port}} & \
    elif command -v open >/dev/null; then open http://127.0.0.1:{{port}} & \
    fi
    just serve

# ──────────────────────────────── Audit ───────────────────────────────────

# Audit pinned npm dependencies for known vulnerabilities.
audit:
    npm audit --omit=dev --audit-level=high

# ──────────────────────────────── Misc ────────────────────────────────────

# Open an opam shell with every dependency on PATH. Useful for ad-hoc REPL
# work or one-off scripting.
repl:
    opam exec -- dune utop src/lib

# Print the active opam switch and OCaml compiler version.
info:
    @echo "switch:    $(opam switch show)"
    @echo "compiler:  $(opam exec -- ocamlc --version)"
    @echo "dune:      $(opam exec -- dune --version)"
