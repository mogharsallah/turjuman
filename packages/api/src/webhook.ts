import { createHmac } from "node:crypto";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import {
  Repository,
  type Webhook,
  type WebhookEvent,
  logError,
  logInfo,
  repositoryFromEnv,
} from "@turjuman/core";

/**
 * DynamoDB Streams → webhook dispatcher.
 *
 * Triggered by changes to the Turjuman table, it maps relevant item changes to
 * events, looks up each project's webhooks, and delivers HMAC-signed POSTs. Off
 * the request path, so the API/MCP latency is unaffected.
 *
 * Delivery is best-effort / at-most-once: a single unreachable, slow, or
 * error-returning endpoint is logged and skipped so it can never block the
 * others, and we do not re-throw (which would make the stream re-deliver the
 * whole batch to endpoints that already succeeded). Consumers should treat
 * events as fire-and-forget.
 */
const repo: Repository = repositoryFromEnv();

/** Per-delivery timeout; a hanging endpoint must not stall the whole batch. */
const DELIVERY_TIMEOUT_MS = Number(process.env.TURJUMAN_WEBHOOK_TIMEOUT_MS) || 5000;

interface StreamRecord {
  eventName?: "INSERT" | "MODIFY" | "REMOVE";
  dynamodb?: {
    NewImage?: Record<string, AttributeValue>;
    OldImage?: Record<string, AttributeValue>;
  };
}

export interface DispatchEvent {
  event: WebhookEvent;
  data: Record<string, unknown>;
}

export async function handler(event: { Records?: StreamRecord[] }): Promise<void> {
  const byProject = new Map<string, DispatchEvent[]>();
  const baseLocaleCache = new Map<string, string | undefined>();

  for (const record of event.Records ?? []) {
    const image = record.dynamodb?.NewImage ?? record.dynamodb?.OldImage;
    if (!image) continue;
    const item = unmarshall(image) as Record<string, unknown>;
    const mapped = mapEvent(String(item.entityType), record.eventName);
    if (!mapped) continue;
    const projectId = item.projectId as string | undefined;
    if (!projectId) continue;
    const list = byProject.get(projectId) ?? [];
    list.push({ event: mapped, data: summarize(item) });

    // A base-locale value change moves the source on, so dependent translations
    // for that key are now stale. Emit a one-off signal keyed on the key.
    if (item.entityType === "Translation" && record.eventName === "MODIFY") {
      const oldImage = record.dynamodb?.OldImage;
      const old = oldImage ? (unmarshall(oldImage) as Record<string, unknown>) : undefined;
      if (old && old.value !== item.value) {
        const baseLocale = await baseLocaleFor(projectId, baseLocaleCache);
        if (baseLocale && item.localeCode === baseLocale) {
          list.push({
            event: "translation.stale",
            data: { namespace: item.namespace, key: item.keyName },
          });
        }
      }
    }
    byProject.set(projectId, list);
  }

  // One summary line per stream batch that maps to ≥1 event (most table writes map
  // to none, so this stays quiet). Makes dispatcher activity visible in the logs.
  const eventCount = [...byProject.values()].reduce((n, list) => n + list.length, 0);
  if (eventCount > 0) {
    logInfo({
      msg: "webhook_batch",
      records: event.Records?.length ?? 0,
      projects: byProject.size,
      events: eventCount,
    });
  }

  await Promise.all([...byProject].map(([projectId, events]) => dispatch(projectId, events)));
}

/** Project base locale, cached per invocation so a batch costs at most one read each. */
async function baseLocaleFor(
  projectId: string,
  cache: Map<string, string | undefined>,
): Promise<string | undefined> {
  if (!cache.has(projectId)) cache.set(projectId, (await repo.getProject(projectId))?.baseLocale);
  return cache.get(projectId);
}

function mapEvent(entityType: string, eventName?: string): WebhookEvent | null {
  switch (entityType) {
    case "Translation":
      return eventName === "REMOVE" ? null : "translation.updated";
    case "TranslationKey":
      return eventName === "INSERT"
        ? "key.created"
        : eventName === "REMOVE"
          ? "key.deleted"
          : "key.updated";
    case "Locale":
      return eventName === "INSERT" ? "locale.added" : null;
    default:
      return null;
  }
}

function summarize(item: Record<string, unknown>): Record<string, unknown> {
  switch (item.entityType) {
    case "Translation":
      return {
        namespace: item.namespace,
        key: item.keyName,
        locale: item.localeCode,
        status: item.status,
      };
    case "TranslationKey":
      return { namespace: item.namespace, key: item.name };
    case "Locale":
      return { code: item.code };
    default:
      return {};
  }
}

async function dispatch(projectId: string, events: DispatchEvent[]): Promise<void> {
  const webhooks = await repo.listWebhooks(projectId);
  if (webhooks.length === 0) return;
  await Promise.all(
    webhooks.flatMap((webhook) =>
      events
        .filter((e) => webhook.events.includes("*") || webhook.events.includes(e.event))
        .map((e) => deliver(webhook, projectId, e)),
    ),
  );
}

export async function deliver(
  webhook: Webhook,
  projectId: string,
  e: DispatchEvent,
  timeoutMs: number = DELIVERY_TIMEOUT_MS,
): Promise<void> {
  const body = JSON.stringify({
    event: e.event,
    projectId,
    timestamp: new Date().toISOString(),
    data: e.data,
  });
  const signature = createHmac("sha256", webhook.secret).update(body).digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Turjuman-Event": e.event,
        "X-Turjuman-Signature": `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });
    // `fetch` only rejects on network/abort errors, so an endpoint returning 4xx/5xx
    // would otherwise be counted as a successful delivery — check the status too.
    const fields = { projectId, event: e.event, webhookId: webhook.id, url: webhook.url };
    if (res.ok) {
      logInfo({ msg: "webhook_delivered", ...fields, status: res.status });
    } else {
      logError({ msg: "webhook_delivery_failed", ...fields, status: res.status });
    }
  } catch (err) {
    // Best-effort: an unreachable or timed-out endpoint is logged and skipped so it
    // never blocks the others. We deliberately do not re-throw (see file header).
    const reason = controller.signal.aborted ? `timeout after ${timeoutMs}ms` : (err as Error).message;
    logError({
      msg: "webhook_delivery_failed",
      projectId,
      event: e.event,
      webhookId: webhook.id,
      url: webhook.url,
      reason,
    });
  } finally {
    clearTimeout(timer);
  }
}
