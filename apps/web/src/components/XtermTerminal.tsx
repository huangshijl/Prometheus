import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import clsx from "clsx";
import { Brush, Keyboard, Square } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { isTouchPrimary } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { usePrefs } from "../lib/prefs.ts";
import { terminalIds, useStore, type WorkbenchTab } from "../lib/store.ts";

const M = defineMessages({
	zh: {
		opening: "正在打开终端…",
		interrupt: "中断（Ctrl+C）",
		clear: "清屏（Ctrl+L）",
		keys: "快捷键栏",
		ctrl: "Ctrl",
		ctrlHint: "按住 Ctrl：下一次按键会变成组合键",
		ended: "终端已关闭或服务已重启。",
		restart: "重新打开终端",
	},
	en: {
		opening: "Opening the terminal…",
		interrupt: "Interrupt (Ctrl+C)",
		clear: "Clear (Ctrl+L)",
		keys: "Key bar",
		ctrl: "Ctrl",
		ctrlHint: "Ctrl is held for the next key",
		ended: "The terminal was closed or the service restarted.",
		restart: "Reopen terminal",
	},
});

const quiet = <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
	const client = useStore.getState().client;
	if (!client) return Promise.reject(new Error("offline"));
	return client.rpc("plugin.call", { plugin: "terminal", method, params }) as Promise<T>;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The palette follows the app's own variables, so a light theme or another skin does not leave a dark hole here. */
function readTheme(): ITheme {
	const css = getComputedStyle(document.documentElement);
	const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
	const ink = (n: number, fallback: string) => v(`--color-ink-${n}`, fallback);
	return {
		background: ink(950, "#1c1814"),
		foreground: ink(200, "#d7ccbf"),
		cursor: v("--color-ember-400", "#ff7a2f"),
		cursorAccent: ink(950, "#1c1814"),
		selectionBackground: ink(700, "#443c34"),
		black: ink(900, "#242019"),
		red: "#e5484d",
		green: v("--color-moss-400", "#9bc77a"),
		yellow: v("--color-ember-200", "#ffc061"),
		blue: v("--color-sky-400", "#7fb2d9"),
		magenta: "#b17bd1",
		cyan: "#5fb8ad",
		white: ink(200, "#d7ccbf"),
		brightBlack: ink(500, "#7a6d62"),
		brightRed: "#ff6369",
		brightGreen: "#b3dd93",
		brightYellow: "#ffd9a0",
		brightBlue: "#a3cfe9",
		brightMagenta: "#cda6e8",
		brightCyan: "#8ad4cb",
		brightWhite: ink(100, "#e9e0d5"),
	};
}

/** What a key bar sends: the same bytes a keyboard would, which the terminal hands to the shell as-is. */
const KEY = {
	escape: "\x1b",
	tab: "\t",
	ctrlC: "\x03",
	ctrlD: "\x04",
	ctrlL: "\x0c",
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	home: "\x1b[H",
	end: "\x1b[F",
} as const;

/**
 * The terminal proper: a real pseudo-terminal on the server (see `ptySpec`) drawn by xterm.js, so ^C is a signal, Tab
 * completes, arrows scroll through history and full-screen programs work.
 *
 * Output arrives as a plugin stream rather than by polling, and each message carries its absolute offset, so a client
 * that joined late (or dropped a frame) can pull the gap with `read` instead of showing a torn screen.
 */
export function XtermTerminal({ tab }: { tab: Extract<WorkbenchTab, { kind: "terminal" }> }) {
	const t = useT(M);
	const client = useStore((s) => s.client);
	const conn = useStore((s) => s.conn);
	const themeMode = usePrefs((p) => p.theme);
	const host = useRef<HTMLDivElement>(null);
	const term = useRef<Terminal | null>(null);
	const fitAddon = useRef<FitAddon | null>(null);
	const session = useRef({ id: "", topic: "", offset: 0, primed: false });
	const [status, setStatus] = useState<"opening" | "ready" | "lost">("opening");
	const [error, setError] = useState("");
	/** Bumped to open a fresh shell after the old one died. */
	const [epoch, setEpoch] = useState(0);
	// A phone has no Esc, no Tab, no Ctrl and no arrows: they live on screen, and here they actually reach the shell.
	const [pad, setPad] = useState(() => isTouchPrimary());
	const [ctrl, setCtrlState] = useState(false);
	const ctrlHeld = useRef(false);
	const setCtrl = (held: boolean) => {
		ctrlHeld.current = held;
		setCtrlState(held);
	};

	const send = useCallback((data: string) => {
		const id = session.current.id;
		if (!id) return;
		void quiet("write", { id, data }).catch(() => undefined);
	}, []);

	/** Fill a gap the stream left: the buffer on the server still has it. */
	const pull = useCallback(async () => {
		const s = session.current;
		if (!s.id) return;
		const r = await quiet<{ data: string; next: number }>("read", { id: s.id, since: s.offset }).catch(() => undefined);
		if (!r || session.current.id !== s.id) return;
		s.offset = r.next;
		if (r.data) term.current?.write(r.data);
	}, []);

	const feed = useCallback(
		(from: number, text: string) => {
			const s = session.current;
			// Before the first read there is no offset to align against; that read carries everything anyway.
			if (!s.id || !s.primed) return;
			let at = from;
			let chunk = text;
			// Already on screen (the initial read overlapped the stream): drop the part we have.
			if (at < s.offset) {
				chunk = chunk.slice(s.offset - at);
				at = s.offset;
			}
			if (!chunk) return;
			// A message went missing; bring the buffer over instead of leaving a hole in the screen.
			if (at > s.offset) {
				void pull();
				return;
			}
			s.offset = at + chunk.length;
			term.current?.write(chunk);
		},
		[pull],
	);

	// The terminal itself: one per mount. Its palette is refreshed below rather than rebuilt.
	useEffect(() => {
		const el = host.current;
		if (!el) return;
		const xterm = new Terminal({
			theme: readTheme(),
			fontFamily: '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
			fontSize: isTouchPrimary() ? 13 : 12,
			lineHeight: 1.2,
			cursorBlink: true,
			scrollback: 5000,
			macOptionIsMeta: true,
			allowProposedApi: true,
		});
		const fit = new FitAddon();
		xterm.loadAddon(fit);
		xterm.open(el);
		// A one-column terminal would make the shell rewrite every line; the fit is only a guess before layout settles.
		try {
			fit.fit();
		} catch {
			/* the container has no size yet */
		}
		term.current = xterm;
		fitAddon.current = fit;

		const data = xterm.onData((input) => {
			if (ctrlHeld.current) {
				setCtrl(false);
				// Ctrl only transforms a single character; anything longer (a paste) goes through untouched.
				if (input.length === 1) {
					const code = input.toLowerCase().charCodeAt(0);
					// a-z map to 1-26, and the bracket family to 27-31, exactly as a terminal would send them.
					if (code >= 97 && code <= 122) return send(String.fromCharCode(code - 96));
					if (input === " ") return send("\x00");
					if (input === "[") return send("\x1b");
					if (input === "\\") return send("\x1c");
					if (input === "]") return send("\x1d");
				}
			}
			send(input);
		});

		const ro = new ResizeObserver(() => {
			try {
				fit.fit();
			} catch {
				/* hidden for a moment */
			}
		});
		ro.observe(el);

		return () => {
			ro.disconnect();
			data.dispose();
			xterm.dispose();
			term.current = null;
			fitAddon.current = null;
		};
	}, [send]);

	// A theme or skin change repaints the palette in place: the shell keeps running.
	useEffect(() => {
		const xterm = term.current;
		if (xterm) xterm.options.theme = readTheme();
	}, [themeMode]);

	// Open (or reopen) the session and follow its stream. A tab that still has a live shell on the server is replayed
	// from its buffer instead of starting a new one, so switching tabs costs nothing.
	useEffect(() => {
		if (!client || conn !== "open") return;
		let dead = false;
		let off: (() => void) | undefined;
		let unwatch: (() => void) | undefined;
		session.current = { id: "", topic: "", offset: 0, primed: false };
		term.current?.reset();
		setStatus("opening");
		setError("");

		void (async () => {
			try {
				// The size the terminal wrapped to is the size the shell should assume; it cannot be changed later.
				const cols = Math.max(20, term.current?.cols ?? 80);
				const rows = Math.max(5, term.current?.rows ?? 24);
				let id = terminalIds.get(tab.id);
				if (!id) {
					const opened = await quiet<{ id: string }>("open", { cwd: tab.cwd, cols, rows });
					if (dead) return;
					id = opened.id;
					terminalIds.set(tab.id, id);
				}
				const topic = `pty:${id}`;
				session.current = { id, topic, offset: 0, primed: false };
				off = client.onFrame((f) => {
					if (f.type !== "plugin.event" || f.plugin !== "terminal" || f.topic !== topic) return;
					const msg = f.data as { k?: string; from?: number; text?: string };
					if (msg.k === "data" && typeof msg.from === "number" && typeof msg.text === "string") feed(msg.from, msg.text);
				});
				unwatch = client.watch("terminal", topic);
				// Everything the shell printed before the stream was attached.
				const all = await quiet<{ data: string; next: number }>("read", { id, since: 0 });
				if (dead) return;
				session.current.offset = all.next;
				session.current.primed = true;
				if (all.data) term.current?.write(all.data);
				setStatus("ready");
			} catch (e) {
				if (dead) return;
				terminalIds.delete(tab.id);
				setError(message(e));
				setStatus("lost");
			}
		})();

		return () => {
			dead = true;
			off?.();
			unwatch?.();
		};
	}, [client, conn, tab.id, tab.cwd, epoch, feed]);

	const reopen = () => {
		const id = session.current.id;
		if (id) void quiet("close", { id }).catch(() => undefined);
		terminalIds.delete(tab.id);
		session.current = { id: "", topic: "", offset: 0, primed: false };
		term.current?.reset();
		setStatus("opening");
		setError("");
		setEpoch((n) => n + 1);
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-ink-950">
			<div className="flex shrink-0 items-center gap-2 border-b hairline px-3 py-1.5 text-xs">
				<span className="min-w-0 flex-1 truncate font-mono text-ink-400" title={tab.cwd}>
					{tab.cwd}
				</span>
				<button
					type="button"
					onClick={() => setPad(!pad)}
					aria-pressed={pad}
					className={clsx("grid size-6 place-items-center rounded hover:bg-ink-800", pad ? "text-ember-300" : "text-ink-400 hover:text-ink-100")}
					title={t("keys")}
				>
					<Keyboard className="size-3.5" />
				</button>
				<button type="button" onClick={() => send(KEY.ctrlC)} disabled={status !== "ready"} className="grid size-6 place-items-center rounded text-ink-400 hover:bg-ink-800 hover:text-rose-400 disabled:opacity-40" title={t("interrupt")}>
					<Square className="size-3.5" />
				</button>
				<button type="button" onClick={() => send(KEY.ctrlL)} disabled={status !== "ready"} className="grid size-6 place-items-center rounded text-ink-400 hover:bg-ink-800 hover:text-ink-100 disabled:opacity-40" title={t("clear")}>
					<Brush className="size-3.5" />
				</button>
			</div>

			<div ref={host} className="min-h-0 flex-1 overflow-hidden px-2 py-1" onClick={() => term.current?.focus()} />

			{status === "lost" && (
				<div className="flex shrink-0 items-center gap-2 border-t hairline px-3 py-2 text-xs text-ink-400">
					<span className="min-w-0 flex-1 truncate" title={error}>
						{t("ended")}
						{error ? ` ${error}` : ""}
					</span>
					<button type="button" onClick={reopen} className="shrink-0 rounded-md bg-ink-800 px-2.5 py-1 text-ink-200 hover:bg-ink-700">
						{t("restart")}
					</button>
				</div>
			)}

			{pad && status === "ready" && (
				<div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t hairline px-2 py-1.5">
					<Key
						title={t("ctrlHint")}
						onPress={() => setCtrl(!ctrl)}
						className={ctrl ? "bg-ember-500/20 text-ember-200" : undefined}
					>
						{t("ctrl")}
					</Key>
					<Key title="Esc" onPress={() => send(KEY.escape)}>
						Esc
					</Key>
					<Key title="Tab" onPress={() => send(KEY.tab)}>
						Tab
					</Key>
					<Key title="Ctrl+C" onPress={() => send(KEY.ctrlC)}>
						^C
					</Key>
					<Key title="Ctrl+D" onPress={() => send(KEY.ctrlD)}>
						^D
					</Key>
					<Key title="↑" onPress={() => send(KEY.up)}>
						↑
					</Key>
					<Key title="↓" onPress={() => send(KEY.down)}>
						↓
					</Key>
					<Key title="←" onPress={() => send(KEY.left)}>
						←
					</Key>
					<Key title="→" onPress={() => send(KEY.right)}>
						→
					</Key>
					<Key title="Home" onPress={() => send(KEY.home)}>
						Home
					</Key>
					<Key title="End" onPress={() => send(KEY.end)}>
						End
					</Key>
				</div>
			)}
		</div>
	);
}

/** One key of the on-screen bar: a thumb wide, a terminal apart from the next. */
function Key({ title, onPress, className, children }: { title: string; onPress: () => void; className?: string; children: ReactNode }) {
	return (
		<button
			type="button"
			title={title}
			aria-label={title}
			onClick={onPress}
			className={clsx("shrink-0 rounded-md bg-ink-800 px-3 py-1 font-mono text-[11px] text-ink-200 transition-colors hover:bg-ink-700 active:bg-ink-600", className)}
		>
			{children}
		</button>
	);
}
