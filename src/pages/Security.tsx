import { useState, useEffect } from "react";
import {
  Shield,
  Gauge,
  Lock,
  Activity,
  AlertTriangle,
  Check,
  RefreshCw,
  Key,
  Zap,
} from "lucide-react";
import {
  useLatencyStats,
  useRateLimitStatus,
  useKeyAuditLog,
  useTlsStatus,
} from "../hooks/useTauri";
import styles from "./Security.module.css";

export function Security() {
  const [activeTab, setActiveTab] = useState<"overview" | "latency" | "audit">("overview");

  const tabs = [
    { id: "overview" as const, label: "Security Overview", icon: Shield },
    { id: "latency" as const, label: "Performance", icon: Gauge },
    { id: "audit" as const, label: "Key Audit Trail", icon: Key },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Security & Performance</h1>
        <p className={styles.subtitle}>
          Monitor gateway security, latency, and key lifecycle events
        </p>
      </div>

      <div className={styles.tabBar}>
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`${styles.tab} ${activeTab === id ? styles.activeTab : ""}`}
            onClick={() => setActiveTab(id)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {activeTab === "overview" && <SecurityOverview />}
      {activeTab === "latency" && <PerformanceView />}
      {activeTab === "audit" && <KeyAuditTrail />}
    </div>
  );
}

// ── Security Overview ─────────────────────────────────────────────────────────

function SecurityOverview() {
  const tls = useTlsStatus();
  const rateLimit = useRateLimitStatus();

  return (
    <div className={styles.section}>
      {/* Loopback binding */}
      <div className={styles.statusCard}>
        <div className={styles.cardHeader}>
          <Lock size={16} />
          <h3 className={styles.cardTitle}>Network Binding</h3>
          <span className={`${styles.badge} ${styles.badgeOk}`}>Secure</span>
        </div>
        <p className={styles.cardDesc}>
          Gateway binds to <code>127.0.0.1</code> (loopback only). No external
          connections are accepted. All traffic stays on the local machine.
        </p>
      </div>

      {/* TLS */}
      <div className={styles.statusCard}>
        <div className={styles.cardHeader}>
          <Shield size={16} />
          <h3 className={styles.cardTitle}>TLS Encryption</h3>
          {tls.status?.enabled ? (
            <span className={`${styles.badge} ${styles.badgeOk}`}>
              <Check size={12} /> Enabled
            </span>
          ) : (
            <span className={`${styles.badge} ${styles.badgeOff}`}>Optional</span>
          )}
        </div>
        <p className={styles.cardDesc}>
          {tls.status?.enabled
            ? "Self-signed TLS certificate is active. Prevents local packet sniffing."
            : "TLS is disabled. Enable for defense-in-depth against local packet sniffing."}
        </p>
        {tls.status && (
          <div className={styles.cardMeta}>
            <span>Cert exists: {tls.status.files_exist ? "✓" : "✗"}</span>
            {tls.status.validity && (
              <span>Cert size: {(tls.status.validity.cert_size_bytes / 1024).toFixed(1)} KB</span>
            )}
          </div>
        )}
      </div>

      {/* Rate Limiting */}
      <div className={styles.statusCard}>
        <div className={styles.cardHeader}>
          <Zap size={16} />
          <h3 className={styles.cardTitle}>Rate Limiting</h3>
          <span className={`${styles.badge} ${styles.badgeOk}`}>Active</span>
        </div>
        <p className={styles.cardDesc}>
          Requests are rate-limited per client to prevent abuse. Limits are
          enforced at both per-minute and per-hour granularity, plus a
          concurrent request cap.
        </p>
        {rateLimit.status && (
          <div className={styles.rateLimits}>
            <div className={styles.rateItem}>
              <span className={styles.rateLabel}>Per minute</span>
              <span className={styles.rateValue}>
                {rateLimit.status.max_requests_per_minute} req
              </span>
            </div>
            <div className={styles.rateItem}>
              <span className={styles.rateLabel}>Per hour</span>
              <span className={styles.rateValue}>
                {rateLimit.status.max_requests_per_hour} req
              </span>
            </div>
            <div className={styles.rateItem}>
              <span className={styles.rateLabel}>Concurrent</span>
              <span className={styles.rateValue}>
                {rateLimit.status.max_concurrent} req
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Key Lifecycle */}
      <div className={styles.statusCard}>
        <div className={styles.cardHeader}>
          <Key size={16} />
          <h3 className={styles.cardTitle}>Key Security</h3>
          <span className={`${styles.badge} ${styles.badgeOk}`}>Enforced</span>
        </div>
        <p className={styles.cardDesc}>
          All API keys are stored exclusively in the OS keychain (Keychain on
          macOS, Credential Manager on Windows, Secret Service on Linux). Keys
          never touch disk, logs, or crash dumps. Every key access is audited.
        </p>
      </div>
    </div>
  );
}

// ── Performance View ──────────────────────────────────────────────────────────

function PerformanceView() {
  const { stats, refresh } = useLatencyStats();

  useEffect(() => {
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (!stats) {
    return (
      <div className={styles.section}>
        <p className={styles.empty}>No latency data yet. Send some requests through the gateway.</p>
      </div>
    );
  }

  const stages = [
    { label: "Authentication", value: stats.avg_auth_ms, color: "#4ade80" },
    { label: "PII Detection", value: stats.avg_pii_detect_ms, color: "#60a5fa" },
    { label: "Pseudonymization", value: stats.avg_pseudonymize_ms, color: "#a78bfa" },
    { label: "Upstream Forward", value: stats.avg_upstream_ms, color: "#fb923c" },
    { label: "Rehydration", value: stats.avg_rehydrate_ms, color: "#f472b6" },
  ];

  const maxStageMs = Math.max(...stages.map((s) => s.value), 1);

  return (
    <div className={styles.section}>
      <div className={styles.perfHeader}>
        <div className={styles.perfStat}>
          <span className={styles.perfStatValue}>{stats.sample_count}</span>
          <span className={styles.perfStatLabel}>Requests Tracked</span>
        </div>
        <div className={styles.perfStat}>
          <span className={styles.perfStatValue}>{stats.avg_total_ms.toFixed(1)} ms</span>
          <span className={styles.perfStatLabel}>Avg Latency</span>
        </div>
        <div className={styles.perfStat}>
          <span className={styles.perfStatValue}>{stats.p95_total_ms.toFixed(1)} ms</span>
          <span className={styles.perfStatLabel}>P95 Latency</span>
        </div>
        <div className={styles.perfStat}>
          <span className={styles.perfStatValue}>{stats.p99_total_ms.toFixed(1)} ms</span>
          <span className={styles.perfStatLabel}>P99 Latency</span>
        </div>
        <button className={styles.refreshBtn} onClick={refresh}>
          <RefreshCw size={14} />
        </button>
      </div>

      <h3 className={styles.subTitle}>
        <Activity size={16} />
        Pipeline Breakdown
      </h3>
      <p className={styles.subDesc}>
        Average time spent in each stage of request processing. Lower is better.
      </p>

      <div className={styles.stageList}>
        {stages.map((stage) => (
          <div key={stage.label} className={styles.stageRow}>
            <span className={styles.stageLabel}>{stage.label}</span>
            <div className={styles.stageBar}>
              <div
                className={styles.stageFill}
                style={{
                  width: `${Math.min((stage.value / maxStageMs) * 100, 100)}%`,
                  backgroundColor: stage.color,
                }}
              />
            </div>
            <span className={styles.stageValue}>{stage.value.toFixed(1)} ms</span>
          </div>
        ))}
      </div>

      {/* Target indicator */}
      {stats.avg_total_ms > 0 && stats.avg_total_ms < 500 && (
        <div className={`${styles.targetBanner} ${styles.targetMet}`}>
          <Check size={14} />
          Average gateway overhead is under the 500ms target
        </div>
      )}
      {stats.avg_total_ms >= 500 && (
        <div className={`${styles.targetBanner} ${styles.targetExceeded}`}>
          <AlertTriangle size={14} />
          Average gateway overhead exceeds the 500ms target ({stats.avg_total_ms.toFixed(0)}ms)
        </div>
      )}
    </div>
  );
}

// ── Key Audit Trail ───────────────────────────────────────────────────────────

function KeyAuditTrail() {
  const { events, refresh } = useKeyAuditLog();

  useEffect(() => {
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h3 className={styles.subTitle}>
          <Key size={16} />
          Key Lifecycle Events
        </h3>
        <button className={styles.refreshBtn} onClick={refresh}>
          <RefreshCw size={14} />
        </button>
      </div>
      <p className={styles.subDesc}>
        Every key creation, access, rotation, and deletion is recorded. Key values
        are never stored in this log — only identifiers and operation metadata.
      </p>

      {events.length === 0 ? (
        <div className={styles.empty}>No key events recorded yet.</div>
      ) : (
        <div className={styles.auditList}>
          {[...events].reverse().map((event, i) => (
            <div key={i} className={styles.auditRow}>
              <div className={styles.auditTime}>
                {new Date(event.timestamp).toLocaleTimeString()}
              </div>
              <div className={styles.auditKey}>{event.key_id}</div>
              <div className={styles.auditAction}>
                <span className={`${styles.actionBadge} ${getActionClass(event.action)}`}>
                  {event.action}
                </span>
              </div>
              <div className={styles.auditDetail}>{event.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function getActionClass(action: string): string {
  switch (action) {
    case "Created":
      return styles.actionCreated;
    case "Accessed":
      return styles.actionAccessed;
    case "Rotated":
      return styles.actionRotated;
    case "Deleted":
      return styles.actionDeleted;
    case "AccessDenied":
      return styles.actionDenied;
    default:
      return "";
  }
}
