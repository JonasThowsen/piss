(* Deprecated source-compatibility facade. Production targets intentionally do
   not depend on this library; see docs/ARCHITECTURE.md. *)
include Piss_shared
module Origin_pattern = Piss_origin.Origin_pattern
module Registry = Piss_registry.Registry
module Registry_domain = Piss_registry_domain.Registry_domain
module Store = Piss_worker_store.Store
module Workspace_io = Piss_workspace_io.Workspace_io
