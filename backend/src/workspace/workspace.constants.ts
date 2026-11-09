export const READ_DEFAULT_LIMIT = 300;
export const READ_MAX_LIMIT = 1000;
export const READ_LINE_TRUNCATE = 500;
export const READ_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_WRITE_CHARS = 100 * 1024;
export const MAX_WRITE_BASE64_BYTES = 8 * 1024 * 1024;
export const MAX_EDIT_OLD_CHARS = 2 * 1024;
export const MAX_LIST_ENTRIES = 200;
export const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const EXEC_MAX_TIMEOUT_MS = 600_000;
export const EXEC_OUTPUT_CAP = 8 * 1024;

export const DENY_PATTERNS: Array<[RegExp, string]> = [
  [/\bsudo\b/, 'sudo'],
  [/\bosascript\b/, 'osascript'],
  [/\.ssh\b/, '~/.ssh access'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'piping a download into a shell'],
  [/\brm\s+[^;|&]*-(\w*r\w*f|\w*f\w*r)\w*\s+(\/|~|\$HOME)(\s|['"]|$)/, 'rm -rf on an absolute or home path'],
  [/\bchmod\s+-R\s+777\s+\/(\s|$)/, 'chmod -R 777 /'],
  [/\b(shutdown|reboot|halt)\b/, 'shutdown/reboot'],
];
