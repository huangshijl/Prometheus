/**
 * Keys the on-screen bar sends, as the bytes a terminal expects.
 *
 * Kept apart from the view so it can be checked without a DOM: everything here is a pure function over key names and
 * the modifiers currently held.
 */

export type Mod = "ctrl" | "alt" | "shift";

export interface Mods {
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
}

/** A modifier waiting in the bar. `lock` comes from a double tap; a single tap only lasts for the next key. */
export interface Held {
	id: string;
	lock: boolean;
}

export const MODIFIERS: { id: Mod; label: string }[] = [
	{ id: "ctrl", label: "Ctrl" },
	{ id: "alt", label: "Alt" },
	{ id: "shift", label: "Shift" },
];

/** The fixed keys: what a phone keyboard does not have at all. */
export const FIXED: { id: string; label: string }[] = [
	{ id: "tab", label: "Tab" },
	{ id: "left", label: "←" },
	{ id: "up", label: "↑" },
	{ id: "down", label: "↓" },
	{ id: "right", label: "→" },
	{ id: "home", label: "Home" },
	{ id: "end", label: "End" },
];

/** How long two taps on one key still count as a double tap. */
export const DOUBLE_TAP_MS = 320;

const CSI: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };

export const modsOf = (held: Held[]): Mods => ({
	ctrl: held.some((h) => h.id === "ctrl"),
	alt: held.some((h) => h.id === "alt"),
	shift: held.some((h) => h.id === "shift"),
});

export const anyMod = (m: Mods) => m.ctrl || m.alt || m.shift;

/** xterm's modifier parameter for cursor keys: 1 + shift(1) + alt(2) + ctrl(4). */
export const modNum = (m: Mods) => 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);

/** C0 codes: a-z map to 1-26, and `@A-Z[\]^_` to 0-31, exactly as a terminal computes them. */
export function ctrlChar(ch: string): string {
	const code = ch.toLowerCase().charCodeAt(0);
	if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
	if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
	if (ch === " ") return "\x00";
	return ch;
}

/** One character with the held modifiers applied. Alt is an ESC prefix in front of whatever the character became. */
export function encodeChar(ch: string, m: Mods): string {
	let out = m.shift ? ch.toUpperCase() : ch;
	if (m.ctrl) out = ctrlChar(out);
	return (m.alt ? "\x1b" : "") + out;
}

/** A fixed key or a custom one, with the held modifiers. */
export function encodeKey(id: string, m: Mods, custom?: string): string {
	if (custom !== undefined) {
		// A custom key is usually one character (so modifiers apply) but may be a whole snippet.
		return custom.length === 1 ? encodeChar(custom, m) : (m.alt ? "\x1b" : "") + custom;
	}
	if (id === "tab") {
		if (m.shift && !m.ctrl && !m.alt) return "\x1b[Z";
		if (m.alt && !m.ctrl && !m.shift) return "\x1b\t";
		return "\t";
	}
	const final = CSI[id];
	if (final) {
		const n = modNum(m);
		return n === 1 ? `\x1b[${final}` : `\x1b[1;${n}${final}`;
	}
	return "";
}

/** What the user typed in the custom-key form, as bytes: `^C`, `\t`, `\x1b` or plain text. */
export function parseKeys(spec: string): string {
	const s = spec.trim();
	if (!s) return "";
	const caret = /^\^(.?)$/.exec(s);
	if (caret?.[1]) return ctrlChar(caret[1].toUpperCase());
	return s
		.replace(/\\e/g, "\x1b")
		.replace(/\\t/g, "\t")
		.replace(/\\n/g, "\r")
		.replace(/\\r/g, "\r")
		.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}
