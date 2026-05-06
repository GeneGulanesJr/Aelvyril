import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KanbanBoard } from '../KanbanBoard.js';

const tickets = [
  { id: '#1', title: 'Add dark mode', status: 'in_progress', priority: 1, cost_tokens: 100, cost_usd: 0.01, assigned_agent: 'sub-1' },
  { id: '#2', title: 'Build toggle', status: 'backlog', priority: 2, cost_tokens: 0, cost_usd: 0, assigned_agent: null },
  { id: '#3', title: 'Theme context', status: 'done', priority: 1, cost_tokens: 500, cost_usd: 0.05, assigned_agent: null },
];

describe('KanbanBoard', () => {
  it('renders all 5 columns', () => {
    render(<KanbanBoard tickets={tickets as any} />);
    expect(screen.getByText('Backlog')).toBeDefined();
    expect(screen.getByText('In Progress')).toBeDefined();
    expect(screen.getByText('Testing')).toBeDefined();
    expect(screen.getByText('In Review')).toBeDefined();
    expect(screen.getByText('Done')).toBeDefined();
  });

  it('places tickets in correct columns', () => {
    render(<KanbanBoard tickets={tickets as any} />);
    expect(screen.getByText('Add dark mode')).toBeDefined();
    expect(screen.getByText('Build toggle')).toBeDefined();
    expect(screen.getByText('Theme context')).toBeDefined();
  });
});
