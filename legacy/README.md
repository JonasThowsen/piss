# legacy/

This directory preserves the previous TypeScript/Effect implementation of
PISS for historical reference.

It is **not** built, packaged, or deployed by the active flake. The
canonical source is `src/` (native OCaml 5.5) and `web/`
(OCaml/Bonsai/js_of_ocaml in the OCaml 5.2 web shell). The NixOS module lives
in `nix/nixos-module.nix` and ships the new control plane.

Files are kept so that:

- historical git blame and archaeology remain easy;
- any slice not yet ported to the rewrite can be reviewed against its
  predecessor;
- the rewrite can quote previous security, durability, and workflow
  invariants verbatim.

Do not add new code here. New code goes into `src/`, `web/`, or `nix/`.
