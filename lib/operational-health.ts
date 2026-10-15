import type { BugReport } from "@/types/bug-report";

export interface OperationalHealth {
  generatedAt: string;
  categories: Array<{
    key: "unresolved-exceptions" | "stale-records" | "reconciliation-drift" | "user-incidents";
    label: string;
    count: number;
    severity: "info" | "warning" | "critical";
    href: string;
  }>;
}

export interface OperationalMetricSample {
  ts: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  activeConnections: number;
  rpcLatencyMs: number | null;
}

export const MAX_OPERATIONAL_METRIC_SAMPLES = 60;
export const OPERATIONAL_MEMORY_WARNING_RATIO = 0.8;
export const OPERATIONAL_MEMORY_CRITICAL_RATIO = 0.9;

export function isOperationalMetricSample(value: unknown): value is OperationalMetricSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Record<string, unknown>;
  return (
    typeof sample.ts === "number" && Number.isFinite(sample.ts) &&
    typeof sample.heapUsedBytes === "number" && Number.isFinite(sample.heapUsedBytes) && sample.heapUsedBytes >= 0 &&
    typeof sample.heapTotalBytes === "number" && Number.isFinite(sample.heapTotalBytes) && sample.heapTotalBytes > 0 &&
    typeof sample.activeConnections === "number" && Number.isFinite(sample.activeConnections) && sample.activeConnections >= 0 &&
    (sample.rpcLatencyMs === null ||
      (typeof sample.rpcLatencyMs === "number" && Number.isFinite(sample.rpcLatencyMs) && sample.rpcLatencyMs >= 0))
  );
}

/** Appends one sample without mutating the prior buffer and keeps it bounded. */
export function appendOperationalMetricSample(
  samples: readonly OperationalMetricSample[],
  sample: OperationalMetricSample,
  maxSamples = MAX_OPERATIONAL_METRIC_SAMPLES,
): OperationalMetricSample[] {
  if (!Number.isInteger(maxSamples) || maxSamples < 1) {
    throw new Error("maxSamples must be a positive integer");
  }
  return [...samples, sample].slice(-maxSamples);
}

export function buildOperationalHealth(
  reports: readonly BugReport[],
  now = Date.now(),
  staleAfterMs = 7 * 24 * 60 * 60 * 1000,
): OperationalHealth {
  const unresolved = reports.filter((report) => report.status !== "resolved");
  const stale = unresolved.filter(
    (report) => now - Date.parse(report.updatedAt) >= staleAfterMs,
  );
  const drift = reports.filter(
    (report) => report.status === "resolved" && report.rewardStatus === "pending",
  );
  const incidents = reports.filter(
    (report) => report.priority === "critical" && report.status !== "resolved",
  );

  return {
    generatedAt: new Date(now).toISOString(),
    categories: [
      {
        key: "unresolved-exceptions",
        label: "Unresolved exceptions",
        count: unresolved.length,
        severity: unresolved.length > 0 ? "warning" : "info",
        href: "/bug-reports?status=all",
      },
      {
        key: "stale-records",
        label: "Stale records",
        count: stale.length,
        severity: stale.length > 0 ? "warning" : "info",
        href: "/bug-reports?status=all&stale=true",
      },
      {
        key: "reconciliation-drift",
        label: "Reconciliation drift",
        count: drift.length,
        severity: drift.length > 0 ? "critical" : "info",
        href: "/bug-reports?status=resolved",
      },
      {
        key: "user-incidents",
        label: "User-impacting incidents",
        count: incidents.length,
        severity: incidents.length > 0 ? "critical" : "info",
        href: "/bug-reports?status=all&priority=critical",
      },
    ],
  };
}

/** Severity levels shared with the client telemetry contract. */
export type ExceptionSeverity = "warning" | "error" | "critical";

/** Bounded exception category; `rpc` failures back the RPC-error alert metric. */
export type ExceptionKind = "rpc" | "api" | "ui" | "render" | "wallet" | "other";

/**
 * A single sanitized application exception.
 *
 * The shape follows `docs/telemetry-event-contract.md`: every field is a
 * low-cardinality, non-identifying dimension, so the dashboard can group and
 * chart exceptions without storing user or wallet data.
 */
export interface ExceptionEvent {
  id: string;
  /** Event timestamp in milliseconds. */
  ts: number;
  kind: ExceptionKind;
  severity: ExceptionSeverity;
  /** Bounded feature/component label, e.g. `"wallet"`. */
  component: string;
  /** Bounded platform label, e.g. `"macOS"`. */
  browserOS: string;
  /** Release/build identifier, e.g. `"v1.4.0"`. */
  release: string;
  /** Stable error code from the telemetry contract, e.g. `"rpc_unavailable"`. */
  code?: string;
}

export type ExceptionGroupDimension = "component" | "browserOS" | "release" | "kind";

export interface ExceptionFilters {
  component?: string;
  browserOS?: string;
  release?: string;
  kind?: ExceptionKind;
}

export interface ExceptionGroup {
  key: string;
  count: number;
}

export interface ErrorTrendOptions extends ExceptionFilters {
  /** Total time range to chart, in milliseconds. */
  windowMs: number;
  /** Width of each bucket, in milliseconds. */
  bucketMs: number;
  /** Reference "now" in milliseconds; defaults to `Date.now()`. */
  now?: number;
}

export interface ErrorTrendBucket {
  bucketStart: number;
  bucketEnd: number;
  /** UTC `HH:MM` label for chart axes. */
  label: string;
  count: number;
  /** Bucket count normalised to errors per minute. */
  ratePerMinute: number;
  bySeverity: Record<ExceptionSeverity, number>;
}

export type AlertMetric = "exceptions" | "rpc-exceptions" | "critical-exceptions";

export interface AlertRule {
  id: string;
  name: string;
  metric: AlertMetric;
  /** A window breaches when its observed count is strictly greater than this. */
  threshold: number;
  windowMs: number;
  severity: "warning" | "critical";
  /** Defaults to enabled when omitted. */
  enabled?: boolean;
  filters?: ExceptionFilters;
}

export interface AlertBreach {
  ruleId: string;
  ruleName: string;
  metric: AlertMetric;
  threshold: number;
  observed: number;
  severity: "warning" | "critical";
  windowStart: number;
  windowEnd: number;
}

export interface ExceptionTrendReport {
  generatedAt: number;
  windowMs: number;
  bucketMs: number;
  /** Exceptions inside the chart window after filters are applied. */
  total: number;
  buckets: ErrorTrendBucket[];
  groups: Record<ExceptionGroupDimension, ExceptionGroup[]>;
  breaches: AlertBreach[];
}

export interface AlertRuleInput {
  id?: string;
  name?: string;
  metric: AlertMetric;
  threshold: number;
  windowMinutes: number;
  severity?: AlertRule["severity"];
  filters?: ExceptionFilters;
}

const MINUTE_MS = 60 * 1000;

const ALERT_METRIC_LABELS: Record<AlertMetric, string> = {
  exceptions: "Exceptions",
  "rpc-exceptions": "RPC errors",
  "critical-exceptions": "Critical exceptions",
};

/** Maintainer defaults, including the `> 15 RPC errors in 5 min` rule from the issue. */
export const DEFAULT_ALERT_RULES: readonly AlertRule[] = [
  {
    id: "rpc-errors-5m",
    name: "RPC errors over threshold",
    metric: "rpc-exceptions",
    threshold: 15,
    windowMs: 5 * MINUTE_MS,
    severity: "critical",
  },
  {
    id: "exceptions-15m",
    name: "Exception volume spike",
    metric: "exceptions",
    threshold: 30,
    windowMs: 15 * MINUTE_MS,
    severity: "warning",
  },
  {
    id: "critical-exceptions-10m",
    name: "Critical exception burst",
    metric: "critical-exceptions",
    threshold: 5,
    windowMs: 10 * MINUTE_MS,
    severity: "critical",
  },
];

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
}

function toMinuteLabel(ts: number): string {
  return new Date(ts).toISOString().slice(11, 16);
}

/** True when every populated filter dimension matches the event. */
export function matchesExceptionFilters(
  event: ExceptionEvent,
  filters: ExceptionFilters = {},
): boolean {
  if (filters.component && event.component !== filters.component) return false;
  if (filters.browserOS && event.browserOS !== filters.browserOS) return false;
  if (filters.release && event.release !== filters.release) return false;
  if (filters.kind && event.kind !== filters.kind) return false;
  return true;
}

export function filterExceptionEvents(
  events: readonly ExceptionEvent[],
  filters: ExceptionFilters = {},
): ExceptionEvent[] {
  return events.filter((event) => matchesExceptionFilters(event, filters));
}

/** Counts exceptions per dimension, highest count first, then alphabetically. */
export function groupExceptionEvents(
  events: readonly ExceptionEvent[],
  dimension: ExceptionGroupDimension,
): ExceptionGroup[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = event[dimension];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts, ([key, count]) => ({ key, count })).sort(
    (a, b) => b.count - a.count || a.key.localeCompare(b.key),
  );
}

/**
 * Buckets exceptions into contiguous, fixed-width time slots ending at `now`.
 *
 * The window is half-open (`[now - windowMs, now)`), so an event is counted in
 * exactly one bucket. `ratePerMinute` normalises partial buckets so short
 * windows remain comparable with longer ones.
 */
export function buildErrorTrend(
  events: readonly ExceptionEvent[],
  options: ErrorTrendOptions,
): ErrorTrendBucket[] {
  const { windowMs, bucketMs } = options;
  assertPositive("windowMs", windowMs);
  assertPositive("bucketMs", bucketMs);

  const now = options.now ?? Date.now();
  const windowStart = now - windowMs;
  const bucketCount = Math.max(1, Math.ceil(windowMs / bucketMs));
  const minutesPerBucket = bucketMs / MINUTE_MS;

  const buckets: ErrorTrendBucket[] = Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = windowStart + index * bucketMs;
    return {
      bucketStart,
      bucketEnd: bucketStart + bucketMs,
      label: toMinuteLabel(bucketStart),
      count: 0,
      ratePerMinute: 0,
      bySeverity: { warning: 0, error: 0, critical: 0 },
    };
  });

  for (const event of filterExceptionEvents(events, options)) {
    if (event.ts < windowStart || event.ts >= now) continue;
    const index = Math.min(bucketCount - 1, Math.floor((event.ts - windowStart) / bucketMs));
    const bucket = buckets[index];
    bucket.count += 1;
    bucket.bySeverity[event.severity] += 1;
  }

  for (const bucket of buckets) {
    bucket.ratePerMinute = Math.round((bucket.count / minutesPerBucket) * 100) / 100;
  }

  return buckets;
}

/** Maps an event to the alert metric it contributes to. */
export function matchesAlertMetric(event: ExceptionEvent, metric: AlertMetric): boolean {
  if (metric === "exceptions") return true;
  if (metric === "rpc-exceptions") return event.kind === "rpc";
  return event.severity === "critical";
}

/**
 * Evaluates maintainer alert rules over the half-open window
 * `[now - rule.windowMs, now)` and returns the breached rules.
 *
 * A rule breaches only when the observed count is strictly greater than its
 * threshold, matching the `> 15 RPC errors in 5 mins` semantics.
 */
export function evaluateAlertRules(
  events: readonly ExceptionEvent[],
  rules: readonly AlertRule[],
  now = Date.now(),
): AlertBreach[] {
  const breaches: AlertBreach[] = [];

  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const windowStart = now - rule.windowMs;
    const observed = events.filter(
      (event) =>
        event.ts >= windowStart &&
        event.ts < now &&
        matchesAlertMetric(event, rule.metric) &&
        matchesExceptionFilters(event, rule.filters),
    ).length;

    if (observed > rule.threshold) {
      breaches.push({
        ruleId: rule.id,
        ruleName: rule.name,
        metric: rule.metric,
        threshold: rule.threshold,
        observed,
        severity: rule.severity,
        windowStart,
        windowEnd: now,
      });
    }
  }

  return breaches.sort(
    (a, b) => b.observed / b.threshold - a.observed / a.threshold || a.ruleId.localeCompare(b.ruleId),
  );
}

/** Human-readable summary of a rule, e.g. `RPC errors > 15 in 5 min`. */
export function describeAlertRule(rule: Pick<AlertRule, "metric" | "threshold" | "windowMs">): string {
  return `${ALERT_METRIC_LABELS[rule.metric]} > ${rule.threshold} in ${rule.windowMs / MINUTE_MS} min`;
}

/**
 * Validates and normalises a rule coming from the maintainer rule creator.
 * Throws when the threshold or window is not usable.
 */
export function createAlertRule(input: AlertRuleInput): AlertRule {
  const threshold = Math.round(input.threshold);
  assertPositive("Alert threshold", threshold);

  const windowMinutes = Math.round(input.windowMinutes);
  if (!Number.isFinite(windowMinutes) || windowMinutes < 1 || windowMinutes > 24 * 60) {
    throw new Error("Alert window must be between 1 and 1440 minutes");
  }

  const metric = input.metric;
  return {
    id: input.id ?? `alert-${metric}-${threshold}-${windowMinutes}m`,
    name:
      (input.name ?? "").trim() ||
      `${ALERT_METRIC_LABELS[metric]} > ${threshold} in ${windowMinutes} min`,
    metric,
    threshold,
    windowMs: windowMinutes * MINUTE_MS,
    severity: input.severity ?? "warning",
    enabled: true,
    ...(input.filters ? { filters: input.filters } : {}),
  };
}

/** Builds the chart, grouping and breach payload rendered by the operations page. */
export function buildExceptionTrendReport(
  events: readonly ExceptionEvent[],
  options: {
    windowMs: number;
    bucketMs: number;
    now?: number;
    filters?: ExceptionFilters;
    rules?: readonly AlertRule[];
  },
): ExceptionTrendReport {
  const now = options.now ?? Date.now();
  const filters = options.filters ?? {};
  const windowStart = now - options.windowMs;

  const inWindow = events.filter(
    (event) =>
      event.ts >= windowStart && event.ts < now && matchesExceptionFilters(event, filters),
  );

  return {
    generatedAt: now,
    windowMs: options.windowMs,
    bucketMs: options.bucketMs,
    total: inWindow.length,
    buckets: buildErrorTrend(events, {
      windowMs: options.windowMs,
      bucketMs: options.bucketMs,
      now,
      ...filters,
    }),
    groups: {
      component: groupExceptionEvents(inWindow, "component"),
      browserOS: groupExceptionEvents(inWindow, "browserOS"),
      release: groupExceptionEvents(inWindow, "release"),
      kind: groupExceptionEvents(inWindow, "kind"),
    },
    breaches: evaluateAlertRules(events, options.rules ?? DEFAULT_ALERT_RULES, now),
  };
}

const PRIORITY_SEVERITY: Record<BugReport["priority"], ExceptionSeverity> = {
  critical: "critical",
  high: "error",
  medium: "warning",
  low: "warning",
};

const CATEGORY_KIND: Record<BugReport["category"], ExceptionKind> = {
  security: "api",
  functionality: "other",
  performance: "render",
  ui: "ui",
  other: "other",
};

/**
 * Projects a bug report into the exception stream. Bug reports are the
 * dashboard's existing "unresolved exceptions", so maintainer data already on
 * hand feeds the trend chart and the alert rules.
 */
export function bugReportToExceptionEvent(report: BugReport): ExceptionEvent {
  const updated = Date.parse(report.updatedAt);
  const created = Date.parse(report.createdAt);
  return {
    id: `BR-EX-${report.id}`,
    ts: updated || created || 0,
    kind: CATEGORY_KIND[report.category],
    severity: PRIORITY_SEVERITY[report.priority],
    component: report.category,
    browserOS: "unknown",
    release: "unknown",
    code: `bug_report_${report.category}`,
  };
}

/** Probe outcome shape used across health probe runners. */
export interface ProbeOutcome {
  key: string;
  ok: boolean;
  latencyMs: number | null;
  statusCode?: number | null;
  error?: string | null;
  skipped?: boolean;
}

export type ExternalServiceKey = "horizon" | "soroban-rpc" | "ipfs" | "algolia";
export type ServiceHealthStatus = "healthy" | "degraded" | "down";

export interface ProbeSampleRecord {
  ts: number;
  latencyMs: number;
  success: boolean;
  statusCode?: number | null;
  error?: string | null;
  timedOut?: boolean;
}

export interface RollingLatencyStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
  samplesCount: number;
}

export interface ExternalServiceHealth {
  service: ExternalServiceKey | string;
  label: string;
  endpoint: string;
  status: ServiceHealthStatus;
  lastCheckedAt: string | null;
  lastLatencyMs: number | null;
  rollingLatency: RollingLatencyStats;
  uptimePercentage: number;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface SyntheticProbeConfig {
  service: ExternalServiceKey | string;
  label: string;
  url: string;
  method?: "GET" | "HEAD";
  timeoutMs?: number;
  degradedLatencyThresholdMs?: number;
  probeFn?: () => Promise<{
    success: boolean;
    latencyMs: number;
    error?: string;
    statusCode?: number;
    timedOut?: boolean;
  }>;
}

export const DEFAULT_DEGRADED_LATENCY_THRESHOLD_MS = 1500;
export const DEFAULT_PROBE_TIMEOUT_MS = 3000;
export const MAX_PROBE_SAMPLES_PER_SERVICE = 100;

export function computePercentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return Math.round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

export function computeRollingLatency(samples: readonly ProbeSampleRecord[]): RollingLatencyStats {
  const successfulLatencies = samples
    .filter((s) => s.success && typeof s.latencyMs === "number" && Number.isFinite(s.latencyMs))
    .map((s) => s.latencyMs);

  if (successfulLatencies.length === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0, samplesCount: samples.length };
  }

  const sum = successfulLatencies.reduce((a, b) => a + b, 0);
  const avg = Math.round(sum / successfulLatencies.length);
  const min = Math.min(...successfulLatencies);
  const max = Math.max(...successfulLatencies);

  return {
    p50: computePercentile(successfulLatencies, 50),
    p95: computePercentile(successfulLatencies, 95),
    p99: computePercentile(successfulLatencies, 99),
    min,
    max,
    avg,
    samplesCount: samples.length,
  };
}

export function evaluateServiceHealth(
  samples: readonly ProbeSampleRecord[],
  degradedLatencyThresholdMs = DEFAULT_DEGRADED_LATENCY_THRESHOLD_MS,
): {
  status: ServiceHealthStatus;
  rollingLatency: RollingLatencyStats;
  uptimePercentage: number;
  consecutiveFailures: number;
  lastError: string | null;
} {
  if (samples.length === 0) {
    return {
      status: "healthy",
      rollingLatency: { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0, samplesCount: 0 },
      uptimePercentage: 100,
      consecutiveFailures: 0,
      lastError: null,
    };
  }

  const rollingLatency = computeRollingLatency(samples);
  const successCount = samples.filter((s) => s.success).length;
  const uptimePercentage = Math.round((successCount / samples.length) * 1000) / 10;

  let consecutiveFailures = 0;
  let lastError: string | null = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (!samples[i].success) {
      consecutiveFailures++;
      if (!lastError && samples[i].error) {
        lastError = samples[i].error!;
      }
    } else {
      break;
    }
  }

  const recentWindow = samples.slice(-5);
  const recentTimeouts = recentWindow.filter((s) => s.timedOut).length;
  const failureRate = (samples.length - successCount) / samples.length;

  let status: ServiceHealthStatus = "healthy";

  if (consecutiveFailures >= 3 || failureRate >= 0.75) {
    status = "down";
  } else if (
    rollingLatency.p95 >= degradedLatencyThresholdMs ||
    recentTimeouts > 0 ||
    consecutiveFailures > 0 ||
    failureRate >= 0.15
  ) {
    status = "degraded";
  }

  return { status, rollingLatency, uptimePercentage, consecutiveFailures, lastError };
}

export async function executeSyntheticProbe(
  config: SyntheticProbeConfig,
  fetchFn?: typeof fetch,
): Promise<ProbeSampleRecord> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const started = Date.now();

  if (config.probeFn) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<{
        success: boolean;
        latencyMs: number;
        error?: string;
        statusCode?: number;
        timedOut?: boolean;
      }>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Probe timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      const res = await Promise.race([config.probeFn(), timeoutPromise]);
      return {
        ts: Date.now(),
        latencyMs: res.latencyMs ?? (Date.now() - started),
        success: res.success,
        statusCode: res.statusCode ?? null,
        error: res.error ?? null,
        timedOut: res.timedOut ?? false,
      };
    } catch (err: unknown) {
      const isTimeout = (err as Error)?.message?.includes("timed out");
      return {
        ts: Date.now(),
        latencyMs: timeoutMs,
        success: false,
        statusCode: null,
        error: (err as Error)?.message || "Probe failed",
        timedOut: isTimeout,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const doFetch = fetchFn ?? (typeof fetch === "function" ? fetch : undefined);
  if (!doFetch) {
    return {
      ts: Date.now(),
      latencyMs: 0,
      success: false,
      statusCode: null,
      error: "No fetch implementation available",
      timedOut: false,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(config.url, {
      method: config.method ?? "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    const latencyMs = Date.now() - started;
    const ok = response.status < 500 && response.status !== 429;
    return {
      ts: Date.now(),
      latencyMs,
      success: ok,
      statusCode: response.status,
      error: ok ? null : `HTTP ${response.status}`,
      timedOut: false,
    };
  } catch (error: unknown) {
    const latencyMs = Date.now() - started;
    const isTimeout =
      (error as { name?: string })?.name === "AbortError" ||
      (error as Error)?.message?.includes("aborted") ||
      latencyMs >= timeoutMs;

    return {
      ts: Date.now(),
      latencyMs: isTimeout ? timeoutMs : latencyMs,
      success: false,
      statusCode: null,
      error: isTimeout ? `Probe timed out after ${timeoutMs}ms` : (error as Error)?.message || "Probe request failed",
      timedOut: isTimeout,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const DEFAULT_SYNTHETIC_PROBE_TARGETS: readonly SyntheticProbeConfig[] = [
  {
    service: "horizon",
    label: "Stellar Horizon API",
    url: process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org/fee_stats",
    timeoutMs: 3000,
    degradedLatencyThresholdMs: 1200,
  },
  {
    service: "soroban-rpc",
    label: "Stellar Soroban RPC",
    url: process.env.NEXT_PUBLIC_STELLAR_RPC_URL || "https://soroban-testnet.stellar.org",
    method: "GET",
    timeoutMs: 3000,
    degradedLatencyThresholdMs: 1500,
  },
  {
    service: "ipfs",
    label: "IPFS Gateway",
    url: process.env.NEXT_PUBLIC_IPFS_GATEWAY || "https://ipfs.io/ipfs/bafybeifx7yeb55kdqb75",
    method: "HEAD",
    timeoutMs: 4000,
    degradedLatencyThresholdMs: 2000,
  },
  {
    service: "algolia",
    label: "Algolia Search",
    url: "https://status.algolia.com/api/v1/status",
    timeoutMs: 3000,
    degradedLatencyThresholdMs: 1000,
  },
];

export class SyntheticProbeManager {
  private samples: Map<string, ProbeSampleRecord[]> = new Map();
  private targets: Map<string, SyntheticProbeConfig> = new Map();

  constructor(initialTargets: readonly SyntheticProbeConfig[] = DEFAULT_SYNTHETIC_PROBE_TARGETS) {
    for (const target of initialTargets) {
      this.targets.set(target.service, target);
      this.samples.set(target.service, []);
    }
  }

  registerTarget(target: SyntheticProbeConfig): void {
    this.targets.set(target.service, target);
    if (!this.samples.has(target.service)) {
      this.samples.set(target.service, []);
    }
  }

  recordSample(service: string, sample: ProbeSampleRecord): void {
    const list = this.samples.get(service) ?? [];
    list.push(sample);
    if (list.length > MAX_PROBE_SAMPLES_PER_SERVICE) {
      list.shift();
    }
    this.samples.set(service, list);
  }

  getSamples(service: string): readonly ProbeSampleRecord[] {
    return this.samples.get(service) ?? [];
  }

  clearSamples(service?: string): void {
    if (service) {
      this.samples.set(service, []);
    } else {
      this.samples.clear();
      for (const key of Array.from(this.targets.keys())) {
        this.samples.set(key, []);
      }
    }
  }

  async runProbes(fetchFn?: typeof fetch): Promise<ExternalServiceHealth[]> {
    const results = await Promise.all(
      Array.from(this.targets.values()).map(async (target) => {
        const sample = await executeSyntheticProbe(target, fetchFn);
        this.recordSample(target.service, sample);
        return this.getServiceHealth(target.service);
      }),
    );
    return results;
  }

  getServiceHealth(service: string): ExternalServiceHealth {
    const target = this.targets.get(service);
    const samples = this.samples.get(service) ?? [];
    const evaluation = evaluateServiceHealth(
      samples,
      target?.degradedLatencyThresholdMs ?? DEFAULT_DEGRADED_LATENCY_THRESHOLD_MS,
    );
    const lastSample = samples[samples.length - 1];

    return {
      service,
      label: target?.label ?? service,
      endpoint: target?.url ?? "",
      status: evaluation.status,
      lastCheckedAt: lastSample ? new Date(lastSample.ts).toISOString() : null,
      lastLatencyMs: lastSample ? lastSample.latencyMs : null,
      rollingLatency: evaluation.rollingLatency,
      uptimePercentage: evaluation.uptimePercentage,
      consecutiveFailures: evaluation.consecutiveFailures,
      lastError: evaluation.lastError,
    };
  }

  getAllServicesHealth(): ExternalServiceHealth[] {
    return Array.from(this.targets.keys()).map((service) => this.getServiceHealth(service));
  }
}

/** Global singleton instance for synthetic probes. */
export const syntheticProbeManager = new SyntheticProbeManager();

