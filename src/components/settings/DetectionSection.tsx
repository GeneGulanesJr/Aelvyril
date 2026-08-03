import { useState } from "react";
import { Eye, Monitor, Cpu, ShieldAlert } from "lucide-react";
import { useSettings, useClipboard } from "../../hooks/useTauri";
import { ToggleRow } from "./components";
import styles from "../../pages/Settings.module.css";

export function DetectionSection() {
  const { settings, update } = useSettings();
  const clipboard = useClipboard();
  const [recognizers, setRecognizers] = useState<string[] | null>(null);

  if (!settings) return null;

  const currentRecognizers = recognizers ?? settings.enabled_recognizers ?? [];

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
    await update({ ...settings, enabled_recognizers: updated });
  };

  const handleToggleClipboard = async () => {
    const enabled = !settings.clipboard_monitoring;
    await clipboard.toggle(enabled);
    await update({ ...settings, clipboard_monitoring: enabled });
  };

  const handleToggleLiquidPii = async () => {
    await update({
      ...settings,
      liquid_pii_enabled: !settings.liquid_pii_enabled,
    });
  };

  const handleToggleLiquidPolicy = async () => {
    await update({
      ...settings,
      liquid_policy_enabled: !settings.liquid_policy_enabled,
    });
  };

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>Detection Configuration</h2>

      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>
          <Eye size={16} />
          PII Recognizers
        </h3>
        <p className={styles.subDesc}>
          Enable or disable individual PII recognizers. Disabled recognizers won't scan incoming
          content.
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
          When enabled, Aelvyril will monitor your clipboard for sensitive content and notify you
          when PII is detected.
        </p>
        <ToggleRow
          label="Monitor clipboard for PII"
          enabled={settings.clipboard_monitoring}
          onToggle={handleToggleClipboard}
        />
      </div>

      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>
          <Cpu size={16} />
          Liquid LFM2.5 Encoder Backends
        </h3>
        <p className={styles.subDesc}>
          Enable the locally-hosted Liquid LFM2.5-Encoder models (auto-downloaded from
          Hugging Face). The PII encoder runs as a token-classification layer ahead of
          Presidio; the policy linter gates outbound user messages against your rules.
        </p>
        <ToggleRow
          label="Liquid PII encoder (LFM2.5-Encoder-350M-PII-Detector)"
          enabled={!!settings.liquid_pii_enabled}
          onToggle={handleToggleLiquidPii}
        />
        <ToggleRow
          label="Liquid policy linter (LFM2.5-Encoder-350M-Policy-Linter)"
          enabled={!!settings.liquid_policy_enabled}
          onToggle={handleToggleLiquidPolicy}
        />
        {settings.liquid_policy_enabled && (
          <p className={styles.hint}>
            <ShieldAlert size={12} /> Author policy rules in the{" "}
            <strong>Policy</strong> tab.
          </p>
        )}
      </div>

      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>
          <Eye size={16} />
          Detection Sensitivity
        </h3>
        <p className={styles.subDesc}>
          Lower threshold = catch more (more false positives). Higher threshold = only high-confidence
          detections.
        </p>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            marginTop: "8px",
          }}
        >
          <span
            style={{
              fontSize: "13px",
              color: "var(--text-secondary, #888)",
              minWidth: "30px",
            }}
          >
            {Math.round(settings.confidence_threshold * 100)}%
          </span>
          <input
            type="range"
            min="0.1"
            max="0.9"
            step="0.05"
            value={settings.confidence_threshold}
            onChange={(e) => {
              update({
                ...settings,
                confidence_threshold: parseFloat(e.target.value),
              });
            }}
            style={{
              flex: 1,
              accentColor: "var(--accent, #4f46e5)",
            }}
          />
        </div>
      </div>
    </div>
  );
}
