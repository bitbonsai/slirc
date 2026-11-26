set dotenv-load := true
set shell := ["bash", "-euo", "pipefail", "-c"]

deploy_host := env_var_or_default("SLIRC_DEPLOY_HOST", "chat.example.com")
checkout := env_var_or_default("SLIRC_CHECKOUT", "/srv/slirc")
config_dir := env_var_or_default("SLIRC_CONFIG_DIR", "./config")
deploy_instance := env_var_or_default("SLIRC_INSTANCE", "slirc")
deploy_app := env_var_or_default("SLIRC_APP_CONTAINER", deploy_instance)
deploy_ergo := env_var_or_default("SLIRC_ERGO_CONTAINER", deploy_instance + "-ergo")
deploy_network := env_var_or_default("SLIRC_NETWORK", deploy_instance)
deploy_subnet := env_var_or_default("SLIRC_SUBNET", "10.89.0.0/24")
deploy_ergo_ip := env_var_or_default("ERGO_IP", "10.89.0.2")
deploy_app_ip := env_var_or_default("SLIRC_APP_IP", "10.89.0.14")
deploy_origin := env_var_or_default("SLIRC_ORIGIN", "https://chat.example.com")
deploy_port := env_var_or_default("SLIRC_APP_PORT", "9010")
deploy_app_volume := env_var_or_default("SLIRC_APP_DATA_VOLUME", deploy_instance + "-data")
deploy_ergo_data_volume := env_var_or_default("SLIRC_ERGO_DATA_VOLUME", deploy_instance + "-ergo-data")
deploy_ergo_api_volume := env_var_or_default("SLIRC_ERGO_API_VOLUME", deploy_instance + "-ergo-api")
deploy_irc_key_path := env_var_or_default("SLIRC_IRC_KEY_PATH", "")

import "scripts/just/dev.just"
import "scripts/just/deploy.just"
import "scripts/just/ops.just"
