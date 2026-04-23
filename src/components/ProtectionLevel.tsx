import { ShieldCheck } from "lucide-react";
import styles from "../pages/Dashboard.module.css";

interface ProtectionLevelProps {
  level?: number; // 0-100
}

export function ProtectionLevel({ level = 92 }: ProtectionLevelProps) {
  const segments = 5;
  const filled = Math.round((level / 100) * segments);

  return (
    <div className={styles.protectionCard}>
      <div className={styles.protectionHeader}>
        <ShieldCheck size={18} strokeWidth={1.5} />
        <span className={styles.protectionTitle}>Protection Level</span>
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
