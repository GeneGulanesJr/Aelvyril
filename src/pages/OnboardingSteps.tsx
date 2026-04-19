import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Cable,
  Download,
  Key,
  Monitor,
  Shield,
} from "lucide-react";
import type { DetectedTool } from "../hooks/useTauri";
import styles from "./Onboarding.module.css";

// ─── Welcome Step ───
interface WelcomeStepProps {
  tools: DetectedTool[];
  onStart: () => void;
}

export function WelcomeStep({ tools, onStart }: WelcomeStepProps) {
  return (
    <div className={styles.step}>
      <div className={styles.heroIcon}>
        <Shield size={48} strokeWidth={1.5} />
      </div>
      <h1 className={styles.stepTitle}>Welcome to Aelvyril</h1>
      <p className={styles.stepDesc}>
        Your local privacy gateway for AI workflows. Aelvyril sits between your AI
        tools and upstream providers, automatically detecting and sanitizing
        sensitive information.
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
      <button className={styles.primaryBtn} onClick={onStart}>
        Get Started
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

// ─── Add Provider Step ───
interface ProviderData {
  name: string;
  baseUrl: string;
  models: string;
  apiKey: string;
}

interface AddProviderStepProps {
  data: ProviderData;
  error: string;
  onChange: (data: ProviderData) => void;
  onBack: () => void;
  onSubmit: () => void;
}

export function AddProviderStep({
  data,
  error,
  onChange,
  onBack,
  onSubmit,
}: AddProviderStepProps) {
  const updateField = (field: keyof ProviderData, value: string) => {
    onChange({ ...data, [field]: value });
  };

  return (
    <div className={styles.step}>
      <div className={styles.stepIcon}>
        <Cable size={32} />
      </div>
      <h2 className={styles.stepTitle}>Add Your First Provider</h2>
      <p className={styles.stepDesc}>
        Connect an upstream AI provider. Aelvyril will route requests to it while
        protecting your data.
      </p>
      <div className={styles.form}>
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label}>Provider Name</label>
            <input
              className={styles.input}
              placeholder="OpenAI"
              value={data.name}
              onChange={(e) => updateField("name", e.target.value)}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>Base URL</label>
            <input
              className={styles.input}
              placeholder="https://api.openai.com/v1"
              value={data.baseUrl}
              onChange={(e) => updateField("baseUrl", e.target.value)}
            />
          </div>
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>Models (comma-separated)</label>
          <input
            className={styles.input}
            placeholder="gpt-4o, gpt-4o-mini"
            value={data.models}
            onChange={(e) => updateField("models", e.target.value)}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>API Key</label>
          <input
            className={styles.input}
            type="password"
            placeholder="sk-..."
            value={data.apiKey}
            onChange={(e) => updateField("apiKey", e.target.value)}
          />
        </div>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.btnRow}>
          <button className={styles.secondaryBtn} onClick={onBack}>
            <ArrowLeft size={16} /> Back
          </button>
          <button className={styles.primaryBtn} onClick={onSubmit}>
            Add Provider
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Gateway Key Step ───
interface GatewayKeyStepProps {
  keyValue: string | null;
  copied: boolean;
  tools: DetectedTool[];
  onCopy: () => void;
  onBack: () => void;
  onNext: () => void;
}

export function GatewayKeyStep({
  keyValue,
  copied,
  tools,
  onCopy,
  onBack,
  onNext,
}: GatewayKeyStepProps) {
  return (
    <div className={styles.step}>
      <div className={styles.stepIcon}>
        <Key size={32} />
      </div>
      <h2 className={styles.stepTitle}>Your Gateway Key</h2>
      <p className={styles.stepDesc}>
        Use this key in your AI tools instead of your upstream API key. All
        requests will go through Aelvyril for privacy protection.
      </p>
      {keyValue && (
        <div className={styles.keyDisplay}>
          <code className={styles.keyValue}>{keyValue}</code>
          <button className={styles.copyBtn} onClick={onCopy}>
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
        <button className={styles.secondaryBtn} onClick={onBack}>
          <ArrowLeft size={16} /> Back
        </button>
        <button className={styles.primaryBtn} onClick={onNext}>
          Next
          <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}

// ─── Install Extension Step ───
interface InstallExtensionStepProps {
  onBack: () => void;
  onNext: () => void;
}

export function InstallExtensionStep({ onBack, onNext }: InstallExtensionStepProps) {
  return (
    <div className={styles.step}>
      <div className={styles.stepIcon}>
        <Download size={32} />
      </div>
      <h2 className={styles.stepTitle}>Browser Extension</h2>
      <p className={styles.stepDesc}>
        Install the companion browser extension to protect clipboard data when
        using web-based AI tools like ChatGPT, Claude.ai, and others.
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
      <p className={styles.optional}>
        This step is optional — you can install it later.
      </p>
      <div className={styles.btnRow}>
        <button className={styles.secondaryBtn} onClick={onBack}>
          <ArrowLeft size={16} /> Back
        </button>
        <button className={styles.primaryBtn} onClick={onNext}>
          Skip
          <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}

// ─── Done Step ───
interface DoneStepProps {
  onFinish: () => void;
}

export function DoneStep({ onFinish }: DoneStepProps) {
  return (
    <div className={styles.step}>
      <div className={styles.heroIcon}>
        <Shield size={48} strokeWidth={1.5} />
      </div>
      <h2 className={styles.stepTitle}>You&apos;re All Set!</h2>
      <p className={styles.stepDesc}>
        Aelvyril is running and protecting your data. Configure additional
        providers, adjust detection rules, or explore the audit log from the
        sidebar.
      </p>
      <button className={styles.primaryBtn} onClick={onFinish}>
        Open Dashboard
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

// ─── Progress Bar ───
interface ProgressBarProps {
  steps: string[];
  currentStep: number;
}

export function ProgressBar({ steps, currentStep }: ProgressBarProps) {
  return (
    <div className={styles.progressBar}>
      {steps.map((_, i) => (
        <div
          key={i}
          className={`${styles.progressDot} ${
            i <= currentStep ? styles.active : ""
          } ${i === currentStep ? styles.current : ""}`}
        />
      ))}
    </div>
  );
}
