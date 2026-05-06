import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatPanel } from '../ChatPanel.js';

describe('ChatPanel', () => {
  it('renders chat input', () => {
    render(<ChatPanel onSend={() => {}} messages={[]} />);
    expect(screen.getByPlaceholderText('Message the Supervisor...')).toBeDefined();
  });

  it('renders existing messages', () => {
    const messages = [
      { direction: 'user_to_supervisor' as const, content: 'Add dark mode', timestamp: '2026-01-01T00:00:00Z' },
      { direction: 'supervisor_to_user' as const, content: 'Creating tickets...', timestamp: '2026-01-01T00:00:01Z' },
    ];
    render(<ChatPanel onSend={() => {}} messages={messages} />);
    expect(screen.getByText('Add dark mode')).toBeDefined();
    expect(screen.getByText('Creating tickets...')).toBeDefined();
  });

  it('disables input when not connected', () => {
    render(<ChatPanel onSend={() => {}} messages={[]} connected={false} />);
    const input = screen.getByPlaceholderText('Message the Supervisor...');
    expect(input).toBeDisabled();
  });
});
