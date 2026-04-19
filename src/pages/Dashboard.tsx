import type { LucideIcon } from "lucide-react";
import { Zap, Eye, Activity, Lock, Coins, TrendingUp, BarChart3, AlertTriangle } from "lucide-react";
import { useGatewayStatus, useAuditStats, useTokenStats } from "../hooks/useTauri";
import { useAnimatedValues } from "../hooks/useAnimatedValues";
import { StatCard } from "../components/StatCard";
import { EntityBreakdown } from "../components/EntityBreakdown";
import { GatewayInfo } from "../components/GatewayInfo";
import { formatTokenCount, formatPercent } from "../hooks/tauri/token_usage";
import styles from "./Dashboard.module.css";

// ── Type aliases ─────────────────────────────────────────────────────────────

type StatValues = {
  requests: number; entities: number; sessions: number; providers: number;
  tokensIn: number; tokensOut: number; costCents: number;
};

type StatCardDef = {
  icon: LucideIcon; label: string; value: number; color: string;
  format?: "number" | "tokens" | "money"; displayValue?: string;
};

type TokenStatsBase = {
  total_cost_unavailable?: boolean;
  success_rate?: number;
};

// ── Dashboard ────────────────────────────────────────────────────────────────

export function Dashboard() {
  const { status, loading } = useGatewayStatus();
  const { stats } = useAuditStats();
  const { stats: tokenStats } = useTokenStats();

  const targets = getStatTargets(stats, status, tokenStats);
  const animatedValues = useAnimatedValues(targets);
  const statCards = createStatCards(animatedValues, tokenStats);

  if (loading) return <LoadingState />;

  return (
    <div className={styles.page}>
      <Header status={status} />
      <StatsGrid statCards={statCards} />
      {tokenStats && <TokenUsagePanel stats={tokenStats} />}
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

function getStatTargets(
  stats: { total_requests?: number; total_entities?: number } | null,
  status: { active_sessions?: number; provider_count?: number } | null,
  tokenStats: { total_tokens_in?: number; total_tokens_out?: number; total_cost_cents?: number } | null
): StatValues {
  return {
    requests: stats?.total_requests ?? 0,
    entities: stats?.total_entities ?? 0,
    sessions: status?.active_sessions ?? 0,
    providers: status?.provider_count ?? 0,
    tokensIn: tokenStats?.total_tokens_in ?? 0,
    tokensOut: tokenStats?.total_tokens_out ?? 0,
    costCents: tokenStats?.total_cost_cents ?? 0,
  };
}

function createStatCards(animatedValues: StatValues, tokenStats: TokenStatsBase | null): StatCardDef[] {
  const baseCards: StatCardDef[] = [
    { icon: Zap, label: "Total Requests", value: animatedValues.requests, color: "accent" },
    { icon: Eye, label: "Entities Caught", value: animatedValues.entities, color: "warning" },
    { icon: Activity, label: "Active Sessions", value: animatedValues.sessions, color: "success" },
    { icon: Lock, label: "Providers", value: animatedValues.providers, color: "danger" },
  ];

  if (animatedValues.tokensIn > 0 || animatedValues.tokensOut > 0) {
    baseCards.push(...createTokenStatCards(animatedValues, tokenStats));
  }

  return baseCards;
}

function createTokenStatCards(animatedValues: StatValues, tokenStats: TokenStatsBase | null): StatCardDef[] {
  const cards: StatCardDef[] = [
    { icon: TrendingUp, label: "Tokens In", value: animatedValues.tokensIn, color: "accent", format: "tokens" },
    { icon: BarChart3, label: "Tokens Out", value: animatedValues.tokensOut, color: "success", format: "tokens" },
  ];

  if (!tokenStats?.total_cost_unavailable) {
    cards.push({ icon: Coins, label: "Est. Cost", value: animatedValues.costCents, color: "warning", format: "money" });
  }

  return cards;
}

function LoadingState() {
  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Dashboard</h1>
        <p className={styles.subtitle}>Loading gateway status…</p>
      </div>
    </div>
  );
}

function Header({ status }: { status: { active?: boolean } | null }) {
  return (
    <div className={styles.header}>
      <div>
        <h1 className={styles.title}>Dashboard</h1>
        <p className={styles.subtitle}>Your privacy gateway overview</p>
      </div>
      <div className={styles.statusBadge}>
        <div className={`${styles.statusDot} ${status?.active ? styles.live : styles.idle}`} />
        <span>{status?.active ? "Gateway Active" : "Gateway Idle"}</span>
      </div>
    </div>
  );
}

function StatsGrid({ statCards }: { statCards: StatCardDef[] }) {
  return (
    <div className={styles.statsGrid}>
      {statCards.map(({ icon, label, value, color, format: _format }) => (
        <StatCard key={label} icon={icon} label={label} value={value} color={color} />
      ))}
    </div>
  );
}

// Token usage detail panel
function TokenUsagePanel({ stats }: { stats: {
  total_tokens_in: number;
  total_tokens_out: number;
  total_tokens_cached: number;
  total_tokens_truncated: number;
  success_rate: number;
  truncation_rate: number;
  avg_duration_ms: number;
  cost_estimate_usd: string;
  suggestion: string;
  total_cost_unavailable: boolean;
} }) {
  const cachedPct = stats.total_tokens_in > 0
    ? (stats.total_tokens_cached / stats.total_tokens_in) * 100
    : 0;

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <BarChart3 size={18} />
        <span className={styles.sectionTitle}>Token Usage</span>
      </div>

      <div className={styles.tokenGrid}>
        <div className={styles.tokenItem}>
          <span className={styles.tokenLabel}>Tokens In</span>
          <span className={styles.tokenValue}>{formatTokenCount(stats.total_tokens_in)}</span>
        </div>
        <div className={styles.tokenItem}>
          <span className={styles.tokenLabel}>Tokens Out</span>
          <span className={styles.tokenValue}>{formatTokenCount(stats.total_tokens_out)}</span>
        </div>
        <div className={styles.tokenItem}>
          <span className={styles.tokenLabel}>Cached Tokens</span>
          <span className={styles.tokenValue}>{formatTokenCount(stats.total_tokens_cached)}</span>
        </div>
        <div className={styles.tokenItem}>
          <span className={styles.tokenLabel}>Cache Hit Rate</span>
          <span className={styles.tokenValue}>{formatPercent(cachedPct)}</span>
        </div>
        <div className={styles.tokenItem}>
          <span className={styles.tokenLabel}>Avg Latency</span>
          <span className={styles.tokenValue}>{stats.avg_duration_ms > 0 ? `${stats.avg_duration_ms.toFixed(0)}ms` : "—"}</span>
        </div>
        {!stats.total_cost_unavailable && (
          <div className={styles.tokenItem}>
            <span className={styles.tokenLabel}>Est. Cost</span>
            <span className={styles.tokenValue}>{stats.cost_estimate_usd}</span>
          </div>
        )}
        {stats.total_cost_unavailable && (
          <div className={styles.tokenItem}>
            <span className={styles.tokenLabel}>Est. Cost</span>
            <span className={styles.tokenValueUnavailable}>unavailable</span>
          </div>
        )}
      </div>

      {stats.truncation_rate > 0 && (
        <div className={styles.suggestionWarning}>
          <AlertTriangle size={14} />
          <span>Truncation rate: {formatPercent(stats.truncation_rate * 100)}</span>
        </div>
      )}

      {stats.suggestion && (
        <div className={styles.suggestion}>
          <TrendingUp size={14} />
          <span>{stats.suggestion}</span>
        </div>
      )}
    </div>
  );
}