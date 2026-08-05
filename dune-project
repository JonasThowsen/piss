(lang dune 3.20)
(using melange 0.1)
(name piss-next)
(generate_opam_files false)
(source (github JonasThowsen/piss))
(license MIT)
(authors "Jonas Ådland Thowsen")
(maintainers "Jonas Ådland Thowsen")
(package
 (name piss-next)
 (synopsis "A durable, harness-agnostic control plane for coding agents")
 (depends
  (ocaml (>= 5.4))
  dune
  eio_main
  cohttp-eio
  yojson
  sqlite3
  logs
  fmt
  alcotest
  melange
  reason
  reason-react
  reason-react-ppx))
