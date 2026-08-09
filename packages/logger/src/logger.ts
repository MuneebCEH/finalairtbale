import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';

import { getContext } from './context';
import { redact } from './redact';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerOptionsInput {
  readonly name: string;
  readonly level?: LogLevel;
  readonly pretty?: boolean;
  readonly base?: Record<string, unknown>;
}

export interface Logger {
  trace(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  fatal(message: string, fields?: Record<string, unknown>): void;
  /** Returns a logger with the given fields bound to every subsequent line. */
  child(fields: Record<string, unknown>): Logger;
}

function buildPinoOptions(input: LoggerOptionsInput): LoggerOptions {
  const options: LoggerOptions = {
    name: input.name,
    level: input.level ?? 'info',
    base: { service: input.name, ...input.base },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Belt and braces: pino's own redaction handles the common header paths cheaply, and our
    // deep redactor in `write` catches everything else including nested and shape-based secrets.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.secret',
      ],
      censor: '[redacted]',
    },
  };

  if (input.pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
    };
  }

  return options;
}

class PinoLoggerAdapter implements Logger {
  constructor(private readonly instance: PinoLogger) {}

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    const context = getContext();
    const payload = {
      ...(context ? { ...context } : {}),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    this.instance[level](payload, message);
  }

  trace(message: string, fields?: Record<string, unknown>): void {
    this.write('trace', message, fields);
  }
  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }
  fatal(message: string, fields?: Record<string, unknown>): void {
    this.write('fatal', message, fields);
  }

  child(fields: Record<string, unknown>): Logger {
    return new PinoLoggerAdapter(this.instance.child(redact(fields) as Record<string, unknown>));
  }
}

export function createLogger(input: LoggerOptionsInput): Logger {
  return new PinoLoggerAdapter(pino(buildPinoOptions(input)));
}

/**
 * A logger that discards everything. Used in tests so a failing assertion is not buried under
 * a thousand log lines.
 */
export function createNullLogger(): Logger {
  const noop = (): void => undefined;
  const nullLogger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => nullLogger,
  };
  return nullLogger;
}
