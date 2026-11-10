/**
 * Whether an assistant turn is the one currently being generated.
 *
 * A new send sets `streaming` before the next user message is in the transcript, so the
 * previous reply is still lastIndex (or still looks like it is awaiting the next model
 * call). Treating that finished turn as live unfolds every collapsed step and the
 * conversation jumps.
 */
export function assistantTurnLive(input: {
	streaming: boolean;
	/** Fresh prompt echoed as a pending bubble; not yet a user message in `messages`. */
	pending: boolean;
	lastInGroup: number;
	lastIndex: number;
	lastNonResult: number;
	stopReason?: string;
}): boolean {
	if (!input.streaming) return false;
	// The next prompt is on screen as a placeholder: no existing turn belongs to this run yet.
	if (input.pending) return false;
	const awaitingNext = input.lastInGroup < input.lastIndex && input.lastNonResult === input.lastInGroup;
	if (awaitingNext) return true;
	if (input.lastInGroup !== input.lastIndex) return false;
	// Completed reply that is still last while the next run has started (or has not produced tokens yet).
	if (input.stopReason && input.stopReason !== "pending" && input.stopReason !== "toolUse") return false;
	return true;
}

export type AssistantBlockLike = { type: string; text?: string; thinking?: string };
export type AssistantMessageLike = { stopReason?: string; content: AssistantBlockLike[] };

/**
 * `group` index of the message that owns the turn's error box.
 *
 * A turn that keeps failing - a rate-limited provider retries six times - appends one assistant message per
 * attempt and every one of them carries the same error. Rendering each box buries the conversation under
 * identical red frames, so only the last attempt keeps one and every new failure replaces the one before it.
 */
export function lastErrorAt(group: readonly { stopReason?: string; errorMessage?: string }[]): number {
	for (let i = group.length - 1; i >= 0; i--) if (group[i]?.stopReason === "error" && group[i]?.errorMessage) return i;
	return -1;
}

/**
 * How a finished assistant turn is shown: intermediate tools/thinking fold away, one
 * closing answer stays. History pages often end on a tool call (no trailing text on
 * the last message); those must still fold, or lazy-loaded turns explode open.
 */
export function turnPresentation(group: AssistantMessageLike[], live: boolean): {
	fold: boolean;
	/** `group` index of the message that holds the visible answer. */
	finalMessage: number;
	/** Block index of that answer, or -1 when the turn has no text to keep visible. */
	finalAt: number;
	steps: number;
} {
	const last = group.length - 1;
	let finalMessage = Math.max(0, last);
	let finalAt = -1;
	const failed = group[last] && (group[last].stopReason === "error" || group[last].stopReason === "aborted");
	const from = failed ? last : 0;
	outer: for (let g = last; g >= from; g--) {
		const content = group[g]?.content ?? [];
		for (let i = content.length - 1; i >= 0; i--) {
			const b = content[i];
			if (b?.type === "text" && b.text?.trim()) {
				finalMessage = g;
				finalAt = i;
				break outer;
			}
		}
	}
	let steps = 0;
	group.forEach((msg, gi) => {
		msg.content.forEach((b, i) => {
			if (!b || (gi === finalMessage && i === finalAt)) return;
			if (b.type === "toolCall" || (b.type === "thinking" && b.thinking?.trim()) || (b.type === "text" && b.text?.trim())) steps++;
		});
	});
	return { fold: !live && !failed && steps > 0, finalMessage, finalAt, steps };
}
