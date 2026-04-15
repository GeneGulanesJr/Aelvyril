import { useState, useEffect } from "react";
import {
  Shield,
  ArrowRight,
  ArrowLeft,
  Key,
  Copy,
  Check,
  Download,
  Monitor,
  Cable,
} from "lucide-react";
import { useOnboarding, useGatewayKey, useProviders } from "../hooks/useTauri";
import type { DetectedTool } from "../hooks/useTauri";
import styles from "./Onboarding.module.css";

const STEPS = ["Welcome", "Add Provider", "Gateway Key", "Install Extension", "Done"];

export function Onboarding() {
  const [step, setStep] = useState(0);
  const { status, complete, detectTools } = useOnboarding();
  const { key, generate } = useGatewayKey();
  const { add, fetchModels } = useProviders();

  const [newProvider, setNewProvider] = useState({
    name: "",
    baseUrl: "",
    models: "",
    apiKey: "",
  });
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [tools, setTools] = useState<DetectedTool[]>([]);
  const [error, setError] = useState("");
  const [fetchingModels, setFetchingModels] = useState(false);

  useEffect(() => {
    detectTools()
      .then(setTools)
      .catch((e) => setError("Failed to detect installed tools: " + String(e)));
  }, [detectTools]);

  // Auto-generate key when reaching that step
  useEffect(() => {
    if (step === 2 && !key) {
      generate();
    }
  }, [step, key, generate]);

  // Auto-fetch models when baseUrl and apiKey are provided and no models have been fetched yet
  useEffect(() => {
    const shouldFetch =
      newProvider.baseUrl?.trim() &&
      newProvider.apiKey?.trim() &&
      newProvider.baseUrl.startsWith("http") &&
      newProvider.apiKey.length > 10 && // Basic API key validation
      availableModels.length === 0; // Only fetch if we haven't fetched models yet

    if (shouldFetch) {
      console.log("Auto-fetching models for:", newProvider.baseUrl);
      setFetchingModels(true);
      fetchModels(newProvider.baseUrl, newProvider.apiKey)
        .then((models) => {
          console.log("Auto-fetched models:", models);
          if (models && models.length > 0) {
            setAvailableModels(models);
            // Auto-select all models by default
            setSelectedModels(new Set(models));
          }
        })
        .catch((e) => {
          console.log("Auto-fetch failed:", e);
          // Don't show error for auto-fetching - user can manually fetch
        })
        .finally(() => {
          setFetchingModels(false);
        });
    }
  }, [newProvider.baseUrl, newProvider.apiKey, availableModels.length, fetchModels]);

  const handleAddProvider = async () => {
    if (!newProvider.name || !newProvider.baseUrl || !newProvider.apiKey) {
      setError("Please fill in all required fields");
      return;
    }
    try {
      const models = Array.from(selectedModels);
      await add(newProvider.name, newProvider.baseUrl, models, newProvider.apiKey);
      setStep(3);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCopyKey = () => {
    if (key) {
      navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleFinish = async () => {
    await complete();
  };

  if (status?.complete) return null;

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        {/* Progress bar */}
        <div className={styles.progressBar}>
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`${styles.progressDot} ${i <= step ? styles.active : ""} ${i === step ? styles.current : ""}`}
            />
          ))}
        </div>

        {/* Step 0: Welcome */}
        {step === 0 && (
          <div className={styles.step}>
            <div className={styles.heroIcon}>
              <Shield size={48} strokeWidth={1.5} />
            </div>
            <h1 className={styles.stepTitle}>Welcome to Aelvyril</h1>
            <p className={styles.stepDesc}>
              Your local privacy gateway for AI workflows. Aelvyril sits between your AI tools and
              upstream providers, automatically detecting and sanitizing sensitive information.
            </p>
            {tools.length > 0 && (
              <div className={styles.detectedTools}>
                <p className={styles.detectedLabel}>Detected on your system:</p>
                {tools.map((tool) => (
                  <div key={tool.name} className={styles.detectedTool}>
                    <Monitor size={16} />
                    <span>{tool.name}</span>
                  </div>
                ))}
              </div>
            )}
            <button className={styles.primaryBtn} onClick={() => setStep(1)}>
              Get Started
              <ArrowRight size={16} />
            </button>
          </div>
        )}

        {/* Step 1: Add Provider */}
        {step === 1 && (
          <div className={styles.step}>
            <div className={styles.stepIcon}>
              <Cable size={32} />
            </div>
            <h2 className={styles.stepTitle}>Add Your First Provider</h2>
            <p className={styles.stepDesc}>
              Connect an upstream AI provider. Aelvyril will route requests to it while protecting
              your data.
            </p>
            <div className={styles.form}>
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
              <div className={styles.formGroup}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: "8px",
                  }}
                >
                  <label className={styles.label}>
                    Available Models
                    {fetchingModels && (
                      <span style={{ marginLeft: "8px", fontSize: "12px", color: "var(--accent)" }}>
                        Fetching...
                      </span>
                    )}
                  </label>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={async () => {
                      if (newProvider.baseUrl && newProvider.apiKey) {
                        setFetchingModels(true);
                        try {
                          const models = await fetchModels(newProvider.baseUrl, newProvider.apiKey);
                          if (models && models.length > 0) {
                            setAvailableModels(models);
                            // Auto-select all models by default
                            setSelectedModels(new Set(models));
                          } else {
                            setError("No models found for this provider");
                          }
                        } catch (e) {
                          setError(`Failed to fetch models: ${e}`);
                        } finally {
                          setFetchingModels(false);
                        }
                      }
                    }}
                    disabled={!newProvider.baseUrl || !newProvider.apiKey || fetchingModels}
                    style={{ padding: "4px 8px", fontSize: "12px", height: "auto" }}
                  >
                    {fetchingModels ? "..." : "Refresh"}
                  </button>
                </div>
                {availableModels.length > 0 ? (
                  <div className={styles.modelsChecklist}>
                    {availableModels.map((model) => (
                      <label key={model} className={styles.checkboxLabel}>
                        <input
                          type="checkbox"
                          checked={selectedModels.has(model)}
                          onChange={(e) => {
                            const newSelected = new Set(selectedModels);
                            if (e.target.checked) {
                              newSelected.add(model);
                            } else {
                              newSelected.delete(model);
                            }
                            setSelectedModels(newSelected);
                          }}
                        />
                        <span>{model}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className={styles.modelsPlaceholder}>
                    {fetchingModels ? (
                      <span>Loading available models...</span>
                    ) : newProvider.baseUrl && newProvider.apiKey ? (
                      <span>Click "Refresh" to fetch available models</span>
                    ) : (
                      <span>Enter Base URL and API Key to fetch models</span>
                    )}
                  </div>
                )}
              </div>
              {error && <p className={styles.error}>{error}</p>}
              <div className={styles.btnRow}>
                <button className={styles.secondaryBtn} onClick={() => setStep(0)}>
                  <ArrowLeft size={16} /> Back
                </button>
                <button className={styles.primaryBtn} onClick={handleAddProvider}>
                  Add Provider
                  <ArrowRight size={16} />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Gateway Key */}
        {step === 2 && (
          <div className={styles.step}>
            <div className={styles.stepIcon}>
              <Key size={32} />
            </div>
            <h2 className={styles.stepTitle}>Your Gateway Key</h2>
            <p className={styles.stepDesc}>
              Use this key in your AI tools instead of your upstream API key. All requests will go
              through Aelvyril for privacy protection.
            </p>
            {key && (
              <div className={styles.keyDisplay}>
                <code className={styles.keyValue}>{key}</code>
                <button className={styles.copyBtn} onClick={handleCopyKey}>
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            )}
            {tools.length > 0 && (
              <div className={styles.toolInstructions}>
                <p className={styles.detectedLabel}>Setup instructions:</p>
                {tools.map((tool) => (
                  <div key={tool.name} className={styles.toolInstruction}>
                    <strong>{tool.name}</strong>
                    <p>{tool.instructions}</p>
                  </div>
                ))}
              </div>
            )}
            <div className={styles.btnRow}>
              <button className={styles.secondaryBtn} onClick={() => setStep(1)}>
                <ArrowLeft size={16} /> Back
              </button>
              <button className={styles.primaryBtn} onClick={() => setStep(3)}>
                Next
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Install Extension */}
        {step === 3 && (
          <div className={styles.step}>
            <div className={styles.stepIcon}>
              <Download size={32} />
            </div>
            <h2 className={styles.stepTitle}>Browser Extension</h2>
            <p className={styles.stepDesc}>
              Install the companion browser extension to protect clipboard data when using web-based
              AI tools like ChatGPT, Claude.ai, and others.
            </p>
            <div className={styles.extensionCards}>
              <div className={styles.extensionCard}>
                <span className={styles.extName}>Chrome</span>
                <p className={styles.extDesc}>
                  Works with Manifest V3. Available from the Chrome Web Store.
                </p>
                <span className={styles.extBadge}>Coming Soon</span>
              </div>
              <div className={styles.extensionCard}>
                <span className={styles.extName}>Firefox</span>
                <p className={styles.extDesc}>
                  Supports MV2 and MV3. Available from Firefox Add-ons.
                </p>
                <span className={styles.extBadge}>Coming Soon</span>
              </div>
            </div>
            <p className={styles.optional}>This step is optional — you can install it later.</p>
            <div className={styles.btnRow}>
              <button className={styles.secondaryBtn} onClick={() => setStep(2)}>
                <ArrowLeft size={16} /> Back
              </button>
              <button className={styles.primaryBtn} onClick={() => setStep(4)}>
                Skip
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Done */}
        {step === 4 && (
          <div className={styles.step}>
            <div className={styles.heroIcon}>
              <Shield size={48} strokeWidth={1.5} />
            </div>
            <h2 className={styles.stepTitle}>You're All Set!</h2>
            <p className={styles.stepDesc}>
              Aelvyril is running and protecting your data. Configure additional providers, adjust
              detection rules, or explore the audit log from the sidebar.
            </p>
            <button className={styles.primaryBtn} onClick={handleFinish}>
              Open Dashboard
              <ArrowRight size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
