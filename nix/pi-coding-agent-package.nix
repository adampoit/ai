{
  buildNpmPackage,
  fd,
  fetchzip,
  jq,
  lib,
  makeBinaryWrapper,
  nodejs_22,
  npm-lockfile-fix,
  ripgrep,
  stdenvNoCC,
}: let
  dependency = import ./pi-coding-agent-source.nix;
  buildNpmPackageNode22 = buildNpmPackage.override {nodejs = nodejs_22;};
in
  buildNpmPackageNode22 {
    pname = "pi-coding-agent";
    inherit (dependency) version npmDepsHash;

    src = fetchzip (dependency.source
      // {
        nativeBuildInputs = [npm-lockfile-fix];
        postFetch = ''
          ${lib.getExe npm-lockfile-fix} $out/npm-shrinkwrap.json
        '';
      });
    npmDepsFetcherVersion = 2;
    npmFlags = ["--omit=dev"];
    npmRebuildFlags = ["--ignore-scripts"];
    dontNpmBuild = true;

    nativeBuildInputs = [makeBinaryWrapper];

    postPatch = ''
      ${jq}/bin/jq 'del(.devDependencies)' package.json > package.json.tmp
      mv package.json.tmp package.json
    '';

    postInstall = lib.optionalString stdenvNoCC.hostPlatform.isDarwin ''
      local nm="$out/lib/node_modules/@earendil-works/pi-coding-agent/node_modules"
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
