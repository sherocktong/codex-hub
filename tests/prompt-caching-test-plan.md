# Prompt Caching Test Plan

## 1. Objectives

Verify that `codx` correctly routes OpenAI-compatible requests to Kimi and Qianwen upstreams so that prompt caching is enabled, stable, observable, and cost-efficient. The test plan covers unit, integration, and end-to-end scenarios.

## 2. Scope

### In scope

- Cache key selection (`selectCacheKeySource`).
- Injection of `prompt_cache_key` for `/v1/responses`.
- Absence of `prompt_cache_key` for `/v1/chat/completions`.
- Provider adapters (`kimi`, `qianwen`) honoring `shouldEnablePromptCacheRouting`.
- Model normalization and upstream URL building.
- SSE streaming with UTF-8-safe buffering.
- Usage parsing (`cached_tokens`, `cache_write_tokens`).
- Cost computation with cache read/write rates.
- Per-profile proxy instances and concurrent proxies.
- End-to-end forwarding to a mock upstream.

### Out of scope

- Real upstream provider billing verification.
- Browser-based or UI testing.
- Load/performance benchmarks beyond concurrency smoke tests.
- Provider authentication token refresh flows.

## 3. Test Strategy

| Level | Approach | Tools |
|-------|----------|-------|
| Unit | Test pure functions in isolation. | Vitest |
| Integration | Test adapters + cache-key logic with mocked `fetch`. | Vitest + `vi.fn()` |
| Server | Spin up `startProxyServer` with `createRequestHandler` and a local mock upstream. | Vitest + `node:http` |
| E2E CLI | Use the linked `codx` binary to start a profile proxy and call `/v1/responses`. | Shell + `curl` |

## 4. Test Environment

- Node.js 18+.
- `codx` built and linked via `npm link`.
- Local mock upstream on `127.0.0.1` random port.
- `~/.codex/codx/providers.json` contains the default Kimi and Qianwen presets.

## 5. Detailed Test Cases

### 5.1 Cache Key Routing (`src/proxy/cache-key.ts`)

| ID | Scenario | Steps | Expected Result | Priority |
|----|----------|-------|-----------------|----------|
| CK-01 | Prefer session id | Call `selectCacheKeySource` with `sessionId` set. | Returns the session id. | P1 |
| CK-02 | Fallback key | Call `selectCacheKeySource` without `sessionId`. | Returns `profile:provider:model`. | P1 |
| CK-03 | Inject for Responses | Call `injectPromptCacheKey` with path `/v1/responses`. | Body contains `prompt_cache_key`. | P1 |
| CK-04 | Skip for Chat Completions | Call `injectPromptCacheKey` with path `/v1/chat/completions`. | Body does **not** contain `prompt_cache_key`. | P1 |
| CK-05 | Stable fallback key | Call twice with the same profile/provider/model. | Returns identical string. | P2 |
| CK-06 | Different sessions get different keys | Call with two different `sessionId` values. | Keys differ. | P2 |

### 5.2 Provider Adapters (`src/proxy/providers/kimi.ts`, `src/proxy/providers/qianwen.ts`)

| ID | Scenario | Steps | Expected Result | Priority |
|----|----------|-------|-----------------|----------|
| AD-01 | Kimi injects cache key | Transform a `/v1/responses` request with Kimi. | Upstream body has `prompt_cache_key` and `model` normalized. | P1 |
| AD-02 | Qianwen injects cache key | Transform a `/v1/responses` request with Qianwen. | Upstream body has `prompt_cache_key` and `model` normalized. | P1 |
| AD-03 | Chat completions skip cache key | Transform a `/v1/chat/completions` request. | Upstream body has no `prompt_cache_key`. | P1 |
| AD-04 | Authorization header set | Inspect transformed headers. | `Authorization: Bearer <provider.apiKey>`. | P1 |
| AD-05 | Host header removed | Inspect transformed headers. | No `host` header is forwarded. | P2 |
| AD-06 | Kimi reasoning block | Stream chunk contains `delta.reasoning_content`. | Transformed chunk contains `delta.reasoning`. | P2 |
| AD-07 | Model alias mapping | Request body uses an alias mapped by the provider. | Upstream body uses the mapped model id. | P2 |
| AD-08 | Unknown model fallback | Request body uses an unlisted model. | Upstream body falls back to provider default model. | P2 |

### 5.3 Usage Parsing (`src/proxy/providers/index.ts`)

| ID | Scenario | Steps | Expected Result | Priority |
|----|----------|-------|-----------------|----------|
| UP-01 | Parse standard OpenAI usage | Call `parseOpenAIUsage` with `prompt_tokens`, `completion_tokens`, `cached_tokens`, `cache_write_tokens`. | Returns correct input/output/cache read/cache creation counts. | P1 |
| UP-02 | Parse `input_tokens_details` | Provide `input_tokens_details.cached_tokens` and `cache_write_tokens`. | Returns correct cache counts. | P2 |
| UP-03 | Missing usage | Call `parseOpenAIUsage({})`. | Returns `undefined`. | P2 |
| UP-04 | Zero counts | Provide usage object with all zeros. | Returns zeros, not `undefined`. | P2 |

### 5.4 Cost Computation (`src/proxy/usage.ts`)

| ID | Scenario | Steps | Expected Result | Priority |
|----|----------|-------|-----------------|----------|
| CC-01 | Kimi cost with cache read | `computeCost("kimi", usageWithCacheRead)`. | Cost reflects non-cache input at input rate and cache read at cache-read rate. | P1 |
| CC-02 | Qianwen cost with cache write | `computeCost("qianwen", usageWithCacheWrite)`. | Cost reflects cache write at cache-write rate. | P1 |
| CC-03 | Unknown provider | `computeCost("unknown", usage)`. | Returns `undefined`. | P2 |
| CC-04 | Non-cache input only | Usage with no cache tokens. | Cost equals input tokens × input rate + output tokens × output rate. | P2 |

### 5.5 SSE Streaming (`src/proxy/sse.ts`)

| ID | Scenario | Steps | Expected Result | Priority |
|----|----------|-------|-----------------|----------|
| SSE-01 | Complete blocks | Feed `"data: a\n\ndata: b\n\n"` into `splitSseBlocks`. | Yields two blocks, remaining empty. | P1 |
| SSE-02 | Partial block buffered | Feed `"data: partial"`. | Yields nothing, remaining equals input. | P1 |
| SSE-03 | Multi-byte UTF-8 split | Feed a 3-byte UTF-8 character split across two chunks. | `appendUtf8Safe` produces valid character. | P2 |
| SSE-04 | Serialize block | Call `serializeSseBlock({ data: "[DONE]" })`. | Output is `"data: [DONE]\n\n"`. | P2 |
| SSE-05 | Parse fields | Parse `"data: {}\nevent: completion"`. | Fields object has correct keys/values. | P2 |

### 5.6 Proxy Server Integration (`src/proxy/server.ts`, `src/proxy/handlers.ts`)

| ID | Scenario | Steps | Expected Result | Priority |
|----|----------|-------|-----------------|----------|
| PS-01 | Health endpoint | `GET /health` on a running proxy. | Returns `200 { status: "ok", profile }`. | P1 |
| PS-02 | Models endpoint | `GET /v1/models` with Kimi + Qianwen providers. | Returns union of provider model ids. | P1 |
| PS-03 | Forward chat completion | `POST /v1/chat/completions` to mock upstream. | Upstream receives normalized model; client gets 200 response. | P1 |
| PS-04 | Forward responses with cache key | `POST /v1/responses` to mock upstream. | Upstream body includes `prompt_cache_key`. | P1 |
| PS-05 | Invalid JSON body | `POST /v1/responses` with malformed JSON. | Returns `400 invalid_request_error`. | P2 |
| PS-06 | Unknown endpoint | `POST /unknown`. | Returns `404 not_found`. | P2 |
| PS-07 | Concurrent proxies | Start two profile proxies simultaneously. | Both bind to distinct ports in `57000-57999`. | P1 |
| PS-08 | Port range allocation | Start proxy repeatedly. | Every bound port is inside `57000-57999`. | P2 |
| PS-09 | Stop all proxies | Call `stopAllProxies` after starting two proxies. | Both servers close and ports are free. | P1 |

### 5.7 CLI / End-to-End

| ID | Scenario | Steps | Expected Result | Priority |
|----|----------|-------|-----------------|----------|
| CLI-01 | `provider list` | Run `codx provider list`. | Lists Kimi and Qianwen with `promptCacheRouting: enabled`. | P1 |
| CLI-02 | `profile add -p kimi` | Add a profile with Kimi provider. | Output shows proxy URL and provider URL. | P1 |
| CLI-03 | `run` starts proxy | Run `codx run <profile>` and hit `/health`. | Returns `200 ok`. | P1 |
| CLI-04 | `proxy stop` stops all | Start two profile proxies, run `codx proxy stop`, retry `/health`. | Both proxies are unreachable. | P1 |
| CLI-05 | Cache key in response | Send two identical `/v1/responses` via proxy. | Both include stable `prompt_cache_key`; mock upstream sees the same key. | P1 |

## 6. Test Data

- Long static system prompt (`≥1024` tokens) reused across requests.
- Short dynamic user suffix changed per request.
- Mock upstream responses with:
  - Standard Chat Completions usage shape.
  - Responses API usage shape.
  - Missing usage.
- Multi-byte UTF-8 chunks for SSE tests.

## 7. Entry / Exit Criteria

### Entry criteria

- `npm run build` succeeds.
- `npm test` currently passes.
- `codx --version` works when linked.

### Exit criteria

- All P1 test cases pass.
- No regressions in existing test suite.
- Cache key behavior matches OpenAI guide recommendations:
  - Stable key for shared prefixes.
  - `prompt_cache_key` only on `/v1/responses`.

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Port `57000-57999` already in use on CI machine. | Test flakiness. | Use `port: 0` in unit tests; mock `isPortAvailable` if needed. |
| Upstream provider response shapes differ from OpenAI spec. | Parsing misses cache tokens. | Keep provider adapters isolated and add per-provider parsing tests. |
| Race conditions in concurrent proxy startup. | Tests fail intermittently. | Serialize startup assertions and add retry for port availability. |
| Existing `proxy-integration.test.ts` references removed fields. | Build/test failure. | Update the test to match current `ProxyInstanceConfig` shape. |

## 9. Execution Checklist

- [ ] Run existing tests: `npm test`.
- [ ] Add/update cache-key tests (CK-05, CK-06).
- [ ] Add adapter tests (AD-05, AD-06, AD-07, AD-08).
- [ ] Add usage parsing tests (UP-02, UP-03, UP-04).
- [ ] Add cost computation tests (CC-01, CC-02, CC-03, CC-04).
- [ ] Add SSE multi-byte test (SSE-03).
- [ ] Add proxy integration tests for `/v1/responses` and cache key (PS-04).
- [ ] Add concurrent proxy tests (PS-07, PS-08, PS-09).
- [ ] Run CLI smoke tests (CLI-01 through CLI-05).
- [ ] Review and update this plan after implementation.
