import type { CircuitBreakerConfig, CircuitState } from "./types.js";

interface BreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number;
  requests: number;
  errors: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 3,
  timeoutSeconds: 60,
  errorRateThreshold: 0.5,
  minRequests: 10,
};

export class CircuitBreaker {
  private stats: BreakerStats;
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stats = {
      state: "closed",
      failures: 0,
      successes: 0,
      lastFailureTime: 0,
      requests: 0,
      errors: 0,
    };
  }

  allowRequest(): boolean {
    if (this.stats.state === "closed") return true;
    if (this.stats.state === "open") {
      const elapsed = (Date.now() - this.stats.lastFailureTime) / 1000;
      if (elapsed >= this.config.timeoutSeconds) {
        this.stats.state = "half-open";
        this.stats.failures = 0;
        this.stats.successes = 0;
        return true;
      }
      return false;
    }
    // half-open
    return true;
  }

  recordSuccess(): void {
    this.stats.requests++;
    this.stats.successes++;

    if (this.stats.state === "half-open") {
      if (this.stats.successes >= this.config.successThreshold) {
        this.stats.state = "closed";
        this.stats.failures = 0;
        this.stats.errors = 0;
      }
    } else if (this.stats.state === "closed") {
      this.stats.failures = 0;
    }
  }

  recordFailure(): void {
    this.stats.requests++;
    this.stats.errors++;
    this.stats.failures++;
    this.stats.lastFailureTime = Date.now();

    if (this.stats.state === "half-open") {
      this.stats.state = "open";
      return;
    }

    if (this.stats.state === "closed") {
      const errorRate = this.stats.requests >= this.config.minRequests
        ? this.stats.errors / this.stats.requests
        : 0;
      if (
        this.stats.failures >= this.config.failureThreshold ||
        errorRate >= this.config.errorRateThreshold
      ) {
        this.stats.state = "open";
      }
    }
  }

  getState(): CircuitState {
    return this.stats.state;
  }

  reset(): void {
    this.stats.state = "closed";
    this.stats.failures = 0;
    this.stats.successes = 0;
    this.stats.errors = 0;
    this.stats.lastFailureTime = 0;
  }
}
