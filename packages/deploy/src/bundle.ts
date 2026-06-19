import { createHash } from "node:crypto";
import { join } from "node:path";
import AdmZip from "adm-zip";
import * as esbuild from "esbuild";
import type { EsbuildFunction } from "./functions.js";

export interface Artifact {
  logicalId: string;
  /** The zip to upload to S3. */
  zip: Buffer;
  /** Content hash of the bundle (stable across runs for identical source). */
  hash: string;
}

/**
 * Bundle one function with esbuild and wrap it in a Lambda deployment zip, using
 * the function's build settings (ESM, node20, createRequire banner). The hash is
 * derived from the bundle contents — not the zip bytes — so identical source
 * yields a stable S3 key and CloudFormation sees no change.
 */
export async function bundleFunction(root: string, fn: EsbuildFunction): Promise<Artifact> {
  const result = await esbuild.build({
    entryPoints: [join(root, fn.codeUri, fn.entryPoint)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    write: false,
    outfile: fn.outFile,
    ...(fn.banner ? { banner: { js: fn.banner } } : {}),
  });

  const bundle = result.outputFiles[0];
  if (!bundle) throw new Error(`esbuild produced no output for ${fn.logicalId}.`);
  const output = bundle.contents;
  const hash = createHash("sha256").update(output).digest("hex").slice(0, 16);

  const zip = new AdmZip();
  zip.addFile(fn.outFile, Buffer.from(output));
  // The bundle is ESM, so mark the package as a module — otherwise the Lambda
  // Node runtime loads the .js handler as CommonJS and throws "Cannot use import
  // statement outside a module". This mirrors what an ESM Lambda bundle needs.
  zip.addFile("package.json", Buffer.from('{"type":"module"}\n'));

  return { logicalId: fn.logicalId, zip: zip.toBuffer(), hash };
}
