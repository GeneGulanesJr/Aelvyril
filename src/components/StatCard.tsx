import type { LucideIcon } from "lucide-react";
import styles from "../pages/Dashboard.module.css";

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: number;
  color: string;
}

export function StatCard({ icon: Icon, label, value, color }: StatCardProps) {
  return (
    <div className={`${styles.statCard} ${styles[color]}`}>
      <div className={styles.statIcon}>
        <Icon size={20} />
      </div>
      <div className={styles.statInfo}>
        <span className={styles.statValue}>{value.toLocaleString()}</span>
        <span className={styles.statLabel}>{label}</span>
      </div>
    </div>
  );
}
