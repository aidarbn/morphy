// Everything that happened between the app and morphy-service in this session: each API call
// the app made, and the events the service logged (fetched from /api/logs while the Logs
// document is shown). Read by the Logs document and, for the error badge, by the navigator.
//
// Reconstructed: the original file sat in src/logs/, which the template's .gitignore ignores
// (`logs`), so it was never committed. The API is what LogsPane, Navigator, ErrorDialog and
// api/client.ts use.

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** An API call the app made, as the logs show it */
export interface ApiCall {
  requestId: string;
  /** When it was sent, as an ISO-8601 instant */
  time: string;
  method: string;
  url: string;
  /** What the call was for, e.g. 'Create game' */
  what: string;
  /** The HTTP status; 0 when no answer came; undefined while pending */
  status?: number;
  durationMs?: number;
  /** The service's answer to a failed call, or the reason no answer came */
  error?: string;
  level: LogLevel;
}

/** An event the service logged, as /api/logs returns it */
export interface ServerLogEntry {
  seq: number;
  time: string;
  level: LogLevel;
  logger: string;
  thread: string;
  message: string;
  stackTrace?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
}

export interface LogSnapshot {
  calls: readonly ApiCall[];
  serverEntries: readonly ServerLogEntry[];
  /** The request the user asked to see in the logs, from an error dialog */
  focusedRequestId: string | null;
  /** Failed calls not yet shown in the Logs document, for the badge */
  unseenErrors: number;
}

/** Identifies this app session to the service, so it can return the events of its requests. */
export const SESSION_ID = randomId();

/** API calls kept; older ones are dropped */
const MAX_CALLS = 1000;
/** Service events kept; older ones are dropped */
const MAX_SERVER_ENTRIES = 5000;

let snapshot: LogSnapshot = { calls: [], serverEntries: [], focusedRequestId: null, unseenErrors: 0 };
/** The seq of the last service event fetched, to ask for the ones after it */
let lastServerSeq = 0;
const listeners = new Set<() => void>();

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  }
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function set(next: Partial<LogSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): LogSnapshot {
  return snapshot;
}

/** A new id for an API call, sent as X-Request-Id so the service's events can be tied to it. */
export function newRequestId(): string {
  return randomId();
}

/** An API call was sent. */
export function callStarted(call: { requestId: string; time: string; method: string; url: string; what: string }) {
  const calls = [...snapshot.calls, { ...call, level: 'INFO' as LogLevel }];
  set({ calls: calls.length > MAX_CALLS ? calls.slice(calls.length - MAX_CALLS) : calls });
}

/**
 * An API call got its answer, or none.
 *
 * @param status the HTTP status, or 0 when no answer came
 * @param error the service's answer to a failed call, or why no answer came
 */
export function callFinished(requestId: string, status: number, durationMs: number, error?: string) {
  const failed = status === 0 || status >= 400;
  let found = false;
  const calls = snapshot.calls.map((c) => {
    if (c.requestId !== requestId) return c;
    found = true;
    return { ...c, status, durationMs, error, level: (failed ? 'ERROR' : 'INFO') as LogLevel };
  });
  if (!found) return;
  set({ calls, unseenErrors: failed ? snapshot.unseenErrors + 1 : snapshot.unseenErrors });
}

/** Fetches the service's events logged since the last fetch and keeps them. */
export async function fetchServerLogs(): Promise<void> {
  const res = await fetch(`/api/logs?after=${lastServerSeq}`, { headers: { 'X-Session-Id': SESSION_ID } });
  if (!res.ok) throw new Error(`Fetching the service's logs failed: ${res.status}`);
  const body = (await res.json()) as { entries: ServerLogEntry[]; lastSeq: number };
  if (body.entries.length === 0) {
    lastServerSeq = Math.max(lastServerSeq, body.lastSeq);
    return;
  }
  const known = new Set(snapshot.serverEntries.map((e) => e.seq));
  const fresh = body.entries.filter((e) => !known.has(e.seq));
  let serverEntries = [...snapshot.serverEntries, ...fresh];
  if (serverEntries.length > MAX_SERVER_ENTRIES) {
    serverEntries = serverEntries.slice(serverEntries.length - MAX_SERVER_ENTRIES);
  }
  lastServerSeq = Math.max(lastServerSeq, body.lastSeq, ...fresh.map((e) => e.seq));
  set({ serverEntries });
}

/** The user asked to see this request in the logs. */
export function focusRequest(requestId: string | null) {
  set({ focusedRequestId: requestId });
}

/** The errors so far have been shown in the Logs document. */
export function markSeen() {
  if (snapshot.unseenErrors !== 0) set({ unseenErrors: 0 });
}

/** Forgets the entries so far. The service's events are fetched again from here on. */
export function clearLogs() {
  set({ calls: [], serverEntries: [], focusedRequestId: null, unseenErrors: 0 });
}
