import type { ProviderConfig, RequestContext, ForwardResult } from "./types.js";
import { getAdapter } from "./providers/index.js";
import { createProviderRouter } from "./router.js";
import { logProxyRequest } from "./logging.js";
import * as logger from "../logger.js";

export interface Forwarder {
  forward(
    request: Request,
    body: Record<string, unknown>,
    path: string,
    method: string,
    headers: Headers,
    sessionId?: string,
  ): Promise<ForwardResult>;
}

export function createForwarder(
  profileName: string,
  primary: ProviderConfig,
): Forwarder {
  const router = createProviderRouter(primary, []);

  return {
    async forward(request, body, path, method, headers, sessionId) {
      const providers = router.selectProviders();
      if (providers.length === 0) {
        providers.push(primary);
      }

      const lastErrorMessages: string[] = [];

      for (let attempt = 0; attempt < providers.length; attempt++) {
        const provider = providers[attempt];
        const ctx: RequestContext = {
          profileName,
          provider,
          failoverQueue: providers.slice(attempt + 1),
          request,
          body: { ...body },
          path,
          method,
          headers: new Headers(headers),
          startTime: Date.now(),
          sessionId,
          attempt,
          state: {},
        };

        try {
          const adapter = getAdapter(provider);
          const upstreamReq = await adapter.transformRequest(ctx);

          let upstreamBody: string | undefined;
          try {
            upstreamBody = await upstreamReq.clone().text();
          } catch {
            // ignore body-read failures for logging
          }

          logger.debug(`forward: ${method} ${path} -> ${provider.name} (${provider.baseUrl})`);

          // Log the original Responses API body for diagnostics before the adapter
          // strips or rewrites fields.
          logProxyRequest(profileName, {
            timestamp: new Date().toISOString(),
            session_id: sessionId,
            method,
            path,
            upstream_url: upstreamReq.url,
            original_body: body,
          });

          const upstreamRes = await fetch(upstreamReq, {
            redirect: "follow",
          });

          const isStream =
            upstreamRes.headers.get("content-type")?.includes("text/event-stream") ?? false;

          if (upstreamRes.ok) {
            router.recordResult(provider.id, true);
            const response = await adapter.transformResponse(ctx, upstreamRes);
            logProxyRequest(profileName, {
              timestamp: new Date().toISOString(),
              session_id: sessionId,
              method,
              path,
              upstream_url: upstreamReq.url,
              request_body: upstreamBody ? tryParseJson(upstreamBody) : undefined,
              response_status: response.status,
              streaming: isStream,
            });
            return { response, provider, ctx };
          }

          // Give providers a chance to rewrite upstream error responses (e.g.
          // Qianwen's context-length error) into an OpenAI-compatible shape
          // before treating the request as failed.
          if (adapter.translateError) {
            const errText = await upstreamRes.clone().text();
            const translated = await adapter.translateError(upstreamRes.clone(), errText);
            if (translated) {
              router.recordResult(provider.id, false);
              return { response: translated, provider, ctx };
            }
          }

          // If no provider remains in the failover queue, surface the upstream
          // error response directly instead of masking it as a generic 502.
          if (ctx.failoverQueue.length === 0) {
            router.recordResult(provider.id, false);
            logger.warn(`forward: upstream error from ${provider.name}: ${upstreamRes.status}`);
            return { response: upstreamRes, provider, ctx };
          }

          const errText = await upstreamRes.text();
          logger.warn(`forward: upstream error from ${provider.name}: ${upstreamRes.status} ${errText.slice(0, 200)}`);
          lastErrorMessages.push(`${provider.name}: ${upstreamRes.status}`);
          router.recordResult(provider.id, false);
        } catch (err) {
          logger.error(`forward: exception from ${provider.name}`, err);
          lastErrorMessages.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
          router.recordResult(provider.id, false);
        }
      }

      throw new Error(`All providers failed for profile '${profileName}'. ${lastErrorMessages.join("; ")}`);
    },
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
