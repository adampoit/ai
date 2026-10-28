{
  alsa-lib,
  autoPatchelfHook,
  cups,
  fetchurl,
  fontconfig,
  freetype,
  lib,
  libGL,
  libx11,
  libxext,
  libxi,
  libxrender,
  libxtst,
  stdenv,
  stdenvNoCC,
  unzip,
}: let
  version = "263.7084.0";
  system = stdenv.hostPlatform.system;
  releases = {
    aarch64-darwin = {
      archive = "kotlin-server-${version}-aarch64.sit";
      hash = "sha256-tAO/ilS9RY47pnMc+KuzNAvgi0OcA1dt/AKxP682lLg=";
    };
    x86_64-darwin = {
      archive = "kotlin-server-${version}.sit";
      hash = "sha256-spw5Ol5UEVPQPWJueUYmhDfjWKZnpfkUoSbbtAB2ZLE=";
    };
    aarch64-linux = {
      archive = "kotlin-server-${version}-aarch64.tar.gz";
      hash = "sha256-RQq3wdgOSBBqpCm0jLQibYLKEqiiQARHrgI4Z5R4DKw=";
    };
    x86_64-linux = {
      archive = "kotlin-server-${version}.tar.gz";
      hash = "sha256-rgxLAeF6tzpKUienjqmebcvj5JlgAxWyJ1mk5M3dEd8=";
    };
  };
  release = releases.${system} or (throw "kotlin-lsp: unsupported system ${system}");
  builder =
    if stdenv.hostPlatform.isDarwin
    then stdenvNoCC
    else stdenv;
in
  builder.mkDerivation {
    pname = "kotlin-lsp";
    inherit version;

    src = fetchurl {
      url = "https://download.jetbrains.com/language-server/kotlin-server/${version}/${release.archive}";
      inherit (release) hash;
    };

    nativeBuildInputs =
      [unzip]
      ++ lib.optionals stdenv.hostPlatform.isLinux [autoPatchelfHook];
    buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
      alsa-lib
      cups
      fontconfig
      freetype
      libGL
      libx11
      libxext
      libxi
      libxrender
      libxtst
      stdenv.cc.cc
    ];

    unpackPhase = ''
      runHook preUnpack
      ${
        if stdenv.hostPlatform.isDarwin
        # JetBrains uses a .sit suffix for Darwin, but these are ZIP archives.
        then "unzip -q $src"
        else "tar -xzf $src"
      }
      cd kotlin-server-${version}
      runHook postUnpack
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/libexec $out/bin
      cp -a . $out/libexec
      chmod +x $out/libexec/bin/intellij-server
      ln -s $out/libexec/bin/intellij-server $out/bin/kotlin-lsp
      runHook postInstall
    '';

    dontFixup = stdenv.hostPlatform.isDarwin;
    dontStrip = true;
    autoPatchelfIgnoreMissingDeps = true;

    meta = {
      description = "Official Kotlin language server from JetBrains";
      homepage = "https://github.com/Kotlin/kotlin-lsp";
      license = lib.licenses.asl20;
      mainProgram = "kotlin-lsp";
      platforms = builtins.attrNames releases;
      sourceProvenance = [lib.sourceTypes.binaryNativeCode];
    };
  }
