import { useState } from "react";
import { Shield, Eye, ListFilter, Power, Bot } from "lucide-react";
import { Key } from "lucide-react";
import {
  ProvidersSection,
  GatewayKeySection,
  ListsSection,
  DetectionSection,
  BehaviorSection,
  OrchestratorSection,
} from "../components/settings";
import styles from "./Settings.module.css";

type SettingsTab = "providers" | "gateway" | "lists" | "detection" | "behavior" | "orchestrator";

const tabs: { id: SettingsTab; label: string; icon: typeof Shield }[] = [
  { id: "providers", label: "Providers", icon: Shield },
  { id: "gateway", label: "Gateway Key", icon: Key },
  { id: "lists", label: "Allow / Deny Lists", icon: ListFilter },
  { id: "detection", label: "Detection", icon: Eye },
  { id: "behavior", label: "Startup & Behavior", icon: Power },
  { id: "orchestrator", label: "Orchestrator", icon: Bot },
];

export function Settings() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("providers");

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Settings</h1>
        <p className={styles.subtitle}>
          Configure upstream providers, detection rules, and gateway preferences
        </p>
      </div>

      <div className={styles.tabBar}>
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`${styles.tab} ${activeTab === id ? styles.activeTab : ""}`}
            onClick={() => setActiveTab(id)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {activeTab === "providers" && <ProvidersSection />}
      {activeTab === "gateway" && <GatewayKeySection />}
      {activeTab === "lists" && <ListsSection />}
      {activeTab === "detection" && <DetectionSection />}
      {activeTab === "behavior" && <BehaviorSection />}
      {activeTab === "orchestrator" && <OrchestratorSection />}
    </div>
  );
}
