import type { ProviderConfig, FailoverQueueItem } from "../types.js";
import { CircuitBreaker } from "./circuit-breaker.js";

export interface ProviderRouter {
  selectProviders(): ProviderConfig[];
  recordResult(providerId: string, success: boolean): void;
  resetBreaker(providerId: string): void;
  getActiveProvider(): ProviderConfig;
}

export function createProviderRouter(
  primary: ProviderConfig,
  failover: ProviderConfig[],
): ProviderRouter {
  const breakers = new Map<string, CircuitBreaker>();

  function getBreaker(id: string): CircuitBreaker {
    if (!breakers.has(id)) {
      breakers.set(id, new CircuitBreaker());
    }
    return breakers.get(id)!;
  }

  function selectProviders(): ProviderConfig[] {
    const candidates = [primary, ...failover];
    const result: ProviderConfig[] = [];
    for (const provider of candidates) {
      if (getBreaker(provider.id).allowRequest()) {
        result.push(provider);
      }
    }
    return result;
  }

  return {
    selectProviders,
    recordResult(providerId: string, success: boolean) {
      const breaker = getBreaker(providerId);
      if (success) breaker.recordSuccess();
      else breaker.recordFailure();
    },
    resetBreaker(providerId: string) {
      getBreaker(providerId).reset();
    },
    getActiveProvider() {
      const available = selectProviders();
      if (available.length === 0) {
        // All breakers are open — force the primary and let it fail normally.
        return primary;
      }
      return available[0];
    },
  };
}

export function toFailoverQueueItem(provider: ProviderConfig): FailoverQueueItem {
  return {
    providerId: provider.id,
    providerName: provider.name,
  };
}
