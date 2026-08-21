(** Deprecated source-compatibility facade. New code must import one of the
    ownership libraries documented in [docs/ARCHITECTURE.md]. *)

include module type of Piss_shared
module Origin_pattern : module type of Piss_origin.Origin_pattern
module Registry : module type of Piss_registry.Registry
module Registry_domain : module type of Piss_registry_domain.Registry_domain
module Store : module type of Piss_worker_store.Store
module Workspace_io : module type of Piss_workspace_io.Workspace_io
