import { describe, it, expect } from 'vitest';
import { getPollingInterval, getPollingTier } from './polling-scheduler.js';

describe('polling-scheduler', () => {
    it('returns daytime intervals between 7am and 8pm', () => {
        expect(getPollingTier(10)).toBe('daytime');
        expect(getPollingInterval(10)).toBe(300000); // DAYTIME_POLL_INTERVAL
    });

    it('returns evening intervals between 8pm and 11pm', () => {
        expect(getPollingTier(21)).toBe('evening');
        expect(getPollingInterval(21)).toBe(1800000); // EVENING_POLL_INTERVAL
    });

    it('returns overnight intervals between 11pm and 7am', () => {
        expect(getPollingTier(3)).toBe('overnight');
        expect(getPollingInterval(3)).toBe(7200000); // OVERNIGHT_POLL_INTERVAL
    });
});
