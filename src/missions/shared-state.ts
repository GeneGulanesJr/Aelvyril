import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  FeaturesFile,
  HandoffEntry,
  ModelAssignment,
  BroadcastEntry,
  ErrorEntry,
  CommandEntry,
  ValidationContract,
} from './missions.types.js';
import { HandoffLog } from './handoff-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILLS_DIR = path.join(__dirname, 'default-skills');

export class SharedState {
  private handoffLog: HandoffLog;

  constructor(private missionDir: string) {
    this.handoffLog = new HandoffLog(path.join(missionDir, 'handoffs.jsonl'));
  }

  initialize(features: FeaturesFile, models: ModelAssignment): void {
    fs.mkdirSync(this.missionDir, { recursive: true });
    fs.mkdirSync(path.join(this.missionDir, 'research-findings'), { recursive: true });
    fs.mkdirSync(path.join(this.missionDir, 'agent-skills'), { recursive: true });
    this.seedDefaultSkills();

    this.writeFeatures(features);
    this.writeModelAssignment(models);

    this.ensureFile('broadcasts.jsonl');
    this.ensureFile('error-log.jsonl');
    this.ensureFile('command-log.jsonl');
  }

  getMissionDir(): string {
    return this.missionDir;
  }

  // features.json

  readFeatures(): FeaturesFile {
    return this.readJsonFile('features.json') as FeaturesFile;
  }

  writeFeatures(features: FeaturesFile): void {
    this.writeJsonFile('features.json', features);
  }

  advanceMilestone(): void {
    const features = this.readFeatures();
    if (features.current_milestone_index < features.milestones.length - 1) {
      features.milestones[features.current_milestone_index].status = 'done';
      features.current_milestone_index++;
      features.milestones[features.current_milestone_index].status = 'in_progress';
      this.writeFeatures(features);
    } else {
      features.milestones[features.current_milestone_index].status = 'done';
      this.writeFeatures(features);
    }
    this.clearValidationContract();
  }

  updateFeatureStatus(featureId: string, status: FeaturesFile['features'][number]['status']): void {
    const features = this.readFeatures();
    const feature = features.features.find(f => f.id === featureId);
    if (feature) {
      feature.status = status;
      this.writeFeatures(features);
    }
  }

  // handoffs.jsonl

  appendHandoff(entry: HandoffEntry): void {
    this.handoffLog.append(entry);
  }

  readHandoffs(): HandoffEntry[] {
    return this.handoffLog.readAll();
  }

  readLatestHandoff(): HandoffEntry | null {
    return this.handoffLog.readLatest();
  }

  // validation-contract.md

  writeValidationContract(contract: ValidationContract): void {
    const filePath = path.join(this.missionDir, 'validation-contract.md');
    const existing = this.readValidationContract();
    if (existing && existing.locked) {
      throw new Error('Validation contract is locked and cannot be overwritten');
    }
    const content = JSON.stringify(contract, null, 2);
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  readValidationContract(): ValidationContract | null {
    const filePath = path.join(this.missionDir, 'validation-contract.md');
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  lockValidationContract(): void {
    const contract = this.readValidationContract();
    if (contract) {
      contract.locked = true;
      const filePath = path.join(this.missionDir, 'validation-contract.md');
      fs.writeFileSync(filePath, JSON.stringify(contract, null, 2), 'utf-8');
    }
  }

  clearValidationContract(): void {
    const filePath = path.join(this.missionDir, 'validation-contract.md');
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  // model-assignment.json

  readModelAssignment(): ModelAssignment {
    return this.readJsonFile('model-assignment.json') as ModelAssignment;
  }

  writeModelAssignment(config: ModelAssignment): void {
    this.writeJsonFile('model-assignment.json', config);
  }

  // broadcasts.jsonl

  appendBroadcast(entry: BroadcastEntry): void {
    this.appendJsonl('broadcasts.jsonl', entry);
  }

  readBroadcasts(sinceIndex?: number): BroadcastEntry[] {
    const all = this.readJsonl('broadcasts.jsonl') as BroadcastEntry[];
    if (sinceIndex !== undefined) {
      return all.slice(sinceIndex);
    }
    return all;
  }

  // error-log.jsonl

  appendError(entry: ErrorEntry): void {
    this.appendJsonl('error-log.jsonl', entry);
  }

  readErrors(): ErrorEntry[] {
    return this.readJsonl('error-log.jsonl') as ErrorEntry[];
  }

  // command-log.jsonl

  appendCommand(entry: CommandEntry): void {
    this.appendJsonl('command-log.jsonl', entry);
  }

  // research-findings/

  writeResearchFinding(id: string, content: string): void {
    const dir = path.join(this.missionDir, 'research-findings');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.md`), content, 'utf-8');
  }

  readResearchFindings(): Map<string, string> {
    const dir = path.join(this.missionDir, 'research-findings');
    const result = new Map<string, string>();
    if (!fs.existsSync(dir)) return result;
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.md')) {
        const id = file.replace('.md', '');
        result.set(id, fs.readFileSync(path.join(dir, file), 'utf-8'));
      }
    }
    return result;
  }

  // worker.lock

  acquireWorkerLock(workerId: string, featureId: string): void {
    const filePath = path.join(this.missionDir, 'worker.lock');
    if (fs.existsSync(filePath)) {
      throw new Error(`Worker slot occupied: ${fs.readFileSync(filePath, 'utf-8')}`);
    }
    fs.writeFileSync(filePath, JSON.stringify({ worker_id: workerId, feature_id: featureId, timestamp: new Date().toISOString() }), 'utf-8');
  }

  releaseWorkerLock(): void {
    const filePath = path.join(this.missionDir, 'worker.lock');
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  readWorkerLock(): { worker_id: string; feature_id: string; timestamp: string } | null {
    const filePath = path.join(this.missionDir, 'worker.lock');
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  // private helpers

  private seedDefaultSkills(): void {
    if (!fs.existsSync(DEFAULT_SKILLS_DIR)) return;
    const targetDir = path.join(this.missionDir, 'agent-skills');
    for (const file of fs.readdirSync(DEFAULT_SKILLS_DIR)) {
      if (!file.endsWith('.md')) continue;
      const target = path.join(targetDir, file);
      if (!fs.existsSync(target)) {
        fs.copyFileSync(path.join(DEFAULT_SKILLS_DIR, file), target);
      }
    }
  }

  private ensureFile(name: string): void {
    const filePath = path.join(this.missionDir, name);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '', 'utf-8');
    }
  }

  private readJsonFile(name: string): unknown {
    const filePath = path.join(this.missionDir, name);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  private writeJsonFile(name: string, data: unknown): void {
    fs.writeFileSync(path.join(this.missionDir, name), JSON.stringify(data, null, 2), 'utf-8');
  }

  private appendJsonl(name: string, entry: unknown): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(path.join(this.missionDir, name), line, 'utf-8');
  }

  private readJsonl(name: string): unknown[] {
    const filePath = path.join(this.missionDir, name);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) return [];
    const entries: unknown[] = [];
    for (const line of content.split('\n')) {
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
