import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../src/proxy/circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("allows requests when closed", () => {
    const breaker = new CircuitBreaker();
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.getState()).toBe("closed");
  });

  it("opens after consecutive failures", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    expect(breaker.allowRequest()).toBe(false);
  });

  it("transitions to half-open after timeout", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, timeoutSeconds: 0 });
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.getState()).toBe("half-open");
  });

  it("closes after enough successes in half-open state", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, timeoutSeconds: 0, successThreshold: 2 });
    breaker.recordFailure();
    breaker.allowRequest(); // -> half-open
    breaker.recordSuccess();
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("closed");
  });

  it("resets to closed", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure();
    breaker.reset();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.allowRequest()).toBe(true);
  });
});
