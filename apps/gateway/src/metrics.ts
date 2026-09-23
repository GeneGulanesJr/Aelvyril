// Minimal Prometheus text-format metrics. Spec §11: observability hooks.
// No external dep — counters + gauges + text serialization.
//
// Add new metrics via createMetrics() and increment in the route handlers.

export interface Metrics {
  httpRequestsTotal: Counter;
  httpRequestDurationMs: Histogram;
  conversationCreationsTotal: Counter;
  promptRequestsTotal: Counter;
  promptRejections: Counter;
  rateLimitedTotal: Counter;
  conversationLimitReachedTotal: Counter;
  workspaceRejectionsTotal: Counter;
  activeSessionHosts: Gauge;
  /** Render the Prometheus text exposition format. */
  render(): string;
}

interface Counter { inc(labels?: Record<string, string>): void; }
interface Gauge { inc(labels?: Record<string, string>): void; dec(labels?: Record<string, string>): void; }
interface Histogram {
  observe(value: number, labels?: Record<string, string>): void;
}

interface CounterSeries {
  labels: Record<string, string>;
  value: number;
}
interface HistogramSeries {
  labels: Record<string, string>;
  buckets: number[];
  counts: number[]; // parallel to buckets; counts[i] = count of values <= buckets[i]; last entry is +Inf
  sum: number;
  count: number;
}

const DEFAULT_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];

function makeCounter(name: string, help: string, labelNames: string[] = []) {
  const series: CounterSeries[] = [];
  return {
    name,
    help,
    labelNames,
    series,
    inc(labels: Record<string, string> = {}) {
      const match = series.find(
        (s) => Object.keys(labels).length === Object.keys(s.labels).length &&
          Object.entries(labels).every(([k, v]) => s.labels[k] === v),
      );
      if (match) match.value += 1;
      else series.push({ labels: { ...labels }, value: 1 });
    },
  };
}

function makeGauge(name: string, help: string, labelNames: string[] = []) {
  const series: CounterSeries[] = []; // reuse the same shape
  return {
    name,
    help,
    labelNames,
    series,
    inc(labels: Record<string, string> = {}) {
      const match = series.find(
        (s) => Object.keys(labels).length === Object.keys(s.labels).length &&
          Object.entries(labels).every(([k, v]) => s.labels[k] === v),
      );
      if (match) match.value += 1;
      else series.push({ labels: { ...labels }, value: 1 });
    },
    dec(labels: Record<string, string> = {}) {
      const match = series.find(
        (s) => Object.keys(labels).length === Object.keys(s.labels).length &&
          Object.entries(labels).every(([k, v]) => s.labels[k] === v),
      );
      if (match) match.value -= 1;
    },
  };
}

function makeHistogram(
  name: string,
  help: string,
  labelNames: string[] = [],
  buckets: number[] = DEFAULT_BUCKETS_MS,
) {
  return {
    name,
    help,
    labelNames,
    buckets: [...buckets, Infinity],
    series: [] as HistogramSeries[],
    observe(value: number, labels: Record<string, string> = {}) {
      const key = JSON.stringify(labels);
      let s = this.series.find((x: HistogramSeries) => JSON.stringify(x.labels) === key);
      if (!s) {
        s = {
          labels: { ...labels },
          buckets: [...this.buckets],
          counts: new Array(this.buckets.length).fill(0),
          sum: 0,
          count: 0,
        };
        this.series.push(s);
      }
      s.sum += value;
      s.count += 1;
      for (let i = 0; i < this.buckets.length; i++) {
        if (value <= this.buckets[i]!) {
          s.counts[i]! += 1;
        }
      }
    },
  };
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const parts = keys.map((k) => `${k}="${escape(labels[k]!)}"`);
  return `{${parts.join(",")}}`;
}

function escape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function renderCounter(m: { name: string; help: string; series: CounterSeries[] }): string {
  const lines = [`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} counter`];
  for (const s of m.series) {
    lines.push(`${m.name}${formatLabels(s.labels)} ${s.value}`);
  }
  return lines.join("\n");
}

function renderGauge(m: { name: string; help: string; series: CounterSeries[] }): string {
  const lines = [`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} gauge`];
  for (const s of m.series) {
    lines.push(`${m.name}${formatLabels(s.labels)} ${s.value}`);
  }
  return lines.join("\n");
}

function renderHistogram(m: {
  name: string;
  help: string;
  buckets: number[];
  series: HistogramSeries[];
}): string {
  const lines = [`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} histogram`];
  for (const s of m.series) {
    let cumulative = 0;
    for (let i = 0; i < m.buckets.length; i++) {
      cumulative = s.counts[i]!;
      const le = m.buckets[i] === Infinity ? "+Inf" : String(m.buckets[i]);
      lines.push(`${m.name}_bucket${formatLabels({ ...s.labels, le })} ${cumulative}`);
    }
    lines.push(`${m.name}_sum${formatLabels(s.labels)} ${s.sum}`);
    lines.push(`${m.name}_count${formatLabels(s.labels)} ${s.count}`);
  }
  return lines.join("\n");
}

export function createMetrics(): Metrics {
  const httpRequestsTotal = makeCounter("aelvyril_http_requests_total", "Total HTTP requests", ["method", "route", "status"]);
  const httpRequestDurationMs = makeHistogram(
    "aelvyril_http_request_duration_ms",
    "HTTP request duration in ms",
    ["method", "route", "status"],
  );
  const conversationCreationsTotal = makeCounter(
    "aelvyril_conversation_creations_total",
    "Total conversation rows created",
  );
  const promptRequestsTotal = makeCounter(
    "aelvyril_prompt_requests_total",
    "Total /prompt requests accepted (202)",
  );
  const promptRejections = makeCounter(
    "aelvyril_prompt_rejections_total",
    "Total /prompt rejections (agent_rejected)",
  );
  const rateLimitedTotal = makeCounter(
    "aelvyril_rate_limited_total",
    "Total 429 responses",
  );
  const conversationLimitReachedTotal = makeCounter(
    "aelvyril_conversation_limit_reached_total",
    "Total 503 responses from the per-user cap",
  );
  const workspaceRejectionsTotal = makeCounter(
    "aelvyril_workspace_rejections_total",
    "Total 400 responses for non-allowlisted workspaces",
  );
  const activeSessionHosts = makeGauge(
    "aelvyril_active_session_hosts",
    "Currently-spawned pi children",
  );

  function render(): string {
    return [
      renderCounter(httpRequestsTotal),
      renderHistogram(httpRequestDurationMs),
      renderCounter(conversationCreationsTotal),
      renderCounter(promptRequestsTotal),
      renderCounter(promptRejections),
      renderCounter(rateLimitedTotal),
      renderCounter(conversationLimitReachedTotal),
      renderCounter(workspaceRejectionsTotal),
      renderGauge(activeSessionHosts),
      "",
    ].join("\n");
  }

  return {
    httpRequestsTotal,
    httpRequestDurationMs,
    conversationCreationsTotal,
    promptRequestsTotal,
    promptRejections,
    rateLimitedTotal,
    conversationLimitReachedTotal,
    workspaceRejectionsTotal,
    activeSessionHosts,
    render,
  };
}
