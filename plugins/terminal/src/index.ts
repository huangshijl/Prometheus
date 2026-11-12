import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { definePlugin } from "@prometheus/plugin-sdk";
import { ptySpec, ShellSession, shellSpec } from "./shell.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** Sizes arrive from browsers; keep them inside what a terminal can actually be. */
const dim = (v: unknown, min: number, max: number, fallback: number) => {
	const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
	return Math.min(max, Math.max(min, n));
};
const MAX_SESSIONS = 8;
/** A shell nobody has read from for this long is assumed abandoned (closed tab, lost connection). */
const IDLE_MS = 30 * 60_000;

export default definePlugin({
	name: "terminal",
	version: "0.1.0",
	// Nothing else depends on it: the terminal tab only exists while the user opens one.
	optional: true,
	setup(ctx) {
		const sessions = new Map<string, ShellSession>();
		const need = (id: unknown): ShellSession => {
			const s = sessions.get(str(id));
			if (!s) throw new Error("终端已关闭");
			return s;
		};
		const reap = setInterval(() => {
			for (const [id, s] of sessions) {
				if (Date.now() - s.lastUsed > IDLE_MS) {
					s.close();
					sessions.delete(id);
				}
			}
		}, 60_000);
		reap.unref();
		ctx.onDispose(() => {
			clearInterval(reap);
			for (const s of sessions.values()) s.close();
			sessions.clear();
		});

		/** Only folders the app already knows may host a shell, so a client cannot pick an arbitrary start point. */
		const allowedCwd = async (wanted: string): Promise<string> => {
			// Symlinks are resolved on both sides: `/sdcard/x` and `/storage/emulated/0/x` are the same folder.
			const norm = async (p: string) => {
				const abs = resolve(p);
				const real = await realpath(abs).catch(() => abs);
				return process.platform === "win32" ? real.toLowerCase() : real;
			};
			const known = await Promise.all([ctx.cwd, ...(await ctx.workspaces()).map((w) => w.path)].map(norm));
			const dir = resolve(wanted || ctx.cwd);
			if (!known.includes(await norm(dir))) throw new Error("该目录不在已添加的项目中");
			if (!(await stat(dir).catch(() => undefined))?.isDirectory()) throw new Error("目录不存在");
			return dir;
		};

		ctx.rpc("open", async (p) => {
			if (sessions.size >= MAX_SESSIONS) throw new Error(`最多同时打开 ${MAX_SESSIONS} 个终端`);
			const cwd = await allowedCwd(str(p.cwd));
			const id = randomUUID();
			// The terminal's size is fixed when it starts: the wrapper has no way to be resized later.
			const spec = ptySpec(shellSpec().command, { cols: dim(p.cols, 20, 300, 80), rows: dim(p.rows, 5, 200, 24) });
			const topic = `pty:${id}`;
			const sink =
				spec &&
				((from: number, text: string) => {
					// Nobody watching means nobody to stream to; the buffer still holds everything for `read`.
					if (ctx.stream.watchers(topic) > 0) ctx.stream.publish(topic, { k: "data", from, text });
				});
			sessions.set(id, new ShellSession(id, cwd, spec ?? shellSpec(), sink || undefined));
			return { id, cwd, mode: spec ? "pty" : "pipe", topic: spec ? topic : "" };
		});
		/** Whether this host can hand out a real terminal; the client picks its view from this. */
		ctx.rpc("caps", () => ({ pty: !!ptySpec(shellSpec().command, { cols: 80, rows: 24 }) }));
		ctx.rpc("read", (p) => {
			const s = need(p.id);
			const since = typeof p.since === "number" && p.since >= 0 ? p.since : 0;
			return s.read(since);
		});
		ctx.rpc("run", (p) => {
			const line = str(p.line);
			if (line.length > 20_000) throw new Error("命令过长");
			need(p.id).run(line);
			return {};
		});
		ctx.rpc("interrupt", (p) => {
			need(p.id).interrupt();
			return {};
		});
		// Raw keystrokes: what a terminal sends, control sequences included.
		ctx.rpc("write", (p) => {
			need(p.id).write(str(p.data));
			return {};
		});
		// Read-only: a phone keyboard cannot reasonably type a path, so Tab asks the shell's own folder instead.
		ctx.rpc("complete", (p) => need(p.id).complete(str(p.prefix)));
		ctx.rpc("close", (p) => {
			const s = sessions.get(str(p.id));
			s?.close();
			sessions.delete(str(p.id));
			return {};
		});
	},
});
