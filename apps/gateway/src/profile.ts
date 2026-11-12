import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";

export interface Profile {
  /** What the assistant calls itself. */
  assistantName: string;
  /** What the assistant calls the person; empty = it doesn't use a name. */
  yourName: string;
}

export const DEFAULT_ASSISTANT_NAME = "Aelvyril";

/** A name goes into the assistant's instructions, so keep it to one short plain line. */
const clean = (v: unknown, max = 40) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The two names the person can set. Lives in the data folder next to the database. */
export class ProfileStore {
  private file: string;
  private value: Profile;
  private onChange: () => void;

  constructor(cfg: Config, onChange: () => void = () => {}) {
    this.onChange = onChange;
    this.file = join(cfg.dataDir, "profile.json");
    let saved: Partial<Profile> = {};
    try {
      if (existsSync(this.file)) saved = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      // a damaged file just means defaults
    }
    this.value = { assistantName: clean(saved.assistantName) || DEFAULT_ASSISTANT_NAME, yourName: clean(saved.yourName) };
  }

  get(): Profile {
    return { ...this.value };
  }

  /** Empty assistant name means "back to the default". Restarts the assistant's process on the next turn so it picks the change up. */
  set(next: Partial<Profile>): Profile {
    this.value = {
      assistantName: "assistantName" in next ? clean(next.assistantName) || DEFAULT_ASSISTANT_NAME : this.value.assistantName,
      yourName: "yourName" in next ? clean(next.yourName) : this.value.yourName,
    };
    writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    this.onChange();
    return this.get();
  }
}
