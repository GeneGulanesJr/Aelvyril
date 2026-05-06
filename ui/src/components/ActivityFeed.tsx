import { useRef, useEffect } from 'react';

export interface ActivityEntry {
  timestamp: string;
  agent: string;
  action: string;
  ticket_id?: string;
  details?: string;
}

interface ActivityFeedProps {
  entries: ActivityEntry[];
}

const AGENT_COLORS: Record<string, string> = {
  SUPERVISOR: '#4fc3f7',
  TICKET_AGENT: '#81c784',
  MAIN_AGENT: '#ffb74d',
  SUB_AGENT: '#e57373',
  TEST_AGENT: '#ba68c8',
  REVIEW_AGENT: '#4db6ac',
  WATCHDOG: '#fff176',
};

export function ActivityFeed({ entries }: ActivityFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div className="activity-feed">
      <div className="activity-header">Activity</div>
      <div className="activity-entries" ref={scrollRef}>
        {entries.map((entry, i) => {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const color = AGENT_COLORS[entry.agent] ?? '#aaa';
          return (
            <div key={i} className="activity-entry">
              <span className="activity-time">{time}</span>
              <span className="activity-agent" style={{ color }}>{entry.agent}</span>
              <span className="activity-action">
                {entry.ticket_id && <span className="activity-ticket">{entry.ticket_id} </span>}
                {entry.action}
              </span>
            </div>
          );
        })}
        {entries.length === 0 && (
          <div className="activity-empty">No activity yet</div>
        )}
      </div>
    </div>
  );
}
