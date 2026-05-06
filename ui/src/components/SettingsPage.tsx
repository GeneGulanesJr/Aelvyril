import { useState } from 'react';
import type { Config } from '../api/client.js';

interface SettingsPageProps {
  config: Config | null;
  onSave: (config: Partial<Config>) => void;
}

const AGENT_TYPES = ['supervisor', 'ticket_agent', 'main_agent', 'sub_agent', 'test_agent', 'review_agent', 'watchdog'];

export function SettingsPage({ config, onSave }: SettingsPageProps) {
  const [apiKeys, setApiKeys] = useState<Record<string, string>>(config?.api_keys ?? {});
  const [models, setModels] = useState<Record<string, string>>(config?.models ?? {});
  const [maxParallel, setMaxParallel] = useState(config?.max_parallel ?? 2);
  const [watchdogTimeout, setWatchdogTimeout] = useState(config?.watchdog_timeout_ms ?? 300000);

  const handleSave = () => {
    onSave({
      api_keys: apiKeys,
      models,
      max_parallel: maxParallel,
      watchdog_timeout_ms: watchdogTimeout,
    });
  };

  return (
    <div className="settings-page">
      <h2>Settings</h2>

      <section className="settings-section">
        <h3>API Keys</h3>
        <div className="settings-field">
          <label>OpenAI</label>
          <input type="password" value={apiKeys.openai ?? ''} onChange={e => setApiKeys({ ...apiKeys, openai: e.target.value })} placeholder="sk-..." />
        </div>
        <div className="settings-field">
          <label>Anthropic</label>
          <input type="password" value={apiKeys.anthropic ?? ''} onChange={e => setApiKeys({ ...apiKeys, anthropic: e.target.value })} placeholder="sk-ant-..." />
        </div>
      </section>

      <section className="settings-section">
        <h3>Model Selection</h3>
        {AGENT_TYPES.map(agent => (
          <div key={agent} className="settings-field">
            <label>{agent.replace(/_/g, ' ')}</label>
            <select value={models[agent] ?? ''} onChange={e => setModels({ ...models, [agent]: e.target.value })}>
              <option value="">Default</option>
              <option value="claude-sonnet-4-20250514">Claude Sonnet</option>
              <option value="claude-opus-4-20250514">Claude Opus</option>
              <option value="gpt-4o">GPT-4o</option>
              <option value="gpt-4.1">GPT-4.1</option>
              <option value="o3">o3</option>
            </select>
          </div>
        ))}
      </section>

      <section className="settings-section">
        <h3>Max Parallel Agents</h3>
        <input type="range" min={1} max={5} value={maxParallel} onChange={e => setMaxParallel(Number(e.target.value))} />
        <span>{maxParallel}</span>
      </section>

      <section className="settings-section">
        <h3>Watchdog Timeout (ms)</h3>
        <input type="number" value={watchdogTimeout} onChange={e => setWatchdogTimeout(Number(e.target.value))} step={60000} min={60000} />
      </section>

      <button className="settings-save" onClick={handleSave}>Save Settings</button>
    </div>
  );
}
