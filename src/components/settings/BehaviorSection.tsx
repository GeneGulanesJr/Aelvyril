import { Bell, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { useSettings, AppSettings } from "../../hooks/useTauri";
import { ToggleRow, TimeoutSelector } from "./components";
import styles from "../../pages/Settings.module.css";

type BooleanKey = Extract<
  keyof AppSettings,
  "launch_at_login" | "minimize_to_tray" | "show_notifications"
>;

interface ToggleConfig {
  key: BooleanKey;
  label: string;
  desc: string;
  icon?: React.ReactNode;
}

export function BehaviorSection() {
  const { settings, update } = useSettings();
  const [draft, setDraft] = useState<{
    perMinute: string;
    perHour: string;
    concurrent: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  if (!settings) return null;

  const effectiveDraft = useMemo(() => {
    if (draft) return draft;
    return {
      perMinute: String(settings.rate_limit_max_requests_per_minute ?? 60),
      perHour: String(settings.rate_limit_max_requests_per_hour ?? 1000),
      concurrent: String(settings.rate_limit_max_concurrent_requests ?? 10),
    };
  }, [draft, settings.rate_limit_max_requests_per_minute, settings.rate_limit_max_requests_per_hour, settings.rate_limit_max_concurrent_requests]);

  const toggle = async (key: BooleanKey) => {
    await update({ ...settings, [key]: !settings[key] });
  };

  const setTimeout = async (minutes: number) => {
    await update({ ...settings, session_timeout_minutes: minutes });
  };

  const clampInt = (raw: string, min: number, max: number, fallback: number) => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  const saveRateLimits = async () => {
    setSaving(true);
    try {
      const next = {
        rate_limit_max_requests_per_minute: clampInt(
          effectiveDraft.perMinute,
          1,
          100_000,
          settings.rate_limit_max_requests_per_minute,
        ),
        rate_limit_max_requests_per_hour: clampInt(
          effectiveDraft.perHour,
          1,
          1_000_000,
          settings.rate_limit_max_requests_per_hour,
        ),
        rate_limit_max_concurrent_requests: clampInt(
          effectiveDraft.concurrent,
          1,
          10_000,
          settings.rate_limit_max_concurrent_requests,
        ),
      };

      await update({
        ...settings,
        ...next,
      });
      setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  const toggles: ToggleConfig[] = [
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
      label: "Notification on PII Detection",
      desc: "Show an OS notification with Sanitize/Allow/Block action buttons when sensitive content is detected.",
      icon: <Bell size={14} />,
    },
  ];

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>Startup & Behavior</h2>

      {toggles.map(({ key, label, desc, icon }) => (
        <ToggleRow
          key={key}
          label={label}
          desc={desc}
          enabled={settings[key]}
          onToggle={() => toggle(key)}
          icon={icon}
        />
      ))}

      <TimeoutSelector value={settings.session_timeout_minutes} onChange={setTimeout} />

      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>
          <Zap size={16} />
          Rate Limiting
        </h3>
        <p className={styles.subDesc}>
          Configure gateway rate limits enforced per client (minute/hour) plus a global concurrent cap.
        </p>

        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label}>Requests / minute (per client)</label>
            <input
              className={styles.input}
              inputMode="numeric"
              value={effectiveDraft.perMinute}
              onChange={(e) =>
                setDraft({
                  ...(draft ?? effectiveDraft),
                  perMinute: e.target.value,
                })
              }
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>Requests / hour (per client)</label>
            <input
              className={styles.input}
              inputMode="numeric"
              value={effectiveDraft.perHour}
              onChange={(e) =>
                setDraft({
                  ...(draft ?? effectiveDraft),
                  perHour: e.target.value,
                })
              }
            />
          </div>
        </div>

        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label}>Concurrent requests (global)</label>
            <input
              className={styles.input}
              inputMode="numeric"
              value={effectiveDraft.concurrent}
              onChange={(e) =>
                setDraft({
                  ...(draft ?? effectiveDraft),
                  concurrent: e.target.value,
                })
              }
            />
          </div>
          <div className={styles.formGroup} />
        </div>

        <button className={styles.saveButton} onClick={saveRateLimits} disabled={saving}>
          {saving ? "Saving..." : "Save Rate Limits"}
        </button>
      </div>
    </div>
  );
}
