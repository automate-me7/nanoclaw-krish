/**
 * Loop Guards — Unit Tests
 *
 * These tests verify the loop guard decision logic (token budget limits and
 * consecutive error limits) WITHOUT modifying the production constants.
 * We replicate the exact same branching logic used inside `runQuery` in
 * container/agent-runner/src/index.ts so that the guard thresholds are
 * validated at their real values.
 */
import { describe, it, expect } from 'vitest';

// Mirror the production constants from container/agent-runner/src/index.ts
const MAX_CONSECUTIVE_ERRORS = 8;
const TOKEN_SOFT_LIMIT = 50_000;
const TOKEN_HARD_LIMIT = 100_000;

/** Pure-logic replica of the token budget guard from runQuery(). */
function evaluateTokenGuard(
    totalTokens: number,
    guardTriggered: boolean,
): 'none' | 'soft_warning' | 'hard_kill' {
    if (totalTokens >= TOKEN_HARD_LIMIT) return 'hard_kill';
    if (totalTokens >= TOKEN_SOFT_LIMIT && totalTokens < TOKEN_HARD_LIMIT && !guardTriggered) {
        return 'soft_warning';
    }
    return 'none';
}

/** Pure-logic replica of the consecutive error guard from runQuery(). */
function evaluateErrorGuard(consecutiveErrorCount: number): boolean {
    return consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS;
}

describe('loop-guards: token budget', () => {
    it('does nothing below the soft limit', () => {
        expect(evaluateTokenGuard(10_000, false)).toBe('none');
        expect(evaluateTokenGuard(49_999, false)).toBe('none');
    });

    it('emits a soft warning at exactly the soft limit', () => {
        expect(evaluateTokenGuard(TOKEN_SOFT_LIMIT, false)).toBe('soft_warning');
    });

    it('emits a soft warning between soft and hard limits', () => {
        expect(evaluateTokenGuard(75_000, false)).toBe('soft_warning');
        expect(evaluateTokenGuard(99_999, false)).toBe('soft_warning');
    });

    it('does NOT re-warn if guardTriggered is already true', () => {
        expect(evaluateTokenGuard(75_000, true)).toBe('none');
    });

    it('hard-kills at exactly the hard limit', () => {
        expect(evaluateTokenGuard(TOKEN_HARD_LIMIT, false)).toBe('hard_kill');
    });

    it('hard-kills above the hard limit', () => {
        expect(evaluateTokenGuard(150_000, false)).toBe('hard_kill');
    });

    it('hard-kill overrides guardTriggered flag', () => {
        // Even if guardTriggered is true (from a previous soft warning),
        // crossing the hard limit should still kill.
        expect(evaluateTokenGuard(TOKEN_HARD_LIMIT, true)).toBe('hard_kill');
    });
});

describe('loop-guards: consecutive errors', () => {
    it('does not trigger below the limit', () => {
        for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i++) {
            expect(evaluateErrorGuard(i)).toBe(false);
        }
    });

    it('triggers at exactly the limit (8 consecutive errors)', () => {
        expect(evaluateErrorGuard(MAX_CONSECUTIVE_ERRORS)).toBe(true);
    });

    it('triggers above the limit', () => {
        expect(evaluateErrorGuard(MAX_CONSECUTIVE_ERRORS + 1)).toBe(true);
        expect(evaluateErrorGuard(100)).toBe(true);
    });
});

describe('loop-guards: simulated session lifecycle', () => {
    it('simulates a full session hitting soft then hard limit', () => {
        let totalTokens = 0;
        let guardTriggered = false;
        const events: string[] = [];

        // Simulate 5 turns of ~25k tokens each
        const tokenIncrements = [20_000, 15_000, 20_000, 25_000, 25_000];
        for (const increment of tokenIncrements) {
            totalTokens += increment;
            const result = evaluateTokenGuard(totalTokens, guardTriggered);

            if (result === 'soft_warning') {
                events.push(`soft@${totalTokens}`);
                // In production code, guardTriggered is NOT set here — it's only
                // set on hard_kill. The soft warning fires once per evaluation.
            }
            if (result === 'hard_kill') {
                events.push(`kill@${totalTokens}`);
                guardTriggered = true;
                break; // Session is killed
            }
        }

        // Turn 1: 20k → none
        // Turn 2: 35k → none
        // Turn 3: 55k → soft warning (≥50k)
        // Turn 4: 80k → soft warning again (guardTriggered is still false)
        // Turn 5: 105k → hard kill (≥100k)
        expect(events).toEqual([
            'soft@55000',
            'soft@80000',
            'kill@105000',
        ]);
    });

    it('simulates error recovery resetting the counter', () => {
        let consecutiveErrors = 0;
        const statusSequence = ['error', 'error', 'error', 'success', 'error', 'error'];
        let killed = false;

        for (const status of statusSequence) {
            if (status === 'error') {
                consecutiveErrors++;
            } else {
                consecutiveErrors = 0; // Reset on success — matches production logic
            }

            if (evaluateErrorGuard(consecutiveErrors)) {
                killed = true;
                break;
            }
        }

        // 3 errors → reset → 2 errors = never hits 8
        expect(killed).toBe(false);
        expect(consecutiveErrors).toBe(2);
    });

    it('simulates 8 consecutive errors triggering the kill', () => {
        let consecutiveErrors = 0;
        let killed = false;

        for (let i = 0; i < 10; i++) {
            consecutiveErrors++;
            if (evaluateErrorGuard(consecutiveErrors)) {
                killed = true;
                break;
            }
        }

        expect(killed).toBe(true);
        expect(consecutiveErrors).toBe(MAX_CONSECUTIVE_ERRORS);
    });
});
