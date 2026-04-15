import { NavLink } from "react-router-dom";
import {
  Activity,
  Clock,
  FileText,
  Settings,
  Shield,
  Gauge,
} from "lucide-react";
import { useGatewayStatus } from "../hooks/useTauri";
import styles from "./Sidebar.module.css";

const navItems = [
  { to: "/", icon: Activity, label: "Dashboard" },
  { to: "/sessions", icon: Clock, label: "Sessions" },
  { to: "/audit", icon: FileText, label: "Audit Log" },
  { to: "/security", icon: Gauge, label: "Security" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export function Sidebar() {
  const { status } = useGatewayStatus();

  return (
    <aside className={styles.sidebar}>
      <div className={styles.logo}>
        <Shield size={24} strokeWidth={2.5} />
        <span className={styles.logoText}>Aelvyril</span>
      </div>
      <nav className={styles.nav}>
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.active : ""}`
            }
          >
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className={styles.footer}>
        <div className={styles.status}>
          <div
            className={`${styles.statusDot} ${status?.active ? styles.live : styles.idle}`}
          />
          <span className={styles.statusText}>
            {status?.active ? "Gateway Active" : "Starting…"}
          </span>
        </div>
        {status?.clipboard_monitoring && (
          <div className={styles.clipboardStatus}>
            <span className={styles.clipboardDot} />
            <span className={styles.clipboardText}>Clipboard On</span>
          </div>
        )}
        {status && !status.onboarding_complete && (
          <div className={styles.setupBadge}>
            Setup incomplete
          </div>
        )}
      </div>
    </aside>
  );
}
