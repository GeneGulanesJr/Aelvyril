import { useState } from "react";
import { Plus, Copy, Check, AlertTriangle } from "lucide-react";
import { useGatewayKey } from "../../hooks/useTauri";
import styles from "../../pages/Settings.module.css";

export function GatewayKeySection() {
  const { key, generate } = useGatewayKey();
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    await generate();
  };

  const handleCopy = () => {
    if (key) {
      navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Gateway API Keys</h2>
        <button className={styles.addButton} onClick={handleGenerate}>
          <Plus size={14} /> Generate Key
        </button>
      </div>
      <p className={styles.sectionDesc}>
        Use these keys in your AI tools instead of your upstream provider key. Aelvyril will
        authenticate requests and route them to the correct provider.
      </p>

      {!key && (
        <div className={styles.empty}>
          No API keys generated yet. Generate one to secure your gateway.
        </div>
      )}

      {key && (
        <div className={styles.keyDisplay}>
          <code className={styles.keyValue}>{key}</code>
          <button
            className={styles.copyBtn}
            onClick={handleCopy}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      )}

      <div className={styles.keyWarning}>
        <AlertTriangle size={14} />
        <span>Store these keys securely. You'll need them to configure your AI tools.</span>
      </div>
    </div>
  );
}
