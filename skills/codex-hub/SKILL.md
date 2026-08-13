# Skill: codex-hub

Use the `codex-hub` CLI to manage OpenAI Codex CLI profiles, hooks, sessions, and provider proxies.

## Working with profiles

- Add a Kimi profile:

  ```bash
  codex-hub profile add kimi-dev --provider kimi --model kimi-k2 --token $KIMI_API_KEY --proxy-port 15721
  ```

- Add a Qianwen profile:

  ```bash
  codex-hub profile add qwen-dev --provider qianwen --model qwen-max --token $DASHSCOPE_API_KEY --proxy-port 15722
  ```

- Set a default profile:

  ```bash
  codex-hub use kimi-dev
  ```

- View profile details:

  ```bash
  codex-hub profile view kimi-dev
  ```

## Running Codex CLI through a proxy

`codex-hub run` starts the profile's dedicated provider proxy and launches Codex CLI with `OPENAI_BASE_URL` pointing at that proxy.

```bash
codex-hub run              # default profile
codex-hub run kimi-dev     # specific profile
codex-hub run kimi-dev -- --approval-mode full-auto   # pass flags to Codex CLI
```

## Managing proxies

- Start a proxy manually:

  ```bash
  codex-hub proxy start kimi-dev
  ```

- Stop a proxy:

  ```bash
  codex-hub proxy stop kimi-dev
  ```

- List running proxies:

  ```bash
  codex-hub proxy status
  ```

Each profile has its own proxy port, so multiple proxies can run at the same time.

## Provider failover

Add backup providers with `codex-hub proxy provider add`, then reference them when creating a profile:

```bash
codex-hub proxy provider add kimi-backup --type kimi --url https://api.moonshot.cn --api-key $KIMI_API_KEY2 -m kimi-k2

codex-hub profile add stable --provider kimi --model kimi-k2 --token $KIMI_API_KEY --providers kimi-backup --proxy-port 15723
```

## Prompt cache routing

Cache routing is `auto` by default. For Kimi/Qianwen adapters, `/v1/responses` requests get a stable `prompt_cache_key` injected. Control it per profile:

```bash
codex-hub profile update kimi-dev --prompt-cache-routing enabled
codex-hub profile update kimi-dev --prompt-cache-routing disabled
```

## Common flags

- `-m, --model <model>` — model ID (repeatable, up to 3)
- `-t, --token <token>` — API key/token
- `-u, --url <url>` — provider base URL override
- `-p, --provider <kimi|qianwen>` — primary provider type
- `--proxy-port <port>` — dedicated proxy port
- `--providers <ids>` — comma-separated failover provider IDs
- `--prompt-cache-routing <auto|enabled|disabled>` — cache routing mode

## Diagnostics

- Check proxy health:

  ```bash
  curl http://127.0.0.1:<proxy-port>/health
  ```

- List models exposed by the proxy:

  ```bash
  curl http://127.0.0.1:<proxy-port>/v1/models
  ```

- Usage logs are appended to `~/.codex/codex-hub/usage.jsonl`.

## Important rules

- Always prefer `codex-hub run <profile>` over calling `codex` directly when you want requests routed through a provider proxy.
- Do not share provider API keys in plain text; use environment variables and the `--token` flag.
- When adding a failover queue, make sure every provider ID exists in `codex-hub proxy provider list` first.
- If a proxy fails to start on the configured port, use `--proxy-port 0` to let the OS allocate a free port.
