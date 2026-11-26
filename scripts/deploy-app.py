#!/usr/bin/env python3
"""App-only upgrade; invoked on the SSH target by just deploy, with explicit targets."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def inspect(container):
    return json.loads(run("podman", "inspect", container, stdout=subprocess.PIPE).stdout)[0]


def environment(container):
    return dict(item.split("=", 1) for item in container["Config"]["Env"] if "=" in item)


def check_target(app, ergo, args):
    env = environment(app)
    require(app["Name"].lstrip("/") == args.app, "App container mismatch")
    require(ergo["Name"].lstrip("/") == args.ergo and ergo["State"]["Running"], "Ergo target is not running")
    origin = env.get("APP_ORIGIN") or (f"https://{env['APP_HOST']}" if env.get("APP_HOST") else "")
    require(origin == args.origin, "App origin mismatch")
    require(env.get("DB_PATH") == "/data/chat.sqlite", "App database path mismatch")
    require(not env.get("SLIRC_DEV_PROFILE") and not env.get("DEV_IRC_NICK"), "Refusing a dev profile")
    require(env.get("ERGO_HOST") == args.ergo_host and env.get("ERGO_PORT") == "6667", "App IRC target mismatch")
    require(any(m.get("Name") == args.volume and m["Destination"] == "/data" and m["RW"] for m in app["Mounts"]), "App data mount mismatch")
    require(any(m.get("Name") == args.api_volume and m["Destination"] == "/run/secrets" and not m["RW"] for m in app["Mounts"]), "API mount mismatch")
    require(args.network in app["NetworkSettings"]["Networks"], "App network mismatch")
    require(ergo["NetworkSettings"]["Networks"][args.network]["IPAddress"] == args.ergo_host, "Ergo address mismatch")
    require(args.app_ip != args.ergo_host, "App address must differ from Ergo's")
    require(any(m["Destination"] == "/ircd/ircd.yaml" and m["Source"] == str(Path(args.config_dir) / "ergo.yaml") for m in ergo["Mounts"]), "Ergo config/profile mismatch")
    require(app["Config"]["Labels"].get("com.docker.compose.project") == args.app, "App Compose project mismatch")
    require(app["Config"]["Labels"].get("com.docker.compose.service") == "app", "App Compose service mismatch")


def check_writers(stopped_id, volume, migration_id=None):
    old = inspect(stopped_id)
    require(not old["State"]["Running"] and not old["State"].get("Paused"), "Old app is not stopped")
    require(old["HostConfig"]["RestartPolicy"]["Name"] == "no", "Old app restart policy is not disabled")
    ids = run("podman", "ps", "-q", "--no-trunc", stdout=subprocess.PIPE).stdout.split()
    for container_id in ids:
        if container_id == migration_id:
            continue
        container = inspect(container_id)
        require(not any(m.get("Name") == volume and m.get("RW") for m in container["Mounts"]), "Another running container can write app data")


def deploy(args):
    checkout = Path(args.checkout).resolve(strict=True)
    config = Path(args.config_dir).resolve(strict=True)
    require(str(config) == args.config_dir, "Config path must be canonical")
    require((config / "env").is_file() and (config / "env").stat().st_mode & 0o077 == 0, "Private env file must be mode 0600")
    require((config / "ergo.yaml").is_file(), "Missing Ergo config")
    require(not run("git", "-C", str(checkout), "status", "--porcelain", stdout=subprocess.PIPE).stdout.strip(), "Remote checkout is dirty")
    commit = run("git", "-C", str(checkout), "rev-parse", "HEAD", stdout=subprocess.PIPE).stdout.strip()
    app, ergo = inspect(args.app), inspect(args.ergo)
    check_target(app, ergo, args)
    require(app["State"]["Running"] and not app["State"].get("Paused"), "Expected a running old app")
    old_id, ergo_id = app["Id"], ergo["Id"]
    ergo_started = ergo["State"]["StartedAt"]
    policy = app["HostConfig"]["RestartPolicy"]["Name"]
    require(policy in ("unless-stopped", "always", "no"), "Unsupported app restart policy")
    image = f"localhost/slirc-app:{commit}"
    # Build and verify the shipped artifact before downtime. No checkout bind in migration.
    run("podman", "build", "-t", image, str(checkout / "app"))
    run("podman", "run", "--rm", "--network", "none", "--entrypoint", "sh", image,
        "-c", "test -f /app/src/direct-readiness.ts && test -f /app/src/grants.ts && test -f /app/src/main.ts")
    # Resolve every import the server makes inside the image, so a file .dockerignore leaves out stops
    # the deploy here instead of crash-looping the new container (agent harness registry, 16 Nov 2026).
    run("podman", "run", "--rm", "--network", "none", "--entrypoint", "bun", image,
        "build", "/app/src/main.ts", "--target=bun", "--outdir=/tmp/import-check")
    # The instance's IRC password key, kept outside the backed-up config folder.
    irc_key = os.environ.get("SLIRC_IRC_KEY_PATH") or str(Path.home() / ".config/slirc-keys" / args.app / "irc-key")
    require(Path(irc_key).is_file(), f"IRC key {irc_key} is missing; create it with openssl rand -out {irc_key} 32")
    compose_env = {**os.environ, "SLIRC_CONFIG_DIR": str(config), "SLIRC_APP_CONTAINER": args.app,
                   "SLIRC_APP_IMAGE": image, "SLIRC_APP_DATA_VOLUME": args.volume,
                   "SLIRC_ERGO_API_VOLUME": args.api_volume, "SLIRC_NETWORK": args.network,
                   "ERGO_IP": args.ergo_host, "SLIRC_APP_PORT": str(args.port), "SLIRC_APP_IP": args.app_ip,
                   "SLIRC_IRC_KEY_PATH": irc_key}
    migration_id = None
    replaced = False
    paused = False
    try:
        # Save and disable restart before stopping; never remove the old container on proof failure.
        print(f"Maintenance checkpoint: old app {old_id}; restart policy {policy}; image {app['Image']}", flush=True)
        paused = True
        run("podman", "update", "--restart=no", old_id, stdout=subprocess.DEVNULL)
        run("podman", "stop", "--time", "30", old_id, stdout=subprocess.DEVNULL)
        check_writers(old_id, args.volume)
        with tempfile.TemporaryDirectory(prefix="slirc-dm-upgrade-") as checkpoint:
            Path(checkpoint, "stopped").write_text(old_id)
            migration_id = run("podman", "create", "--network", args.network,
                "--env-file", str(config / "env"), "--env", "DB_PATH=/data/chat.sqlite",
                "--env", f"ERGO_HOST={args.ergo_host}", "--env", "ERGO_PORT=6667",
                "--env", f"APP_ORIGIN={args.origin}",
                "--volume", f"{args.volume}:/data", "--volume", f"{checkpoint}:/run/dm-upgrade:Z",
                "--entrypoint", "bun", image, "/app/src/direct-readiness.ts", "verify",
                args.origin, "/data/chat.sqlite", old_id, stdout=subprocess.PIPE).stdout.strip()
            print(f"Migration container: {migration_id}", flush=True)
            check_writers(old_id, args.volume)
            process = subprocess.Popen(["podman", "start", "--attach", migration_id])
            while process.poll() is None:
                if Path(checkpoint, "ready").exists() and not Path(checkpoint, "commit").exists():
                    require(Path(checkpoint, "ready").read_text() == old_id, "Wrong migration checkpoint")
                    check_writers(old_id, args.volume, migration_id)
                    require(inspect(ergo_id)["State"]["StartedAt"] == ergo_started, "Ergo restarted during proof")
                    Path(checkpoint, "commit.tmp").write_text(old_id)
                    Path(checkpoint, "commit.tmp").replace(Path(checkpoint, "commit"))
                time.sleep(0.1)
            require(process.returncode == 0, "Legacy verification failed; rollout aborted")
            check_writers(old_id, args.volume)
        run("podman", "rm", migration_id, stdout=subprocess.DEVNULL)
        migration_id = None
        # From here Compose can replace the old container. A subsequent failure needs an
        # operator rollback to the printed image, not a second app competing for the volume.
        print(f"Readiness verified. Previous app image for rollback: {app['Image']}", flush=True)
        replaced = True
        # Pinned address, so SLIRC_TRUSTED_PROXIES keeps naming the app across recreates (deploy/README.md).
        run("podman-compose", "--in-pod=false", "-p", args.app, "-f", str(checkout / "deploy/app.compose.yaml"),
            "-f", str(checkout / "deploy/app.fixed-ip.compose.yaml"), "up", "-d", "--no-build", "--force-recreate", env=compose_env)
    finally:
        if migration_id:
            # Captured ID belongs only to this invocation; closing SQLite rolls back pending writes.
            run("podman", "rm", "--force", migration_id, stdout=subprocess.DEVNULL)
        if paused and not replaced:
            run("podman", "update", f"--restart={policy}", old_id, stdout=subprocess.DEVNULL)
            run("podman", "start", old_id, stdout=subprocess.DEVNULL)
            print("Rollout stopped; original app container resumed. No mappings or history were removed.", flush=True)
        require(inspect(ergo_id)["State"]["StartedAt"] == ergo_started, "Ergo restarted")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("checkout", "config-dir", "app", "ergo", "volume", "api-volume", "network", "ergo-host", "app-ip", "origin"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    try:
        # Serialize this maintenance recipe; another invocation must not restart its old app.
        with open(Path(args.config_dir) / "app-deploy.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            deploy(args)
    except (AssertionError, OSError, subprocess.CalledProcessError) as error:
        # Never dump inspect JSON or env-file contents: they contain credentials.
        print(f"App deployment stopped: {error}", flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
