import { useOnboardingFlow } from "../hooks/useOnboardingFlow";
import {
  WelcomeStep,
  AddProviderStep,
  GatewayKeyStep,
  InstallExtensionStep,
  DoneStep,
  ProgressBar,
} from "./OnboardingSteps";
import styles from "./Onboarding.module.css";

const STEPS = ["Welcome", "Add Provider", "Gateway Key", "Install Extension", "Done"];

export function Onboarding() {
  const {
    step,
    tools,
    error,
    providerData,
    gatewayKey,
    copied,
    setStep,
    setProviderData,
    submitProvider,
    copyKey,
    finish,
  } = useOnboardingFlow();

  if (step >= 0 && step <= 4) {
    const stepContent = {
      0: <WelcomeStep tools={tools} onStart={() => setStep(1)} />,
      1: (
        <AddProviderStep
          data={providerData}
          error={error}
          onChange={setProviderData}
          onBack={() => setStep(0)}
          onSubmit={submitProvider}
        />
      ),
      2: (
        <GatewayKeyStep
          keyValue={gatewayKey}
          copied={copied}
          tools={tools}
          onCopy={copyKey}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      ),
      3: <InstallExtensionStep onBack={() => setStep(2)} onNext={() => setStep(4)} />,
      4: <DoneStep onFinish={finish} />,
    }[step] ?? null;

    return (
      <div className={styles.overlay}>
        <div className={styles.modal}>
          <ProgressBar steps={STEPS} currentStep={step} />
          {stepContent}
        </div>
      </div>
    );
  }

  return null;
}
