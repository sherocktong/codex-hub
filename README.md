# codex-hub

A lightweight CLI for managing [OpenAI Codex CLI](https://github.com/openai/codex) profiles, hooks, sessions, and provider proxies.

codex-hub is shaped like [`cc-hub`](https://github.com/anthropics/claude-code-hub) but tailored for Codex CLI. Its provider proxy subsystem is inspired by [`cc-switch`](https://github.com/anthropics/cc-switch) and supports multiple concurrent provider proxies — one per profile — so you can run Kimi on one port and Qianwen on another at the same time.

## Features

- **Profile management** — add, update, list, remove, and switch Codex CLI profiles.
- **Per-profile provider proxy** — each profile gets its own port; run multiple proxies simultaneously.
- **Provider adapters** — Kimi and Qianwen (DashScope) with OpenAI-compatible request/response transforms.
- **Prompt cache routing** — injects `prompt_cache_key` for the OpenAI Responses API when enabled.
- **Failover and circuit breakers** — automatic failover between providers with per-provider circuit breaker protection.
- **Usage logging** — request/token logs written to `~/.codex/codex-hub/usage.jsonl`.
- **Shell completion** — bash/zsh/powershell completions (via Codex CLI style command).

## Install

```bash
npm install -g codex-hub-cli
```

Requires Node.js 18+.

## Quick start

```bash
# Add a profile that routes to Kimi
codex-hub profile add kimi-dev \
  --provider kimi \
  --model kimi-k2 \
  --token $KIMI_API_KEY \
  --proxy-port 15721

# Start its dedicated proxy
codex-hub proxy start kimi-dev

# Launch Codex CLI through the proxy
codex-hub run kimi-dev
```

## Commands

### Profiles

```bash
codex-hub profile add <name> [options]
codex-hub profile update <name> [options]
codex-hub profile list
codex-hub profile view <name>
codex-hub profile remove <name>
codex-hub profile rename <old> <new>
```

Common profile options:

- `-p, --provider <kimi|qianwen>` — primary provider type
- `-m, --model <model>` — model ID (can be used up to 3 times)
- `-t, --token <token>` — API key / token
- `-u, --url <url>` — base URL override

### Providers

```bash
codex-hub provider list
```

### Run

```bash
# Launch Codex CLI with the default profile
codex-hub run

# Launch with a specific profile
codex-hub run kimi-dev

# Forward extra flags to Codex CLI
codex-hub run kimi-dev -- --approval-mode full-auto
```

When you run a profile, codex-hub automatically starts its provider proxy and points Codex CLI at `OPENAI_BASE_URL=<proxy url>`.

## Provider configuration

Provider presets are stored in `~/.codex/codex-hub/providers.json`. Built-in presets:

- `kimi` — `https://api.kimi.com/coding` (model `kimi-k2-5-coding`)
- `qianwen` — `https://dashscope.aliyuncs.com/compatible-mode/v1` (model `qwen-max`)

You can override base URL and API key per profile.

## Prompt caching

For `/v1/responses`, the proxy injects a stable `prompt_cache_key` derived from the Codex session ID or from the profile/provider/model tuple. Prompt cache routing is always enabled for Kimi and Qianwen to maximize token savings.

## Development

```bash
npm install
npm run dev        # watch build
npm test           # Vitest
npm run build      # tsup
npm run test:build # tests + build
```

## License

MIT
