import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import clsx from "clsx";
import { Brush, Keyboard, Plus, Square, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { isTouchPrimary } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { usePrefs } from "../lib/prefs.ts";
import { anyMod, DOUBLE_TAP_MS, encodeChar, encodeKey, FIXED, type Held, MODIFIERS, modsOf, parseKeys } from "../lib/terminalKeys.ts";
import { terminalIds, useStore, type WorkbenchTab } from "../lib/store.ts";

const M = defineMessages({
	zh: {
		interrupt: "中断（Ctrl+C）",
		clear: "清屏（Ctrl+L）",
		keys: "快捷键栏",
		ended: "终端已关闭或服务已重启。",
		restart: "重新打开终端",
		holdHint: "双击 Ctrl/Alt/Shift 可以按住不放，再点别的键组成组合",
		add: "自定义按键",
		keyLabel: "显示名",
		keySpec: "按键（如 ^C、\\t、ls）",
		save: "添加",
		cancel: "取消",
	},
	en: {
		interrupt: "Interrupt (Ctrl+C)",
		clear: "Clear (Ctrl+L)",
		keys: "Key bar",
		ended: "The terminal was closed or the service restarted.",
		restart: "Reopen terminal",
		holdHint: "Double-tap Ctrl/Alt/Shift to hold it, then tap another key to combine",
		add: "Custom key",
		keyLabel: "Label",
		keySpec: "Keys (^C, \\t, ls …)",
		save: "Add",
		cancel: "Cancel",
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

interface CustomKey {
	id: string;
	label: string;
	spec: string;
}

const KEY_STORE = "prometheus.terminal.customKeys";

function loadCustomKeys(): CustomKey[] {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY_STORE) ?? "[]") as unknown;
		if (!Array.isArray(raw)) return [];
		return raw.filter((k): k is CustomKey => !!k && typeof (k as CustomKey).id === "string" && typeof (k as CustomKey).spec === "string");
	} catch {
		return [];
	}
}

const saveCustomKeys = (keys: CustomKey[]) => {
	try {
		localStorage.setItem(KEY_STORE, JSON.stringify(keys));
	} catch {
		/* storage full or blocked; the bar still works for this session */
	}
};

/** How long two taps on the same key still count as a double tap. */
// ---------- Component ----------

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
	const [held, setHeld] = useState<Held[]>([]);
	const heldRef = useRef<Held[]>([]);
	heldRef.current = held;
	const [custom, setCustom] = useState<CustomKey[]>(loadCustomKeys);

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
			const mods = modsOf(heldRef.current);
			// A held modifier applies to what the keyboard types next, then releases: Ctrl + c from the soft keyboard.
			if (anyMod(mods) && input.length === 1) {
				setHeld([]);
				return send(encodeChar(input, mods));
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

	/**
	 * One tap on a modifier picks it up until the next key; a second tap within the double-tap window locks it down,
	 * and locks can stack (Ctrl then Alt), until a normal key is tapped and the combination goes out.
	 */
	const lastTap = useRef({ id: "", at: 0 });
	const press = (id: string, customSpec?: string) => {
		const mod = MODIFIERS.some((m) => m.id === id);
		const now = Date.now();
		const doubled = lastTap.current.id === id && now - lastTap.current.at < DOUBLE_TAP_MS;
		lastTap.current = { id, at: now };

		if (mod) {
			if (doubled) {
				setHeld((cur) => (cur.some((h) => h.id === id) ? cur.map((h) => (h.id === id ? { ...h, lock: true } : h)) : [...cur, { id, lock: true }]));
				return;
			}
			setHeld((cur) => (cur.some((h) => h.id === id) ? cur.filter((h) => h.id !== id) : [...cur, { id, lock: false }]));
			return;
		}
		send(encodeKey(id, modsOf(heldRef.current), customSpec));
		setHeld([]);
	};

	const lockCount = held.filter((h) => h.lock).length;

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
				<button type="button" onClick={() => send("\x03")} disabled={status !== "ready"} className="grid size-6 place-items-center rounded text-ink-400 hover:bg-ink-800 hover:text-rose-400 disabled:opacity-40" title={t("interrupt")}>
					<Square className="size-3.5" />
				</button>
				<button
					type="button"
					onClick={() => {
						setHeld([]);
						send("\x0c");
					}}
					disabled={status !== "ready"}
					className="grid size-6 place-items-center rounded text-ink-400 hover:bg-ink-800 hover:text-ink-100 disabled:opacity-40"
					title={t("clear")}
				>
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
				<KeyBar
					held={held}
					locked={lockCount > 0}
					custom={custom}
					onPress={press}
					onCustomChange={(keys) => {
						setCustom(keys);
						saveCustomKeys(keys);
					}}
				/>
			)}
		</div>
	);
}

/**
 * The on-screen keys: Ctrl/Alt/Shift/Tab on the first row, the arrows and Home/End on the second, then whatever the user
 * added and a `+` to add more. Nothing here is a fixed shortcut — a ^C is just a custom key that sends `^C`.
 */
function KeyBar({ held, locked, custom, onPress, onCustomChange }: { held: Held[]; locked: boolean; custom: CustomKey[]; onPress: (id: string, spec?: string) => void; onCustomChange: (keys: CustomKey[]) => void }) {
	const t = useT(M);
	const [editing, setEditing] = useState(false);
	const [label, setLabel] = useState("");
	const [spec, setSpec] = useState("");
	const isHeld = (id: string) => held.some((h) => h.id === id);
	const isLocked = (id: string) => held.some((h) => h.id === id && h.lock);

	const add = () => {
		const keys = spec.trim();
		if (!keys) return;
		onCustomChange([...custom, { id: `k${Date.now().toString(36)}`, label: label.trim() || keys, spec: keys }]);
		setLabel("");
		setSpec("");
	};

	return (
		<div className="shrink-0 border-t hairline bg-ink-950/60">
			{editing && (
				<div className="border-b hairline px-2 py-2">
					<div className="flex items-center gap-1">
						<input
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							placeholder={t("keyLabel")}
							className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-ink-100 outline-none placeholder:text-ink-600 focus:border-ember-500"
						/>
						<input
							value={spec}
							onChange={(e) => setSpec(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && add()}
							placeholder={t("keySpec")}
							autoFocus
							className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-xs text-ink-100 outline-none placeholder:text-ink-600 focus:border-ember-500"
						/>
						<button type="button" onClick={add} disabled={!spec.trim()} className="rounded-md bg-ember-500 px-2 py-1 text-xs font-medium text-white disabled:bg-ink-800 disabled:text-ink-500">
							{t("save")}
						</button>
						<button type="button" onClick={() => setEditing(false)} className="rounded-md px-2 py-1 text-xs text-ink-400 hover:text-ink-100">
							{t("cancel")}
						</button>
					</div>
					{custom.length > 0 && (
						<div className="mt-1.5 flex flex-wrap gap-1">
							{custom.map((k) => (
								<span key={k.id} className="inline-flex items-center gap-1 rounded-md bg-ink-800 px-1.5 py-0.5 text-[11px] text-ink-300">
									<span className="font-mono">{k.label}</span>
									<button type="button" onClick={() => onCustomChange(custom.filter((c) => c.id !== k.id))} className="text-ink-500 hover:text-rose-400" aria-label={`remove ${k.label}`}>
										<X className="size-3" />
									</button>
								</span>
							))}
						</div>
					)}
				</div>
			)}

			<div className="flex items-center gap-1 overflow-x-auto px-2 pt-1.5">
				{MODIFIERS.map((m) => (
					<PadKey key={m.id} onPress={() => onPress(m.id)} active={isHeld(m.id)} locked={isLocked(m.id)} title={t("holdHint")}>
						{m.label}
					</PadKey>
				))}
				<PadKey onPress={() => onPress("tab")} active={isHeld("tab")}>
					Tab
				</PadKey>
			</div>

			<div className="flex items-center gap-1 overflow-x-auto px-2 py-1.5">
				{FIXED.filter((k) => k.id !== "tab").map((k) => (
					<PadKey key={k.id} onPress={() => onPress(k.id)} active={isHeld(k.id)}>
						{k.label}
					</PadKey>
				))}
				{custom.map((k) => (
					<PadKey key={k.id} onPress={() => onPress(k.id, parseKeys(k.spec))} active={isHeld(k.id)} mono>
						{k.label}
					</PadKey>
				))}
				<button
					type="button"
					onClick={() => setEditing((v) => !v)}
					aria-pressed={editing}
					title={t("add")}
					aria-label={t("add")}
					className={clsx("grid size-9 shrink-0 place-items-center rounded-lg border border-dashed transition-colors", editing ? "border-ember-500 text-ember-300" : "border-ink-700 text-ink-400 hover:border-ink-600 hover:text-ink-200")}
				>
					<Plus className="size-4" />
				</button>
			</div>

			{locked && <div className="px-2 pb-1 text-[10.5px] text-ember-300/80">{t("holdHint")}</div>}
		</div>
	);
}

/** One key: a thumb wide, and visibly held when a modifier is waiting for the rest of its combination. */
function PadKey({ onPress, active, locked, mono, title, children }: { onPress: () => void; active?: boolean; locked?: boolean; mono?: boolean; title?: string; children: ReactNode }) {
	return (
		<button
			type="button"
			onClick={onPress}
			title={title}
			aria-pressed={active}
			className={clsx(
				"h-9 shrink-0 rounded-lg px-3 text-[12px] transition-colors",
				mono && "font-mono",
				active
					? locked
						? "bg-ember-500/25 text-ember-100 ring-1 ring-ember-400/60"
						: "bg-ember-500/15 text-ember-200 ring-1 ring-ember-400/35"
					: "bg-ink-800 text-ink-200 hover:bg-ink-700 active:bg-ink-600",
			)}
		>
			{children}
		</button>
	);
}
