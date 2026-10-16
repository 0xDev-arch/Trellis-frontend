import {
  DEFAULT_ALERT_RULES,
  appendOperationalMetricSample,
  bugReportToExceptionEvent,
  buildErrorTrend,
  buildExceptionTrendReport,
  buildOperationalHealth,
  createAlertRule,
  evaluateAlertRules,
  filterExceptionEvents,
  groupExceptionEvents,
  isOperationalMetricSample,
  computePercentile,
  computeRollingLatency,
  evaluateServiceHealth,
  executeSyntheticProbe,
  SyntheticProbeManager,
} from "@/lib/operational-health";
import type { ExceptionEvent, OperationalMetricSample, ProbeSampleRecord } from "@/lib/operational-health";
import type { BugReport } from "@/types/bug-report";

const baseReport: BugReport = {
  id: "BR-1",
  title: "Critical issue",
  description: "description",
  stepsToReproduce: "steps",
  expectedBehavior: "expected",
  actualBehavior: "actual",
  priority: "critical",
  category: "functionality",
  screenshots: [],
  reporterAddress: "private-address",
  reporterEmail: "private@example.com",
  status: "submitted",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  rewardAmount: 10,
  rewardStatus: "pending",
};

test("aggregates actionable categories without exposing report details", () => {
  const health = buildOperationalHealth([baseReport], Date.parse("2026-01-10T00:00:00.000Z"));
  expect(health.categories.map((category) => category.count)).toEqual([1, 1, 0, 1]);
  expect(JSON.stringify(health)).not.toContain("private@example.com");
  expect(JSON.stringify(health)).not.toContain("private-address");
});

describe("operational metric stream buffer", () => {
  const sample = (ts: number): OperationalMetricSample => ({
    ts,
    heapUsedBytes: 64,
    heapTotalBytes: 128,
    activeConnections: 3,
    rpcLatencyMs: 42,
  });

  test("retains only the newest samples without mutating the previous buffer", () => {
    const original = [sample(1), sample(2)];
    const buffered = appendOperationalMetricSample(original, sample(3), 2);

    expect(buffered.map((entry) => entry.ts)).toEqual([2, 3]);
    expect(original.map((entry) => entry.ts)).toEqual([1, 2]);
  });

  test("validates incoming performance samples", () => {
    expect(isOperationalMetricSample(sample(1))).toBe(true);
    expect(isOperationalMetricSample({ ...sample(1), rpcLatencyMs: null })).toBe(true);
    expect(isOperationalMetricSample({ ...sample(1), heapTotalBytes: 0 })).toBe(false);
    expect(isOperationalMetricSample({ ...sample(1), activeConnections: -1 })).toBe(false);
  });
});

const MINUTE = 60 * 1000;
const NOW = Date.parse("2026-02-01T12:00:00.000Z");

function exceptionEvent(overrides: Partial<ExceptionEvent> = {}): ExceptionEvent {
  return {
    id: "ex-1",
    ts: NOW - MINUTE,
    kind: "rpc",
    severity: "error",
    component: "wallet",
    browserOS: "macOS",
    release: "v1.4.0",
    ...overrides,
  };
}

describe("buildErrorTrend", () => {
  test("buckets exceptions into contiguous fixed-width windows", () => {
    const buckets = buildErrorTrend(
      [
        exceptionEvent({ id: "a", ts: NOW - 55_000 }),
        exceptionEvent({ id: "b", ts: NOW - 60_000 }),
        exceptionEvent({ id: "c", ts: NOW - 45_000 }),
        exceptionEvent({ id: "d", ts: NOW - 5_000 }),
        exceptionEvent({ id: "past", ts: NOW - 61_000 }),
        exceptionEvent({ id: "future", ts: NOW }),
      ],
      { windowMs: 6 * 10_000, bucketMs: 10_000, now: NOW },
    );

    expect(buckets).toHaveLength(6);
    expect(buckets.map((bucket) => bucket.count)).toEqual([2, 1, 0, 0, 0, 1]);
    expect(buckets.map((bucket) => bucket.ratePerMinute)).toEqual([12, 6, 0, 0, 0, 6]);
    expect(buckets[0].bucketStart).toBe(NOW - 60_000);
    expect(buckets[0].bucketEnd).toBe(NOW - 50_000);
    expect(buckets[0].label).toBe("11:59");
    expect(buckets[5].bucketEnd).toBe(NOW);
    for (let index = 1; index < buckets.length; index += 1) {
      expect(buckets[index].bucketStart).toBe(buckets[index - 1].bucketEnd);
    }
  });

  test("counts severities per bucket", () => {
    const buckets = buildErrorTrend(
      [
        exceptionEvent({ id: "a", severity: "critical", ts: NOW - 1_000 }),
        exceptionEvent({ id: "b", severity: "warning", ts: NOW - 2_000 }),
      ],
      { windowMs: MINUTE, bucketMs: MINUTE, now: NOW },
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0].bySeverity).toEqual({ warning: 1, error: 0, critical: 1 });
  });

  test("applies component, browser OS and release filters", () => {
    const events = [
      exceptionEvent({ id: "a", component: "wallet" }),
      exceptionEvent({ id: "b", component: "arena", browserOS: "Windows", release: "v1.5.0" }),
    ];

    expect(filterExceptionEvents(events, { component: "wallet" }).map((event) => event.id)).toEqual(["a"]);
    expect(filterExceptionEvents(events, { browserOS: "Windows" }).map((event) => event.id)).toEqual(["b"]);
    expect(filterExceptionEvents(events, { release: "v1.5.0" }).map((event) => event.id)).toEqual(["b"]);
    expect(
      buildErrorTrend(events, { windowMs: MINUTE, bucketMs: MINUTE, now: NOW, component: "arena" })[0].count,
    ).toBe(1);
  });

  test("rejects non-positive windows", () => {
    expect(() => buildErrorTrend([], { windowMs: 0, bucketMs: MINUTE, now: NOW })).toThrow();
    expect(() => buildErrorTrend([], { windowMs: MINUTE, bucketMs: 0, now: NOW })).toThrow();
  });
});

describe("groupExceptionEvents", () => {
  test("ranks groups by count then alphabetically", () => {
    const events = [
      exceptionEvent({ id: "a", component: "wallet" }),
      exceptionEvent({ id: "b", component: "arena" }),
      exceptionEvent({ id: "c", component: "wallet" }),
    ];

    expect(groupExceptionEvents(events, "component")).toEqual([
      { key: "wallet", count: 2 },
      { key: "arena", count: 1 },
    ]);
  });
});

describe("evaluateAlertRules", () => {
  const rpcRule = createAlertRule({
    id: "rpc",
    metric: "rpc-exceptions",
    threshold: 15,
    windowMinutes: 5,
    severity: "critical",
  });

  function rpcBurst(count: number, overrides: Partial<ExceptionEvent> = {}): ExceptionEvent[] {
    return Array.from({ length: count }, (_, index) =>
      exceptionEvent({ id: `burst-${index}`, kind: "rpc", ts: NOW - (index + 1) * 1_000, ...overrides }),
    );
  }

  test("breaches only when the count is strictly greater than the threshold", () => {
    expect(evaluateAlertRules(rpcBurst(16), [rpcRule], NOW)).toEqual([
      {
        ruleId: "rpc",
        ruleName: "RPC errors > 15 in 5 min",
        metric: "rpc-exceptions",
        threshold: 15,
        observed: 16,
        severity: "critical",
        windowStart: NOW - 5 * MINUTE,
        windowEnd: NOW,
      },
    ]);
    expect(evaluateAlertRules(rpcBurst(15), [rpcRule], NOW)).toEqual([]);
    expect(evaluateAlertRules(rpcBurst(14), [rpcRule], NOW)).toEqual([]);
  });

  test("ignores events outside the rule window and non-matching metrics", () => {
    const outside = exceptionEvent({ id: "old", ts: NOW - 6 * MINUTE });
    const wrongMetric = exceptionEvent({ id: "api", kind: "api", ts: NOW - 1_000 });
    expect(evaluateAlertRules([outside, wrongMetric], [rpcRule], NOW)).toEqual([]);
  });

  test("honours rule filters and disabled rules", () => {
    const filtered = createAlertRule({
      id: "rpc-wallet",
      metric: "rpc-exceptions",
      threshold: 15,
      windowMinutes: 5,
      filters: { component: "wallet" },
    });
    expect(evaluateAlertRules(rpcBurst(16, { component: "arena" }), [filtered], NOW)).toEqual([]);
    expect(evaluateAlertRules(rpcBurst(16), [filtered], NOW)).toHaveLength(1);
    expect(evaluateAlertRules(rpcBurst(16), [{ ...rpcRule, enabled: false }], NOW)).toEqual([]);
  });

  test("evaluates the default maintainer rules", () => {
    const breaches = evaluateAlertRules(rpcBurst(16), DEFAULT_ALERT_RULES, NOW);
    expect(breaches.map((breach) => breach.ruleId)).toEqual(["rpc-errors-5m"]);
  });
});

describe("createAlertRule", () => {
  test("normalises the threshold and window", () => {
    const rule = createAlertRule({ metric: "rpc-exceptions", threshold: 15.4, windowMinutes: 5 });
    expect(rule.threshold).toBe(15);
    expect(rule.windowMs).toBe(5 * MINUTE);
    expect(rule.severity).toBe("warning");
    expect(rule.name).toBe("RPC errors > 15 in 5 min");
    expect(rule.enabled).toBe(true);
  });

  test("rejects invalid thresholds and windows", () => {
    expect(() => createAlertRule({ metric: "exceptions", threshold: 0, windowMinutes: 5 })).toThrow();
    expect(() => createAlertRule({ metric: "exceptions", threshold: 5, windowMinutes: 0 })).toThrow();
    expect(() => createAlertRule({ metric: "exceptions", threshold: 5, windowMinutes: 2000 })).toThrow();
  });
});

describe("buildExceptionTrendReport", () => {
  test("combines trend buckets, groups and breaches", () => {
    const events = [
      ...Array.from({ length: 16 }, (_, index) =>
        exceptionEvent({
          id: `rpc-${index}`,
          kind: "rpc",
          severity: "critical",
          component: index % 2 === 0 ? "wallet" : "arena",
          browserOS: index % 2 === 0 ? "macOS" : "Windows",
          release: index % 2 === 0 ? "v1.4.0" : "v1.5.0",
          ts: NOW - (index + 1) * 1_000,
        }),
      ),
      exceptionEvent({ id: "outside", ts: NOW - 10 * MINUTE }),
    ];

    const report = buildExceptionTrendReport(events, {
      windowMs: 5 * MINUTE,
      bucketMs: MINUTE,
      now: NOW,
      rules: DEFAULT_ALERT_RULES,
    });

    expect(report.total).toBe(16);
    expect(report.buckets).toHaveLength(5);
    expect(report.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(16);
    expect(report.groups.component).toEqual([
      { key: "arena", count: 8 },
      { key: "wallet", count: 8 },
    ]);
    expect(report.groups.browserOS).toHaveLength(2);
    expect(report.groups.release).toHaveLength(2);
    expect(report.breaches.map((breach) => breach.ruleId)).toEqual(["critical-exceptions-10m", "rpc-errors-5m"]);
  });
});

describe("bugReportToExceptionEvent", () => {
  test("projects a report without leaking reporter data", () => {
    const event = bugReportToExceptionEvent(baseReport);
    expect(event).toEqual({
      id: "BR-EX-BR-1",
      ts: Date.parse("2026-01-01T00:00:00.000Z"),
      kind: "other",
      severity: "critical",
      component: "functionality",
      browserOS: "unknown",
      release: "unknown",
      code: "bug_report_functionality",
    });
    expect(JSON.stringify(event)).not.toContain("private@example.com");
    expect(JSON.stringify(event)).not.toContain("private-address");
  });
});

describe("synthetic probe rolling percentiles", () => {
  test("calculates p50, p95, p99 correctly", () => {
    // Array of 100 values: 10, 20, 30, ... 1000
    const latencies = Array.from({ length: 100 }, (_, i) => (i + 1) * 10);
    const p50 = computePercentile(latencies, 50);
    const p95 = computePercentile(latencies, 95);
    const p99 = computePercentile(latencies, 99);

    expect(p50).toBeCloseTo(505, 0);
    expect(p95).toBeCloseTo(951, 0);
    expect(p99).toBeCloseTo(990, 0);
  });

  test("handles empty and single element arrays", () => {
    expect(computePercentile([], 50)).toBe(0);
    expect(computePercentile([120], 95)).toBe(120);
  });

  test("computes rolling latency stats including min, max, avg", () => {
    const samples: ProbeSampleRecord[] = [
      { ts: Date.now() - 3000, latencyMs: 100, success: true },
      { ts: Date.now() - 2000, latencyMs: 200, success: true },
      { ts: Date.now() - 1000, latencyMs: 300, success: true },
      { ts: Date.now(), latencyMs: 0, success: false, error: "Network timeout", timedOut: true },
    ];

    const stats = computeRollingLatency(samples);
    expect(stats.min).toBe(100);
    expect(stats.max).toBe(300);
    expect(stats.avg).toBe(200);
    expect(stats.p50).toBe(200);
    expect(stats.samplesCount).toBe(4);
  });
});

describe("synthetic probe execution and timeout handling", () => {
  test("records successful probe latency when response is received within timeout", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      status: 200,
    } as Response);

    const result = await executeSyntheticProbe(
      {
        service: "horizon",
        label: "Horizon API",
        url: "https://horizon-testnet.stellar.org",
        timeoutMs: 2000,
      },
      mockFetch as unknown as typeof fetch,
    );

    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeNull();
  });

  test("handles probe timeout gracefully when HTTP request aborts", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const mockFetch = jest.fn().mockRejectedValue(abortError);

    const result = await executeSyntheticProbe(
      {
        service: "soroban-rpc",
        label: "Soroban RPC",
        url: "https://soroban-testnet.stellar.org",
        timeoutMs: 1000,
      },
      mockFetch as unknown as typeof fetch,
    );

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
  });

  test("handles custom probeFn timeout and failure", async () => {
    const slowProbeFn = jest.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ success: true, latencyMs: 500 }), 300)),
    );

    const result = await executeSyntheticProbe({
      service: "ipfs",
      label: "IPFS Gateway",
      url: "https://ipfs.io",
      timeoutMs: 50,
      probeFn: slowProbeFn,
    });

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
  });
});

describe("evaluateServiceHealth", () => {
  test("returns healthy when latency is within threshold and all samples succeed", () => {
    const samples: ProbeSampleRecord[] = Array.from({ length: 10 }, (_, i) => ({
      ts: Date.now() - i * 1000,
      latencyMs: 150,
      success: true,
    }));

    const health = evaluateServiceHealth(samples, 1500);
    expect(health.status).toBe("healthy");
    expect(health.uptimePercentage).toBe(100);
    expect(health.consecutiveFailures).toBe(0);
  });

  test("triggers degraded status when p95 response latency exceeds threshold", () => {
    const samples: ProbeSampleRecord[] = [
      ...Array.from({ length: 15 }, (_, i) => ({
        ts: Date.now() - (i + 5) * 1000,
        latencyMs: 200,
        success: true,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        ts: Date.now() - i * 1000,
        latencyMs: 2500,
        success: true,
      })),
    ];

    const health = evaluateServiceHealth(samples, 1500);
    expect(health.status).toBe("degraded");
    expect(health.rollingLatency.p95).toBeGreaterThanOrEqual(1500);
  });

  test("triggers degraded status on recent timeout", () => {
    const samples: ProbeSampleRecord[] = [
      { ts: Date.now() - 2000, latencyMs: 200, success: true },
      { ts: Date.now() - 1000, latencyMs: 150, success: true },
      { ts: Date.now(), latencyMs: 3000, success: false, timedOut: true, error: "Timed out" },
    ];

    const health = evaluateServiceHealth(samples, 1500);
    expect(health.status).toBe("degraded");
    expect(health.lastError).toBe("Timed out");
  });

  test("triggers down status when 3 or more consecutive failures occur", () => {
    const samples: ProbeSampleRecord[] = [
      { ts: Date.now() - 4000, latencyMs: 100, success: true },
      { ts: Date.now() - 3000, latencyMs: 1000, success: false, error: "Network error" },
      { ts: Date.now() - 2000, latencyMs: 1000, success: false, error: "Network error" },
      { ts: Date.now() - 1000, latencyMs: 1000, success: false, error: "Network error" },
    ];

    const health = evaluateServiceHealth(samples, 1500);
    expect(health.status).toBe("down");
    expect(health.consecutiveFailures).toBe(3);
  });
});

describe("SyntheticProbeManager", () => {
  test("maintains rolling samples per service and computes health reports", async () => {
    const manager = new SyntheticProbeManager([
      {
        service: "horizon",
        label: "Horizon API",
        url: "https://horizon.example.com",
        degradedLatencyThresholdMs: 500,
      },
      {
        service: "soroban-rpc",
        label: "Soroban RPC",
        url: "https://soroban.example.com",
        degradedLatencyThresholdMs: 500,
      },
      {
        service: "ipfs",
        label: "IPFS Gateway",
        url: "https://ipfs.example.com",
        degradedLatencyThresholdMs: 500,
      },
    ]);

    manager.recordSample("horizon", { ts: Date.now(), latencyMs: 120, success: true });
    manager.recordSample("soroban-rpc", { ts: Date.now(), latencyMs: 800, success: true });
    manager.recordSample("ipfs", { ts: Date.now() - 2000, latencyMs: 200, success: true });
    manager.recordSample("ipfs", { ts: Date.now() - 1000, latencyMs: 220, success: true });
    manager.recordSample("ipfs", { ts: Date.now(), latencyMs: 2000, success: false, timedOut: true, error: "Timed out" });

    const horizonHealth = manager.getServiceHealth("horizon");
    expect(horizonHealth.status).toBe("healthy");
    expect(horizonHealth.rollingLatency.p50).toBe(120);

    const sorobanHealth = manager.getServiceHealth("soroban-rpc");
    expect(sorobanHealth.status).toBe("degraded");

    const ipfsHealth = manager.getServiceHealth("ipfs");
    expect(ipfsHealth.status).toBe("degraded");
    expect(ipfsHealth.lastError).toBe("Timed out");

    const all = manager.getAllServicesHealth();
    expect(all).toHaveLength(3);
    expect(all.map((s) => s.service)).toEqual(["horizon", "soroban-rpc", "ipfs"]);
  });
});
