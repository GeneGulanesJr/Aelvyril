import { Shield, Zap, Eye, Lock } from "lucide-react";
import styles from "./Dashboard.module.css";

const stats = [
  { icon: Zap, label: "Requests Today", value: "0", color: "accent" },
  { icon: Eye, label: "Entities Caught", value: "0", color: "warning" },
  { icon: Shield, label: "Active Sessions", value: "0", color: "success" },
  { icon: Lock, label: "Providers", value: "0", color: "danger" },
];

export function Dashboard() {
  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Dashboard</h1>
        <p className={styles.subtitle}>Your privacy gateway overview</p>
      </div>

      <div className={styles.statsGrid}>
        {stats.map(({ icon: Icon, label, value, color }) => (
          <div key={label} className={`${styles.statCard} ${styles[color]}`}>
            <div className={styles.statIcon}>
              <Icon size={20} />
            </div>
            <div className={styles.statInfo}>
              <span className={styles.statValue}>{value}</span>
              <span className={styles.statLabel}>{label}</span>
            </div>
          </div>
        ))}
      </div>

      <div className={styles.placeholder}>
        <Shield size={48} strokeWidth={1} />
        <h2>Aelvyril Gateway</h2>
        <p>Your local privacy gateway is running. Configure your upstream providers in Settings to start routing requests.</p>
      </div>
    </div>
  );
}
