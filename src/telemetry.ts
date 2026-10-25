import * as core from '@actions/core';

export interface TelemetryEvent {
  eventName: string;
  durationMs?: number;
  reviewedFilesCount?: number;
  totalFindingsCount?: number;
  publishedFindingsCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  status?: string;
  reasonCode?: string;
  [key: string]: unknown;
}

export class SafeLogger {
  private static registeredSecrets: string[] = [];
  private static activeGroups: string[] = [];

  public static registerSecret(secret: string): void {
    if (secret && secret.length > 3) {
      this.registeredSecrets.push(secret);
      core.setSecret(secret);
    }
  }

  public static sanitize(message: string): string {
    let sanitized = message;
    for (const secret of this.registeredSecrets) {
      if (secret) {
        sanitized = sanitized.replaceAll(secret, '[REDACTED_SECRET]');
      }
    }
    // Redact credential patterns
    sanitized = sanitized
      .replace(/ghp_[0-9a-zA-Z]{36}/g, '[REDACTED_TOKEN]')
      .replace(/AIza[0-9A-Za-z\\-_]{35}/g, '[REDACTED_KEY]')
      .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]');

    // Prevent workflow command injection by neutralizing modern (::) and legacy (##[) command syntax
    sanitized = sanitized
      .replace(/^(\s*)::/gm, '$1: :')
      .replace(/^(\s*)##\[/gm, '$1# #[')
      .replace(/##\[/g, '# #[');

    return sanitized;
  }

  public static startGroup(name: string): void {
    const safeName = this.sanitize(name).replace(/[\r\n]+/g, ' ').trim();
    this.activeGroups.push(safeName);
    core.startGroup(safeName);
  }

  public static endGroup(): void {
    if (this.activeGroups.length > 0) {
      this.activeGroups.pop();
      core.endGroup();
    }
  }

  public static closeAllGroups(): void {
    while (this.activeGroups.length > 0) {
      this.activeGroups.pop();
      core.endGroup();
    }
  }

  public static info(message: string): void {
    core.info(this.sanitize(message));
  }

  public static warning(message: string): void {
    core.warning(this.sanitize(message));
  }

  public static error(message: string): void {
    core.error(this.sanitize(message));
  }

  public static logMetrics(event: TelemetryEvent): void {
    const summary = Object.entries(event)
      .map(([key, val]) => `${key}=${JSON.stringify(val)}`)
      .join(' ');
    core.info(this.sanitize(`[Metrics] ${summary}`));
  }
}
