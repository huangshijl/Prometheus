import { describe, expect, it } from "vitest";
import { cacheRate, clockOf, fmtTokens } from "../src/lib/format.ts";

describe("fmtTokens", () => {
	it("switches units instead of showing 1000k", () => {
		expect(fmtTokens(999)).toBe("999");
		expect(fmtTokens(1500)).toBe("1.5k");
		expect(fmtTokens(999_949)).toBe("999.9k");
		expect(fmtTokens(999_950)).toBe("1m");
		expect(fmtTokens(1_000_000)).toBe("1m");
		expect(fmtTokens(2_340_000)).toBe("2.3m");
	});
});

describe("cacheRate", () => {
	it("is cacheRead share of prompt tokens", () => {
		expect(cacheRate({ input: 100, cacheRead: 300, cacheWrite: 100 })).toBe(60);
		expect(cacheRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
	});
});

describe("clockOf", () => {
	// Local time on purpose: a message is stamped in the reader's own clock, not in UTC.
	const at = new Date(2026, 10, 11, 1, 20, 5).getTime();

	it("shows hours, minutes and seconds below a message", () => {
		expect(clockOf(at)).toBe("01:20:05");
	});

	it("adds the date only where it is asked for", () => {
		expect(clockOf(at, true)).toBe("2026-11-11 01:20:05");
	});

	it("renders nothing for a message with no timestamp", () => {
		expect(clockOf(undefined)).toBe("");
		expect(clockOf(undefined, true)).toBe("");
	});
});
