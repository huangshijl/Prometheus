// api-error-retry — keep an upstream failure from ending the turn.
//
// PI's own retry gives up after a handful of attempts, which on a flaky link (or a gateway that drops a long
// response) leaves the whole run dead. This extension resends the exact same request until it goes through, and keeps
// the failed assistant turn out of the model's context so the attempts do not pile error messages onto the prompt.
//
// Both mechanisms are the ones PI's own auto-retry uses:
//  1. `context` drops failed assistant turns from the *request* only. PI restores the transcript afterwards, so
//     nothing is written to the session and the user does not see the attempt disappear.
//  2. `agent_before_settle` appends a `context_edit` entry with `replacement: null`, which durably omits the failed
//     turn from the model projection, so the truncation also survives a restart or a resume.
//
// The extension registers no tools, no commands and no prompt text, so it adds nothing to the model context by
// itself, and both the switch and the pacing are read on every event: changing them applies to running sessions too.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type RetryTuning, retryDelayMs } from "./retry-tuning.ts";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

/** The fields of an assistant turn this extension cares about. */
interface AnyMessage {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
}

/** An assistant turn the provider ended with an error. */
function isFailedAssistant(message: unknown): message is AnyMessage & { role: "assistant"; stopReason: "error" } {
	const m = message as AnyMessage | null | undefined;
	return !!m && m.role === "assistant" && m.stopReason === "error";
}

/** Failed turns that carry tool calls must stay: their tool results are still in the transcript. */
function hasToolCall(message: AnyMessage): boolean {
	return Array.isArray(message.content) && message.content.some((b) => (b as { type?: string } | null)?.type === "toolCall");
}

/**
 * Context-window overflow is not an upstream outage: retrying the same oversized request can never succeed.
 * PI recovers from it with compaction, so leave it alone.
 */
function isContextOverflow(message: AnyMessage): boolean {
	const text = String(message.errorMessage ?? "");
	return /context[ _-]?(window|length|limit)|too (long|many tokens)|maximum context|prompt is too long|exceeds? (the )?(maximum|context)|input is too large|token limit/i.test(text);
}

/** Failed assistant turns we are allowed to drop from the model request. */
function isDroppable(message: unknown): boolean {
	return isFailedAssistant(message) && !hasToolCall(message as AnyMessage) && !isContextOverflow(message as AnyMessage);
}

/**
 * The extension factory. `enabled` and `tuning` are live getters (not snapshots) so the settings switch and the retry
 * pacing take effect without reloading the session's extensions.
 */
export function apiErrorRetryExtension(enabled: () => boolean, tuning: () => RetryTuning): (pi: ExtensionAPI) => void {
	return (pi) => {
		// 1) Request-local truncation — the failed turn never reaches the model. Runs before every LLM call and is
		//    restored by PI afterwards, so it leaves no trace in the transcript and no entry in the session.
		pi.on("context", (event) => {
			if (!enabled()) return;
			const messages = event.messages;
			if (!messages?.length) return;
			const kept = messages.filter((m) => !isDroppable(m));
			if (kept.length === messages.length) return;
			return { messages: kept };
		});

		// 2) Durable truncation + retry at the last actionable boundary. `agent_before_settle` only runs once PI's own
		//    automatic retry / compaction / queued continuations are done, so this never fights the built-in loop.
		pi.on("agent_before_settle", async (event, ctx) => {
			if (!enabled()) return;
			// Only a failed run is retried. Completed and user-aborted runs are final.
			if (event.outcome !== "error") return;
			if (ctx.signal?.aborted) return;

			const projected = event.context?.contextEntries ?? [];

			// Find the newest failed assistant turn that is still in the projection.
			let targetId: string | undefined;
			let failed: AnyMessage | undefined;
			for (let i = projected.length - 1; i >= 0 && !targetId; i--) {
				const entry = projected[i];
				const messages = entry?.messages ?? [];
				for (let j = messages.length - 1; j >= 0; j--) {
					const message = messages[j];
					if (!isFailedAssistant(message)) continue;
					// Already omit-able? Only then can we truncate and continue.
					if (!isDroppable(message)) return;
					failed = message;
					targetId = entry?.sourceEntry?.id;
					break;
				}
			}

			if (!targetId) {
				// Nothing persisted to truncate (e.g. the failure happened before the message was stored). Continue only
				// if the transcript still ends on a user/toolResult message, which is what the provider expects.
				const last = event.context?.contextMessages?.at(-1) as AnyMessage | undefined;
				if (!last || (last.role !== "user" && last.role !== "toolResult")) return;
			}

			if (failed && isContextOverflow(failed)) return;

			await sleep(retryDelayMs(tuning()), ctx.signal);
			if (ctx.signal?.aborted) return;

			return {
				entries: targetId ? [{ type: "context_edit" as const, targetId, replacement: null }] : undefined,
				continue: true,
			};
		});
	};
}
