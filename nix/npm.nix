{
  stdenvNoCC,
  fetchurl,
  makeWrapper,
  nodejs,
}:

let
  packageManager = (builtins.fromJSON (builtins.readFile ../package.json)).packageManager;
  pinnedVersion = builtins.match "npm@([0-9]+\\.[0-9]+\\.[0-9]+)" packageManager;
in
# The npm bundled with nixpkgs' Node moves with Node releases. The Validate
# workflow regenerates package-lock.json with the exact pinned npm, so the
# shell runs that release from the registry tarball instead.
assert
  pinnedVersion != null
  || throw "nix/npm.nix expects packageManager = npm@x.y.z in package.json.";
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "npm";
  version = builtins.head pinnedVersion;

  src = fetchurl {
    url = "https://registry.npmjs.org/npm/-/npm-${finalAttrs.version}.tgz";
    # Update this hash (the registry's dist.integrity) alongside package.json's
    # packageManager pin.
    hash = "sha512-fYwb6ODSmHkqrJQQaCxY3M2lPf/mpgC7ik0HSzzIwG5CGtabRp4bNqikatvCoT42b5INQSqudVH0R7yVmC9hVg==";
  };

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/node_modules/npm
    cp -r . $out/lib/node_modules/npm
    for command in npm npx; do
      makeWrapper ${nodejs}/bin/node $out/bin/$command \
        --add-flags $out/lib/node_modules/npm/bin/$command-cli.js
    done
    runHook postInstall
  '';
})
