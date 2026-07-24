{
  fetchurl,
  lib,
  stdenvNoCC,
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "xterm-headless";
  version = "6.0.0";

  src = fetchurl {
    url = "https://registry.npmjs.org/@xterm/headless/-/headless-${finalAttrs.version}.tgz";
    hash = "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==";
  };
  sourceRoot = "package";

  dontBuild = true;

  installPhase = ''
    runHook preInstall
    cp -R . "$out"
    runHook postInstall
  '';

  meta = {
    description = "Headless terminal component that runs in Node.js";
    homepage = "https://github.com/xtermjs/xterm.js";
    license = lib.licenses.mit;
  };
})
