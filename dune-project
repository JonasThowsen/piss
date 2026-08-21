(lang dune 3.20)
(name piss)
(implicit_transitive_deps false)
(generate_opam_files true)
(source (github JonasThowsen/piss))
(license MIT)
(authors "Jonas Ådland Thowsen")
(maintainers "Jonas Ådland Thowsen")
(package
 (name piss)
 (synopsis "A durable, harness-agnostic control plane for coding agents")
 (depends
  (ocaml (= 5.2.1))
  dune
  eio_main
  cohttp-eio
  yojson
  sqlite3
  logs
  fmt
  alcotest))
