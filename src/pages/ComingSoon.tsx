import styles from "./ComingSoon.module.css";

interface ComingSoonProps {
  title: string;
  description?: string;
  icon?: "orchestrator" | "agent" | "pipeline" | "default";
}

const icons = {
  orchestrator: (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="12" width="40" height="8" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect x="4" y="24" width="28" height="8" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect x="4" y="36" width="16" height="8" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M40 28L44 32L40 36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  agent: (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="24" cy="24" r="16" stroke="currentColor" strokeWidth="2" />
      <circle cx="24" cy="24" r="6" stroke="currentColor" strokeWidth="2" />
      <path d="M24 4V12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M24 36V44" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M4 24H12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M36 24H44" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  pipeline: (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="18" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect x="32" y="18" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M16 24H32" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 4" />
      <circle cx="24" cy="24" r="3" fill="currentColor" />
    </svg>
  ),
  default: (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M24 4L28 16H40L30 24L34 36L24 28L14 36L18 24L8 16H20L24 4Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

export function ComingSoon({ title, description, icon = "default" }: ComingSoonProps) {
  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <div className={styles.icon}>{icons[icon]}</div>
        <h1 className={styles.title}>{title}</h1>
        {description && <p className={styles.description}>{description}</p>}
        <div className={styles.badge}>
          <span className={styles.badgeDot} />
          Coming Soon
        </div>
      </div>
    </div>
  );
}
