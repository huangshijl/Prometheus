// Unit tests for the app's retry extension: what it drops from the request, when it decides to retry, and the switch.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { apiErrorRetryExtension } from "../src/agent/pi/api-error-retry.ts";
import { type RetryTuning } from "../src/agent/pi/retry-tuning.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Registers the extension against a stub PI and exposes its handlers. */
function wire(on: () => boolean, tuning: RetryTuning = { intervalMs: 500, jitterPercent: 0 }) {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	apiErrorRetryExtension(on, () => tuning)(pi);
	const run = (event: "context" | "agent_before_settle", payload: unknown) => handlers.get(event)?.(payload, { signal: undefined });
	return { run };
}

const user = { role: "user", content: "question" };
const answer = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hi" }] };
const failed = { role: "assistant", stopReason: "error", errorMessage: "502 upstream", content: [{ type: "text", text: "" }] };
const failedWithTool = { role: "assistant", stopReason: "error", errorMessage: "502 upstream", content: [{ type: "toolCall", id: "t1" }] };
const overflow = { role: "assistant", stopReason: "error", errorMessage: "prompt is too long: 210000 tokens", content: [] };

/** A settle event whose projection ends with the given messages, as PI builds it before the final answer. */
function settleEvent(outcome: string, messages: unknown[]) {
	return { type: "agent_before_settle", outcome, entries: [], continue: false, context: { contextEntries: [{ sourceEntry: { id: "e2" }, messages }], contextMessages: messages } };
}

describe("api-error-retry extension", () => {
	it("drops a failed reply from the request so the retry does not pile errors onto the prompt", () => {
		const { run } = wire(() => true);
		const result = run("context", { type: "context", messages: [user, answer, failed] }) as { messages: unknown[] };
		expect(result.messages).toEqual([user, answer]);
	});

	it("keeps a failed reply that carries a tool call: its results are still in the transcript", () => {
		const { run } = wire(() => true);
		expect(run("context", { type: "context", messages: [user, failedWithTool] })).toBeUndefined();
	});

	it("leaves a context-window overflow alone: retrying the same oversized request cannot succeed", async () => {
		const { run } = wire(() => true);
		expect(run("context", { type: "context", messages: [user, overflow] })).toBeUndefined();
		expect(await run("agent_before_settle", settleEvent("error", [user, overflow]))).toBeUndefined();
	});

	it("retries a failed run and durably omits the failed reply", async () => {
		const { run } = wire(() => true);
		const result = await run("agent_before_settle", settleEvent("error", [user, failed]));
		expect(result).toEqual({ entries: [{ type: "context_edit", targetId: "e2", replacement: null }], continue: true });
	});

	it("does not retry a run that completed, and does not retry one that failed after a tool call", async () => {
		const { run } = wire(() => true);
		expect(await run("agent_before_settle", settleEvent("completed", [user, answer]))).toBeUndefined();
		expect(await run("agent_before_settle", settleEvent("error", [user, failedWithTool]))).toBeUndefined();
	});

	it("does nothing while switched off", async () => {
		const { run } = wire(() => false);
		expect(run("context", { type: "context", messages: [user, failed] })).toBeUndefined();
		expect(await run("agent_before_settle", settleEvent("error", [user, failed]))).toBeUndefined();
	});
});
