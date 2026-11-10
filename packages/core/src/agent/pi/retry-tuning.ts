// Retry pacing for the app's own retry loop (api-error-retry.ts).
//
// The numbers come from Prometheus' own config.json, edited on the settings page: a base interval that never drops
// below half a second, plus a one-sided jitter, so 1000 ms with 20% waits 1000..1200 ms and nothing ever shortens the
// wait. PI's settings.json is deliberately not read here: it carries only the on/off switch for PI's built-in retry.
import {
	DEFAULT_RETRY_INTERVAL_MS,
	DEFAULT_RETRY_JITTER_PERCENT,
	MAX_RETRY_INTERVAL_MS,
	MAX_RETRY_JITTER_PERCENT,
	MIN_RETRY_INTERVAL_MS,
	MIN_RETRY_JITTER_PERCENT,
} from "@prometheus/protocol";

/** How long to wait before resending, and how much longer the wait may randomly become. */
export interface RetryTuning {
	/** Base interval in ms; the shortest possible wait. */
	intervalMs: number;
	/** Upper bound of the extra wait, in percent of `intervalMs`. */
	jitterPercent: number;
}

export function clampRetryInterval(ms: number): number {
	return Number.isFinite(ms) ? Math.min(MAX_RETRY_INTERVAL_MS, Math.max(MIN_RETRY_INTERVAL_MS, Math.round(ms))) : DEFAULT_RETRY_INTERVAL_MS;
}

export function clampRetryJitter(percent: number): number {
	return Number.isFinite(percent) ? Math.min(MAX_RETRY_JITTER_PERCENT, Math.max(MIN_RETRY_JITTER_PERCENT, Math.round(percent))) : DEFAULT_RETRY_JITTER_PERCENT;
}

/** The wait before the next attempt: the base interval plus 0..jitter, never less than the base. */
export function retryDelayMs(tuning: RetryTuning, random: () => number = Math.random): number {
	return Math.round(tuning.intervalMs * (1 + random() * (tuning.jitterPercent / 100)));
}
