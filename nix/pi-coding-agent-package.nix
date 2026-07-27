{
  buildNpmPackage,
  fd,
  fetchurl,
  jq,
  lib,
  makeBinaryWrapper,
  nodejs_22,
  ripgrep,
  stdenvNoCC,
}: let
  dependency = import ./pi-coding-agent-source.nix;
  packageLock = builtins.fromJSON (builtins.readFile ../package-lock.json);
  piPackageIntegrity = package:
    packageLock.packages."node_modules/@earendil-works/${package}".integrity;
  buildNpmPackageNode22 = buildNpmPackage.override {nodejs = nodejs_22;};
in
  buildNpmPackageNode22 {
    pname = "pi-coding-agent";
    inherit (dependency) version npmDepsHash;

    src = fetchurl dependency.source;
    npmDepsFetcherVersion = 2;
    npmFlags = ["--omit=dev"];
    npmRebuildFlags = ["--ignore-scripts"];
    dontNpmBuild = true;

    nativeBuildInputs = [makeBinaryWrapper];

    postPatch = let
      addPiPackageIntegrity = package: ''
        substituteInPlace npm-shrinkwrap.json \
          --replace-fail \
          '"resolved": "https://registry.npmjs.org/@earendil-works/pi-${package}/-/pi-${package}-${dependency.version}.tgz"' \
          '"resolved": "https://registry.npmjs.org/@earendil-works/pi-${package}/-/pi-${package}-${dependency.version}.tgz", "integrity": "${piPackageIntegrity "pi-${package}"}"'
      '';
    in
      addPiPackageIntegrity "agent-core"
      + addPiPackageIntegrity "ai"
      + addPiPackageIntegrity "tui"
      + ''
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
