import { useState, useEffect, useCallback } from "react";
import { useOnboarding, useGatewayKey, useProviders } from "./useTauri";
import type { DetectedTool } from "./useTauri";

interface ProviderFormData {
  name: string;
  baseUrl: string;
  models: string;
  apiKey: string;
}

interface OnboardingFlowState {
  step: number;
  tools: DetectedTool[];
  error: string;
  providerData: ProviderFormData;
  gatewayKey: string | null;
  copied: boolean;
}

interface OnboardingFlowActions {
  setStep: (step: number) => void;
  setProviderData: (data: ProviderFormData) => void;
  submitProvider: () => Promise<void>;
  copyKey: () => void;
  finish: () => void;
}

const INITIAL_PROVIDER_DATA: ProviderFormData = {
  name: "",
  baseUrl: "",
  models: "",
  apiKey: "",
};

export function useOnboardingFlow(): OnboardingFlowState & OnboardingFlowActions {
  const [step, setStep] = useState(0);
  const [tools, setTools] = useState<DetectedTool[]>([]);
  const [error, setError] = useState("");
  const [providerData, setProviderData] = useState<ProviderFormData>(INITIAL_PROVIDER_DATA);
  const [copied, setCopied] = useState(false);

  const { complete, detectTools } = useOnboarding();
  const { key: gatewayKey, generate } = useGatewayKey();
  const { add } = useProviders();

  useEffect(() => {
    detectTools()
      .then(setTools)
      .catch((e) => setError("Failed to detect installed tools: " + String(e)));
  }, [detectTools]);

  useEffect(() => {
    if (step === 2 && !gatewayKey) {
      generate();
    }
  }, [step, gatewayKey, generate]);

  const submitProvider = useCallback(async () => {
    const { name, baseUrl, apiKey } = providerData;
    if (!name || !baseUrl || !apiKey) {
      setError("Please fill in all required fields");
      return;
    }
    try {
      const models = providerData.models
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      await add(name, baseUrl, models, apiKey);
      setStep(3);
    } catch (e) {
      setError(String(e));
    }
  }, [providerData, add]);

  const copyKey = useCallback(() => {
    if (!gatewayKey) return;
    navigator.clipboard.writeText(gatewayKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [gatewayKey]);

  const finish = useCallback(() => {
    complete();
  }, [complete]);

  return {
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
  };
}
