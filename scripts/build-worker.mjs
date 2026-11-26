// Builds the Cloudflare Worker bundle locally WITHOUT deploying (wrangler --dry-run).
// Output: cloudflare/dist_worker/ (gitignored). Needs no Cloudflare login.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', 'dist_worker'], {
  cwd: path.join(root, 'cloudflare'),
  stdio: 'inherit',
  shell: process.platform === 'win32'
});
process.exit(r.status ?? 1);
