import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { type Dirent, existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Oldest output is dropped past this many characters. */
export const MAX_BUFFER = 400_000;

export interface ShellSpec {
	command: string;
	args: string[];
	/** Lines written to the shell before the user's first command. */
	init: string;
}

export function shellSpec(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ShellSpec {
	if (platform === "win32") {
		return {
			command: "powershell.exe",
			args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "-"],
			init: "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8\n",
		};
	}
	// Android has no /bin/bash; its system shell is /system/bin/sh. Termux builds of Node report the platform as "android".
	const fallback = platform === "android" || !existsSync("/bin/bash") ? "/system/bin/sh" : "/bin/bash";
	return { command: env.SHELL || (existsSync(fallback) ? fallback : "sh"), args: [], init: "" };
}

export interface ReadResult {
	data: string;
	/** Pass this back as `since` to continue. */
	next: number;
	alive: boolean;
	exitCode: number | null;
}

/** One row of the completion strip: what to show, and what to put in place of the word being typed. */
export interface Completion {
	label: string;
	insert: string;
	dir: boolean;
}

/** Single-quote a path for sh and PowerShell, both of which take the single-quoted form literally. */
const quote = (path: string) => (/[\s'"$`\\]/.test(path) ? `'${path.replace(/'/g, `'\\''`)}'` : path);

/**
 * Where a `cd` line ends up, when that can be told without asking a shell.
 *
 * Only used to restart the shell in the right folder after ^C. A path built from a variable, a glob or a pipeline is
 * left alone rather than guessed at — a wrong `cd` after the restart would be worse than starting over.
 */
export function cdTarget(line: string, cwd: string): string | undefined {
	const m = /^\s*cd(?:\s+(?:--\s+)?(.+))?\s*$/.exec(line);
	if (!m?.[1]) return undefined;
	let arg = m[1].trim();
	const quoted = /^(['"])(.*)\1$/.exec(arg);
	if (quoted?.[2] !== undefined) arg = quoted[2];
	else if (/[\s$`;&|<>*?()[\]{}]/.test(arg)) return undefined;
	if (!arg || arg === "-") return undefined;
	const path = arg === "~" ? homedir() : arg.startsWith("~/") ? join(homedir(), arg.slice(2)) : arg;
	const next = resolve(cwd, path);
	try {
		return statSync(next).isDirectory() ? next : undefined;
	} catch {
		return undefined;
	}
}

/** Longest shared start of the candidates: what Tab fills in before the strip appears. */
export function commonPrefix(names: string[]): string {
	const first = names[0] ?? "";
	if (names.length < 2) return first;
	let end = first.length;
	for (const name of names.slice(1)) {
		let i = 0;
		while (i < end && i < name.length && first[i] === name[i]) i++;
		end = i;
	}
	return first.slice(0, end);
}

/**
 * Folder completion for the word in front of the caret, resolved against the shell's folder. Hidden entries only show
 * up once the word itself starts with a dot, the way a shell's own completion behaves.
 */
export async function completePath(cwd: string, prefix: string): Promise<{ items: Completion[]; common: string }> {
	if (prefix.startsWith("-")) return { items: [], common: "" };
	const cut = prefix.lastIndexOf("/");
	const head = cut >= 0 ? prefix.slice(0, cut + 1) : "";
	const base = cut >= 0 ? prefix.slice(cut + 1) : prefix;
	const root = head === "" ? "." : head.startsWith("~/") ? join(homedir(), head.slice(2)) : head;
	let entries: Dirent[];
	try {
		entries = await readdir(resolve(cwd, root), { withFileTypes: true });
	} catch {
		return { items: [], common: "" };
	}
	const items = entries
		.filter((e) => e.name.startsWith(base) && (base.startsWith(".") || !e.name.startsWith(".")))
		.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
		.slice(0, 60)
		.map((e) => ({ label: `${e.name}${e.isDirectory() ? "/" : ""}`, insert: `${head}${e.name}${e.isDirectory() ? "/" : ""}`, dir: e.isDirectory() }));
	return { items, common: items.length > 1 ? commonPrefix(items.map((i) => i.label)) : "" };
}

/**
 * A long-lived shell fed through pipes. There is no pseudo-terminal, so full-screen programs (vim, top) do not work,
 * but ordinary commands, `cd`, environment variables and long-running servers do.
 */
export class ShellSession {
	readonly id: string;
	readonly cwd: string;
	private proc: ChildProcess | undefined;
	private buf = "";
	/** Characters dropped from the front of `buf`; offsets handed to clients are absolute. */
	private base = 0;
	private exitCode: number | null = null;
	private closed = false;
	private readonly spec: ShellSpec;
	/**
	 * The folder to start in next time: the last `cd` that could be resolved, or the one the terminal was opened in.
	 * Pipes cannot carry ^C, so interrupting replaces the shell — without this it would also forget where the user was.
	 */
	private cwdHint: string;
	lastUsed = Date.now();

	constructor(id: string, cwd: string, spec: ShellSpec = shellSpec()) {
		this.id = id;
		this.cwd = cwd;
		this.cwdHint = cwd;
		this.spec = spec;
		this.start();
	}

	private append(text: string): void {
		this.buf += text;
		if (this.buf.length > MAX_BUFFER) {
			const drop = this.buf.length - MAX_BUFFER;
			this.buf = this.buf.slice(drop);
			this.base += drop;
		}
	}

	private start(): void {
		this.exitCode = null;
		const proc = spawn(this.spec.command, this.spec.args, {
			cwd: this.cwd,
			env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		this.proc = proc;
		proc.stdout?.setEncoding("utf8").on("data", (d: string) => this.append(d));
		proc.stderr?.setEncoding("utf8").on("data", (d: string) => this.append(d));
		proc.stdin?.on("error", () => undefined);
		proc.on("error", (e) => {
			this.append(`\n[无法启动 shell: ${e.message}]\n`);
			if (this.proc === proc) this.exitCode = -1;
		});
		proc.on("exit", (code) => {
			// A killed-and-replaced shell reports here too; only the current one counts.
			if (this.proc !== proc) return;
			this.exitCode = code ?? 0;
			if (!this.closed) this.append(`\n[shell 已退出，代码 ${code ?? 0}]\n`);
		});
		if (this.spec.init) proc.stdin?.write(this.spec.init);
		// A replaced shell (^C) starts where the terminal was opened; walk it back to where the user actually was.
		if (this.cwdHint !== this.cwd) proc.stdin?.write(`cd ${quote(this.cwdHint)}\n`);
	}

	get alive(): boolean {
		return this.exitCode === null;
	}

	read(since: number): ReadResult {
		this.lastUsed = Date.now();
		const from = Math.max(since, this.base);
		return { data: this.buf.slice(from - this.base), next: this.base + this.buf.length, alive: this.alive, exitCode: this.exitCode };
	}

	/** Send one command line; it is echoed into the output so history survives a reload. */
	run(line: string): void {
		this.lastUsed = Date.now();
		if (!this.alive) throw new Error("shell 已退出，请重启终端");
		this.append(`> ${line}\n`);
		this.proc?.stdin?.write(`${line}\n`);
		const next = cdTarget(line, this.cwdHint);
		if (next) this.cwdHint = next;
	}

	/** Candidates for the word in front of the caret, read from the folder the shell is in. */
	complete(prefix: string): Promise<{ items: Completion[]; common: string }> {
		this.lastUsed = Date.now();
		return completePath(this.cwdHint, prefix.slice(0, 512));
	}

	/** Stop whatever is running by replacing the shell (pipes cannot carry Ctrl+C). Output so far is kept. */
	interrupt(): void {
		this.append("^C\n");
		// The replacement shell is walked back to this folder; say so, or the user cannot tell the state survived.
		if (this.cwdHint !== this.cwd) this.append(`[回到 ${this.cwdHint}]\n`);
		this.killProc();
		this.start();
	}

	private killProc(): void {
		const proc = this.proc;
		this.proc = undefined;
		if (!proc?.pid) return;
		try {
			if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
			else process.kill(-proc.pid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}

	close(): void {
		this.closed = true;
		this.killProc();
		this.exitCode ??= 0;
	}
}
