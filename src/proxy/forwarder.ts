import type { ProviderConfig, RequestContext, ForwardResult } from "./types.js";
import { getAdapter } from "./providers/index.js";
import { createProviderRouter } from "./router.js";
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
          logger.debug(`forward: ${method} ${path} -> ${provider.name} (${provider.baseUrl})`);

          const upstreamRes = await fetch(upstreamReq, {
            redirect: "follow",
          });

          if (upstreamRes.ok) {
            router.recordResult(provider.id, true);
            const response = await adapter.transformResponse(ctx, upstreamRes);
            return { response, provider, ctx };
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
