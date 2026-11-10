// Retry pacing: the one-sided jitter that made "1000 ms + 20%" mean 1000..1200 ms rather than 800..1200, plus the
// clamps that keep a hand-typed value usable. The numbers live in Prometheus' config, never in PI's settings.json.
import { describe, expect, it } from "vitest";
import { clampRetryInterval, clampRetryJitter, retryDelayMs } from "../src/agent/pi/retry-tuning.ts";

describe("retry pacing", () => {
	it("never waits less than the base interval", () => {
		const tuning = { intervalMs: 1000, jitterPercent: 20 };
		expect(retryDelayMs(tuning, () => 0)).toBe(1000);
		expect(retryDelayMs(tuning, () => 0.5)).toBe(1100);
		// The ceiling is 1.2x, and no draw can land below the base.
		expect(retryDelayMs(tuning, () => 0.999)).toBe(1200);
		expect(retryDelayMs({ intervalMs: 800, jitterPercent: 0 }, () => 0.9)).toBe(800);
	});

	it("keeps the interval at half a second or more and the jitter within 0-100%", () => {
		expect(clampRetryInterval(120)).toBe(500);
		expect(clampRetryInterval(12_345.6)).toBe(12_346);
		expect(clampRetryInterval(Number.NaN)).toBe(1000);
		expect(clampRetryInterval(10 * 60_000)).toBe(60_000);
		expect(clampRetryJitter(-5)).toBe(0);
		expect(clampRetryJitter(250)).toBe(100);
	});
});
