{ lib
, stdenv
, nodejs_24
, esbuild
, makeWrapper
, src
}:

# Nix package for the portly CLI, built from source (this repo's own tree).
#
# Because it builds from `src` rather than a pinned release artifact, there is
# nothing to update per release: `nix flake update portly` downstream just moves
# to the latest commit and rebuilds. There is also no hash to maintain at all.
#
# The CLI has zero runtime dependencies — every external import resolves to a
# Node builtin (verified: only `fs`/`path`), everything else is a relative
# import within the package. So we don't need pnpm, a lockfile or node_modules:
# we bundle src/cli.ts straight to a single file with esbuild (which is exactly
# what the package's tsup build wraps) and wrap it with a pinned Node.
#
# NOTE: this relies on portly staying dependency-free. If a real runtime npm
# dependency is ever added to packages/portly, this bare-esbuild bundle will
# fail to resolve it, and the package would need a pnpm-based build instead.

let
  pkgJson = lib.importJSON (src + "/packages/portly/package.json");
in
stdenv.mkDerivation {
  pname = "portly";
  version = pkgJson.version;

  inherit src;

  nativeBuildInputs = [ esbuild makeWrapper ];

  buildPhase = ''
    runHook preBuild

    # Mirror packages/portly/tsup.config.ts: ESM, Node platform, the __VERSION__
    # define, and the require() shim (tsup's `shims: true`) for turbo.ts's
    # CommonJS-style requires. Emit .mjs so Node treats the bundle as ESM.
    esbuild packages/portly/src/cli.ts \
      --bundle \
      --platform=node \
      --format=esm \
      --target=node24 \
      --define:__VERSION__='"${pkgJson.version}"' \
      --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
      --outfile=portly.mjs

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/libexec/portly
    cp portly.mjs $out/libexec/portly/portly.mjs

    makeWrapper ${nodejs_24}/bin/node $out/bin/portly \
      --add-flags $out/libexec/portly/portly.mjs

    runHook postInstall
  '';

  meta = with lib; {
    description = pkgJson.description;
    homepage = "https://portly.sh";
    license = licenses.asl20;
    platforms = nodejs_24.meta.platforms;
    mainProgram = "portly";
  };
}
