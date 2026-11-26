[group('operations')]
status:
  ssh {{deploy_host}} 'podman ps; curl -fsS http://127.0.0.1:{{deploy_port}}/healthz'

[group('operations')]
logs service:
  case "{{service}}" in app) container={{deploy_app}};; ergo) container={{deploy_ergo}};; *) echo "usage: just logs app|ergo" >&2; exit 1;; esac
  ssh -t {{deploy_host}} "podman logs -f $container"
