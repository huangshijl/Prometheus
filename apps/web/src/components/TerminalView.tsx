import clsx from "clsx";
import { Brush, Keyboard, Square } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { isTouchPrimary } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { terminalIds, useStore, type WorkbenchTab } from "../lib/store.ts";
import { XtermTerminal } from "./XtermTerminal.tsx";

const M = defineMessages({
	zh: {
		prompt: "输入命令，回车执行（Tab 补全 · ^C 中断）",
		interrupt: "中断当前命令（Ctrl+C）",
		clear: "清屏（Ctrl+L）",
		restart: "重新打开终端",
		ended: "终端已关闭或服务已重启。",
		keys: "快捷键栏",
		complete: "补全路径（Tab）",
		prev: "上一条命令（↑）",
		next: "下一条命令（↓）",
	},
	en: {
		prompt: "Type a command, Enter to run (Tab completes, ^C interrupts)",
		interrupt: "Interrupt the running command (Ctrl+C)",
		clear: "Clear (Ctrl+L)",
		restart: "Reopen terminal",
		ended: "The terminal was closed or the service restarted.",
		keys: "Key bar",
		complete: "Complete path (Tab)",
		prev: "Previous command (↑)",
		next: "Next command (↓)",
	},
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escape sequences
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const clean = (t: string) => t.replace(ANSI, "").replace(/\r/g, "");
const KEEP_CHARS = 300_000;

interface ReadResult {
	data: string;
	next: number;
	alive: boolean;
}

interface Completion {
	label: string;
	insert: string;
	dir: boolean;
}

/** Polling must stay quiet: a toast every few hundred milliseconds would bury the screen. */
const quiet = <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
	const client = useStore.getState().client;
	if (!client) return Promise.reject(new Error("offline"));
	return client.rpc("plugin.call", { plugin: "terminal", method, params }) as Promise<T>;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The word the caret is in, as the shell would see it: everything back to the last blank. */
const wordStart = (value: string, at: number) => at - (/\S*$/.exec(value.slice(0, at))?.[0].length ?? 0);

export function PipeTerminal({ tab }: { tab: Extract<WorkbenchTab, { kind: "terminal" }> }) {
	const t = useT(M);
	const [text, setText] = useState("");
	const [alive, setAlive] = useState(true);
	const [lost, setLost] = useState(false);
	const [epoch, setEpoch] = useState(0);
	const [line, setLine] = useState("");
	const [cands, setCands] = useState<Completion[]>([]);
	// A phone has no Tab, no Ctrl and no arrow keys at all, so the keys a terminal needs live on screen instead.
	const [pad, setPad] = useState(() => isTouchPrimary());
	const history = useRef<string[]>([]);
	const cursor = useRef(-1);
	const sid = useRef<string | undefined>(terminalIds.get(tab.id));
	const input = useRef<HTMLInputElement>(null);
	const screen = useRef<HTMLPreElement>(null);
	const stick = useRef(true);

	// The shell lives on the server, so switching tabs only stops polling; coming back replays its output.
	// biome-ignore lint/correctness/useExhaustiveDependencies: epoch restarts the loop on purpose
	useEffect(() => {
		let dead = false;
		let since = 0;
		setLost(false);
		setText("");
		void (async () => {
			try {
				if (!sid.current) {
					const r = await quiet<{ id: string }>("open", { cwd: tab.cwd });
					sid.current = r.id;
					terminalIds.set(tab.id, r.id);
				}
				while (!dead) {
					const r = await quiet<ReadResult>("read", { id: sid.current, since });
					since = r.next;
					if (r.data) setText((old) => (old + clean(r.data)).slice(-KEEP_CHARS));
					setAlive(r.alive);
					await new Promise((res) => setTimeout(res, r.data ? 120 : 400));
				}
			} catch (e) {
				if (dead) return;
				sid.current = undefined;
				terminalIds.delete(tab.id);
				setText((old) => `${old}\n[${message(e)}]\n`);
				setLost(true);
			}
		})();
		return () => {
			dead = true;
		};
	}, [tab.id, tab.cwd, epoch]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the output grows
	useEffect(() => {
		const el = screen.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [text]);

	const send = (value: string) => {
		if (!sid.current) return;
		void quiet("run", { id: sid.current, line: value }).catch((e) => setText((old) => `${old}\n[${message(e)}]\n`));
	};
	const interrupt = () => {
		if (sid.current) void quiet("interrupt", { id: sid.current }).catch(() => undefined);
	};
	const reopen = () => {
		if (sid.current) void quiet("close", { id: sid.current }).catch(() => undefined);
		sid.current = undefined;
		terminalIds.delete(tab.id);
		setAlive(true);
		setEpoch((n) => n + 1);
	};

	const recall = (dir: -1 | 1) => {
		const h = history.current;
		if (!h.length) return;
		if (dir < 0) cursor.current = cursor.current < 0 ? h.length - 1 : Math.max(0, cursor.current - 1);
		else if (cursor.current >= 0) cursor.current = cursor.current + 1 >= h.length ? -1 : cursor.current + 1;
		setLine(cursor.current < 0 ? "" : (h[cursor.current] ?? ""));
	};

	/** Put `insert` in place of the word at the caret, keeping whatever followed it. */
	const spliceWord = (insert: string, keepList: boolean) => {
		const at = input.current?.selectionStart ?? line.length;
		const start = wordStart(line, at);
		setLine(line.slice(0, start) + insert + line.slice(at));
		const caret = start + insert.length;
		if (!keepList) setCands([]);
		requestAnimationFrame(() => {
			const el = input.current;
			if (!el) return;
			el.focus();
			el.setSelectionRange(caret, caret);
		});
	};

	const complete = async () => {
		if (!sid.current) return;
		const at = input.current?.selectionStart ?? line.length;
		const word = line.slice(wordStart(line, at), at);
		if (!word) return;
		const res = await quiet<{ items: Completion[]; common: string }>("complete", { id: sid.current, prefix: word }).catch(() => undefined);
		if (!res?.items.length) return;
		// One match is the answer; several only fill in what they share and offer the rest to tap.
		const grown = res.items.length === 1 ? (res.items[0]?.insert ?? word) : res.common;
		if (grown.length > word.length) spliceWord(grown, res.items.length > 1);
		if (res.items.length > 1) setCands(res.items);
	};

	const launch = () => {
		const value = line.trim();
		if (!value) return;
		history.current.push(line);
		cursor.current = -1;
		send(line);
		setLine("");
		setCands([]);
		stick.current = true;
	};

	return (
		<div className="flex h-full flex-col bg-ink-950" onClick={() => !window.getSelection()?.toString() && input.current?.focus()}>
			<div className="flex shrink-0 items-center gap-2 border-b hairline px-3 py-1.5 text-xs">
				<span className="min-w-0 flex-1 truncate font-mono text-ink-400" title={tab.cwd}>
					{tab.cwd}
				</span>
				<button
					type="button"
					onClick={() => {
						setPad(!pad);
						setCands([]);
					}}
					aria-pressed={pad}
					className={clsx("grid size-6 place-items-center rounded hover:bg-ink-800", pad ? "text-ember-300" : "text-ink-400 hover:text-ink-100")}
					title={t("keys")}
				>
					<Keyboard className="size-3.5" />
				</button>
				<button type="button" onClick={interrupt} disabled={!alive || lost} className="grid size-6 place-items-center rounded text-ink-400 hover:bg-ink-800 hover:text-rose-400 disabled:opacity-40" title={t("interrupt")}>
					<Square className="size-3.5" />
				</button>
				<button
					type="button"
					onClick={() => {
						setText("");
						setCands([]);
					}}
					className="grid size-6 place-items-center rounded text-ink-400 hover:bg-ink-800 hover:text-ink-100"
					title={t("clear")}
				>
					<Brush className="size-3.5" />
				</button>
			</div>
			<pre
				ref={screen}
				onScroll={(e) => {
					const el = e.currentTarget;
					stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
				}}
				className="min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[12px] leading-5 text-ink-200"
			>
				{text}
			</pre>
			{lost || !alive ? (
				<div className="flex shrink-0 items-center gap-2 border-t hairline px-3 py-2 text-xs text-ink-400">
					<span className="flex-1">{t("ended")}</span>
					<button type="button" onClick={reopen} className="rounded-md bg-ink-800 px-2.5 py-1 text-ink-200 hover:bg-ink-700">
						{t("restart")}
					</button>
				</div>
			) : (
				<>
					{cands.length > 0 && (
						<div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t hairline bg-ink-900/40 px-2 py-1.5">
							{cands.map((c) => (
								<button
									key={c.insert}
									type="button"
									onClick={() => spliceWord(c.insert, false)}
									className={clsx("shrink-0 rounded-md px-2 py-1 font-mono text-[11px] hover:bg-ink-700", c.dir ? "bg-ink-800 text-sky-300" : "bg-ink-800 text-ink-300")}
								>
									{c.label}
								</button>
							))}
						</div>
					)}
					{pad && (
						<div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t hairline px-2 py-1.5">
							<Key title={t("interrupt")} onPress={interrupt}>
								^C
							</Key>
							<Key title={t("complete")} onPress={() => void complete()}>
								Tab
							</Key>
							<Key
								title={t("clear")}
								onPress={() => {
									setText("");
									setCands([]);
								}}
							>
								^L
							</Key>
							<Key title={t("prev")} onPress={() => recall(-1)}>
								↑
							</Key>
							<Key title={t("next")} onPress={() => recall(1)}>
								↓
							</Key>
						</div>
					)}
					<form
						className="flex shrink-0 items-center gap-2 border-t hairline px-3 py-2"
						onSubmit={(e) => {
							e.preventDefault();
							launch();
						}}
					>
						<span className="font-mono text-xs text-ember-400">&gt;</span>
						<input
							ref={input}
							// biome-ignore lint/a11y/noAutofocus: opening the terminal means typing in it
							autoFocus
							value={line}
							onChange={(e) => {
								setLine(e.target.value);
								setCands([]);
							}}
							onKeyDown={(e) => {
								if (e.key === "Tab") {
									e.preventDefault();
									void complete();
								} else if (e.key === "c" && e.ctrlKey && !window.getSelection()?.toString()) {
									e.preventDefault();
									interrupt();
								} else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
									if (!history.current.length) return;
									e.preventDefault();
									recall(e.key === "ArrowUp" ? -1 : 1);
								}
							}}
							placeholder={t("prompt")}
							spellCheck={false}
							autoComplete="off"
							autoCapitalize="off"
							autoCorrect="off"
							className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink-100 outline-none placeholder:text-ink-600"
						/>
					</form>
				</>
			)}
		</div>
	);
}

/** One key of the on-screen bar: wide enough for a thumb, small enough not to crowd the output. */
function Key({ title, onPress, children }: { title: string; onPress: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			title={title}
			aria-label={title}
			onClick={onPress}
			className="shrink-0 rounded-md bg-ink-800 px-3 py-1 font-mono text-[11px] text-ink-200 transition-colors hover:bg-ink-700 active:bg-ink-600"
		>
			{children}
		</button>
	);
}

/** Whether this host can hand out a real terminal. Asked once: it depends on the platform, not on the session. */
let ptyCapable: boolean | undefined;
const detectPty = async (): Promise<boolean> => {
	if (ptyCapable !== undefined) return ptyCapable;
	const r = await quiet<{ pty: boolean }>("caps").catch(() => undefined);
	// A failed probe says nothing about the host (still connecting); only a real answer is remembered.
	if (!r) return false;
	ptyCapable = r.pty;
	return ptyCapable;
};

/**
 * The terminal tab. Where the server can hand out a pseudo-terminal (Linux, Android) the view is xterm.js and a shell
 * behaves like a shell; where it cannot (Windows) the pipe version keeps the line editor and its key bar instead.
 */
export function TerminalView({ tab }: { tab: Extract<WorkbenchTab, { kind: "terminal" }> }) {
	const [pty, setPty] = useState<boolean | null>(null);
	useEffect(() => {
		let dead = false;
		void detectPty().then((ok) => !dead && setPty(ok));
		return () => {
			dead = true;
		};
	}, []);
	if (pty === null) return <div className="grid h-full place-items-center bg-ink-950 text-xs text-ink-500">…</div>;
	return pty ? <XtermTerminal tab={tab} /> : <PipeTerminal tab={tab} />;
}
