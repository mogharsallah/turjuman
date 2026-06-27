import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { App, CfnOutput, aws_lambda as lambda, Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { synthTemplate } from "./synth.js";
import { lambdaDir, Turjuman } from "./turjuman.js";

/**
 * The construct is meant to stay open by *composition*, not by growing a prop per
 * knob: consumers tune the functions through the existing overrides and reach the
 * public members (`table`, `mcpFunction`, `apiUrl`, …) to attach their own
 * resources. These tests pin that contract so a future change can't quietly close
 * it. Plus a unit check on the vendored-asset path resolver.
 *
 * A throwaway on-disk fixture stands in for the published Lambda assets so synth
 * stays hermetic (no built bundles required).
 */
const fixture = mkdtempSync(join(tmpdir(), "turjuman-openness-"));
writeFileSync(
	join(fixture, "handler.mjs"),
	"export const handler = async () => ({});\n",
);
writeFileSync(join(fixture, "package.json"), '{"type":"module"}\n');
const freshCode = () => ({
	mcp: lambda.Code.fromAsset(fixture),
	api: lambda.Code.fromAsset(fixture),
	webhook: lambda.Code.fromAsset(fixture),
});

// biome-ignore lint/suspicious/noExplicitAny: synthesized CFN JSON is untyped.
type Cfn = Record<string, any>;

const synthWith = (props: Record<string, unknown> = {}): Cfn =>
	synthTemplate({ stackName: "turjuman", code: freshCode(), ...props }) as Cfn;

const resourcesOfType = (t: Cfn, type: string): [string, Cfn][] =>
	Object.entries(t.Resources as Record<string, Cfn>).filter(
		([, r]) => r.Type === type,
	);

const fnByDescription = (t: Cfn, description: string): Cfn | undefined =>
	resourcesOfType(t, "AWS::Lambda::Function").find(
		([, r]) => r.Properties.Description === description,
	)?.[1];

describe("lambdaDir (vendored-asset resolution)", () => {
	it("resolves to the package's own lambda/<sub> dir", () => {
		for (const sub of ["mcp", "api", "webhook"] as const) {
			const dir = lambdaDir(sub);
			expect(isAbsolute(dir)).toBe(true);
			expect(basename(dir)).toBe(sub);
			expect(basename(dirname(dir))).toBe("lambda");
		}
	});

	// The whole suite above injects `code`, so the construct's DEFAULT branch —
	// `Code.fromAsset(lambdaDir(sub))` — is otherwise never synthesized. Exercise it
	// against the real vendored bundles when they exist (after `pnpm run build`);
	// skip on a bare source checkout so the no-build unit run stays hermetic.
	const vendored = (["mcp", "api", "webhook"] as const).every((s) =>
		existsSync(lambdaDir(s)),
	);
	it.skipIf(!vendored)(
		"synthesizes the stack from the real vendored assets (no code override)",
		() => {
			const t = synthTemplate({ stackName: "turjuman" }) as Cfn;
			expect(resourcesOfType(t, "AWS::Lambda::Function")).toHaveLength(3);
		},
	);
});

describe("openness by composition (no new props)", () => {
	it("applies functionDefaults (memory/timeout/architecture) to every function", () => {
		const t = synthWith({
			functionDefaults: {
				memorySize: 512,
				timeout: 30,
				architecture: "x86_64",
			},
		});
		const fns = resourcesOfType(t, "AWS::Lambda::Function");
		expect(fns).toHaveLength(3);
		for (const [, fn] of fns) {
			expect(fn.Properties.MemorySize).toBe(512);
			expect(fn.Properties.Timeout).toBe(30);
			expect(fn.Properties.Architectures).toEqual(["x86_64"]);
		}
	});

	it("lets per-function tuning override the defaults independently", () => {
		const t = synthWith({
			functionDefaults: { memorySize: 256 },
			mcp: { memorySize: 1024 },
		});
		expect(
			fnByDescription(t, "Turjuman MCP server")!.Properties.MemorySize,
		).toBe(1024);
		// The others still take the shared default — tuning one doesn't disturb them.
		expect(fnByDescription(t, "Turjuman REST API")!.Properties.MemorySize).toBe(
			256,
		);
	});

	it("accepts a per-function code override (the seam tests/hot-reload use)", () => {
		// freshCode() already supplies all three; assert it synthesized real assets
		// rather than throwing — i.e. the override short-circuits vendored resolution.
		const t = synthWith();
		expect(resourcesOfType(t, "AWS::Lambda::Function")).toHaveLength(3);
	});

	it("can be dropped into a consumer stack and composed via its public members", () => {
		const outdir = mkdtempSync(join(tmpdir(), "turjuman-consumer-"));
		try {
			const app = new App({ outdir, analyticsReporting: false });
			const stack = new Stack(app, "Consumer");
			const turjuman = new Turjuman(stack, "Turjuman", { code: freshCode() });

			// Reach the public members — no new construct prop involved.
			new CfnOutput(stack, "MyTableName", {
				value: turjuman.table.tableName,
			});
			new CfnOutput(stack, "MyMcpUrl", { value: turjuman.mcpUrl.url });
			const extra = new lambda.Function(stack, "Extra", {
				runtime: lambda.Runtime.NODEJS_24_X,
				handler: "x.handler",
				code: lambda.Code.fromAsset(fixture),
			});
			// Grant the consumer's own function read access to the construct's table.
			turjuman.table.grantReadData(extra);

			const template = app.synth().getStackArtifact(stack.artifactId)
				.template as Cfn;

			// The construct's 3 functions plus the consumer's own.
			expect(resourcesOfType(template, "AWS::Lambda::Function")).toHaveLength(
				4,
			);
			expect(Object.keys(template.Outputs)).toEqual(
				expect.arrayContaining(["MyTableName", "MyMcpUrl"]),
			);
			// The grant against the public `table` member produced a real IAM policy.
			const json = JSON.stringify(template);
			expect(json).toContain("dynamodb:GetItem");
		} finally {
			rmSync(outdir, { recursive: true, force: true });
		}
	});
});
