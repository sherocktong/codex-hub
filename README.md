# codx

A lightweight CLI for managing [OpenAI Codex CLI](https://github.com/openai/codex) profiles, hooks, sessions, and provider proxies.

codx is shaped like [`cc-hub`](https://github.com/anthropics/claude-code-hub) but tailored for Codex CLI. Its provider proxy subsystem is inspired by [`cc-switch`](https://github.com/anthropics/cc-switch) and supports multiple concurrent provider proxies — one per profile — so you can run Kimi on one port and Qianwen on another at the same time.

## Features

- **Profile management** — add, update, list, remove, and switch Codex CLI profiles.
- **Per-profile provider proxy** — each profile gets its own port; run multiple proxies simultaneously.
- **Provider adapters** — Kimi and Qianwen (DashScope) with OpenAI-compatible request/response transforms.
- **Prompt cache routing** — injects `prompt_cache_key` for the OpenAI Responses API when enabled.
- **Failover and circuit breakers** — automatic failover between providers with per-provider circuit breaker protection.
- **Usage logging** — request/token logs written to `~/.codex/codx/usage.jsonl`.
- **Shell completion** — bash/zsh/powershell completions (via Codex CLI style command).

## Install

```bash
npm install -g codx-cli
```

Requires Node.js 18+.

## Quick start

```bash
# Add a profile that routes to Kimi
codx profile add kimi-dev \
  --provider kimi \
  --model kimi-k2 \
  --token $KIMI_API_KEY \
  --proxy-port 15721

# Start its dedicated proxy
codx proxy start kimi-dev

# Launch Codex CLI through the proxy
codx run kimi-dev
```

## Commands

### Profiles

```bash
codx profile add <name> [options]
codx profile update <name> [options]
codx profile list
codx profile view <name>
codx profile remove <name>
codx profile rename <old> <new>
```

Common profile options:

- `-p, --provider <kimi|qianwen>` — primary provider type
- `-m, --model <model>` — model ID (can be used up to 3 times)
- `-t, --token <token>` — API key / token
- `-u, --url <url>` — base URL override

### Providers

```bash
codx provider list
```

### Run

```bash
# Launch Codex CLI with the default profile
codx run

# Launch with a specific profile
codx run kimi-dev

# Forward extra flags to Codex CLI
codx run kimi-dev -- --approval-mode full-auto
```

When you run a profile, codx automatically starts its provider proxy and points Codex CLI at `OPENAI_BASE_URL=<proxy url>`.

## Provider configuration

Provider presets are stored in `~/.codex/codx/providers.json`. Built-in presets:

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
