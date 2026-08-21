(* Control-local dependency aliases. This is deliberately not a public library:
   Dune still enforces the control plane's narrow registry/shared seams. *)
include Piss_shared
module Registry = Piss_registry.Registry
module Registry_domain = Piss_registry_domain.Registry_domain
module Origin_pattern = Piss_origin.Origin_pattern
