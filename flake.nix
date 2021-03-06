{
  description = "nix dev environment";

  inputs.flake-utils.url = "github:numtide/flake-utils";
  inputs.pnpm2nix.url = "github:LavaDesu/pnpm2nix/next";
  inputs.ramune = { url = "github:LavaDesu/ramune/0.0.12"; flake = false; };

  outputs = { self, nixpkgs, pnpm2nix, ramune, flake-utils }:
    flake-utils.lib.eachDefaultSystem(system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
      pnpm = import pnpm2nix { inherit pkgs; };
    in rec {
      devShell = pkgs.mkShell {
        buildInputs = with pkgs; [ nodejs-16_x watchman ];
      };
      defaultPackage = pnpm.mkPnpmPackage {
        src = ./.;
        srcOverrides.ramune = ramune;
        overrides = {
          ramune = (drv: drv.overrideAttrs(oldAttrs: {
            buildInputs = oldAttrs.buildInputs ++ [ pkgs.nodePackages.typescript ];
          }));
        };

        linkDevDependencies = true;

        outputs = [ "out" ];
        buildInputs = [ pkgs.nodePackages.typescript ];

        installPhase = ''
          runHook preInstall

          mv node_modules/blob work
          mv node_modules work/node_modules

          cd work
          tsc

          cd ..
          mv work $out

          runHook postInstall
        '';
      };
    });
}
