import { describe, expect, it } from "vitest";
import { encodeChar, encodeKey, modsOf, parseKeys } from "../src/lib/terminalKeys.ts";

const NONE = { ctrl: false, alt: false, shift: false };
const CTRL = { ...NONE, ctrl: true };
const ALT = { ...NONE, alt: true };
const SHIFT = { ...NONE, shift: true };

describe("modsOf", () => {
	it("reads the held modifiers, locked or not", () => {
		expect(modsOf([])).toEqual(NONE);
		expect(modsOf([{ id: "ctrl", lock: false }])).toEqual(CTRL);
		expect(
			modsOf([
				{ id: "ctrl", lock: true },
				{ id: "alt", lock: true },
			]),
		).toEqual({ ...NONE, ctrl: true, alt: true });
	});
});

describe("encodeChar", () => {
	it("sends the C0 code for Ctrl+letter, not the letter", () => {
		expect(encodeChar("c", CTRL)).toBe("\x03");
		expect(encodeChar("C", CTRL)).toBe("\x03");
		expect(encodeChar("a", CTRL)).toBe("\x01");
		expect(encodeChar("z", CTRL)).toBe("\x1a");
	});

	it("maps the punctuation a terminal also treats as control codes", () => {
		expect(encodeChar("[", CTRL)).toBe("\x1b");
		expect(encodeChar("\\", CTRL)).toBe("\x1c");
		expect(encodeChar("]", CTRL)).toBe("\x1d");
		expect(encodeChar("_", CTRL)).toBe("\x1f");
		expect(encodeChar("@", CTRL)).toBe("\x00");
	});

	it("prefixes Alt with ESC and uppercases for Shift", () => {
		expect(encodeChar("x", ALT)).toBe("\x1bx");
		expect(encodeChar("x", SHIFT)).toBe("X");
		// Ctrl is applied first, then Alt goes in front of what it became.
		expect(encodeChar("x", { ...CTRL, alt: true })).toBe("\x1b\x18");
	});
});

describe("encodeKey", () => {
	it("sends plain keys without modifiers", () => {
		expect(encodeKey("tab", NONE)).toBe("\t");
		expect(encodeKey("up", NONE)).toBe("\x1b[A");
		expect(encodeKey("end", NONE)).toBe("\x1b[F");
	});

	it("uses the CSI modifier parameter for cursor keys", () => {
		expect(encodeKey("up", SHIFT)).toBe("\x1b[1;2A");
		expect(encodeKey("up", ALT)).toBe("\x1b[1;3A");
		expect(encodeKey("right", { ...CTRL, alt: true })).toBe("\x1b[1;7C");
		expect(encodeKey("home", CTRL)).toBe("\x1b[1;5H");
	});

	it("turns Shift+Tab into backtab", () => {
		expect(encodeKey("tab", SHIFT)).toBe("\x1b[Z");
		expect(encodeKey("tab", { ...SHIFT, ctrl: true })).toBe("\t");
	});

	it("applies modifiers to a one-character custom key but not to a snippet", () => {
		expect(encodeKey("k1", CTRL, "c")).toBe("\x03");
		expect(encodeKey("k1", NONE, "ls -la")).toBe("ls -la");
		expect(encodeKey("k1", ALT, "ls -la")).toBe("\x1bls -la");
	});
});

describe("parseKeys", () => {
	it("understands the caret notation", () => {
		expect(parseKeys("^C")).toBe("\x03");
		expect(parseKeys("^c")).toBe("\x03");
		expect(parseKeys("^[")).toBe("\x1b");
	});

	it("understands the usual escapes", () => {
		expect(parseKeys("\\t")).toBe("\t");
		expect(parseKeys("\\e")).toBe("\x1b");
		expect(parseKeys("\\x1b[A")).toBe("\x1b[A");
		expect(parseKeys("\\n")).toBe("\r");
	});

	it("passes anything else through", () => {
		expect(parseKeys("ls -la")).toBe("ls -la");
		expect(parseKeys("  ")).toBe("");
	});
});
