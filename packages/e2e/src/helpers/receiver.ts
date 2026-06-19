import http from "node:http";

/** A single captured inbound HTTP request (the webhook delivery). */
export interface CapturedRequest {
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface Receiver {
  /** Port the receiver is listening on (host side). */
  port: number;
  /** Resolve with the next not-yet-consumed request, or reject after `timeoutMs`. */
  next(timeoutMs: number): Promise<CapturedRequest>;
  /**
   * Resolve with the first delivery (past or future) matching `predicate`, or
   * reject after `timeoutMs`. Unlike {@link next} this scans every delivery and
   * does not consume, so it tolerates out-of-order webhook arrival.
   */
  waitFor(predicate: (r: CapturedRequest) => boolean, timeoutMs: number): Promise<CapturedRequest>;
  /** Snapshot of every delivery received so far. */
  received(): CapturedRequest[];
  close(): void;
}

/**
 * Start a throwaway HTTP server that records inbound requests. Used as the
 * webhook target for the deployed dispatcher; bound to 0.0.0.0 so the Lambda
 * container can reach it via host.docker.internal.
 */
export function startReceiver(): Promise<Receiver> {
  return new Promise((resolve) => {
    const all: CapturedRequest[] = [];
    let cursor = 0;
    const listeners = new Set<() => void>();

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.statusCode = 200;
        res.end("ok");
        all.push({ headers: req.headers, body });
        for (const notify of [...listeners]) notify();
      });
    });

    /** Generic wait: resolve via `tryResolve`, retrying on each new delivery. */
    function wait<T>(
      tryResolve: () => { done: true; value: T } | { done: false },
      timeoutMs: number,
      timeoutMessage: string,
    ): Promise<T> {
      return new Promise<T>((res, rej) => {
        // `timer` is declared first (and may stay undefined) so the synchronous
        // initial check() below can call cleanup() without hitting a temporal
        // dead zone when a matching delivery is already queued.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const listener = () => check();
        function cleanup() {
          listeners.delete(listener);
          if (timer) clearTimeout(timer);
        }
        function check(): boolean {
          const r = tryResolve();
          if (r.done) {
            cleanup();
            res(r.value);
            return true;
          }
          return false;
        }
        if (check()) return;
        timer = setTimeout(() => {
          cleanup();
          rej(new Error(timeoutMessage));
        }, timeoutMs);
        listeners.add(listener);
      });
    }

    server.listen(0, "0.0.0.0", () => {
      const { port } = server.address() as { port: number };
      resolve({
        port,
        next(timeoutMs) {
          return wait<CapturedRequest>(
            () =>
              cursor < all.length
                ? { done: true, value: all[cursor++] as CapturedRequest }
                : { done: false },
            timeoutMs,
            "Timed out waiting for a webhook delivery",
          );
        },
        waitFor(predicate, timeoutMs) {
          return wait<CapturedRequest>(
            () => {
              const found = all.find(predicate);
              return found ? { done: true, value: found } : { done: false };
            },
            timeoutMs,
            "Timed out waiting for a matching webhook delivery",
          );
        },
        received() {
          return [...all];
        },
        close() {
          server.close();
        },
      });
    });
  });
}
