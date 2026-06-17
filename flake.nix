{
  description = "portly — replace port numbers with stable, named .localhost URLs";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        portly = pkgs.callPackage ./nix/portly.nix { src = self; };
        default = portly;
      });

      apps = forAllSystems (pkgs:
        let pkg = self.packages.${pkgs.system}.portly; in
        rec {
          portly = { type = "app"; program = "${pkg}/bin/portly"; };
          default = portly;
        });
    };
}
