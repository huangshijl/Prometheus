// Runs a command that `npm install -g` put in the npm prefix, and keeps a folder of links to itself for PATH.
//
// npm installs commands into `<prefix>/bin` as scripts that begin with `#!/usr/bin/env node`. Android has no
// /usr/bin/env, and it refuses to execute files outside the native-library directory, so those scripts cannot run.
// This resolves a command name to the JavaScript file behind it and runs that with the same Node instead.
// `--sync` gives every installed command a link (in PROMETHEUS_NPM_GLOBAL_BIN) to the `npmbin` dispatcher.
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";

const prefix = process.env.npm_config_prefix;
const tools = process.env.PROMETHEUS_TOOLS_BIN;
const shimDir = process.env.PROMETHEUS_NPM_GLOBAL_BIN;
if (!prefix || !tools || !shimDir) {
	process.stderr.write("npmbin: npm_config_prefix, PROMETHEUS_TOOLS_BIN or PROMETHEUS_NPM_GLOBAL_BIN is not set\n");
	process.exit(1);
}

const modules = join(prefix, "lib", "node_modules");

/** The `bin` map of every package installed directly in the prefix: command name -> JavaScript file. */
function commands() {
	const found = new Map();
	const add = (dir) => {
		let pkg;
		try {
			pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		} catch {
			return;
		}
		const bin = typeof pkg.bin === "string" ? { [basename(pkg.name ?? dir)]: pkg.bin } : (pkg.bin ?? {});
		for (const [name, file] of Object.entries(bin)) {
			if (typeof file === "string" && !found.has(name)) found.set(name, join(dir, file));
		}
	};
	let names = [];
	try {
		names = readdirSync(modules);
	} catch {
		return found;
	}
	for (const name of names) {
		if (name.startsWith(".")) continue;
		if (!name.startsWith("@")) {
			add(join(modules, name));
			continue;
		}
		let scoped = [];
		try {
			scoped = readdirSync(join(modules, name));
		} catch {
			continue;
		}
		for (const inner of scoped) add(join(modules, name, inner));
	}
	return found;
}

const found = commands();

if (process.argv[2] === "--sync") {
	mkdirSync(shimDir, { recursive: true });
	const dispatcher = join(tools, "npmbin");
	// Drop links whose command is gone; leave anything that is not ours alone.
	for (const name of readdirSync(shimDir)) {
		const at = join(shimDir, name);
		let stat;
		try {
			stat = lstatSync(at);
		} catch {
			continue;
		}
		if (!stat.isSymbolicLink() || found.has(name)) continue;
		rmSync(at, { force: true });
	}
	for (const name of found.keys()) {
		try {
			symlinkSync(dispatcher, join(shimDir, name));
		} catch {
			// Already linked (npm installs are incremental); anything that is not a link is the user's and stays.
		}
	}
	process.exit(0);
}

const name = process.argv[2];
const entry = name ? found.get(name) : undefined;
if (!entry) {
	process.stderr.write(`npmbin: no command named ${name ?? "(none)"} was installed with npm\n`);
	process.exit(127);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(3)], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (e) => {
	process.stderr.write(`npmbin: ${e.message}\n`);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 1);
});
