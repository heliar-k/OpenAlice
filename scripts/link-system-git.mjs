#!/usr/bin/env node
/**
 * dugite's postinstall downloads a bundled git binary from GitHub, which
 * is slow/unreachable on some networks.  This script creates symlinks so
 * dugite uses the system git instead.  No-op when the directory already
 * exists (e.g. dugite's own postinstall already ran).
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

let dugiteRoot;
try {
  dugiteRoot = dirname(createRequire(import.meta.url).resolve('dugite/package.json'));
} catch {
  process.exit(0);
}

const gitDir = join(dugiteRoot, 'git');
// If dugite's own postinstall already created the directory, don't touch it.
if (existsSync(join(gitDir, 'bin', 'git'))) process.exit(0);

const sysGit = process.env.GIT_BINARY || findSystemGit();
if (!sysGit) {
  console.error('[link-system-git] system git not found — dugite may fail');
  process.exit(0);
}

const sysExecPath = execSync(`${sysGit} --exec-path`, { encoding: 'utf8' }).trim();

mkdirSync(join(gitDir, 'bin'), { recursive: true });
mkdirSync(join(gitDir, 'libexec'), { recursive: true });
mkdirSync(join(gitDir, 'share', 'git-core', 'templates'), { recursive: true });
mkdirSync(join(gitDir, 'etc'), { recursive: true });

symlinkSync(sysGit, join(gitDir, 'bin', 'git'));
symlinkSync(sysExecPath, join(gitDir, 'libexec', 'git-core'));
writeFileSync(join(gitDir, 'etc', 'gitconfig'), '');

console.log(`[link-system-git] linked ${sysGit} → dugite`);

function findSystemGit() {
  try {
    return execSync('which git', { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}
