(* Worker-local dependency aliases. This is deliberately not a public
   umbrella. *)
include Piss_shared
module Store = Piss_worker_store.Store
module Workspace_io = Piss_workspace_io.Workspace_io
