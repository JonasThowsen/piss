{
  description = "PISS — Pi sin sidecar";

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
          source =
            files:
            nixpkgs.lib.fileset.toSource {
              root = ./.;
              fileset = nixpkgs.lib.fileset.unions files;
            };
          common = {
            version = "0.1.0";
            npmDepsHash = "sha256-73rUCd7l2SyuZtCvl9MPwEqWINmsKRIIbR3RDbIpD8I=";
            npmDepsFetcherVersion = 2;
          };
        in
        rec {
          piss-server = pkgs.buildNpmPackage (
            common
            // {
              pname = "piss-server";
              src = source [
                ./package.json
                ./package-lock.json
                ./server
                ./shared
                ./workflow-resources
              ];
              nativeBuildInputs = [ pkgs.makeWrapper ];
              npmBuildScript = "build:server";
              doCheck = false;
              installPhase = ''
                runHook preInstall

                mkdir -p $out/bin $out/lib/piss
                cp dist/server.js $out/lib/piss/server.js
                cp -r workflow-resources $out/lib/piss/workflow-resources
                npm prune --omit=dev --offline
                cp -r node_modules $out/lib/piss/node_modules

                makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/piss \
                  --add-flags $out/lib/piss/server.js \
                  --set PISS_WORKFLOW_RESOURCE_DIR $out/lib/piss/workflow-resources \
                  --prefix NODE_PATH : $out/lib/piss/node_modules \
                  --prefix PATH : ${
                    nixpkgs.lib.makeBinPath [
                      pkgs.gitMinimal
                      pkgs.bubblewrap
                    ]
                  }

                runHook postInstall
              '';
              meta = {
                description = "Effect-based PISS runtime server";
                homepage = "https://github.com/JonasThowsen/piss";
                license = nixpkgs.lib.licenses.mit;
                mainProgram = "piss";
                platforms = systems;
              };
            }
          );

          piss-web = pkgs.buildNpmPackage (
            common
            // {
              pname = "piss-web";
              src = source [
                ./package.json
                ./package-lock.json
                ./vite.config.ts
                ./shared
                ./web
              ];
              npmBuildScript = "build:web";
              doCheck = false;
              installPhase = ''
                runHook preInstall

                mkdir -p $out/share/piss
                cp -r dist/public $out/share/piss/public

                runHook postInstall
              '';
              meta = {
                description = "PISS browser shell";
                homepage = "https://github.com/JonasThowsen/piss";
                license = nixpkgs.lib.licenses.mit;
                platforms = systems;
              };
            }
          );

          piss = pkgs.buildNpmPackage (
            common
            // {
              pname = "piss";
              src = source [
                ./CONTRIBUTING.md
                ./LICENSE
                ./README.md
                ./SECURITY.md
                ./package.json
                ./package-lock.json
                ./playwright.config.ts
                ./tsconfig.json
                ./vite.config.ts
                ./browser-test
                ./server
                ./shared
                ./test
                ./web
                ./workflow-resources
              ];
              nativeBuildInputs = [ pkgs.makeWrapper ];
              nativeCheckInputs = [
                pkgs.chromium
                pkgs.fontconfig
                pkgs.dejavu_fonts
                pkgs.gitMinimal
                pkgs.bubblewrap
              ];
              PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "${pkgs.chromium}/bin/chromium";
              FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
              npmBuildScript = "build";
              doCheck = true;
              checkPhase = ''
                runHook preCheck
                npm run check
                CI=1 npm run test:browser
                runHook postCheck
              '';
              installPhase = ''
                runHook preInstall

                mkdir -p $out/bin $out/lib/piss
                cp dist/server.js $out/lib/piss/server.js
                cp -r dist/public $out/lib/piss/public
                cp -r workflow-resources $out/lib/piss/workflow-resources
                npm prune --omit=dev --offline
                cp -r node_modules $out/lib/piss/node_modules

                makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/piss \
                  --add-flags $out/lib/piss/server.js \
                  --set PISS_PUBLIC_DIR $out/lib/piss/public \
                  --set PISS_WORKFLOW_RESOURCE_DIR $out/lib/piss/workflow-resources \
                  --prefix NODE_PATH : $out/lib/piss/node_modules \
                  --prefix PATH : ${
                    nixpkgs.lib.makeBinPath [
                      pkgs.gitMinimal
                      pkgs.bubblewrap
                    ]
                  }

                runHook postInstall
              '';
              meta = {
                description = "Effect-based PISS workspace control plane";
                homepage = "https://github.com/JonasThowsen/piss";
                license = nixpkgs.lib.licenses.mit;
                mainProgram = "piss";
                platforms = systems;
              };
            }
          );

          default = piss;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.piss}/bin/piss";
          meta.description = "Run the Effect-based PISS control plane";
        };
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              chromium
              bubblewrap
              gitMinimal
              tailscale
              jq
              nixfmt
            ];
            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
              echo "PISS development shell — Node $(node --version)"
              echo "Run npm ci once, then npm run dev"
            '';
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
      overlays.default = final: _prev: {
        piss = self.packages.${final.stdenv.hostPlatform.system}.piss;
        piss-server = self.packages.${final.stdenv.hostPlatform.system}.piss-server;
        piss-web = self.packages.${final.stdenv.hostPlatform.system}.piss-web;
      };
      nixosModules.default = import ./nix/nixos-module.nix self;
    };
}
