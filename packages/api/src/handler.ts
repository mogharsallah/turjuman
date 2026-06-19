import { TurjumanService, Repository, repositoryFromEnv } from "@turjuman/core";
import { handle } from "hono/aws-lambda";
import { createApp } from "./router.js";

/** AWS Lambda entry point for the Turjuman REST API (API Gateway HTTP API v2
 * / Lambda Function URL). Hono's aws-lambda adapter parses the event (method,
 * path, query, base64 body) and serializes the Response. */

const repo: Repository = repositoryFromEnv();
const service = new TurjumanService(repo);
const app = createApp({ repo, service });

export const handler = handle(app);
