import { describe, expect, it } from 'vitest';

import { isCutOffAtMostOnceTask } from './at-most-once-task';

describe('at-most-once task marker', () => {
  it('treats a started, unfinished task as cut off', () => {
    expect(isCutOffAtMostOnceTask({ status: 'PENDING', result: { __solidtenStartedAt: '2026-11-20T00:00:00Z' } })).toBe(
      true,
    );
  });

  it('runs a task that never started or whose failure was recorded', () => {
    expect(isCutOffAtMostOnceTask({ status: 'PENDING', result: null })).toBe(false);
    expect(isCutOffAtMostOnceTask({ status: 'COMPLETED', result: { __solidtenStartedAt: 'x' } })).toBe(false);
    expect(isCutOffAtMostOnceTask({ status: 'PENDING', result: ['x'] })).toBe(false);
  });
});
