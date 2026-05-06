import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface Migration {
  version: number;
  name: string;
  up: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readSchemaSql(): string {
  return fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: readSchemaSql(),
  },
];
