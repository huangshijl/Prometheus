// Finding a Chromium-family browser on this machine and starting it with a private profile and a CDP pipe.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { CdpConnection, connectWebSocket } from "./cdp.ts";
import { GUEST_ARGS } from "./guest.ts";

export type BrowserKind = "custom" | "bundled" | "chrome" | "edge" | "chromium" | "brave";

export interface FoundBrowser {
	path: string;
	kind: BrowserKind;
}

function onPath(names: string[]): string | undefined {
	const dirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean);
	const exts = process.platform === "win32" ? ["", ".exe"] : [""];
	for (const name of names) for (const dir of dirs) for (const ext of exts) {
		const full = join(dir, name + ext);
		if (existsSync(full)) return full;
	}
	return undefined;
}

/** Installed browsers, best first: Chrome renders like most users' browser, Edge ships with every Windows. */
export function systemBrowsers(): FoundBrowser[] {
	const out: FoundBrowser[] = [];
	const add = (kind: BrowserKind, ...paths: (string | undefined)[]) => {
		for (const p of paths) if (p && existsSync(p) && !out.some((b) => b.path === p)) out.push({ path: p, kind });
	};
	if (process.platform === "win32") {
		const pf = process.env.ProgramFiles ?? "C:\\Program Files";
		const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
		add("chrome", join(pf, "Google\\Chrome\\Application\\chrome.exe"), join(pf86, "Google\\Chrome\\Application\\chrome.exe"), join(local, "Google\\Chrome\\Application\\chrome.exe"));
		add("edge", join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"), join(pf, "Microsoft\\Edge\\Application\\msedge.exe"));
		add("brave", join(pf, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"), join(local, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"));
		add("chromium", join(local, "Chromium\\Application\\chrome.exe"));
	} else if (process.platform === "darwin") {
		const apps = ["/Applications", join(homedir(), "Applications")];
		for (const dir of apps) {
			add("chrome", join(dir, "Google Chrome.app/Contents/MacOS/Google Chrome"));
			add("edge", join(dir, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"));
			add("chromium", join(dir, "Chromium.app/Contents/MacOS/Chromium"));
			add("brave", join(dir, "Brave Browser.app/Contents/MacOS/Brave Browser"));
		}
	} else {
		add("chrome", onPath(["google-chrome", "google-chrome-stable"]), "/opt/google/chrome/chrome");
		add("chromium", onPath(["chromium", "chromium-browser"]), "/usr/bin/chromium", "/snap/bin/chromium");
		add("edge", onPath(["microsoft-edge", "microsoft-edge-stable"]));
		add("brave", onPath(["brave-browser", "brave"]));
	}
	return out;
}

/** The executable to use: the configured one, then a browser downloaded by the plugin, then the system's. */
export function locateBrowser(customPath: string, bundledPath: string | undefined): FoundBrowser | undefined {
	if (customPath) return existsSync(customPath) ? { path: customPath, kind: "custom" } : undefined;
	if (bundledPath && existsSync(bundledPath)) return { path: bundledPath, kind: "bundled" };
	return systemBrowsers()[0];
}

export interface LaunchOptions {
	executable: string;
	profileDir: string;
	headless: boolean;
	/** http://host:port, socks5://host:port; empty for a direct connection. */
	proxy: string;
	lang: string;
	window: { width: number; height: number };
	/**
	 * Pixel ratio to render at. Headless Chromium captures screencast frames at CSS size unless the ratio is baked in
	 * at launch, which is what makes a 2x/3x phone screen look blurry.
	 */
	scale?: number;
	/** Run inside the phone's PRoot rootfs through the runner (see guest.ts); implies the WebSocket transport. */
	guest?: { runner: string; cwd: string };
	/**
	 * Run pages in the browser process. The phone's PRoot does not always manage to start a renderer; without one
	 * every page dies as soon as it opens, and this is the way back to a usable page.
	 */
	inProcess?: boolean;
	/** "pipe" (default) keeps the browser unreachable for other processes; "ws" listens on a random loopback port. */
	transport?: "pipe" | "ws";
	onExit?: (code: number | null, stderr: string) => void;
}

const usesWs = (o: LaunchOptions) => !!o.guest || o.transport === "ws";

export interface Launched {
	proc: ChildProcess;
	conn: CdpConnection;
	userAgent: string;
	product: string;
	/** What the browser printed so far (filtered when shown); a renderer that dies says why here. */
	stderr: () => string;
}

export function launchArgs(o: LaunchOptions): string[] {
	const args = [
		usesWs(o) ? "--remote-debugging-port=0" : "--remote-debugging-pipe",
		`--user-data-dir=${o.profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-default-apps",
		"--disable-sync",
		"--disable-component-extensions-with-background-pages",
		"--disable-background-timer-throttling",
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		"--disable-ipc-flooding-protection",
		"--disable-hang-monitor",
		"--disable-popup-blocking",
		"--disable-prompt-on-repost",
		"--disable-client-side-phishing-detection",
		"--hide-crash-restore-bubble",
		"--metrics-recording-only",
		"--disable-blink-features=AutomationControlled",
		"--disable-features=Translate,MediaRouter,DialMediaRouteProvider,OptimizationHints,InterestFeedContentSuggestions,CalculateNativeWinOcclusion,HeadlessHideScrollbars,msEdgeSidebarV2,msUndersideButton",
		`--lang=${o.lang}`,
		`--window-size=${o.window.width},${o.window.height}`,
	];
	// chrome-headless-shell (the phone's browser) is headless by itself and does not take --headless=new.
	if (o.headless) args.push(...(o.guest ? ["--mute-audio"] : ["--headless=new", "--mute-audio"]));
	// Screencast frames come out at CSS size when the device scale factor is only emulated; a launch-time factor makes
	// the compositor render (and capture) at the viewer's real pixel density.
	if (o.headless && o.scale && o.scale > 1.01) args.push(`--force-device-scale-factor=${Math.min(o.scale, 4)}`);
	if (o.guest) args.push(...GUEST_ARGS);
	if (o.inProcess) args.push("--single-process");
	if (o.proxy) args.push(`--proxy-server=${o.proxy}`);
	if (process.platform === "linux") args.push("--password-store=basic");
	if (process.platform === "darwin") args.push("--use-mock-keychain");
	// Chromium refuses to sandbox as root (containers); it would not start at all otherwise.
	if (!o.guest && process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox");
	args.push("about:blank");
	return args;
}

const PID_FILE = "browser.pid";

function groupKill(proc: ChildProcess): void {
	if (!proc.pid) return;
	try {
		if (process.platform === "win32") proc.kill();
		else process.kill(-proc.pid, "SIGKILL");
	} catch {
		try {
			proc.kill("SIGKILL");
		} catch {}
	}
}

const ANNOUNCED = /DevTools listening on (ws:\/\/\S+)/;

/** The port-file fallback may repeat on every start; say it once, with the diagnostic, and not on each launch. */
let warnedPortFile = false;

/** Chrome also prints its debugging endpoint on stderr; that address works even when the port file lands elsewhere. */
export function announcedEndpoint(stderr: string): string | undefined {
	return ANNOUNCED.exec(stderr)?.[1];
}

interface ProcRow {
	pid: number;
	ppid: number;
	state: string;
	cmd: string;
}

function processRows(): ProcRow[] {
	const rows: ProcRow[] = [];
	let names: string[] = [];
	try {
		names = readdirSync("/proc");
	} catch {
		return rows;
	}
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name);
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
			rows.push({ pid, ppid: Number(rest[1]), state: rest[0] ?? "?", cmd });
		} catch {
			// Another user's process, or already gone.
		}
	}
	return rows;
}

function treeOf(root: number, rows: ProcRow[]): string[] {
	const out: string[] = [];
	const walk = (pid: number, depth: number) => {
		if (out.length > 24) return;
		const row = rows.find((r) => r.pid === pid);
		if (!row) {
			if (depth === 0) out.push(`${pid}（已退出）`);
			return;
		}
		out.push(`${"  ".repeat(depth)}${row.pid} ${row.state} ${row.cmd.slice(0, 220) || "（无命令行）"}`);
		for (const child of rows.filter((r) => r.ppid === pid)) walk(child.pid, depth + 1);
	};
	walk(root, 0);
	return out;
}

function listNames(dir: string, depth = 2): string[] {
	const out: string[] = [];
	const walk = (at: string, prefix: string, left: number) => {
		let entries: import("node:fs").Dirent[] = [];
		try {
			entries = readdirSync(at, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (out.length > 60) return;
			out.push(prefix + entry.name + (entry.isDirectory() ? "/" : ""));
			if (entry.isDirectory() && left > 1) walk(join(at, entry.name), `${prefix}${entry.name}/`, left - 1);
		}
	};
	walk(dir, "", depth);
	return out;
}

/** Where a guest-side copy of the profile could be: PRoot creates host paths inside the rootfs. */
function portFileMirrors(profileDir: string): string[] {
	const rootfs = process.env.PROMETHEUS_ROOTFS;
	if (!rootfs) return [];
	const rel = profileDir.replace(/^\/+/, "");
	const variants = new Set([rel]);
	// /data/user/0/<pkg> and /data/data/<pkg> are two mounts of the same tree; PRoot may see either.
	if (rel.startsWith("data/user/0/")) variants.add(`data/data/${rel.slice("data/user/0/".length)}`);
	if (rel.startsWith("data/data/")) variants.add(`data/user/0/${rel.slice("data/data/".length)}`);
	return [...variants].map((v) => join(rootfs, v, "DevToolsActivePort"));
}

/**
 * What a start that never got its port looked like from the outside: process state and children (a stopped loader or
 * a hung renderer shows up here), what Chrome wrote into the profile, and whether the port file landed in a
 * guest-side mirror of the path instead. Logged to 设置 → 错误日志 when a start times out.
 */
export function diagnoseLaunch(proc: ChildProcess, profileDir: string): { text: string; brief: string } {
	try {
		const rows = processRows();
		const tree = treeOf(proc.pid ?? -1, rows);
		const names = listNames(profileDir);
		const mirrors = portFileMirrors(profileDir).filter((path) => existsSync(path));
		const alive = rows.find((r) => r.pid === proc.pid);
		const text = [
			`命令：${(proc.spawnargs ?? []).join(" ").slice(0, 600)}`,
			`pid=${proc.pid ?? "-"} 状态=${alive ? `${alive.state}（${alive.cmd.slice(0, 120)}）` : "已退出"}`,
			"进程树：",
			...(tree.length ? tree : ["  （没有可读的进程）"]),
			`profile 目录（${profileDir}）：${names.length ? names.join(" ") : "空"}`,
			`rootfs 里的调试端口文件：${mirrors.length ? mirrors.join(", ") : "无"}`,
		].join("\n");
		const brief = `pid ${proc.pid ?? "-"} ${alive ? "仍在运行" : "已退出"}，进程 ${tree.length} 个，profile ${names.length} 项，rootfs 端口文件 ${mirrors.length} 个`;
		return { text, brief };
	} catch (err) {
		const brief = `诊断失败：${err instanceof Error ? err.message : String(err)}`;
		return { text: brief, brief };
	}
}

async function waitTarget(activePort: string, stderr: () => string, timeoutMs: number): Promise<{ url: string; fromFile: boolean }> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const [port, path] = (await readFile(activePort, "utf8").catch(() => "")).split("\n");
		if (port && path && /^\d+$/.test(port.trim())) return { url: `ws://127.0.0.1:${port.trim()}${path.trim()}`, fromFile: true };
		const announced = announcedEndpoint(stderr());
		if (announced) return { url: announced, fromFile: false };
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("浏览器没有在限定时间内就绪");
}

/**
 * A browser left over from a crashed server still holds the profile; a new one with the same profile would hand its
 * command line to the old process and exit. Ends the one we started last time, if it is still there.
 */
async function endStale(dataDir: string): Promise<void> {
	const file = join(dataDir, PID_FILE);
	const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		process.kill(pid, 0);
	} catch {
		await rm(file, { force: true });
		return;
	}
	try {
		if (process.platform === "win32") {
			await new Promise<void>((done) => {
				const p = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
				p.on("exit", () => done());
				p.on("error", () => done());
			});
		} else {
			// The browser leads its own process group (detached), so its helper processes go with it.
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				process.kill(pid, "SIGKILL");
			}
		}
	} catch {
		// Already gone, or not ours to end.
	}
	await new Promise((r) => setTimeout(r, 300));
	await rm(file, { force: true });
}

/** Noise Chromium prints on a phone (no D-Bus, no udev) says nothing about why it failed. */
const NOISE = /dbus|udev|inotify|Floss|bluez|drmGetDevices2|vaapi|Fontconfig|MESA|libEGL|GLES|DevTools listening/;

/** The end of a browser's stderr, without the noise, for the error the user gets to see. */
export function stderrSummary(stderr: string, max = 600): string {
	const lines = stderr
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	// Only noise means there is nothing to tell; the caller's message is more useful than a dump of D-Bus errors.
	const picked = lines.filter((l) => !NOISE.test(l)).slice(-6).join(" ");
	return picked.slice(0, max);
}

export async function launchBrowser(o: LaunchOptions, dataDir: string, timeoutMs = 30_000): Promise<Launched> {
	await mkdir(o.profileDir, { recursive: true });
	await endStale(dataDir);
	const ws = usesWs(o);
	const activePort = join(o.profileDir, "DevToolsActivePort");
	if (ws) await rm(activePort, { force: true });
	const [command, argv, cwd] = o.guest ? [o.guest.runner, [o.executable, ...launchArgs(o)], o.guest.cwd] : [o.executable, launchArgs(o), undefined];
	const proc = spawn(command, argv, {
		stdio: ws ? ["ignore", "ignore", "pipe"] : ["ignore", "ignore", "pipe", "pipe", "pipe"],
		windowsHide: true,
		detached: process.platform !== "win32",
		...(cwd ? { cwd } : {}),
	});
	let stderr = "";
	proc.stderr?.on("data", (d: Buffer) => {
		if (stderr.length < 16_000) stderr += d.toString("utf8");
	});
	let conn: CdpConnection = ws ? new CdpConnection(new PassThrough(), new PassThrough()) : new CdpConnection(proc.stdio[3] as Writable, proc.stdio[4] as Readable);
	const exited = new Promise<never>((_, reject) => {
		proc.once("error", (e) => reject(e));
		proc.once("exit", (code) => {
			const out = stderrSummary(stderr, 400);
			reject(new Error(`浏览器启动后立即退出（代码 ${code}）${out ? `：${out}` : "。配置目录可能被另一个浏览器进程占用。"}`));
		});
	});
	proc.once("exit", (code) => {
		conn.shutdown(`browser exited (${code})`);
		if (ws) groupKill(proc);
		void rm(join(dataDir, PID_FILE), { force: true }).catch(() => {});
		o.onExit?.(code, stderr);
	});
	try {
		if (ws) {
			// The browser writes the port and the secret socket path of its endpoint here once it listens; its stderr
			// announcement is the fallback for a port file we cannot see (a guest-side path, a read-only profile).
			const target = await Promise.race([waitTarget(activePort, () => stderr, timeoutMs), exited]);
			if (!target.fromFile && !warnedPortFile) {
				warnedPortFile = true;
				const { text } = diagnoseLaunch(proc, o.profileDir);
				console.error(`[plugin:browser] 浏览器没有把调试端口写进 ${o.profileDir}，改用它在 stderr 里报告的地址连接。\n${text}`);
			}
			conn.shutdown("replaced");
			conn = await Promise.race([connectWebSocket(target.url), exited]);
		}
		// Getting the version answers at once once the browser is up; it must not inherit the slow start-up deadline.
		const version = await Promise.race([
			conn.send<{ product: string; userAgent: string }>("Browser.getVersion", {}, undefined, Math.min(timeoutMs, 30_000)),
			exited,
		]);
		if (proc.pid) await writeFile(join(dataDir, PID_FILE), String(proc.pid)).catch(() => {});
		return { proc, conn, userAgent: version.userAgent, product: version.product, stderr: () => stderr };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Look at the process before killing it: a stopped loader or a renderer that never spawned is the whole answer.
		const diag = ws ? diagnoseLaunch(proc, o.profileDir) : undefined;
		if (diag) console.error(`[plugin:browser] ${message}\n${diag.text}`);
		conn.shutdown("launch failed");
		groupKill(proc);
		const out = stderrSummary(stderr);
		// The start-up timeout and a refused WebSocket have no stderr in them; the browser's own output is what says why.
		const details = [out && !message.includes(out) ? `浏览器输出：${out}` : "", diag && message.includes("限定时间内就绪") ? `启动诊断：${diag.brief}` : ""].filter(Boolean).join("；");
		throw new Error(details ? `${message}（${details}）` : message);
	}
}

/** Close politely, then make sure. */
export async function closeBrowser(l: Launched): Promise<void> {
	if (l.proc.exitCode !== null) return;
	const gone = new Promise<void>((done) => l.proc.once("exit", () => done()));
	await l.conn.send("Browser.close", {}, undefined, 3000).catch(() => {});
	const timer = setTimeout(() => groupKill(l.proc), 4000);
	await gone;
	clearTimeout(timer);
}
