import { useState } from "react";
import {
  Plus,
  Trash2,
  Copy,
  Check,
  Shield,
  Eye,
  ListFilter,
  AlertTriangle,
  Monitor,
  Bell,
  Power,
  X,
} from "lucide-react";
import {
  useProviders,
  useGatewayKey,
  useSettings,
  useAllowList,
  useDenyList,
  useClipboard,
} from "../hooks/useTauri";
import styles from "./Settings.module.css";

type SettingsTab = "providers" | "gateway" | "lists" | "detection" | "behavior";

export function Settings() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("providers");

  const tabs: { id: SettingsTab; label: string; icon: typeof Shield }[] = [
    { id: "providers", label: "Providers", icon: Shield },
    { id: "gateway", label: "Gateway Key", icon: Key },
    { id: "lists", label: "Allow / Deny Lists", icon: ListFilter },
    { id: "detection", label: "Detection", icon: Eye },
    { id: "behavior", label: "Startup & Behavior", icon: Power },
  ];

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
    </div>
  );
}

function Key(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}

// ── Providers ─────────────────────────────────────────────────────────────────

function ProvidersSection() {
  const { providers, add, remove } = useProviders();
  const [showAdd, setShowAdd] = useState(false);
  const [newProvider, setNewProvider] = useState({
    name: "",
    baseUrl: "",
    models: "",
    apiKey: "",
  });
  const [error, setError] = useState("");

  const handleAdd = async () => {
    if (!newProvider.name || !newProvider.baseUrl || !newProvider.apiKey) {
      setError("All fields except Models are required");
      return;
    }
    try {
      const models = newProvider.models
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      await add(newProvider.name, newProvider.baseUrl, models, newProvider.apiKey);
      setNewProvider({ name: "", baseUrl: "", models: "", apiKey: "" });
      setShowAdd(false);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Upstream Providers</h2>
        <button className={styles.addButton} onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Cancel" : <><Plus size={14} /> Add Provider</>}
        </button>
      </div>

      {showAdd && (
        <div className={styles.addForm}>
          <div className={styles.formRow}>
            <div className={styles.formGroup}>
              <label className={styles.label}>Provider Name</label>
              <input
                className={styles.input}
                placeholder="OpenAI"
                value={newProvider.name}
                onChange={(e) => setNewProvider({ ...newProvider, name: e.target.value })}
              />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>Base URL</label>
              <input
                className={styles.input}
                placeholder="https://api.openai.com/v1"
                value={newProvider.baseUrl}
                onChange={(e) => setNewProvider({ ...newProvider, baseUrl: e.target.value })}
              />
            </div>
          </div>
          <div className={styles.formRow}>
            <div className={styles.formGroup}>
              <label className={styles.label}>Models (comma-separated)</label>
              <input
                className={styles.input}
                placeholder="gpt-4o, gpt-4o-mini"
                value={newProvider.models}
                onChange={(e) => setNewProvider({ ...newProvider, models: e.target.value })}
              />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>API Key</label>
              <input
                className={styles.input}
                type="password"
                placeholder="sk-..."
                value={newProvider.apiKey}
                onChange={(e) => setNewProvider({ ...newProvider, apiKey: e.target.value })}
              />
            </div>
          </div>
          {error && <p className={styles.error}>{error}</p>}
          <button className={styles.saveButton} onClick={handleAdd}>
            Save Provider
          </button>
        </div>
      )}

      {providers.length === 0 && !showAdd && (
        <div className={styles.empty}>
          No upstream providers configured. Add one to start routing requests.
        </div>
      )}

      {providers.map((provider) => (
        <div key={provider.id} className={styles.providerCard}>
          <div className={styles.providerInfo}>
            <div className={styles.providerName}>{provider.name}</div>
            <div className={styles.providerMeta}>
              <span className={styles.providerUrl}>{provider.base_url}</span>
              {provider.models.map((m) => (
                <span key={m} className={styles.modelTag}>{m}</span>
              ))}
            </div>
          </div>
          <button className={styles.removeButton} onClick={() => remove(provider.name)}>
            <Trash2 size={14} />
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Gateway Key ───────────────────────────────────────────────────────────────

function GatewayKeySection() {
  const { key, generate } = useGatewayKey();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (key) {
      navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>Gateway API Key</h2>
      <p className={styles.sectionDesc}>
        Use this key in your AI tools instead of your upstream provider key.
        Aelvyril will authenticate requests and route them to the correct provider.
      </p>

      {key ? (
        <div className={styles.keyDisplay}>
          <code className={styles.keyValue}>{key}</code>
          <button className={styles.copyBtn} onClick={handleCopy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      ) : (
        <div className={styles.noKey}>
          <p>No gateway key generated yet.</p>
          <button className={styles.saveButton} onClick={generate}>
            Generate Key
          </button>
        </div>
      )}

      <div className={styles.keyWarning}>
        <AlertTriangle size={14} />
        <span>Store this key securely. You'll need it to configure your AI tools.</span>
      </div>
    </div>
  );
}

// ── Allow / Deny Lists ────────────────────────────────────────────────────────

function ListsSection() {
  const allow = useAllowList();
  const deny = useDenyList();
  const [newAllow, setNewAllow] = useState({ pattern: "", label: "" });
  const [newDeny, setNewDeny] = useState({ pattern: "", label: "" });
  const [error, setError] = useState("");

  const handleAddAllow = async () => {
    try {
      await allow.add(newAllow.pattern, newAllow.label || newAllow.pattern);
      setNewAllow({ pattern: "", label: "" });
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  const handleAddDeny = async () => {
    try {
      await deny.add(newDeny.pattern, newDeny.label || newDeny.pattern);
      setNewDeny({ pattern: "", label: "" });
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className={styles.section}>
      {error && <p className={styles.error}>{error}</p>}

      {/* Allowlist */}
      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>
          <Shield size={16} />
          Allowlist
          <span className={styles.subCount}>{allow.rules.length}</span>
        </h3>
        <p className={styles.subDesc}>
          Patterns to never flag — internal codenames, company domains, false positive tokens.
        </p>

        <div className={styles.addRuleRow}>
          <input
            className={styles.input}
            placeholder="Regex pattern (e.g. example\\.com)"
            value={newAllow.pattern}
            onChange={(e) => setNewAllow({ ...newAllow, pattern: e.target.value })}
          />
          <input
            className={styles.input}
            placeholder="Label"
            value={newAllow.label}
            onChange={(e) => setNewAllow({ ...newAllow, label: e.target.value })}
          />
          <button className={styles.smallBtn} onClick={handleAddAllow}>Add</button>
        </div>

        {allow.rules.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            onToggle={(enabled) => allow.toggle(rule.id, enabled)}
            onRemove={() => allow.remove(rule.id)}
          />
        ))}
      </div>

      {/* Denylist */}
      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>
          <AlertTriangle size={16} />
          Denylist
          <span className={styles.subCount}>{deny.rules.length}</span>
        </h3>
        <p className={styles.subDesc}>
          Custom patterns always flagged — project-specific rules on top of built-in detection.
        </p>

        <div className={styles.addRuleRow}>
          <input
            className={styles.input}
            placeholder="Regex pattern (e.g. PROJECT_\\w+)"
            value={newDeny.pattern}
            onChange={(e) => setNewDeny({ ...newDeny, pattern: e.target.value })}
          />
          <input
            className={styles.input}
            placeholder="Label"
            value={newDeny.label}
            onChange={(e) => setNewDeny({ ...newDeny, label: e.target.value })}
          />
          <button className={styles.smallBtn} onClick={handleAddDeny}>Add</button>
        </div>

        {deny.rules.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            onToggle={(enabled) => deny.toggle(rule.id, enabled)}
            onRemove={() => deny.remove(rule.id)}
          />
        ))}
      </div>
    </div>
  );
}

interface RuleRowProps {
  rule: {
    id: string;
    pattern: string;
    label: string;
    enabled: boolean;
  };
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}

function RuleRow({ rule, onToggle, onRemove }: RuleRowProps) {
  return (
    <div className={`${styles.ruleRow} ${!rule.enabled ? styles.disabled : ""}`}>
      <label className={styles.toggleLabel}>
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className={styles.checkbox}
        />
      </label>
      <div className={styles.ruleInfo}>
        <span className={styles.rulePattern}>{rule.pattern}</span>
        <span className={styles.ruleLabel}>{rule.label}</span>
      </div>
      <button className={styles.removeSmallBtn} onClick={onRemove}>
        <X size={12} />
      </button>
    </div>
  );
}

// ── Detection Config ──────────────────────────────────────────────────────────

function DetectionSection() {
  const { settings, update } = useSettings();
  const clipboard = useClipboard();
  const [recognizers, setRecognizers] = useState<string[] | null>(null);

  const currentRecognizers = recognizers ?? settings?.enabled_recognizers ?? [];

  const allRecognizers = [
    "email",
    "phone",
    "ip_address",
    "api_key",
    "credit_card",
    "ssn",
    "domain",
    "iban",
  ];

  const toggleRecognizer = async (name: string) => {
    const updated = currentRecognizers.includes(name)
      ? currentRecognizers.filter((r) => r !== name)
      : [...currentRecognizers, name];

    setRecognizers(updated);

    if (settings) {
      await update({ ...settings, enabled_recognizers: updated });
    }
  };

  const handleToggleClipboard = async () => {
    if (settings) {
      const enabled = !settings.clipboard_monitoring;
      await clipboard.toggle(enabled);
      await update({ ...settings, clipboard_monitoring: enabled });
    }
  };

  if (!settings) return null;

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>Detection Configuration</h2>

      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>
          <Eye size={16} />
          PII Recognizers
        </h3>
        <p className={styles.subDesc}>
          Enable or disable individual PII recognizers. Disabled recognizers won't scan incoming content.
        </p>
        <div className={styles.recognizerGrid}>
          {allRecognizers.map((name) => (
            <button
              key={name}
              className={`${styles.recognizerBtn} ${currentRecognizers.includes(name) ? styles.active : ""}`}
              onClick={() => toggleRecognizer(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>
          <Monitor size={16} />
          Clipboard Monitoring
        </h3>
        <p className={styles.subDesc}>
          When enabled, Aelvyril will monitor your clipboard for sensitive content
          and notify you when PII is detected.
        </p>
        <div className={styles.toggleRow}>
          <span>Monitor clipboard for PII</span>
          <button
            className={`${styles.toggleSwitch} ${settings.clipboard_monitoring ? styles.on : ""}`}
            onClick={handleToggleClipboard}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Startup & Behavior ────────────────────────────────────────────────────────

function BehaviorSection() {
  const { settings, update } = useSettings();

  if (!settings) return null;

  type BooleanKey = Extract<keyof AppSettings, 'launch_at_login' | 'minimize_to_tray' | 'show_notifications'>;

  const toggle = async (key: BooleanKey) => {
    await update({ ...settings, [key]: !settings[key] });
  };

  const setTimeout = async (minutes: number) => {
    await update({ ...settings, session_timeout_minutes: minutes });
  };

  const toggles: { key: BooleanKey; label: string; desc: string }[] = [
    {
      key: "launch_at_login",
      label: "Launch at Login",
      desc: "Start Aelvyril automatically when you log in to your computer.",
    },
    {
      key: "minimize_to_tray",
      label: "Minimize to Tray",
      desc: "Keep Aelvyril running in the system tray when you close the window.",
    },
    {
      key: "show_notifications",
      label: "Show Notifications",
      desc: "Display OS notifications when sensitive content is detected.",
    },
  ];

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>Startup & Behavior</h2>

      {toggles.map(({ key, label, desc }) => (
        <div key={key} className={styles.toggleRow}>
          <div>
            <span className={styles.toggleLabel}>{label}</span>
            <p className={styles.toggleDesc}>{desc}</p>
          </div>
          <button
            className={`${styles.toggleSwitch} ${settings[key] ? styles.on : ""}`}
            onClick={() => toggle(key)}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      ))}

      <div className={styles.timeoutRow}>
        <div>
          <span className={styles.toggleLabel}>Session Timeout</span>
          <p className={styles.toggleDesc}>
            Automatically clear sessions after a period of inactivity.
          </p>
        </div>
        <div className={styles.timeoutOptions}>
          {[15, 30, 60, 120].map((mins) => (
            <button
              key={mins}
              className={`${styles.timeoutBtn} ${settings.session_timeout_minutes === mins ? styles.active : ""}`}
              onClick={() => setTimeout(mins)}
            >
              {mins}m
            </button>
          ))}
        </div>
      </div>

      <div className={styles.toggleRow}>
        <div>
          <span className={styles.toggleLabel}>
            <Bell size={14} /> Notification on PII Detection
          </span>
          <p className={styles.toggleDesc}>
            Show an OS notification with Sanitize/Allow/Block action buttons
            when sensitive content is detected.
          </p>
        </div>
        <button
          className={`${styles.toggleSwitch} ${settings.show_notifications ? styles.on : ""}`}
          onClick={() => toggle("show_notifications")}
        >
          <div className={styles.toggleKnob} />
        </button>
      </div>
    </div>
  );
}
