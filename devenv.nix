{ pkgs, ... }:
let
  nodejs = pkgs.nodejs-slim_22;
  npm = pkgs.callPackage ./nix/npm.nix { inherit nodejs; };
  redis = pkgs.redis;
in
{
  # devenv.local.nix is loaded by devenv itself when present; importing it
  # here would apply it twice.

  # Avoid blocking shell startup on optional Cachix metadata checks. Nix's
  # configured substituters are still used for actual builds.
  cachix.enable = false;
  # Next.js loads the root .env through apps/web/.env; devenv must not export it.
  dotenv.disableHint = true;

  # https://devenv.sh/languages/
  languages.javascript = {
    enable = true;
    package = nodejs;
    npm = {
      enable = true;
      package = npm;
    };
  };

  # https://devenv.sh/packages/
  packages = [
    redis
    # The web app's SQLite database lives in apps/web/data and migrates itself
    # on startup; the CLI is for inspecting it.
    pkgs.sqlite
  ];

  # Start the one Redis shared by all active shells. `npm run dev` uses the
  # exported REDIS_URL instead of starting Docker. This hook runs inside
  # direnv's rc bash, which exports the environment from its own EXIT trap:
  # keep the work in the script below and never set a trap here.
  enterShell = ''
    if overtchat-redis start; then
      export REDIS_URL="$(overtchat-redis url)"
    else
      echo "OvertChat dev Redis is unavailable; run overtchat-redis start to retry." >&2
    fi
  '';

  # `devenv test` enters the shell first, so this checks what the hook produced.
  enterTest = ''
    test "$(node --version)" = "v${nodejs.version}"
    test "$(npm --version)" = "${npm.version}"
    test "$(redis-cli -u "$REDIS_URL" ping)" = PONG
  '';

  scripts = {
    overtchat-redis = {
      exec = ./nix/dev-redis.sh;
      packages = [
        redis
        nodejs
        pkgs.util-linuxMinimal
      ];
      description = "start or stop the repo-local dev Redis, or print its URL";
    };
    overtchat-redis-stop.exec = "overtchat-redis stop";
  };

  # See full reference at https://devenv.sh/reference/options/
}
