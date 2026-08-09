(* Piss_core is the backend umbrella for the PISS libraries. *)

module Domain : module type of Piss_shared.Domain
module Wire : module type of Piss_shared.Wire
module Acp : module type of Piss_shared.Acp
module Workspace_files : module type of Piss_shared.Workspace_files

module Registry : module type of Piss_core__Registry
module Store : module type of Piss_core__Store
module Workspace_io : module type of Piss_core__Workspace_io
