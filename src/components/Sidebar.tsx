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

const navItemClass = ({ isActive }: { isActive: boolean }) =>
  `${styles.navItem} ${isActive ? styles.active : ""}`;

function SidebarNav() {
  return (
    <nav className={styles.nav}>
      {navItems.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          className={navItemClass}
        >
          <Icon size={18} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function GatewayStatusPill({ active }: { active: boolean }) {
  return (
    <div className={styles.status}>
      <div className={`${styles.statusDot} ${active ? styles.live : styles.idle}`} />
      <span className={styles.statusText}>
        {active ? "Gateway Active" : "Starting…"}
      </span>
    </div>
  );
}

function ClipboardStatus({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;
  return (
    <div className={styles.clipboardStatus}>
      <span className={styles.clipboardDot} />
      <span className={styles.clipboardText}>Clipboard On</span>
    </div>
  );
}

function SetupBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return <div className={styles.setupBadge}>Setup incomplete</div>;
}

export function Sidebar() {
  const { status } = useGatewayStatus();
  const gatewayActive = !!status?.active;
  const clipboardOn = !!status?.clipboard_monitoring;
  const showSetup = !!status && !status.onboarding_complete;

  return (
    <aside className={styles.sidebar}>
      <div className={styles.logo}>
        <Shield size={24} strokeWidth={2.5} />
        <span className={styles.logoText}>Aelvyril</span>
      </div>
      <SidebarNav />
      <div className={styles.footer}>
        <GatewayStatusPill active={gatewayActive} />
        <ClipboardStatus enabled={clipboardOn} />
        <SetupBadge show={showSetup} />
      </div>
    </aside>
  );
}
