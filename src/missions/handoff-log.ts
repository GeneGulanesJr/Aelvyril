import fs from 'fs';
import type { HandoffEntry } from './missions.types.js';

export class HandoffLog {
  constructor(private filePath: string) {
    const dir = fs.existsSync(filePath) ? undefined : fs.mkdirSync(filePath.substring(0, filePath.lastIndexOf('/')), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '');
    }
  }

  append(entry: HandoffEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.filePath, line, 'utf-8');
  }

  readAll(): HandoffEntry[] {
    return this.readLines();
  }

  readLatest(): HandoffEntry | null {
    const entries = this.readLines();
    return entries.length > 0 ? entries[entries.length - 1] : null;
  }

  readLatestForFeature(featureId: string): HandoffEntry | null {
    const entries = this.readLines();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].feature_id === featureId) {
        return entries[i];
      }
    }
    return null;
  }

  readForMilestone(milestoneIndex: number): HandoffEntry[] {
    return this.readLines().filter(e => e.milestone_index === milestoneIndex);
  }

  count(): number {
    return this.readLines().length;
  }

  private readLines(): HandoffEntry[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    const content = fs.readFileSync(this.filePath, 'utf-8');
    if (!content.trim()) {
      return [];
    }
    const entries: HandoffEntry[] = [];
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // skip corrupted lines
      }
    }
    return entries;
  }
}
