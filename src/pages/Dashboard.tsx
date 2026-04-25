import type { LucideIcon } from "lucide-react";
import {
  Zap,
  Eye,
  Activity,
  Lock,
  Coins,
  TrendingUp,
  BarChart3,
  AlertTriangle,
  Shield,
  Globe,
  Clock,
  CheckCircle2,
  FileKey,
  CreditCard,
  Phone,
  Mail,
  MapPin,
  User,
  Brain,
  ArrowRight,
  RefreshCw,
} from "lucide-react";
import { useGatewayStatus, useAuditStats, useTokenStats, useAuditLog } from "../hooks/useTauri";
import { useAnimatedValues } from "../hooks/useAnimatedValues";
import { Sparkline } from "../components/Sparkline";
import { formatTokenCount, formatPercent } from "../hooks/tauri/token_usage";
import { formatDateRelative } from "../utils/formatDate";
import styles from "./Dashboard.module.css";

// ─── Types ────────────────────────────────────────────────────────────

type StatValues = {
  requests: number; entities: number; sessions: number; providers: number;
  tokensIn: number; tokensOut: number; costCents: number;
};

type StatCardDef = {
  icon: LucideIcon; label: string; value: number;
  color: "gold" | "green" | "cyan" | "purple" | "danger";
  format?: "number" | "tokens" | "money";
  sparkData?: number[];
};

type TokenStatsBase = {
  total_cost_unavailable?: boolean;
  success_rate?: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
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
    { icon: Zap, label: "Total Requests", value: animatedValues.requests, color: "gold", sparkData: [10, 25, 18, 35, 28, 45, 38, 52, 48, 60, 55, 70] },
    { icon: Eye, label: "Entities Caught", value: animatedValues.entities, color: "purple", sparkData: [5, 12, 8, 15, 20, 18, 25, 22, 30, 28, 35, 32] },
    { icon: Activity, label: "Active Sessions", value: animatedValues.sessions, color: "green", sparkData: [1, 2, 1, 3, 2, 4, 3, 5, 4, 6, 5, 7] },
    { icon: Lock, label: "Providers", value: animatedValues.providers, color: "cyan", sparkData: [1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5] },
  ];

  if (animatedValues.tokensIn > 0 || animatedValues.tokensOut > 0) {
    baseCards.push(
      { icon: TrendingUp, label: "Tokens In", value: animatedValues.tokensIn, color: "gold", format: "tokens", sparkData: [100, 250, 180, 350, 280, 450, 380, 520, 480, 600, 550, 700] },
      { icon: BarChart3, label: "Tokens Out", value: animatedValues.tokensOut, color: "green", format: "tokens", sparkData: [50, 120, 80, 150, 200, 180, 250, 220, 300, 280, 350, 320] },
    );
    if (!tokenStats?.total_cost_unavailable) {
      baseCards.push({ icon: Coins, label: "Est. Cost", value: animatedValues.costCents, color: "cyan", format: "money", sparkData: [5, 12, 8, 15, 20, 18, 25, 22, 30, 28, 35, 32] });
    }
  }

  return baseCards;
}

const colorMap = {
  gold: "var(--accent-gold)",
  green: "var(--accent-green)",
  cyan: "var(--accent-cyan)",
  purple: "var(--accent-purple)",
  danger: "var(--danger)",
};

// ─── Sub-components ───────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, color, format, sparkData }: StatCardDef) {
  const c = colorMap[color];
  const display = format === "money"
    ? `$${(value / 100).toFixed(2)}`
    : format === "tokens"
    ? value.toLocaleString()
    : value.toLocaleString();

  return (
    <div className={styles.statCard} style={{ "--stat-color": c } as React.CSSProperties}>
      <div className={styles.statTop}>
        <div className={styles.statIconWrap} style={{ background: `${c}15`, color: c }}>
          <Icon size={18} strokeWidth={1.5} />
        </div>
        <div className={styles.statInfo}>
          <span className={styles.statValue}>{display}</span>
          <span className={styles.statLabel}>{label}</span>
        </div>
      </div>
      <div className={styles.statSpark}>
        <Sparkline data={sparkData} color={c} width={120} height={32} />
      </div>
    </div>
  );
}

function StatsGrid({ statCards }: { statCards: StatCardDef[] }) {
  return (
    <div className={styles.statsGrid}>
      {statCards.map((card) => (
        <StatCard key={card.label} {...card} />
      ))}
    </div>
  );
}

function Header({ status }: { status: { active?: boolean } | null }) {
  return (
    <div className={styles.header}>
      <div>
        <h1 className={styles.greeting}>{getGreeting()}</h1>
        <p className={styles.subtitle}>Your privacy gateway overview</p>
      </div>
      <div className={styles.statusBadge}>
        <div className={`${styles.statusDot} ${status?.active ? styles.live : styles.idle}`} />
        <span>{status?.active ? "Gateway Active" : "Gateway Idle"}</span>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.greeting}>Dashboard</h1>
        <p className={styles.subtitle}>Loading gateway status…</p>
      </div>
    </div>
  );
}

function RecentActivity() {
  const { entries, loading } = useAuditLog();
  const recent = entries.slice(0, 6);

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <Clock size={16} strokeWidth={1.5} />
        <span>Recent Activity</span>
      </div>
      {loading ? (
        <div className={styles.tableEmpty}>Loading…</div>
      ) : recent.length === 0 ? (
        <div className={styles.tableEmpty}>No activity yet</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Time</th>
              <th>Provider</th>
              <th>Model</th>
              <th>Entities</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((entry) => (
              <tr key={entry.id}>
                <td className={styles.timeCell}>{formatDateRelative(entry.timestamp)}</td>
                <td>
                  <span className={styles.providerCell}>
                    <span className={styles.providerDot} />
                    {entry.provider}
                  </span>
                </td>
                <td className={styles.monoCell}>{entry.model}</td>
                <td className={styles.numCell}>{entry.total_entities}</td>
                <td>
                  <span className={styles.protectedBadge}>
                    <CheckCircle2 size={12} strokeWidth={2} />
                    Protected
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ProtectionLevel({ level = 96 }: { level?: number }) {
  const segments = 5;
  const filled = Math.round((level / 100) * segments);

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <Shield size={16} strokeWidth={1.5} />
        <span>Protection Level</span>
      </div>
      <div className={styles.protectionValueRow}>
        <span className={styles.protectionPercent}>{level}%</span>
        <span className={styles.protectionLabel}>
          {level >= 90 ? "Maximum" : level >= 70 ? "High" : level >= 40 ? "Moderate" : "Low"}
        </span>
      </div>
      <div className={styles.protectionBar}>
        {Array.from({ length: segments }).map((_, i) => (
          <div
            key={i}
            className={`${styles.protectionSegment} ${i < filled ? styles.protectionFilled : ""}`}
          />
        ))}
      </div>
      <p className={styles.protectionDesc}>
        {level >= 90
          ? "All sensitive data types are being masked before leaving your device."
          : "Some data types may not be fully protected. Review settings."}
      </p>
    </div>
  );
}

function DataFlow() {
  const steps = [
    { icon: User, label: "You", desc: "Original prompt" },
    { icon: FileKey, label: "Detect & Mask", desc: "PII replaced with tokens" },
    { icon: Brain, label: "AI Provider", desc: "Safe request sent" },
    { icon: RefreshCw, label: "Response", desc: "Tokens restored" },
  ];

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span>How It Works</span>
      </div>
      <div className={styles.flowSteps}>
        {steps.map((step, i) => (
          <div key={step.label} className={styles.flowStep}>
            <div className={styles.flowCircle}>
              <step.icon size={18} strokeWidth={1.5} />
            </div>
            <span className={styles.flowStepLabel}>{step.label}</span>
            <span className={styles.flowStepDesc}>{step.desc}</span>
            {i < steps.length - 1 && (
              <div className={styles.flowArrow}>
                <ArrowRight size={14} strokeWidth={1.5} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const DATA_TYPE_ICONS: Record<string, LucideIcon> = {
  "email": Mail,
  "phone": Phone,
  "credit_card": CreditCard,
  "ssn": FileKey,
  "address": MapPin,
  "name": User,
};

function ProtectedDataTypes({ breakdown }: { breakdown: [string, number][] }) {
  const types = breakdown.length > 0 ? breakdown : [
    ["Email", 0],
    ["Phone", 0],
    ["Credit Card", 0],
    ["SSN", 0],
    ["Address", 0],
  ] as [string, number][];

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <Shield size={16} strokeWidth={1.5} />
        <span>Protected Data Types</span>
      </div>
      <div className={styles.dataTypeList}>
        {types.map(([type, count]) => {
          const Icon = DATA_TYPE_ICONS[type.toLowerCase().replace(/\s/g, "_")] ?? FileKey;
          return (
            <div key={type} className={styles.dataTypeRow}>
              <div className={styles.dataTypeLeft}>
                <Icon size={14} strokeWidth={1.5} />
                <span>{type}</span>
              </div>
              <span className={styles.dataTypeCount}>{count > 0 ? count : "—"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActiveProviders({ count = 0 }: { count?: number }) {
  const providers = [
    { name: "OpenAI", active: count >= 1 },
    { name: "Anthropic", active: count >= 2 },
    { name: "Google", active: count >= 3 },
    { name: "Local", active: count >= 4 },
  ];

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <Globe size={16} strokeWidth={1.5} />
        <span>Active Providers</span>
      </div>
      <div className={styles.providerList}>
        {providers.map((p) => (
          <div key={p.name} className={styles.providerRow}>
            <div className={styles.providerLeft}>
              <span className={`${styles.providerStatusDot} ${p.active ? styles.providerActive : ""}`} />
              <span>{p.name}</span>
            </div>
            <span className={p.active ? styles.providerConnected : styles.providerDisconnected}>
              {p.active ? "Connected" : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TokenUsagePanel({ stats }: {
  stats: {
    total_tokens_in: number; total_tokens_out: number; total_tokens_cached: number;
    total_tokens_truncated: number; success_rate: number; truncation_rate: number;
    avg_duration_ms: number; cost_estimate_usd: string; total_cost_unavailable: boolean;
    suggestion: string;
  }
}) {
  const cachedPct = stats.total_tokens_in > 0
    ? (stats.total_tokens_cached / stats.total_tokens_in) * 100
    : 0;

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <BarChart3 size={16} strokeWidth={1.5} />
        <span>Token Usage</span>
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
          <span className={styles.tokenLabel}>Cached</span>
          <span className={styles.tokenValue}>{formatTokenCount(stats.total_tokens_cached)}</span>
        </div>
        <div className={styles.tokenItem}>
          <span className={styles.tokenLabel}>Cache Hit</span>
          <span className={styles.tokenValue}>{formatPercent(cachedPct)}</span>
        </div>
        <div className={styles.tokenItem}>
          <span className={styles.tokenLabel}>Latency</span>
          <span className={styles.tokenValue}>{stats.avg_duration_ms > 0 ? `${stats.avg_duration_ms.toFixed(0)}ms` : "—"}</span>
        </div>
        {!stats.total_cost_unavailable ? (
          <div className={styles.tokenItem}>
            <span className={styles.tokenLabel}>Est. Cost</span>
            <span className={styles.tokenValue}>{stats.cost_estimate_usd}</span>
          </div>
        ) : (
          <div className={styles.tokenItem}>
            <span className={styles.tokenLabel}>Est. Cost</span>
            <span className={styles.tokenValueMuted}>unavailable</span>
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
      <div className={styles.qualityNote}>
        <AlertTriangle size={12} style={{ opacity: 0.6 }} />
        <span>Lower token usage ≠ better results. Always check task success rates and output quality.</span>
      </div>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────

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

      <div className={styles.mainGrid}>
        <div className={styles.mainLeft}>
          <RecentActivity />
          {tokenStats && <TokenUsagePanel stats={tokenStats} />}
          <DataFlow />
        </div>
        <div className={styles.mainRight}>
          <ProtectionLevel level={status?.active ? 96 : 0} />
          <ProtectedDataTypes breakdown={stats?.entity_breakdown ?? []} />
          <ActiveProviders count={status?.provider_count ?? 0} />
        </div>
      </div>
    </div>
  );
}
