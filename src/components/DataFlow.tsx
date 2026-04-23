import { User, Brain, ArrowRight, RefreshCw } from "lucide-react";
import styles from "../pages/Dashboard.module.css";

const steps = [
  { icon: User, label: "You", desc: "Original prompt" },
  { icon: Brain, label: "Detect & Mask", desc: "PII replaced with tokens" },
  { icon: Brain, label: "AI Provider", desc: "Safe request sent" },
  { icon: RefreshCw, label: "Response", desc: "Tokens restored" },
];

export function DataFlow() {
  return (
    <div className={styles.flowCard}>
      <div className={styles.flowHeader}>
        <span className={styles.flowTitle}>How It Works</span>
      </div>
      <div className={styles.flowSteps}>
        {steps.map((step, i) => (
          <div key={step.label} className={styles.flowStep}>
            <div className={styles.flowCircle}>
              <step.icon size={18} strokeWidth={1.5} />
            </div>
            <span className={styles.flowStepLabel}>{step.label}</span>
            <span className={styles.flowStepDesc}>{step.desc}</span>
            {i < steps.length - 1 && (
              <div className={styles.flowArrow}>
                <ArrowRight size={14} strokeWidth={1.5} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
