/**
 * Logging with redaction. Nothing in this service logs request bodies, signatures or
 * payloads; redaction is the second line of defence.
 */

const REDACTED = "[redacted]";

const PATTERNS: Array<[RegExp, string]> = [
  // 65-byte signatures (0x + 130 hex) and 32-byte keys (64 hex)
  [/0x[0-9a-fA-F]{130}\b/g, REDACTED],
  [/\b(?:0x)?[0-9a-fA-F]{64}\b/g, REDACTED],
  [/(Bearer\s+)[^\s"',]+/gi, `$1${REDACTED}`],
  [
    /((?:password|passphrase|mnemonic|private[_-]?key|privateKey|secret|token|signature)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,&}]+)/gi,
    `$1${REDACTED}`,
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type LogSink = (level: "info" | "warn" | "error", line: string) => void;

const defaultSink: LogSink = (level, line) => {
  if (level === "info") process.stdout.write(line + "\n");
  else process.stderr.write(line + "\n");
};

export function createLogger(sink: LogSink = defaultSink): Logger {
  const write = (level: "info" | "warn" | "error", msg: string) =>
    sink(level, `${new Date().toISOString()} ${level.toUpperCase()} ${redact(msg)}`);
  return {
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
