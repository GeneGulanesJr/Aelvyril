import { Shield } from "lucide-react";
import styles from "../pages/Dashboard.module.css";

interface GatewayInfoProps {
  port?: number;
  hasKey: boolean;
  clipboardMonitoring: boolean;
  providerCount: number;
}

export function GatewayInfo({
  port = 4242,
  hasKey,
  clipboardMonitoring,
  providerCount,
}: GatewayInfoProps) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <Shield size={18} />
        <h2 className={styles.sectionTitle}>Gateway Info</h2>
      </div>
      <div className={styles.infoGrid}>
        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>Port</span>
          <span className={styles.infoValue}>{port}</span>
        </div>
        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>API Key</span>
          <span className={styles.infoValue}>
            {hasKey ? "✓ Configured" : "⚠ Not Set"}
          </span>
        </div>
        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>Clipboard</span>
          <span className={styles.infoValue}>
            {clipboardMonitoring ? "🟢 Monitoring" : "⚪ Off"}
          </span>
        </div>
        <div className={styles.infoItem}>
          <span className={styles.infoLabel}>Providers</span>
          <span className={styles.infoValue}>
            {providerCount} configured
          </span>
        </div>
      </div>
    </div>
  );
}
