// Small shared helpers: HTTP plumbing, base64, and the deterministic clock.
//
// Nothing in this file reads the wall clock for a value a client can see:
// timestamps come from a base instant (the trial's MAKEFUN_TRIAL_NOW when the
// harness provides one, a fixed epoch otherwise) advanced by a counter, so a
// replayed run produces the same bytes as the live one.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** The fixed base instant used when the trial does not name one. */
const FALLBACK_BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/** A deterministic clock: a base instant plus a tick counter. */
export class Clock {
  private readonly baseMs: number;
  private ticks = 0;

  constructor(baseIso: string | undefined) {
    const parsed = baseIso === undefined ? Number.NaN : Date.parse(baseIso);
    this.baseMs = Number.isFinite(parsed) ? parsed : FALLBACK_BASE_MS;
  }

  /** The next instant, one second after the previous one this clock handed out. */
  nextMs(): number {
    const ms = this.baseMs + this.ticks * 1000;
    this.ticks += 1;
    return ms;
  }

  /** The next instant as an ISO-8601 string. */
  nextIso(): string {
    return new Date(this.nextMs()).toISOString();
  }
}

/** Read a whole request body, capping its size so a bad client cannot balloon memory. */
export async function readBody(req: IncomingMessage, capBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > capBytes) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Whether a value is a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field of a record, or '' when absent or not a string. */
export function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** Send a JSON body with the REST surface's invariants (content type, request id). */
export function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId,
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

/** Send a bare status with no body (the REST surface's 204). */
export function sendEmpty(res: ServerResponse, status: number, requestId: string): void {
  res.writeHead(status, { 'x-github-request-id': requestId, 'content-length': 0 });
  res.end();
}

/** Standard base64 of a buffer (the contents API's encoding). */
export function b64encode(data: Buffer): string {
  return data.toString('base64');
}

/** Decode base64, tolerating the whitespace a client may wrap it in. */
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

/** Decode one URL path segment; malformed escapes pass through unchanged. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
