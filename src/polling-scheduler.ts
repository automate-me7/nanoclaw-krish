/**
 * Smart Polling Scheduler for NanoClaw
 * Time-of-day-aware polling intervals for message checking.
 * Daytime (7am-8pm): every 5 min, Evening (8pm-11pm): every 30 min,
 * Overnight (11pm-7am): every 2 hrs.
 */

import {
  DAYTIME_POLL_INTERVAL,
  EVENING_POLL_INTERVAL,
  OVERNIGHT_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { logger } from './logger.js';

/**
 * Get the polling interval based on the current hour.
 * Uses the configured timezone.
 */
export function getPollingInterval(hour?: number): number {
  const currentHour =
    hour ??
    new Date().toLocaleString('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: TIMEZONE,
    });
  const h =
    typeof currentHour === 'string' ? parseInt(currentHour, 10) : currentHour;

  if (h >= 7 && h < 20) {
    return DAYTIME_POLL_INTERVAL; // 7am-8pm: 5 min
  } else if (h >= 20 && h < 23) {
    return EVENING_POLL_INTERVAL; // 8pm-11pm: 30 min
  } else {
    return OVERNIGHT_POLL_INTERVAL; // 11pm-7am: 2 hrs
  }
}

/**
 * Get a human-readable label for the current polling tier.
 */
export function getPollingTier(hour?: number): string {
  const currentHour =
    hour ??
    parseInt(
      new Date().toLocaleString('en-US', {
        hour: 'numeric',
        hour12: false,
        timeZone: TIMEZONE,
      }),
      10,
    );
  const h =
    typeof currentHour === 'number' ? currentHour : parseInt(currentHour, 10);

  if (h >= 7 && h < 20) return 'daytime';
  if (h >= 20 && h < 23) return 'evening';
  return 'overnight';
}

export interface PollingSchedulerDeps {
  onPoll: () => Promise<void>;
}

let pollingRunning = false;

/**
 * Start the smart polling scheduler.
 * Recalculates interval on each tick based on time of day.
 */
export function startPollingScheduler(deps: PollingSchedulerDeps): void {
  if (pollingRunning) {
    logger.debug('Polling scheduler already running, skipping duplicate start');
    return;
  }
  pollingRunning = true;

  const tier = getPollingTier();
  const interval = getPollingInterval();
  logger.info(
    { tier, intervalMs: interval },
    'Smart polling scheduler started',
  );

  const scheduleTick = () => {
    const currentInterval = getPollingInterval();
    const currentTier = getPollingTier();

    setTimeout(async () => {
      try {
        await deps.onPoll();
      } catch (err) {
        logger.error({ err }, 'Error in smart polling tick');
      }

      const nextInterval = getPollingInterval();
      const nextTier = getPollingTier();
      if (nextTier !== currentTier) {
        logger.info(
          { from: currentTier, to: nextTier, intervalMs: nextInterval },
          'Polling tier changed',
        );
      }

      scheduleTick();
    }, currentInterval);
  };

  scheduleTick();
}

/** @internal - for tests only. */
export function _resetPollingSchedulerForTests(): void {
  pollingRunning = false;
}
