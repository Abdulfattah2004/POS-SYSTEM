import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TestCandidateNotice from './TestCandidateNotice';

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
describe('Candidate release labeling', () => {
  it('uses no candidate header while retaining the explicit internal test channel', () => {
    vi.stubEnv('VITE_POS_BUILD_CHANNEL', 'unverified-test-candidate');
    vi.stubEnv('VITE_POS_SYNC_ENABLED', 'true');
    render(<TestCandidateNotice />);
    expect(screen.queryByRole('alert', { name: 'Unverified test candidate' })).toBeNull();
    expect(import.meta.env.VITE_POS_BUILD_CHANNEL).toBe('unverified-test-candidate');
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('does not falsely label a disabled development configuration as sync-enabled', () => {
    vi.stubEnv('VITE_POS_BUILD_CHANNEL', 'unverified-test-candidate');
    vi.stubEnv('VITE_POS_SYNC_ENABLED', 'false');
    render(<TestCandidateNotice />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(import.meta.env.VITE_POS_SYNC_ENABLED).toBe('false');
  });
  it('does not relabel normal customer builds', () => {
    vi.stubEnv('VITE_POS_BUILD_CHANNEL', 'customer');
    render(<TestCandidateNotice />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('does not introduce a candidate notice solely because sync is enabled', () => {
    vi.stubEnv('VITE_POS_BUILD_CHANNEL', '');
    vi.stubEnv('VITE_POS_SYNC_ENABLED', 'true');
    render(<TestCandidateNotice />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
