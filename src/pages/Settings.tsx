import { useState } from "react";
import styles from "./Settings.module.css";

interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  hasKey: boolean;
}

export function Settings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newProvider, setNewProvider] = useState({
    name: "",
    baseUrl: "",
    models: "",
    apiKey: "",
  });

  const handleAddProvider = () => {
    if (!newProvider.name || !newProvider.baseUrl) return;
    const provider: Provider = {
      id: crypto.randomUUID(),
      name: newProvider.name,
      baseUrl: newProvider.baseUrl.replace(/\/$/, ""),
      models: newProvider.models.split(",").map((m) => m.trim()).filter(Boolean),
      hasKey: !!newProvider.apiKey,
    };
    setProviders((prev) => [...prev, provider]);
    setNewProvider({ name: "", baseUrl: "", models: "", apiKey: "" });
    setShowAdd(false);
  };

  const handleRemoveProvider = (id: string) => {
    setProviders((prev) => prev.filter((p) => p.id !== id));
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Settings</h1>
        <p className={styles.subtitle}>Configure upstream providers and gateway preferences</p>
      </div>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Upstream Providers</h2>
          <button
            className={styles.addButton}
            onClick={() => setShowAdd(!showAdd)}
          >
            {showAdd ? "Cancel" : "+ Add Provider"}
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
                  onChange={(e) =>
                    setNewProvider({ ...newProvider, name: e.target.value })
                  }
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.label}>Base URL</label>
                <input
                  className={styles.input}
                  placeholder="https://api.openai.com/v1"
                  value={newProvider.baseUrl}
                  onChange={(e) =>
                    setNewProvider({ ...newProvider, baseUrl: e.target.value })
                  }
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
                  onChange={(e) =>
                    setNewProvider({ ...newProvider, models: e.target.value })
                  }
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.label}>API Key</label>
                <input
                  className={styles.input}
                  type="password"
                  placeholder="sk-..."
                  value={newProvider.apiKey}
                  onChange={(e) =>
                    setNewProvider({ ...newProvider, apiKey: e.target.value })
                  }
                />
              </div>
            </div>
            <button className={styles.saveButton} onClick={handleAddProvider}>
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
                <span className={styles.providerUrl}>{provider.baseUrl}</span>
                {provider.models.map((m) => (
                  <span key={m} className={styles.modelTag}>
                    {m}
                  </span>
                ))}
              </div>
            </div>
            <div className={styles.providerActions}>
              <span className={styles.keyStatus}>
                {provider.hasKey ? "🔑 Key stored" : "⚠️ No key"}
              </span>
              <button
                className={styles.removeButton}
                onClick={() => handleRemoveProvider(provider.id)}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Gateway API Key</h2>
        <p className={styles.sectionDesc}>
          Use this key in your AI tools instead of your upstream provider key.
          Aelvyril will authenticate requests and route them to the correct provider.
        </p>
        <div className={styles.gatewayKeyRow}>
          <code className={styles.gatewayKey}>aelvyril-••••••••</code>
          <button className={styles.copyButton}>Generate New Key</button>
        </div>
      </section>
    </div>
  );
}
