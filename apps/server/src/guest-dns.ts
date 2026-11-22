// Android local mode: the browser and the other PRoot guests cannot see the phone's network themselves. The app
// publishes the current gateway and resolvers to `PROMETHEUS_DNS_FILE` (see MainActivity's writeGuestDns), and the
// `guestrun` shim writes them into the rootfs' /etc/resolv.conf — but only when it starts a command. The built-in
// browser is one long-lived process: after a Wi-Fi ⇄ mobile-data switch it kept resolving against the old servers
// until the app was restarted. Chromium re-reads /etc/resolv.conf when the file changes, so following the phone's
// network here is enough; no browser restart is involved.
import { existsSync, readFileSync, watchFile, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Same line the `guestrun` shim appends to /etc/resolv.conf. */
const OPTIONS = "options timeout:2 attempts:2";

/** What the app currently knows: line 1 the gateway (may be empty), line 2 the resolvers, space or comma separated. */
function currentServers(file: string): string[] {
	const [gatewayLine = "", resolverLine = ""] = readFileSync(file, "utf8").split("\n");
	const gateway = gatewayLine.trim();
	const resolvers = resolverLine.split(/[\s,]+/).filter(Boolean);
	return [gateway, ...resolvers].filter(Boolean);
}

/** One sync pass; exported for the test. Returns true when /etc/resolv.conf changed. */
export function syncGuestResolv(rootfs = process.env.PROMETHEUS_ROOTFS, dnsFile = process.env.PROMETHEUS_DNS_FILE): boolean {
	if (!rootfs || !dnsFile) return false;
	let servers: string[];
	try {
		servers = currentServers(dnsFile);
	} catch {
		return false;
	}
	// Nothing published yet (or between networks): keep the last servers instead of breaking resolution outright.
	if (!servers.length) return false;
	// Not installed yet (or removed): nothing to update; the shim writes the file when a command starts.
	if (!existsSync(rootfs)) return false;
	const body = `${servers.map((server) => `nameserver ${server}`).join("\n")}\n${OPTIONS}\n`;
	const target = join(rootfs, "etc/resolv.conf");
	let current = "";
	try {
		current = readFileSync(target, "utf8");
	} catch {
		// No resolv.conf yet: create one rather than leaving the guest without a resolver.
	}
	if (current === body) return false;
	try {
		writeFileSync(target, body);
		return true;
	} catch {
		return false;
	}
}

/**
 * Follow `dns.txt` for the life of the server (Android only: the two variables exist only there). The file is tiny and
 * written with truncate+write, so stat polling is enough and does not depend on inotify inside app storage.
 */
export function watchGuestDns(): void {
	const { PROMETHEUS_ROOTFS: rootfs, PROMETHEUS_DNS_FILE: dnsFile } = process.env;
	if (!rootfs || !dnsFile) return;
	// The file may not exist yet (the server can start before MainActivity writes it); watchFile reports it appearing.
	syncGuestResolv(rootfs, dnsFile);
	const watcher = watchFile(dnsFile, { interval: 2000 }, () => syncGuestResolv(rootfs, dnsFile));
	// Polling alone must not keep the process alive; the HTTP server does that.
	watcher.unref();
}
