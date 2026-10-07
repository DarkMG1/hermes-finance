import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Finding = { path: string; line: number; kind: 'term' | 'email' | 'docs'; termIndex?: number };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const ALLOWED_EMAIL = /(@users\.noreply\.github\.com|@example\.com|@example\.org|\.test)$/i;
const alnum = (c: string | undefined) => c !== undefined && /[A-Za-z0-9]/.test(c);

function hasTerm(line: string, term: string): boolean {
  const hay = line.toLowerCase();
  const needle = term.toLowerCase();
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    if (!alnum(line[i - 1]) && !alnum(line[i + needle.length])) return true;
  }
  return false;
}

export function findPersonalData(
  files: { path: string; content: string }[],
  terms: string[],
): Finding[] {
  const out: Finding[] = [];
  for (const { path, content } of files) {
    if (path === 'package-lock.json' || path.endsWith('/package-lock.json')) continue;
    if (path.startsWith('docs/')) out.push({ path, line: 0, kind: 'docs' });
    content.split('\n').forEach((text, i) => {
      const line = i + 1;
      terms.forEach((term, termIndex) => {
        if (term && hasTerm(text, term)) out.push({ path, line, kind: 'term', termIndex });
      });
      if ((text.match(EMAIL) ?? []).some((m) => !ALLOWED_EMAIL.test(m))) {
        out.push({ path, line, kind: 'email' });
      }
    });
  }
  return out;
}

function main(): void {
  const denylist =
    process.env['HERMES_DENYLIST'] ?? join(homedir(), '.config', 'hermes', 'personal-denylist.txt');
  if (!existsSync(denylist)) {
    console.log(`personal-data check: denylist not found at ${denylist}`);
    process.exit(1);
  }
  const terms = readFileSync(denylist, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const names = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const files: { path: string; content: string }[] = [];
  for (const path of names) {
    const buf = execFileSync('git', ['show', `:${path}`], { maxBuffer: 256 * 1024 * 1024 });
    if (!buf.includes(0)) files.push({ path, content: buf.toString('utf8') });
  }
  const findings = findPersonalData(files, terms);
  for (const f of findings) {
    if (f.kind === 'docs') console.log(`${f.path}: docs/ must never be committed`);
    else if (f.kind === 'email') console.log(`${f.path}:${f.line}: email address`);
    else console.log(`${f.path}:${f.line}: personal data (term #${f.termIndex})`);
  }
  if (findings.length) process.exit(1);
  console.log('personal-data check: clean');
}

if (import.meta.main) main();
