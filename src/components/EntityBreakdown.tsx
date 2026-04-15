import { TrendingUp } from "lucide-react";
import styles from "../pages/Dashboard.module.css";

interface EntityBreakdownProps {
  breakdown: [string, number][];
}

export function EntityBreakdown({ breakdown }: EntityBreakdownProps) {
  const maxCount = Math.max(...breakdown.map(([, count]) => count), 1);

  if (breakdown.length === 0) return null;

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <TrendingUp size={18} />
        <h2 className={styles.sectionTitle}>Entity Detection Breakdown</h2>
      </div>
      <div className={styles.breakdown}>
        {breakdown.map(([type, count]) => (
          <div key={type} className={styles.breakdownRow}>
            <span className={styles.breakdownLabel}>{type}</span>
            <div className={styles.breakdownBar}>
              <div
                className={styles.breakdownFill}
                style={{ width: `${(count / maxCount) * 100}%` }}
              />
            </div>
            <span className={styles.breakdownCount}>{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
