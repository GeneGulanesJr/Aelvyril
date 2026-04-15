import { Zap, Eye, Activity, Lock } from "lucide-react";
import { useGatewayStatus, useAuditStats } from "../hooks/useTauri";
import { useAnimatedValues } from "../hooks/useAnimatedValues";
import { StatCard } from "../components/StatCard";
import { EntityBreakdown } from "../components/EntityBreakdown";
import { GatewayInfo } from "../components/GatewayInfo";
import styles from "./Dashboard.module.css";

export function Dashboard() {
  const { status, loading } = useGatewayStatus();
  const { stats } = useAuditStats();

  const targets = {
    requests: stats?.total_requests ?? 0,
    entities: stats?.total_entities ?? 0,
    sessions: status?.active_sessions ?? 0,
    providers: status?.provider_count ?? 0,
  };

  const animatedValues = useAnimatedValues(targets);

  const statCards = [
    { icon: Zap, label: "Total Requests", value: animatedValues.requests, color: "accent" },
    { icon: Eye, label: "Entities Caught", value: animatedValues.entities, color: "warning" },
    { icon: Activity, label: "Active Sessions", value: animatedValues.sessions, color: "success" },
    { icon: Lock, label: "Providers", value: animatedValues.providers, color: "danger" },
  ];

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>Dashboard</h1>
          <p className={styles.subtitle}>Loading gateway status…</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Dashboard</h1>
          <p className={styles.subtitle}>Your privacy gateway overview</p>
        </div>
        <div className={styles.statusBadge}>
          <div
            className={`${styles.statusDot} ${status?.active ? styles.live : styles.idle}`}
          />
          <span>{status?.active ? "Gateway Active" : "Gateway Idle"}</span>
        </div>
      </div>

      <div className={styles.statsGrid}>
        {statCards.map(({ icon, label, value, color }) => (
          <StatCard key={label} icon={icon} label={label} value={value} color={color} />
        ))}
      </div>

      <EntityBreakdown breakdown={stats?.entity_breakdown ?? []} />

      <GatewayInfo
        port={status?.port}
        hasKey={status?.has_key ?? false}
        clipboardMonitoring={status?.clipboard_monitoring ?? false}
        providerCount={status?.provider_count ?? 0}
      />
    </div>
  );
}
