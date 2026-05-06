import { useState, useRef, useEffect } from 'react';

export interface ChatMessage {
  direction: 'user_to_supervisor' | 'supervisor_to_user';
  content: string;
  timestamp: string;
}

interface ChatPanelProps {
  onSend: (content: string) => void;
  messages: ChatMessage[];
  connected?: boolean;
}

export function ChatPanel({ onSend, messages, connected = true }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !connected) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">Supervisor</span>
        <span className={`chat-status ${connected ? 'connected' : 'disconnected'}`}>
          {connected ? '●' : '○'}
        </span>
      </div>
      <div className="chat-messages" ref={scrollRef}>
        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.direction}`}>
            <span className="chat-message-content">{msg.content}</span>
            <span className="chat-message-time">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </span>
          </div>
        ))}
        {messages.length === 0 && (
          <div className="chat-empty">Send a message to start coding</div>
        )}
      </div>
      <form className="chat-input-form" onSubmit={handleSubmit}>
        <input
          className="chat-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message the Supervisor..."
          disabled={!connected}
        />
        <button className="chat-send" type="submit" disabled={!connected || !input.trim()}>
          →
        </button>
      </form>
    </div>
  );
}
