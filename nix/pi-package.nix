# Convenience helper for declarative consumers that want the package path Pi
# should load. Usage: pi install "$(nix build .#piss --no-link --print-out-paths)"
{ piss }: piss
