{
  buildNpmPackage,
  fd,
  fetchFromGitHub,
  lib,
  makeBinaryWrapper,
  nodejs_22,
  ripgrep,
  stdenvNoCC,
}: let
  dependency = import ./pi-coding-agent-source.nix;
  buildNpmPackageNode22 = buildNpmPackage.override {nodejs = nodejs_22;};
in
  buildNpmPackageNode22 {
    pname = "pi-coding-agent";
    inherit (dependency) version npmDepsHash;

    src = fetchFromGitHub dependency.source;
    npmWorkspace = "packages/coding-agent";
    npmDepsFetcherVersion = 2;
    npmRebuildFlags = ["--ignore-scripts"];

    nativeBuildInputs = [makeBinaryWrapper];

    buildPhase = ''
      runHook preBuild

      npx tsgo -p packages/ai/tsconfig.build.json
      npx tsgo -p packages/tui/tsconfig.build.json
      npx tsgo -p packages/agent/tsconfig.build.json
      npm run build --workspace=packages/coding-agent

      runHook postBuild
    '';

    postInstall =
      ''
        local nm="$out/lib/node_modules/pi-monorepo/node_modules"

        for ws in @earendil-works/pi-ai:packages/ai \
                  @earendil-works/pi-agent-core:packages/agent \
                  @earendil-works/pi-tui:packages/tui; do
          IFS=: read -r pkg src <<< "$ws"
          rm "$nm/$pkg"
          cp -r "$src" "$nm/$pkg"
        done

        find "$nm" -type l -lname '*/packages/*' -delete
        find "$nm/.bin" -xtype l -delete
      ''
      + lib.optionalString stdenvNoCC.hostPlatform.isDarwin ''
        rm -rf \
          "$nm/@anthropic-ai/sandbox-runtime/dist/vendor/seccomp" \
          "$nm/@anthropic-ai/sandbox-runtime/vendor/seccomp"
      '';

    postFixup = ''
      wrapProgram $out/bin/pi --prefix PATH : ${
        lib.makeBinPath [
          fd
          ripgrep
        ]
      }
    '';

    meta = {
      description = "Coding agent CLI with read, bash, edit, write tools and session management";
      homepage = "https://pi.dev/";
      license = lib.licenses.mit;
      mainProgram = "pi";
    };
  }
