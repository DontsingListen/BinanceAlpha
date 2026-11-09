import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

/** Content hash of all source files, recorded on every run so events can be traced to the code that produced them. */
export function computeCodeHash(rootDir: string): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts')) files.push(full);
    }
  };
  walk(join(rootDir, 'src'));
  const h = createHash('sha256');
  for (const f of files) {
    h.update(relative(rootDir, f));
    h.update('\u0000');
    h.update(readFileSync(f));
    h.update('\u0000');
  }
  return h.digest('hex');
}
