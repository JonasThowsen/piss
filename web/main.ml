open! Core
open! Bonsai_web.Cont

let component _graph = Bonsai.return (Vdom.Node.text "Bonsai tracer running")
let () = Bonsai_web.Start.start component
