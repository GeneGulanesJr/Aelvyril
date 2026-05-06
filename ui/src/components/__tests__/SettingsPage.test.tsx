import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsPage } from '../SettingsPage.js';

describe('SettingsPage', () => {
  it('renders API key inputs', () => {
    render(<SettingsPage config={null} onSave={() => {}} />);
    expect(screen.getByText('API Keys')).toBeDefined();
  });

  it('renders model selection for each agent type', () => {
    render(<SettingsPage config={null} onSave={() => {}} />);
    expect(screen.getByText('Model Selection')).toBeDefined();
  });

  it('renders concurrency slider', () => {
    render(<SettingsPage config={null} onSave={() => {}} />);
    expect(screen.getByText('Max Parallel Agents')).toBeDefined();
  });
});
