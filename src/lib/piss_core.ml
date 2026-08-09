(* Piss_core is the backend-only library: SQLite stores, filesystem
   access, and the workers registry. The pure type and protocol
   definitions live in `piss.shared`; we re-export them here so
   existing call sites can keep `open Piss_core` and reach every
   shared type and value through the umbrella.

   Dune wraps sibling files at the same directory level into
   `Piss_core__*` names rather than as submodules of `Piss_core`,
   so we alias them explicitly. Without these aliases, code outside
   this directory has to write `Piss_core__Registry.t` instead of
   the more readable `Registry.t` after `open Piss_core`. *)

include Piss_shared

module Registry = Piss_core__Registry
module Store = Piss_core__Store
module Workspace_io = Piss_core__Workspace_io
