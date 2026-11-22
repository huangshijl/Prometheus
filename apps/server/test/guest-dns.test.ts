import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncGuestResolv } from "../src/guest-dns.ts";

const made: string[] = [];

async function fixture(): Promise<{ rootfs: string; dns: string }> {
	const dir = await mkdtemp(join(tmpdir(), "prometheus-dns-"));
	made.push(dir);
	const rootfs = join(dir, "rootfs");
	await mkdir(join(rootfs, "etc"), { recursive: true });
	return { rootfs, dns: join(dir, "dns.txt") };
}

afterEach(async () => {
	for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const read = (rootfs: string) => readFile(join(rootfs, "etc/resolv.conf"), "utf8");
const OPTIONS = "options timeout:2 attempts:2";

describe("guest resolver", () => {
	it("follows the gateway and resolvers the app publishes", async () => {
		const { rootfs, dns } = await fixture();
		await writeFile(dns, "\n223.5.5.5 1.1.1.1");
		expect(syncGuestResolv(rootfs, dns)).toBe(true);
		expect(await read(rootfs)).toBe(`nameserver 223.5.5.5\nnameserver 1.1.1.1\n${OPTIONS}\n`);
		// Same network again: no rewrite, so Chromium is not woken for nothing.
		expect(syncGuestResolv(rootfs, dns)).toBe(false);
	});

	it("puts the gateway first and accepts comma-separated resolvers", async () => {
		const { rootfs, dns } = await fixture();
		await writeFile(dns, "192.168.1.1\n9.9.9.9,149.112.112.112");
		expect(syncGuestResolv(rootfs, dns)).toBe(true);
		expect(await read(rootfs)).toBe(`nameserver 192.168.1.1\nnameserver 9.9.9.9\nnameserver 149.112.112.112\n${OPTIONS}\n`);
	});

	it("keeps the working servers while the app has not published any", async () => {
		const { rootfs, dns } = await fixture();
		await writeFile(join(rootfs, "etc/resolv.conf"), "nameserver 223.5.5.5\n");
		await writeFile(dns, "\n");
		expect(syncGuestResolv(rootfs, dns)).toBe(false);
		expect(await read(rootfs)).toBe("nameserver 223.5.5.5\n");
	});

	it("does nothing without the two paths (desktop and plain servers)", async () => {
		expect(syncGuestResolv("", "")).toBe(false);
	});
});
