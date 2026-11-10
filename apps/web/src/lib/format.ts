const trim = (n: number) => n.toFixed(1).replace(/\.0$/, "");

/** Token counts: 999, 1.5k, 999.9k, then 1m (never "1000k"). */
export function fmtTokens(n: number): string {
	const abs = Math.abs(n);
	if (abs < 1000) return String(Math.round(n));
	// 999_950 rounds to "1000.0k" at one decimal, so switch units on the rounded value.
	if (Math.round(abs / 100) / 10 < 1000) return `${trim(n / 1000)}k`;
	if (Math.round(abs / 1e5) / 10 < 1000) return `${trim(n / 1e6)}m`;
	return `${trim(n / 1e9)}b`;
}

/** Share of prompt tokens served from cache; null when no prompt tokens were counted. */
export function cacheRate(t: { input: number; cacheRead: number; cacheWrite: number }): number | null {
	const prompt = t.input + t.cacheRead + t.cacheWrite;
	return prompt > 0 ? (t.cacheRead / prompt) * 100 : null;
}

export const fmtPercent = (p: number | null): string => (p == null ? "—" : `${p.toFixed(p >= 99.95 || p === 0 ? 0 : 1)}%`);

/**
 * Wall clock of a message. Seconds are what tells two replies of the same turn apart, so they are always shown;
 * the date only earns its space on an error, where the question is "when did this fail in the day".
 */
export function clockOf(ts: number | undefined, withDate = false): string {
	if (ts == null) return "";
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	const clock = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	return withDate ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${clock}` : clock;
}
