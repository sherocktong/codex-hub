import type {
  ProviderConfig,
  ProviderType,
  ProxyConfig,
  ProxyStatus,
  TokenUsage,
} from "../types.js";

export interface ProxyInstanceConfig {
  profileName: string;
  port: number;
  listenAddress: string;
  providers: ProviderConfig[];
  requestTimeout: number;
  maxRetries: number;
  streamingFirstByteTimeout: number;
  streamingIdleTimeout: number;
  nonStreamingTimeout: number;
}

export interface RequestContext {
  profileName: string;
  provider: ProviderConfig;
  failoverQueue: ProviderConfig[];
  request: Request;
  body: Record<string, unknown>;
  path: string;
  method: string;
  headers: Headers;
  startTime: number;
  sessionId?: string;
  attempt: number;
  state: Record<string, unknown>;
}

export interface ForwardResult {
  response: Response;
  provider: ProviderConfig;
  ctx: RequestContext;
  usage?: TokenUsage;
}

export interface ProviderAdapter {
  type: ProviderType;
  name: string;
  transformRequest(ctx: RequestContext): Promise<Request>;
  transformResponse(ctx: RequestContext, response: Response): Promise<Response>;
  transformStreamChunk?(
    ctx: RequestContext,
    chunk: Record<string, unknown>,
  ): Record<string, unknown> | Record<string, unknown>[];
  parseUsage?(chunk: Record<string, unknown>): TokenUsage | undefined;
  supportsPromptCacheRouting: boolean;
  translateError?(response: Response, bodyText: string): Promise<Response | undefined>;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeoutSeconds: number;
  errorRateThreshold: number;
  minRequests: number;
}

export { ProviderConfig, ProviderType, ProxyConfig, ProxyStatus, TokenUsage };
