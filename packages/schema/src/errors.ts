/**
 * Typed application errors. Services throw these; transport layers (MCP, REST)
 * translate them into protocol-appropriate responses via {@link errorStatus}.
 */
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

export const unauthenticated = (m = "Authentication required") =>
  new AppError("UNAUTHENTICATED", m);
export const forbidden = (m = "Not allowed") => new AppError("FORBIDDEN", m);
export const notFound = (m = "Not found") => new AppError("NOT_FOUND", m);
export const conflict = (m = "Already exists") => new AppError("CONFLICT", m);
export const validation = (m: string) => new AppError("VALIDATION", m);

/** Map an error code to an HTTP status, used by the REST layer. */
export function errorStatus(code: ErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "VALIDATION":
      return 400;
    case "INTERNAL":
      return 500;
  }
}
