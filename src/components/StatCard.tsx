import type { LucideIcon } from "lucide-react";
import { Sparkline } from "./Sparkline";
import styles from "../pages/Dashboard.module.css";

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: number;
  color: "gold" | "green" | "cyan" | "purple" | "danger";
  format?: "number" | "tokens" | "money";
}

const colorMap = {
  gold: "var(--accent-gold)",
  green: "var(--accent-green)",
  cyan: "var(--accent-cyan)",
  purple: "var(--accent-purple)",
  danger: "var(--danger)",
};

export function StatCard({ icon: Icon, label, value, color, format }: StatCardProps) {
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
        <Sparkline color={c} />
      </div>
      <div className={styles.statInfo}>
        <span className={styles.statValue}>{display}</span>
        <span className={styles.statLabel}>{label}</span>
      </div>
    </div>
  );
}
