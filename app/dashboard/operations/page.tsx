'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  buildExceptionTrendReport,
  appendOperationalMetricSample,
  createAlertRule,
  describeAlertRule,
  isOperationalMetricSample,
  MAX_OPERATIONAL_METRIC_SAMPLES,
  OPERATIONAL_MEMORY_CRITICAL_RATIO,
  OPERATIONAL_MEMORY_WARNING_RATIO,
  type AlertMetric,
  type AlertRule,
  type ExceptionEvent,
  type OperationalHealth,
  type OperationalMetricSample,
} from '@/lib/operational-health';
import {
  DUPLICATE_RATE_WARNING_THRESHOLD,
  buildIdempotencyRateSeries,
  duplicateRequestRate,
} from '@/lib/idempotency';
import { useApiMetricsStore } from '@/store/apiMetricsStore';
import { DeadLetterPanel } from './DeadLetterPanel';

const MINUTE_MS = 60 * 1000;

const WINDOW_OPTIONS = [
  { label: 'Last 5 minutes', minutes: 5 },
  { label: 'Last 15 minutes', minutes: 15 },
  { label: 'Last 60 minutes', minutes: 60 },
  { label: 'Last 6 hours', minutes: 360 },
] as const;

const METRIC_OPTIONS: ReadonlyArray<{ value: AlertMetric; label: string }> = [
  { value: 'exceptions', label: 'All exceptions' },
  { value: 'rpc-exceptions', label: 'RPC errors' },
  { value: 'critical-exceptions', label: 'Critical exceptions' },
];

const ALL_VALUE = 'all';

type MetricConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'unconfigured';

type FilterState = {
  component: string;
  browserOS: string;
  release: string;
};

type HealthResponse = OperationalHealth & { exceptions?: ExceptionEvent[] };

function uniqueValues(events: readonly ExceptionEvent[], key: keyof FilterState): string[] {
  return Array.from(new Set(events.map((event) => event[key]))).sort((a, b) => a.localeCompare(b));
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function groupLabel(dimension: string): string {
  if (dimension === 'browserOS') return 'Browser / OS';
  return dimension.charAt(0).toUpperCase() + dimension.slice(1);
}

export default function OperationsDashboardPage() {
  const [health, setHealth] = useState<OperationalHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const [windowMinutes, setWindowMinutes] = useState<number>(60);
  const [filters, setFilters] = useState<FilterState>({
    component: ALL_VALUE,
    browserOS: ALL_VALUE,
    release: ALL_VALUE,
  });
  const [ruleDraft, setRuleDraft] = useState({
    name: '',
    metric: 'rpc-exceptions' as AlertMetric,
    threshold: '15',
    windowMinutes: '5',
    severity: 'critical' as AlertRule['severity'],
  });
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [metricSamples, setMetricSamples] = useState<OperationalMetricSample[]>([]);
  const [metricConnection, setMetricConnection] = useState<MetricConnectionStatus>('connecting');

  const exceptionEvents = useApiMetricsStore((state) => state.exceptionEvents);
  const alertRules = useApiMetricsStore((state) => state.alertRules);
  const setExceptionEvents = useApiMetricsStore((state) => state.setExceptionEvents);
  const addAlertRule = useApiMetricsStore((state) => state.addAlertRule);
  const removeAlertRule = useApiMetricsStore((state) => state.removeAlertRule);
  const idempotency = useApiMetricsStore((state) => state.idempotency);
  const idempotencyEvents = useApiMetricsStore((state) => state.idempotencyEvents);
  const abuse = useApiMetricsStore((state) => state.abuse);
  const abuseEvents = useApiMetricsStore((state) => state.abuseEvents);

  useEffect(() => {
    setMounted(true);
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ windowMinutes: String(windowMinutes) });
    fetch(`/api/operational-health?${query.toString()}`)
      .then((response) => {
        if (!response.ok) throw new Error('Unable to load operational health');
        return response.json() as Promise<HealthResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setHealth(data);
        setError(null);
        if (Array.isArray(data.exceptions)) setExceptionEvents(data.exceptions);
      })
      .catch((requestError: Error) => {
        if (!cancelled) setError(requestError.message);
      });
    return () => {
      cancelled = true;
    };
  }, [windowMinutes, setExceptionEvents]);

  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_TELEMETRY_WS_URL?.trim();
    if (!baseUrl) {
      setMetricConnection('unconfigured');
      return;
    }

    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;
    let retryDelay = 1000;

    const connect = () => {
      if (disposed) return;
      let url: URL;
      try {
        url = new URL(baseUrl);
        url.searchParams.set('role', 'operator');
      } catch {
        setMetricConnection('disconnected');
        return;
      }

      setMetricConnection('connecting');
      socket = new WebSocket(url.toString());
      socket.onopen = () => {
        retryDelay = 1000;
        setMetricConnection('connected');
        socket?.send(JSON.stringify({ type: 'telemetry.subscribe', role: 'operator' }));
      };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (frame.type !== 'operational.metrics' || !isOperationalMetricSample(frame)) return;
          setMetricSamples((samples) =>
            appendOperationalMetricSample(samples, frame, MAX_OPERATIONAL_METRIC_SAMPLES),
          );
        } catch {
          // Ignore malformed frames; the telemetry stream is best-effort.
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setMetricConnection('disconnected');
        reconnectTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  const performanceChartData = useMemo(
    () => metricSamples.map((sample) => ({
      label: new Date(sample.ts).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' }),
      heapUsedMb: sample.heapUsedBytes / (1024 * 1024),
      heapTotalMb: sample.heapTotalBytes / (1024 * 1024),
      activeConnections: sample.activeConnections,
      rpcLatencyMs: sample.rpcLatencyMs,
      memoryRatio: sample.heapUsedBytes / sample.heapTotalBytes,
    })),
    [metricSamples],
  );

  const currentMemoryRatio = performanceChartData.at(-1)?.memoryRatio ?? 0;
  const memorySeverity = currentMemoryRatio >= OPERATIONAL_MEMORY_CRITICAL_RATIO
    ? 'critical'
    : currentMemoryRatio >= OPERATIONAL_MEMORY_WARNING_RATIO
      ? 'warning'
      : 'normal';

  const activeFilters = useMemo(
    () => ({
      component: filters.component === ALL_VALUE ? undefined : filters.component,
      browserOS: filters.browserOS === ALL_VALUE ? undefined : filters.browserOS,
      release: filters.release === ALL_VALUE ? undefined : filters.release,
    }),
    [filters],
  );

  const componentOptions = useMemo(() => uniqueValues(exceptionEvents, 'component'), [exceptionEvents]);
  const browserOSOptions = useMemo(() => uniqueValues(exceptionEvents, 'browserOS'), [exceptionEvents]);
  const releaseOptions = useMemo(() => uniqueValues(exceptionEvents, 'release'), [exceptionEvents]);

  const report = useMemo(() => {
    if (now === null) return null;
    const bucketMinutes = Math.max(1, Math.round(windowMinutes / 12));
    return buildExceptionTrendReport(exceptionEvents, {
      windowMs: windowMinutes * MINUTE_MS,
      bucketMs: bucketMinutes * MINUTE_MS,
      now,
      filters: activeFilters,
      rules: alertRules,
    });
  }, [now, exceptionEvents, windowMinutes, activeFilters, alertRules]);

  const chartData = useMemo(
    () =>
      report?.buckets.map((bucket) => ({
        label: bucket.label,
        count: bucket.count,
        ratePerMinute: bucket.ratePerMinute,
      })) ?? [],
    [report],
  );

  const idempotencySeries = useMemo(() => {
    if (now === null) return [];
    const bucketMinutes = Math.max(1, Math.round(windowMinutes / 12));
    return buildIdempotencyRateSeries(idempotencyEvents, {
      windowMs: windowMinutes * MINUTE_MS,
      bucketMs: bucketMinutes * MINUTE_MS,
      now,
    }).map((bucket) => ({
      label: bucket.label,
      hits: bucket.hits,
      collisions: bucket.collisions,
      duplicateRatePct: Number((bucket.duplicateRate * 100).toFixed(1)),
    }));
  }, [now, idempotencyEvents, windowMinutes]);

  const overallDuplicateRate = duplicateRequestRate(idempotency);
  const duplicateRateBreached =
    idempotency.idempotency_requests > 0 && overallDuplicateRate > DUPLICATE_RATE_WARNING_THRESHOLD;

  function updateFilter(key: keyof FilterState, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function handleCreateRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const rule = createAlertRule({
        name: ruleDraft.name,
        metric: ruleDraft.metric,
        threshold: Number(ruleDraft.threshold),
        windowMinutes: Number(ruleDraft.windowMinutes),
        severity: ruleDraft.severity,
      });
      addAlertRule(rule);
      setRuleError(null);
      setRuleDraft((current) => ({ ...current, name: '' }));
    } catch (validationError) {
      setRuleError((validationError as Error).message);
    }
  }

  return (
    <main className="min-h-screen px-4 py-12 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-10">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-trellis-leaf">
            Maintainer operations
          </p>
          <h1 className="mt-3 text-4xl font-bold">Operational health</h1>
          <p className="mt-3 max-w-2xl text-gray-300">
            A redacted view of unresolved work, stale records, reconciliation drift, and user-impacting incidents.
          </p>
        </header>

        <section aria-labelledby="performance-heading" className="mb-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="performance-heading" className="text-2xl font-bold">Live system performance</h2>
              <p className="mt-1 text-sm text-gray-400">Gateway heap, connected clients, and configured RPC probe latency.</p>
            </div>
            <p
              className={`flex items-center gap-2 text-sm ${metricConnection === 'connected' ? 'text-green-300' : metricConnection === 'connecting' ? 'text-yellow-200' : 'text-gray-400'}`}
              role="status"
              aria-live="polite"
            >
              <span className={`h-2 w-2 rounded-full ${metricConnection === 'connected' ? 'bg-green-400' : metricConnection === 'connecting' ? 'bg-yellow-300' : 'bg-gray-500'}`} aria-hidden="true" />
              {metricConnection === 'connected' ? 'Live stream connected' : metricConnection === 'connecting' ? 'Connecting to telemetry' : metricConnection === 'unconfigured' ? 'Telemetry URL not configured' : 'Telemetry disconnected'}
            </p>
          </div>

          {memorySeverity !== 'normal' && performanceChartData.length > 0 && (
            <p role="alert" className={`mt-4 rounded-md border p-3 text-sm ${memorySeverity === 'critical' ? 'border-red-500/60 bg-red-500/15 text-red-100' : 'border-yellow-500/60 bg-yellow-500/10 text-yellow-100'}`}>
              {memorySeverity === 'critical' ? 'Critical' : 'Warning'}: heap usage is {Math.round(currentMemoryRatio * 100)}% of the current heap allocation.
            </p>
          )}

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <article className={`rounded-lg border p-4 ${memorySeverity === 'critical' ? 'border-red-500/70 bg-red-500/10' : memorySeverity === 'warning' ? 'border-yellow-500/70 bg-yellow-500/10' : 'border-trellis-vine/30 bg-trellis-vine/10'}`}>
              <h3 className="font-semibold">Heap memory (MB)</h3>
              <div className="mt-3 h-56">
                {mounted && <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={performanceChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(79, 191, 155, 0.2)" />
                    <XAxis dataKey="label" tick={{ fill: '#cbd5e1', fontSize: 10 }} />
                    <YAxis tick={{ fill: '#cbd5e1', fontSize: 10 }} />
                    <Tooltip />
                    <ReferenceLine y={performanceChartData.at(-1)?.heapTotalMb} stroke="#facc15" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="heapUsedMb" name="Heap used" stroke={memorySeverity === 'normal' ? '#4fbf9b' : memorySeverity === 'warning' ? '#facc15' : '#f87171'} strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>}
              </div>
              <p className="text-xs text-gray-400">Warning at 80%; critical at 90% of allocated heap.</p>
            </article>
            <article className="rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-4">
              <h3 className="font-semibold">Active WebSocket connections</h3>
              <div className="mt-3 h-56">
                {mounted && <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={performanceChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(79, 191, 155, 0.2)" />
                    <XAxis dataKey="label" tick={{ fill: '#cbd5e1', fontSize: 10 }} />
                    <YAxis allowDecimals={false} tick={{ fill: '#cbd5e1', fontSize: 10 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="activeConnections" name="Connections" stroke="#38bdf8" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>}
              </div>
            </article>
            <article className="rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-4">
              <h3 className="font-semibold">RPC latency (ms)</h3>
              <div className="mt-3 h-56">
                {mounted && <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={performanceChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(79, 191, 155, 0.2)" />
                    <XAxis dataKey="label" tick={{ fill: '#cbd5e1', fontSize: 10 }} />
                    <YAxis tick={{ fill: '#cbd5e1', fontSize: 10 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="rpcLatencyMs" name="RPC latency" stroke="#fb923c" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>}
              </div>
              {!process.env.NEXT_PUBLIC_TELEMETRY_WS_URL && <p className="text-xs text-gray-400">Configure the telemetry WebSocket URL to receive samples.</p>}
              {process.env.NEXT_PUBLIC_TELEMETRY_WS_URL && !metricSamples.some((sample) => sample.rpcLatencyMs !== null) && <p className="text-xs text-gray-400">Configure OPERATIONAL_HEALTH_RPC_URL on the gateway to collect RPC latency.</p>}
            </article>
          </div>
        </section>

        {error && <p role="alert" className="rounded-lg border border-red-500/50 bg-red-500/10 p-4 text-red-200">{error}</p>}
        {!health && !error && <p aria-live="polite" className="text-gray-300">Loading operational health...</p>}

        {health && (
          <>
            <section aria-labelledby="health-categories" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <h2 id="health-categories" className="sr-only">Health categories</h2>
              {health.categories.map((category) => (
                <article key={category.key} className="rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-5">
                  <p className="text-sm text-gray-300">{category.label}</p>
                  <p className="mt-2 text-4xl font-bold" aria-label={`${category.count} ${category.label}`}>
                    {category.count}
                  </p>
                  <p className={`mt-2 text-sm ${category.severity === 'critical' ? 'text-red-300' : category.severity === 'warning' ? 'text-yellow-300' : 'text-green-300'}`}>
                    {category.severity}
                  </p>
                  <Link className="mt-4 inline-block text-sm font-semibold text-trellis-leaf underline focus:outline-none focus:ring-2 focus:ring-trellis-leaf" href={category.href}>
                    Investigate records
                  </Link>
                </article>
              ))}
            </section>
            <p className="mt-6 text-xs text-gray-500">
              Last updated {new Date(health.generatedAt).toLocaleString()}. Personal contact and wallet data is excluded.
            </p>
          </>
        )}

        {report && report.breaches.length > 0 && (
          <section role="alert" aria-live="assertive" aria-labelledby="breach-heading" className="mt-10 space-y-3">
            <h2 id="breach-heading" className="text-lg font-semibold text-red-300">Alert thresholds breached</h2>
            {report.breaches.map((breach) => (
              <p
                key={breach.ruleId}
                className="rounded-lg border border-red-500/60 bg-red-500/15 p-4 text-red-100"
              >
                <span className="font-semibold">{breach.ruleName}</span> — observed {breach.observed} against a
                threshold of {breach.threshold} over {breach.windowMs / MINUTE_MS} minutes ({breach.severity}).
              </p>
            ))}
          </section>
        )}

        <section aria-labelledby="trend-heading" className="mt-10">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 id="trend-heading" className="text-2xl font-bold">Exception trend</h2>
              <p className="mt-1 text-sm text-gray-400">
                Error frequency per time bucket. Filters and alert rules apply to the chart below.
              </p>
            </div>
            <div>
              <label htmlFor="trend-window" className="block text-xs uppercase tracking-wide text-gray-400">
                Time window
              </label>
              <select
                id="trend-window"
                className="mt-1 rounded-md border border-trellis-vine/40 bg-transparent px-3 py-2 text-sm"
                value={windowMinutes}
                onChange={(event) => setWindowMinutes(Number(event.target.value))}
              >
                {WINDOW_OPTIONS.map((option) => (
                  <option key={option.minutes} value={option.minutes} className="text-black">
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {(['component', 'browserOS', 'release'] as const).map((dimension) => (
              <div key={dimension}>
                <label htmlFor={`filter-${dimension}`} className="block text-xs uppercase tracking-wide text-gray-400">
                  Group by {groupLabel(dimension)}
                </label>
                <select
                  id={`filter-${dimension}`}
                  className="mt-1 w-full rounded-md border border-trellis-vine/40 bg-transparent px-3 py-2 text-sm"
                  value={filters[dimension]}
                  onChange={(event) => updateFilter(dimension, event.target.value)}
                >
                  <option value={ALL_VALUE} className="text-black">All</option>
                  {(dimension === 'component' ? componentOptions : dimension === 'browserOS' ? browserOSOptions : releaseOptions).map((value) => (
                    <option key={value} value={value} className="text-black">{value}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="mt-6 rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-5">
            {mounted && now !== null ? (
              <div style={{ width: '100%', height: 320 }}>
                <ResponsiveContainer>
                  <LineChart data={chartData} margin={{ top: 10, right: 24, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(79, 191, 155, 0.2)" />
                    <XAxis dataKey="label" stroke="rgba(79, 191, 155, 0.6)" tick={{ fill: '#cbd5e1', fontSize: 12 }} />
                    <YAxis yAxisId="count" allowDecimals={false} stroke="rgba(79, 191, 155, 0.6)" tick={{ fill: '#cbd5e1', fontSize: 12 }} />
                    <YAxis yAxisId="rate" orientation="right" stroke="rgba(139, 92, 246, 0.6)" tick={{ fill: '#cbd5e1', fontSize: 12 }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'rgba(10, 14, 39, 0.9)',
                        border: '1px solid rgba(79, 191, 155, 0.5)',
                        borderRadius: '8px',
                      }}
                      labelStyle={{ color: 'rgb(139, 92, 246)' }}
                    />
                    <Legend />
                    <Line yAxisId="count" type="monotone" dataKey="count" name="Exceptions" stroke="rgb(139, 92, 246)" strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line yAxisId="rate" type="monotone" dataKey="ratePerMinute" name="Errors / min" stroke="rgb(6, 182, 212)" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-gray-400">Loading exception trend...</p>
            )}
            <p aria-live="polite" className="mt-3 text-xs text-gray-400">
              {report
                ? `${report.total} exception${report.total === 1 ? '' : 's'} in the selected window (${report.buckets.length} buckets).`
                : 'Aggregating exceptions...'}
            </p>
          </div>

          {report && (
            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              {(['component', 'browserOS', 'release'] as const).map((dimension) => (
                <div key={dimension} className="rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-4">
                  <h3 className="text-sm font-semibold text-gray-200">{groupLabel(dimension)} breakdown</h3>
                  {report.groups[dimension].length === 0 ? (
                    <p className="mt-2 text-sm text-gray-400">No exceptions.</p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-sm text-gray-300">
                      {report.groups[dimension].slice(0, 5).map((group) => (
                        <li key={group.key} className="flex justify-between gap-2">
                          <span>{group.key}</span>
                          <span className="font-semibold text-white">{group.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="idempotency-heading" className="mt-10" data-testid="idempotency-telemetry">
          <h2 id="idempotency-heading" className="text-2xl font-bold">Duplicate requests</h2>
          <p className="mt-1 text-sm text-gray-400">
            Idempotency key hits (duplicate submissions absorbed) and collisions (key reuse refused). A rising rate
            points to double-submit bugs or network retry storms.
          </p>

          {duplicateRateBreached && (
            <p role="alert" className="mt-4 rounded-lg border border-yellow-500/60 bg-yellow-500/10 p-4 text-yellow-100">
              Duplicate request rate is {formatPercent(overallDuplicateRate)}, above the{' '}
              {formatPercent(DUPLICATE_RATE_WARNING_THRESHOLD)} warning threshold.
            </p>
          )}

          <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {[
              { label: 'Idempotent requests', value: idempotency.idempotency_requests },
              { label: 'Key hits', value: idempotency.idempotency_hits },
              { label: 'Key collisions', value: idempotency.idempotency_collisions },
              { label: 'Retries', value: idempotency.idempotency_retries },
              { label: 'Duplicate rate', value: formatPercent(overallDuplicateRate) },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-4">
                <dt className="text-sm text-gray-300">{item.label}</dt>
                <dd className="mt-1 text-2xl font-bold">{item.value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-6 rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-5">
            {mounted && now !== null ? (
              <div style={{ width: '100%', height: 280 }}>
                <ResponsiveContainer>
                  <LineChart data={idempotencySeries} margin={{ top: 10, right: 24, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(79, 191, 155, 0.2)" />
                    <XAxis dataKey="label" stroke="rgba(79, 191, 155, 0.6)" tick={{ fill: '#cbd5e1', fontSize: 12 }} />
                    <YAxis yAxisId="count" allowDecimals={false} stroke="rgba(79, 191, 155, 0.6)" tick={{ fill: '#cbd5e1', fontSize: 12 }} />
                    <YAxis yAxisId="rate" orientation="right" unit="%" domain={[0, 100]} stroke="rgba(234, 179, 8, 0.6)" tick={{ fill: '#cbd5e1', fontSize: 12 }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'rgba(10, 14, 39, 0.9)',
                        border: '1px solid rgba(79, 191, 155, 0.5)',
                        borderRadius: '8px',
                      }}
                      labelStyle={{ color: 'rgb(139, 92, 246)' }}
                    />
                    <Legend />
                    <Line yAxisId="count" type="monotone" dataKey="hits" name="Key hits" stroke="rgb(6, 182, 212)" strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line yAxisId="count" type="monotone" dataKey="collisions" name="Collisions" stroke="rgb(239, 68, 68)" strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line yAxisId="rate" type="monotone" dataKey="duplicateRatePct" name="Duplicate rate %" stroke="rgb(234, 179, 8)" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-gray-400">Loading duplicate request telemetry...</p>
            )}
            <p className="mt-3 text-xs text-gray-400">
              {idempotencyEvents.length === 0
                ? 'No idempotent requests recorded yet.'
                : `${idempotencyEvents.length} recent idempotency event${idempotencyEvents.length === 1 ? '' : 's'} tracked.`}
            </p>
          </div>
        </section>

        <section aria-labelledby="abuse-heading" className="mt-10" data-testid="abuse-telemetry">
          <h2 id="abuse-heading" className="text-2xl font-bold">Risk-scored abuse detection</h2>
          <p className="mt-1 text-sm text-gray-400">
            Real-time evaluation of high-impact protocol operations (transfers, claims, mints, governance). Evaluates velocity, failure rates, large volumes, and network anomaly signals.
          </p>

          <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {[
              { label: 'Total evaluations', value: abuse.totalEvaluations, color: 'text-white' },
              { label: 'Low-risk allowed', value: abuse.lowRiskAllowed, color: 'text-green-300' },
              { label: 'Step-up challenges', value: abuse.stepUpChallenges, color: 'text-yellow-300' },
              { label: 'Quarantined reviews', value: abuse.quarantinedReviews, color: 'text-orange-300' },
              { label: 'Critical blocks', value: abuse.criticalBlocks, color: 'text-red-300' },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-4">
                <dt className="text-sm text-gray-300">{item.label}</dt>
                <dd className={`mt-1 text-2xl font-bold ${item.color}`}>{item.value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-6 rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-5">
            <h3 className="text-lg font-semibold mb-3">Recent risk-scored activity</h3>
            {abuseEvents.length === 0 ? (
              <p className="text-sm text-gray-400">No high-risk operations evaluated in this session yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-trellis-vine/20 text-left text-sm">
                  <thead>
                    <tr className="text-gray-400">
                      <th className="py-2 pr-4 font-semibold">Time</th>
                      <th className="py-2 pr-4 font-semibold">Operation</th>
                      <th className="py-2 pr-4 font-semibold">Actor</th>
                      <th className="py-2 pr-4 font-semibold">Risk score</th>
                      <th className="py-2 pr-4 font-semibold">Action</th>
                      <th className="py-2 font-semibold">Primary signals</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-trellis-vine/10">
                    {abuseEvents.slice(-10).reverse().map((ev, idx) => (
                      <tr key={`${ev.timestamp}-${idx}`} className="text-gray-300">
                        <td className="py-2 pr-4 text-xs font-mono">{new Date(ev.timestamp).toLocaleTimeString()}</td>
                        <td className="py-2 pr-4 font-mono text-trellis-leaf">{ev.operation}</td>
                        <td className="py-2 pr-4 font-mono text-xs">{ev.actorId}</td>
                        <td className="py-2 pr-4">
                          <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${ev.riskScore >= 70 ? 'bg-red-500/20 text-red-300' : ev.riskScore >= 40 ? 'bg-yellow-500/20 text-yellow-300' : 'bg-green-500/20 text-green-300'}`}>
                            {ev.riskScore} / 100
                          </span>
                        </td>
                        <td className="py-2 pr-4">
                          <span className={`capitalize font-semibold text-xs ${ev.action === 'block' ? 'text-red-400' : ev.action === 'review' ? 'text-orange-400' : ev.action === 'step_up' ? 'text-yellow-400' : 'text-green-400'}`}>
                            {ev.action.replace('_', ' ')}
                          </span>
                        </td>
                        <td className="py-2 text-xs text-gray-400">
                          {ev.signals.length === 0 ? 'Normal activity' : ev.signals.map(s => s.code).join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <section aria-labelledby="rules-heading" className="mt-10">
          <h2 id="rules-heading" className="text-2xl font-bold">Alert rules</h2>
          <p className="mt-1 text-sm text-gray-400">
            Thresholds are evaluated against the recent exception stream; a breach raises the banner above.
          </p>

          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <div className="rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-5">
              <h3 className="text-lg font-semibold">Active rules</h3>
              {alertRules.length === 0 ? (
                <p className="mt-2 text-sm text-gray-400">No alert rules configured.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {alertRules.map((rule) => {
                    const breach = report?.breaches.find((entry) => entry.ruleId === rule.id);
                    return (
                      <li key={rule.id} className="rounded-md border border-trellis-vine/30 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-semibold">{rule.name}</p>
                            <p className="text-sm text-gray-400">{describeAlertRule(rule)}</p>
                            <p className={`mt-1 text-xs font-semibold ${breach ? 'text-red-300' : 'text-green-300'}`}>
                              {breach ? `Breaching (${breach.observed} observed)` : 'Within threshold'}
                            </p>
                          </div>
                          <button
                            type="button"
                            className="rounded border border-red-400/60 px-2 py-1 text-xs text-red-200 focus:outline-none focus:ring-2 focus:ring-red-300"
                            onClick={() => removeAlertRule(rule.id)}
                            aria-label={`Remove alert rule ${rule.name}`}
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <form onSubmit={handleCreateRule} className="rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 p-5">
              <h3 className="text-lg font-semibold">Create alert rule</h3>

              <div className="mt-3">
                <label htmlFor="rule-name" className="block text-xs uppercase tracking-wide text-gray-400">Rule name</label>
                <input
                  id="rule-name"
                  className="mt-1 w-full rounded-md border border-trellis-vine/40 bg-transparent px-3 py-2 text-sm"
                  placeholder="RPC errors > 15 in 5 min"
                  value={ruleDraft.name}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, name: event.target.value }))}
                />
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="rule-metric" className="block text-xs uppercase tracking-wide text-gray-400">Metric</label>
                  <select
                    id="rule-metric"
                    className="mt-1 w-full rounded-md border border-trellis-vine/40 bg-transparent px-3 py-2 text-sm"
                    value={ruleDraft.metric}
                    onChange={(event) => setRuleDraft((current) => ({ ...current, metric: event.target.value as AlertMetric }))}
                  >
                    {METRIC_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value} className="text-black">{option.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="rule-threshold" className="block text-xs uppercase tracking-wide text-gray-400">Threshold</label>
                  <input
                    id="rule-threshold"
                    type="number"
                    min={1}
                    className="mt-1 w-full rounded-md border border-trellis-vine/40 bg-transparent px-3 py-2 text-sm"
                    value={ruleDraft.threshold}
                    onChange={(event) => setRuleDraft((current) => ({ ...current, threshold: event.target.value }))}
                    aria-invalid={Boolean(ruleError)}
                  />
                </div>
                <div>
                  <label htmlFor="rule-window" className="block text-xs uppercase tracking-wide text-gray-400">Window (min)</label>
                  <input
                    id="rule-window"
                    type="number"
                    min={1}
                    max={1440}
                    className="mt-1 w-full rounded-md border border-trellis-vine/40 bg-transparent px-3 py-2 text-sm"
                    value={ruleDraft.windowMinutes}
                    onChange={(event) => setRuleDraft((current) => ({ ...current, windowMinutes: event.target.value }))}
                  />
                </div>
              </div>

              <div className="mt-3">
                <label htmlFor="rule-severity" className="block text-xs uppercase tracking-wide text-gray-400">Severity</label>
                <select
                  id="rule-severity"
                  className="mt-1 w-full rounded-md border border-trellis-vine/40 bg-transparent px-3 py-2 text-sm"
                  value={ruleDraft.severity}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, severity: event.target.value as AlertRule['severity'] }))}
                >
                  <option value="warning" className="text-black">Warning</option>
                  <option value="critical" className="text-black">Critical</option>
                </select>
              </div>

              {ruleError && <p role="alert" className="mt-3 text-sm text-red-300">{ruleError}</p>}

              <button
                type="submit"
                className="mt-4 rounded-md bg-trellis-leaf px-4 py-2 text-sm font-semibold text-black focus:outline-none focus:ring-2 focus:ring-trellis-leaf"
              >
                Add rule
              </button>
            </form>
          </div>
        </section>
      </div>
        <div className="mx-auto max-w-6xl"><DeadLetterPanel /></div>
    </main>
  );
}
