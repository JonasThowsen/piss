# styled-ppx derivation used by the Melange browser shell build.
#
# Upstream `styled-ppx` ships its full source tree but the `server-reason-react`
# package is not in nixpkgs. We strip the parts of the source tree that need
# it and keep only the Melange runtime + ppx rewriter that PISS actually
# consumes.

pkgs:

let fetchurl = pkgs.fetchurl; in

pkgs.ocamlPackages.buildDunePackage {
  pname = "styled-ppx";
  version = "0.61.0";
  src = fetchurl {
    url = "https://github.com/davesnx/styled-ppx/releases/download/0.61.0/styled-ppx-0.61.0.tbz";
    sha256 = "sha256-xuuncOnpu5ACvz91n5nrzsbXtBMsbCrVYohsiLaDm6s=";
  };
  nativeBuildInputs = with pkgs.ocamlPackages; [
    menhir
    melange
    reason
    pkgs.buildPackages.coreutils
  ];
  propagatedBuildInputs = with pkgs.ocamlPackages; [
    reason
    melange
    sedlex
    ppx_deriving
    ppx_deriving_yojson
    ppxlib
    yojson
    menhir
    reason-react
  ];
  dontStrip = true;
  doCheck = false;
  prePatch = ''
    rm -rf demo
    rm -rf packages/runtime/native
    rm -rf packages/runtime/benchmark
    rm -rf packages/runtime/rescript
    rm -rf packages/runtime/test
    rm -rf packages/css-spec-parser/test
    rm -rf packages/css-property-parser/test
    rm -rf packages/string_interpolation/test
    rm -rf packages/parser/test
    rm -rf packages/ppx/test
    mkdir -p packages/runtime/melange/shared
    cp ${fetchurl {
      url = "https://github.com/davesnx/styled-ppx/releases/download/0.61.0/styled-ppx-0.61.0.tbz";
      sha256 = "sha256-xuuncOnpu5ACvz91n5nrzsbXtBMsbCrVYohsiLaDm6s=";
    }} /tmp/styled-ppx.tbz
    tar -xjf /tmp/styled-ppx.tbz -C /tmp --strip-components=1
    cp /tmp/packages/runtime/native/shared/*.ml packages/runtime/melange/shared/
    cp /tmp/packages/runtime/native/Kloth.mli packages/runtime/melange/Kloth.mli
    cat > packages/runtime/melange/dune <<'INNER_EOF'
(library
 (name styled_ppx_runtime_melange)
 (public_name styled-ppx.melange)
 (modes melange)
 (wrapped false)
 (preprocess
  (pps melange.ppx -alert -deprecated)))

(copy_files#
(mode fallback)
(files ./shared/**[!.pp].ml))
INNER_EOF
    cat > dune <<'INNER_EOF'
(dirs packages)

(subdir
 packages
 (dirs :standard \ editors website runtime/benchmark runtime/test runtime/native runtime/rescript))
INNER_EOF
    sed -i '/server-reason-react/d' dune-project
    rm -f /tmp/styled-ppx.tbz
  '';
}
