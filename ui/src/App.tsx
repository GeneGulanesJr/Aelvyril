import { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from './hooks/useWebSocket.js';
import { api } from './api/client.js';
import type { ChatMessage } from './components/ChatPanel.js';
import { ChatPanel } from './components/ChatPanel.js';
import { KanbanBoard } from './components/KanbanBoard.js';
import { ActivityFeed } from './components/ActivityFeed.js';
import { CostDashboard } from './components/CostDashboard.js';
import { SettingsPage } from './components/SettingsPage.js';
import type { CostReport, Config, Ticket } from './api/client.js';
import type { ActivityEntry } from './components/ActivityFeed.js';

interface ProgressAlert {
  ticket: string;
  type: string;
  message: string;
}

interface ProgressReport {
  session_id: string;
  total_tickets: number;
  status: Record<string, number>;
  alerts: ProgressAlert[];
  all_done: boolean;
  timestamp: string;
}

type Tab = 'board' | 'cost' | 'settings';

export function App() {
  const { connected, lastEvent, send } = useWebSocket(
    `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
  );
  const [tab, setTab] = useState<Tab>('board');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [costReport, setCostReport] = useState<CostReport | null>(null);
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    if (!lastEvent) return;

    switch (lastEvent.event) {
      case 'supervisor_response':
        setMessages(prev => [...prev, {
          direction: 'supervisor_to_user',
          content: (lastEvent.data as { message?: string }).message ?? String(lastEvent.data),
          timestamp: new Date().toISOString(),
        }]);
        break;

      case 'ticket_created':
      case 'ticket_transition':
      case 'ticket_held':
      case 'ticket_released':
      case 'board_state':
        if (lastEvent.event === 'board_state') {
          setTickets((lastEvent.data as { tickets?: Ticket[] }).tickets ?? []);
        }
        setActivity(prev => [{
          timestamp: new Date().toISOString(),
          agent: 'SYSTEM',
          action: `${lastEvent.event}: ${JSON.stringify(lastEvent.data)}`,
        }, ...prev].slice(0, 200));
        break;

      case 'agent_activity':
        setActivity(prev => [lastEvent.data as ActivityEntry, ...prev].slice(0, 200));
        break;

      case 'cost_update':
        setCostReport(lastEvent.data as CostReport);
        break;

      case 'progress_report': {
        const report = lastEvent.data as ProgressReport;
        const newEntries: ActivityEntry[] = report.alerts.map(alert => ({
          timestamp: report.timestamp,
          agent: 'WATCHDOG',
          action: `[progress] ${alert.ticket}: ${alert.message}`,
        }));
        if (report.all_done) {
          newEntries.push({
            timestamp: report.timestamp,
            agent: 'WATCHDOG',
            action: '[progress] All tickets completed!',
          });
        }
        setActivity(prev => [...newEntries, ...prev].slice(0, 200));
        break;
      }
    }
  }, [lastEvent]);

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => {});
  }, []);

  const handleSend = useCallback((content: string) => {
    setMessages(prev => [...prev, {
      direction: 'user_to_supervisor',
      content,
      timestamp: new Date().toISOString(),
    }]);
    send('chat_message', { content });
  }, [send]);

  const handleSaveConfig = useCallback(async (newConfig: Partial<Config>) => {
    const updated = await api.updateConfig(newConfig);
    setConfig(updated);
  }, []);

  return (
    <div className="app-layout">
      <div className="app-sidebar">
        <ChatPanel onSend={handleSend} messages={messages} connected={connected} />
      </div>

      <div className="app-main">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)' }}>
            <button className={tab === 'board' ? 'tab-active' : ''} onClick={() => setTab('board')}>Board</button>
            <button className={tab === 'cost' ? 'tab-active' : ''} onClick={() => setTab('cost')}>Cost</button>
            <button className={tab === 'settings' ? 'tab-active' : ''} onClick={() => setTab('settings')}>Settings</button>
          </div>

          <div style={{ flex: 1, overflow: 'auto' }}>
            {tab === 'board' && <KanbanBoard tickets={tickets} />}
            {tab === 'cost' && <CostDashboard report={costReport} />}
            {tab === 'settings' && <SettingsPage config={config} onSave={handleSaveConfig} />}
          </div>
        </div>
      </div>

      <div className="app-aside">
        <ActivityFeed entries={activity} />
      </div>
    </div>
  );
}
