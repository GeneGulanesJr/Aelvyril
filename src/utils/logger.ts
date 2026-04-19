/**
 * Centralized logging utility
 * In production, logs are sent to error tracking service
 * In development, logs are sent to console with context
 */

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

interface LogContext {
  component?: string;
  action?: string;
  [key: string]: unknown;
}

class Logger {
  private isProduction = import.meta.env.PROD;
  private logBuffer: Array<{ level: LogLevel; message: string; context: LogContext; timestamp: number }> = [];
  private maxBufferSize = 100;

  private formatMessage(level: LogLevel, message: string, context: LogContext = {}): string {
    const contextStr = Object.keys(context).length > 0 
      ? ` | ${JSON.stringify(context)}` 
      : '';
    return `[${level.toUpperCase()}] ${message}${contextStr}`;
  }

  private log(level: LogLevel, message: string, context: LogContext = {}) {
    const timestamp = Date.now();
    const logEntry = { level, message, context, timestamp };

    // Store in buffer for error reporting
    this.logBuffer.push(logEntry);
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }

    // In production, you'd send to error tracking service (e.g., Sentry)
    // In development, use console
    if (!this.isProduction) {
      const formatted = this.formatMessage(level, message, context);
      switch (level) {
        case 'error':
          console.error(formatted);
          break;
        case 'warn':
          console.warn(formatted);
          break;
        case 'info':
          console.info(formatted);
          break;
        case 'debug':
          console.debug(formatted);
          break;
      }
    } else if (level === 'error') {
      // In production, send to error tracking service
      // Example: Sentry.captureException(new Error(message), { extra: context });
      this.sendToErrorTracking(message, context);
    }
  }

  private sendToErrorTracking(message: string, context: LogContext) {
    // Implement error tracking service integration
    // This is where you'd send to Sentry, LogRocket, etc.
    // For now, we store in localStorage for debugging
    try {
      const errors = JSON.parse(localStorage.getItem('aelvyril_errors') || '[]');
      errors.push({ message, context, timestamp: Date.now() });
      // Keep only last 50 errors
      if (errors.length > 50) errors.shift();
      localStorage.setItem('aelvyril_errors', JSON.stringify(errors));
    } catch {
      // Silently fail if localStorage is unavailable
    }
  }

  error(message: string, context?: LogContext) {
    this.log('error', message, context);
  }

  warn(message: string, context?: LogContext) {
    this.log('warn', message, context);
  }

  info(message: string, context?: LogContext) {
    this.log('info', message, context);
  }

  debug(message: string, context?: LogContext) {
    this.log('debug', message, context);
  }

  // Get recent errors for debugging
  getRecentErrors(count = 10): Array<{ level: LogLevel; message: string; context: LogContext; timestamp: number }> {
    return this.logBuffer
      .filter(entry => entry.level === 'error')
      .slice(-count);
  }

  // Clear the log buffer
  clear() {
    this.logBuffer = [];
  }
}

export const logger = new Logger();
