{
  description = "PISS - Pi sin sidecar";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          ocamlPackages = pkgs.ocaml-ng.ocamlPackages_5_5;
          bonsaiWeb = import ./nix/bonsai-web.nix { inherit pkgs; };
          dependencies = with ocamlPackages; [
            alcotest
            cohttp-eio
            eio_main
            fmt
            logs
            ocaml_sqlite3
            yojson
          ];
          source = nixpkgs.lib.fileset.toSource {
            root = ./.;
            fileset = nixpkgs.lib.fileset.unions [
              ./.ocamlformat
              ./dune
              ./dune-project
              ./LICENSE
              ./piss.opam
              ./shared
              ./src
              ./web/public
            ];
          };
          pissWeb = bonsaiWeb.ocamlPackages.buildDunePackage {
            pname = "piss-web";
            version = "0.1.0";
            src = nixpkgs.lib.fileset.toSource {
              root = ./web;
              fileset = nixpkgs.lib.fileset.unions [
                ./web/dune
                ./web/dune-project
                ./web/main.ml
              ];
            };
            nativeBuildInputs = [
              bonsaiWeb.js_of_ocaml_compiler
              bonsaiWeb.ocamlPackages.ppx_jane
            ];
            buildInputs = [
              bonsaiWeb.bonsai
              bonsaiWeb.ocamlPackages.ppx_pattern_bind
            ];
            buildPhase = ''
              runHook preBuild
              dune build main.bc.js
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p "$out/share/piss-web"
              cp _build/default/main.bc.js "$out/share/piss-web/app.js"
              runHook postInstall
            '';
          };
          piss = ocamlPackages.buildDunePackage {
            pname = "piss";
            version = "0.1.0";
            src = source;
            buildInputs = dependencies;
            postInstall = ''
              mkdir -p "$out/share/piss"
              cp -r web/public "$out/share/piss/public"
              cp ${pissWeb}/share/piss-web/app.js "$out/share/piss/public/app.js"
            '';
            doCheck = true;
            meta = {
              description = "Private web workspace for coding-agent sessions";
              homepage = "https://github.com/JonasThowsen/piss";
              license = pkgs.lib.licenses.mit;
              mainProgram = "pissd";
              platforms = systems;
            };
          };
        in
        {
          inherit piss;
          piss-web = pissWeb;
          default = piss;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.piss}/bin/pissd";
          meta.description = "Run the PISS control plane";
        };
      });

      checks = forAllSystems (system: {
        inherit (self.packages.${system}) piss piss-web;
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          ocamlPackages = pkgs.ocaml-ng.ocamlPackages_5_5;
          bonsaiWeb = import ./nix/bonsai-web.nix { inherit pkgs; };
        in
        {
          default = pkgs.mkShell {
            inputsFrom = [ self.packages.${system}.piss ];
            packages = [
              ocamlPackages.ocaml
              ocamlPackages.dune_3
              ocamlPackages.ocaml-lsp
              ocamlPackages.ocamlformat
              ocamlPackages.utop
              pkgs.chromium
              pkgs.curl
              pkgs.jq
              pkgs.just
              pkgs.nodejs_24
            ];
            PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "${pkgs.chromium}/bin/chromium";
          };
          web = pkgs.mkShell {
            inputsFrom = [ self.packages.${system}.piss-web ];
            packages = [
              bonsaiWeb.ocamlPackages.ocaml
              bonsaiWeb.ocamlPackages.dune_3
              bonsaiWeb.ocamlPackages.ocamlformat
            ];
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
