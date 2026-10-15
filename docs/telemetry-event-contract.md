# Telemetry Event Contract

This document defines the minimum safe event shape for the existing client telemetry surface. It gives application features one shared contract for recording outcomes without turning telemetry into a source of user or wallet data.

## Required Fields

Every event includes:

| Field | Meaning |
| --- | --- |
| `id` | Unique event identifier. |
| `ts` | Event timestamp in milliseconds. |
| `agentRef` | Opaque, non-identifying actor reference. |
| `type` | `heartbeat`, `status`, `error`, `task_started`, or `task_completed`. |
| `severity` | `debug`, `info`, `warn`, `error`, or `critical`. |

The optional payload may contain only a correlation ID, operation kind, state, stable error code, and a human-safe message.

## Operation Names

Use stable, low-cardinality values for `taskKind`, such as `wallet_connect`, `wallet_sign`, `arena_load`, `transaction_submit`, or `data_refresh`. Do not include identifiers, route parameters, transaction XDR, request bodies, wallet addresses, or free-form user input in an operation name.

## Outcomes And Latency

For an operation that starts and completes, emit `task_started` and `task_completed` with the same opaque `correlationId`. Include a terminal `state` such as `succeeded`, `failed`, `cancelled`, or `timed_out`. The producer or dashboard may derive latency from the two timestamps; do not add unbounded timing labels.

Failures should use a stable `code` such as `wallet_unavailable`, `user_rejected`, `network_mismatch`, `rpc_unavailable`, or `request_timeout`. Error messages must be useful to operators while remaining safe to expose.

## Privacy Boundary

The telemetry sanitizer removes sensitive keys and redacts obvious email and long base64-like values. Producers must still avoid sending passwords, tokens, cookies, IP addresses, names, account IDs, addresses, public keys, private keys, raw transaction payloads, and stack traces. Sanitization is defense in depth, not permission to emit sensitive data. The client stream accepts at most 30 events per second and retains at most 500 events; excess events are dropped from the dashboard view. Metric labels use a fixed key allow-list, reject malformed or overlong values, normalize common ID-shaped route segments, and retain at most six dimensions. Prometheus responses are capped at 200 series and 1,000 newest points per series.

## Metric Export (OTLP)

`lib/metric-definitions.ts` records client counters, histograms, and gauges through `OtlpMetricExporter`, which batches buffered points and POSTs OTLP/HTTP JSON to a collector.

| Variable | Purpose |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL; `/v1/metrics` is appended automatically. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Signal-specific override, used as-is. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` (default), `http/protobuf`, or `grpc`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `key=value` collector headers. |
| `OTEL_SERVICE_NAME` | Resource `service.name` value. |
| `OTEL_METRIC_EXPORT_INTERVAL` | Batch interval in milliseconds (default 30000). |
| `OTEL_METRIC_ALLOW_UNSAFE` | `true` bypasses the `SAFE_METRICS` allow-list (local debugging only). |

The browser bundle only sees `NEXT_PUBLIC_*` variables, so client-side export uses `NEXT_PUBLIC_OTEL_EXPORTER_OTLP_*`. Omit the endpoint entirely to keep metrics local — the exporter then buffers without transmitting.

Batches use delta temporality: counters are encoded as monotonic sums, histograms carry explicit bucket bounds plus string bucket counts, and gauges carry the last observed value. Attribute keys failing `isFieldSafe` and metric names outside `SAFE_METRICS` are dropped before encoding, so exported batches stay inside the privacy boundary above.

The client always transmits OTLP/HTTP JSON. A `grpc` protocol value is treated as a transport hint for the collector setup and still goes over the HTTP endpoint; wire a real gRPC transport only if a collector requires it.

## Dashboard Queries

The primary operational views should group by `type`, `severity`, `taskKind`, `state`, and `code` only. These bounded dimensions support failure-rate and conversion analysis without creating a high-cardinality or personally identifying metric stream.

## Cardinality and overload operations

Unknown metric label keys and values outside the supported formats are omitted from rendered series. When a collector returns too many series or points, the dashboard keeps the first 200 series and newest 1,000 points per series; inspect the collector query and its label dimensions if expected data is missing. The live telemetry view drops events above its 30-per-second display budget, so it is intended for operational visibility rather than complete audit storage. Persist audit events in the protected server-side system of record.

If a legitimate dashboard dimension is missing, add its key and a bounded value rule to `lib/metrics/sanitize.ts` and cover it with a sanitizer test. If a panel regularly reaches the response caps, reduce cardinality in its PromQL query or increase the exported caps with a documented browser memory budget. Recovery requires no data migration: the limits apply only to client-rendered responses, and reconnecting or reloading resumes the current stream. To roll back, revert the sanitizer and cap changes together; do not disable server-side privacy filtering.

## Transports

The dashboard prefers an unordered, unreliable WebRTC data channel (`ordered: false`, `maxRetransmits: 0`) because a
stale metric tick must never delay the ticks behind it. The existing WebSocket stream remains the transport whenever
WebRTC is unsupported, ICE does not complete, or no producer peer is connected, so the event contract above is
identical on both paths.

Connection state, the active transport, and the reason for any fallback are exposed by `useTelemetryStream` (and its
`useTelemetryWebSocket` compatibility wrapper). Configuration lives in `NEXT_PUBLIC_TELEMETRY_WEBRTC`,
`NEXT_PUBLIC_TELEMETRY_STUN_URLS`, `NEXT_PUBLIC_TELEMETRY_TURN_URL`, and `NEXT_PUBLIC_TELEMETRY_ICE_SERVERS`.
