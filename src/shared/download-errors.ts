const TRANSIENT = new Set([
  'NETWORK_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED', 'NETWORK_SERVER_DOWN', 'SERVER_FAILED',
  'SERVER_CONTENT_LENGTH_MISMATCH', 'SERVER_UNREACHABLE', 'FILE_TRANSIENT_ERROR', 'FILE_TOO_SHORT', 'CRASH',
]);

const MESSAGES: Record<string, string> = {
  NETWORK_FAILED: 'Network error. Check your connection.',
  NETWORK_TIMEOUT: 'The server took too long to respond.',
  NETWORK_DISCONNECTED: 'Network connection was lost.',
  NETWORK_SERVER_DOWN: 'The server is not responding.',
  SERVER_FAILED: 'The server returned an error.',
  SERVER_UNREACHABLE: 'The server could not be reached.',
  SERVER_BAD_CONTENT: 'File not found on the server. It may have been deleted.',
  SERVER_FORBIDDEN: 'The server refused access to this file.',
  SERVER_UNAUTHORIZED: 'This file requires authentication, which this extension does not bypass.',
  SERVER_CERT_PROBLEM: 'The server certificate was rejected.',
  SERVER_CONTENT_LENGTH_MISMATCH: 'The download ended early (size mismatch).',
  SERVER_CROSS_ORIGIN_REDIRECT: 'The server redirected to a different site, which was blocked.',
  FILE_ACCESS_DENIED: 'Permission denied while writing the file.',
  FILE_NO_SPACE: 'Not enough disk space.',
  FILE_NAME_TOO_LONG: 'The file path is too long. Shorten the folder or filename settings.',
  FILE_TOO_LARGE: 'The file is too large for the destination.',
  FILE_BLOCKED: 'The browser blocked this file.',
  FILE_SECURITY_CHECK_FAILED: 'The browser security check failed.',
  FILE_VIRUS_INFECTED: 'The browser flagged this file as unsafe.',
  FILE_TRANSIENT_ERROR: 'A temporary file error occurred.',
  FILE_TOO_SHORT: 'The file was incomplete.',
  FILE_FAILED: 'The file could not be saved.',
  USER_CANCELED: 'Cancelled.',
  USER_SHUTDOWN: 'Interrupted because the browser closed.',
  CRASH: 'The browser stopped unexpectedly.',
};

export function classifyInterrupt(reason?: string): { transient: boolean; message: string } {
  const r = reason ?? 'UNKNOWN';
  return { transient: TRANSIENT.has(r), message: MESSAGES[r] ?? `Download failed (${r}).` };
}

/** Errors thrown by downloads.download() itself (before a download exists). */
export function classifyStartError(message: string): { transient: boolean; message: string } {
  if (/invalid filename/i.test(message)) return { transient: false, message: 'The generated filename was rejected by the browser.' };
  if (/blocked|policy|not allowed/i.test(message)) return { transient: false, message: 'The browser blocked this download.' };
  if (/network|timeout|temporar/i.test(message)) return { transient: true, message: 'Network error starting the download.' };
  return { transient: false, message: `Could not start download: ${message}` };
}
