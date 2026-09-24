import { describe, expect, it } from "vitest";
import { createMetrics } from "./metrics.js";

describe("createMetrics", () => {
  it("renders the Prometheus text format with all metrics", () => {
    const m = createMetrics();
    const out = m.render();
    expect(out).toContain("# HELP aelvyril_http_requests_total");
    expect(out).toContain("# TYPE aelvyril_http_requests_total counter");
    expect(out).toContain("# TYPE aelvyril_http_request_duration_ms histogram");
    expect(out).toContain("# TYPE aelvyril_active_session_hosts gauge");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("counts requests by method/route/status", () => {
    const m = createMetrics();
    m.httpRequestsTotal.inc({ method: "POST", route: "/v1/threads/:id/prompt", status: "202" });
    m.httpRequestsTotal.inc({ method: "POST", route: "/v1/threads/:id/prompt", status: "202" });
    m.httpRequestsTotal.inc({ method: "POST", route: "/v1/threads/:id/prompt", status: "429" });
    const out = m.render();
    expect(out).toContain('aelvyril_http_requests_total{method="POST",route="/v1/threads/:id/prompt",status="202"} 2');
    expect(out).toContain('aelvyril_http_requests_total{method="POST",route="/v1/threads/:id/prompt",status="429"} 1');
  });

  it("buckets observations into the histogram", () => {
    const m = createMetrics();
    m.httpRequestDurationMs.observe(7, { method: "GET", route: "/healthz", status: "200" });
    m.httpRequestDurationMs.observe(300, { method: "GET", route: "/healthz", status: "200" });
    m.httpRequestDurationMs.observe(9999, { method: "GET", route: "/healthz", status: "200" });
    const out = m.render();
    // le=10 bucket: 1 (only 7ms)
    expect(out).toContain('aelvyril_http_request_duration_ms_bucket{le="10",method="GET",route="/healthz",status="200"} 1');
    // le=500 bucket: 2 (7 + 300)
    expect(out).toContain('aelvyril_http_request_duration_ms_bucket{le="500",method="GET",route="/healthz",status="200"} 2');
    // le="+Inf" bucket: 3 (all)
    expect(out).toContain('aelvyril_http_request_duration_ms_bucket{le="+Inf",method="GET",route="/healthz",status="200"} 3');
  });

  it("gauges go up and down", () => {
    const m = createMetrics();
    m.activeSessionHosts.inc();
    m.activeSessionHosts.inc();
    m.activeSessionHosts.dec();
    const out = m.render();
    expect(out).toContain("aelvyril_active_session_hosts 1");
  });

  it("escapes special characters in label values", () => {
    const m = createMetrics();
    m.httpRequestsTotal.inc({ method: "GET", route: "/foo", status: 'has "quote" and \\backslash' });
    const out = m.render();
    expect(out).toContain('status="has \\"quote\\" and \\\\backslash"');
  });
});