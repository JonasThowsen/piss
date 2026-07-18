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
        in
        rec {
          piss = pkgs.buildNpmPackage {
            pname = "piss";
            version = "0.1.0";
            src = nixpkgs.lib.fileset.toSource {
              root = ./.;
              fileset = nixpkgs.lib.fileset.unions [
                ./CONTRIBUTING.md
                ./LICENSE
                ./README.md
                ./SECURITY.md
                ./package.json
                ./package-lock.json
                ./tsconfig.json
                ./vite.config.ts
                ./extensions
                ./server
                ./shared
                ./test
                ./web
              ];
            };
            npmDepsHash = "sha256-ZzYl74tUwArCgxcLTAjg/D6/ycM9a/vsLBpok4zwxkI=";
            npmDepsFetcherVersion = 2;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            npmBuildScript = "build";
            doCheck = true;
            checkPhase = ''
              runHook preCheck
              npm run check
              runHook postCheck
            '';
            installPhase = ''
              runHook preInstall

              mkdir -p $out/bin $out/lib/piss $out/node_modules
              cp dist/server.js $out/lib/piss/server.js
              cp -r dist/public $out/lib/piss/public

              # Keep the Pi package at the output root. The extension needs ws
              # at runtime, while Pi provides its peer dependencies itself.
              cp CONTRIBUTING.md LICENSE README.md SECURITY.md package.json $out/
              cp -r extensions shared $out/
              cp -r node_modules/ws $out/node_modules/ws

              makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/piss \
                --add-flags $out/lib/piss/server.js

              runHook postInstall
            '';
            meta = {
              description = "Pi sin sidecar — private web control for live Pi sessions";
              homepage = "https://github.com/JonasThowsen/piss";
              license = nixpkgs.lib.licenses.mit;
              mainProgram = "piss";
              platforms = systems;
            };
          };
          default = piss;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.piss}/bin/piss";
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
              tailscale
              jq
              nixfmt
            ];
            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              echo "PISS development shell — Node $(node --version)"
              echo "Run npm ci once, then npm run dev"
            '';
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
      overlays.default = final: _prev: { piss = self.packages.${final.stdenv.hostPlatform.system}.piss; };
      nixosModules.default = import ./nix/nixos-module.nix self;
    };
}
