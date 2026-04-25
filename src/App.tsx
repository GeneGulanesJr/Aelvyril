import { Routes, Route, Navigate } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { Dashboard } from "./pages/Dashboard";
import { Sessions } from "./pages/Sessions";
import { Settings } from "./pages/Settings";
import { Security } from "./pages/Security";
import { AuditLog } from "./pages/AuditLog";
import { Onboarding } from "./pages/Onboarding";
import { ComingSoon } from "./pages/ComingSoon";
import { Orchestrator } from "./pages/Orchestrator";
import { useGatewayStatus } from "./hooks/useTauri";
import styles from "./App.module.css";

export default function App() {
  const { status } = useGatewayStatus();

  return (
    <div className={styles.app}>
      <Sidebar />
      <main className={styles.main}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/audit" element={<AuditLog />} />
          <Route path="/security" element={<Security />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/orchestrator" element={<Orchestrator />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {/* Show onboarding overlay if not complete */}
      {status && !status.onboarding_complete && <Onboarding />}
    </div>
  );
}
