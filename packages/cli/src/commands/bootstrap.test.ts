import { describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../config.js";
import { type BootstrapPost, runBootstrap } from "./bootstrap.js";
import { capturingSink } from "./fakes.test-helper.js";

const owner = {
	id: "user_1",
	orgId: "default",
	email: "owner@example.com",
	name: "Owner",
	globalRole: "OWNER",
	createdAt: "now",
	updatedAt: "now",
};

describe("runBootstrap", () => {
	it("posts {email,name}, prints the key, and saves credentials", async () => {
		const cap = capturingSink();
		const calls: { url: string; body: unknown }[] = [];
		const post: BootstrapPost = async (url, body) => {
			calls.push({ url, body });
			return { status: 201, json: { user: owner, secret: "op_live_abc123" } };
		};
		const saved: AuthConfig[] = [];
		const save = vi.fn((auth: AuthConfig) => {
			saved.push(auth);
			return "/home/u/.turjuman/auth.json";
		});

		const result = await runBootstrap(
			{
				url: "https://api.example.com",
				email: "owner@example.com",
				name: "Owner",
			},
			cap.sink,
			post,
			save,
		);

		// Only email + name cross the wire (no orgId/force).
		expect(calls).toEqual([
			{
				url: "https://api.example.com",
				body: { email: "owner@example.com", name: "Owner" },
			},
		]);
		// Credentials saved with the returned secret.
		expect(saved).toEqual([
			{ url: "https://api.example.com", key: "op_live_abc123" },
		]);
		// The key is surfaced to the user once.
		expect(cap.lines.some((l) => l.includes("op_live_abc123"))).toBe(true);
		// Structured (--json) result carries the key + user for capture.
		expect(cap.result()).toMatchObject({
			command: "bootstrap",
			url: "https://api.example.com",
			key: "op_live_abc123",
			user: { email: "owner@example.com", globalRole: "OWNER" },
		});
		expect(result.secret).toBe("op_live_abc123");
	});

	it("surfaces a clean message and saves nothing when an owner already exists (409)", async () => {
		const cap = capturingSink();
		const post: BootstrapPost = async () => ({
			status: 409,
			json: { error: "Org already has users", code: "CONFLICT" },
		});
		const save = vi.fn(() => "/should/not/be/called");

		await expect(
			runBootstrap(
				{ url: "https://api.example.com", email: "x@example.com", name: "X" },
				cap.sink,
				post,
				save,
			),
		).rejects.toThrow(/already exists/);
		expect(save).not.toHaveBeenCalled();
	});

	it("throws on any other non-201 status", async () => {
		const cap = capturingSink();
		const post: BootstrapPost = async () => ({
			status: 500,
			json: { error: "boom" },
		});
		await expect(
			runBootstrap(
				{ url: "https://api.example.com", email: "x@example.com", name: "X" },
				cap.sink,
				post,
				vi.fn(() => "/nope"),
			),
		).rejects.toThrow(/boom/);
	});

	it("still surfaces the one-time key when saving credentials fails", async () => {
		const cap = capturingSink();
		const post: BootstrapPost = async () => ({
			status: 201,
			json: { user: owner, secret: "op_live_xyz" },
		});
		const save = vi.fn(() => {
			throw new Error("EACCES");
		});

		const result = await runBootstrap(
			{
				url: "https://api.example.com",
				email: "owner@example.com",
				name: "Owner",
			},
			cap.sink,
			post,
			save,
		);

		// Key reached the operator and the command did NOT throw on the save failure.
		expect(cap.lines.some((l) => l.includes("op_live_xyz"))).toBe(true);
		expect(
			cap.notes.some((n) => n.includes("Could not save credentials")),
		).toBe(true);
		expect(cap.result()).toMatchObject({ key: "op_live_xyz", file: undefined });
		expect(result.secret).toBe("op_live_xyz");
	});

	it("rejects a 201 with a malformed/empty body instead of null-derefing", async () => {
		const cap = capturingSink();
		const post: BootstrapPost = async () => ({ status: 201, json: undefined });
		const save = vi.fn(() => "/nope");

		await expect(
			runBootstrap(
				{ url: "https://api.example.com", email: "x@example.com", name: "X" },
				cap.sink,
				post,
				save,
			),
		).rejects.toThrow(/unexpected body/);
		expect(save).not.toHaveBeenCalled();
	});
});
