import fs from 'fs';
import path from 'path';
import type { SharedState } from './shared-state.js';

export class SkillLoader {
  constructor(private sharedState: SharedState) {}

  loadSkill(name: string, vars?: Record<string, string>): string {
    const skillsDir = path.join(this.sharedState.getMissionDir(), 'agent-skills');
    const filePath = path.join(skillsDir, `${name}.md`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Skill not found: ${name}`);
    }
    let content = fs.readFileSync(filePath, 'utf-8');
    if (vars) {
      for (const [key, value] of Object.entries(vars)) {
        content = content.replaceAll(`{{${key}}}`, value);
      }
    }
    return content;
  }

  listSkills(): string[] {
    const skillsDir = path.join(this.sharedState.getMissionDir(), 'agent-skills');
    if (!fs.existsSync(skillsDir)) return [];
    return fs.readdirSync(skillsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', ''));
  }
}
