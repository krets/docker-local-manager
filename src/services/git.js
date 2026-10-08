import { run } from '../lib/exec.js';

// Remembers the last branch each project was attached to, keyed by dir, so
// "Return to latest" (reattach) has a network-free fallback -- see the
// comment on getDefaultBranch below for why refs/remotes/origin/HEAD alone
// isn't reliable enough. Lost on restart; repopulated the next time getStatus
// observes a non-detached HEAD.
const lastKnownBranch = new Map();

export async function isGitRepo(dir) {
  const { code } = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
  return code === 0;
}

/**
 * Local-only status (no network). aheadBehind is intentionally absent here --
 * it's only ever populated by an explicit "Check for Updates" fetch, per
 * spec.md, so the dashboard poll never touches the network.
 */
export async function getStatus(dir) {
  if (!(await isGitRepo(dir))) return null;

  const [hashRes, messageRes, branchRes, dirtyRes] = await Promise.all([
    run('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir }),
    run('git', ['log', '-1', '--pretty=%s'], { cwd: dir }),
    run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }),
    run('git', ['status', '--porcelain'], { cwd: dir }),
  ]);

  const branch = branchRes.stdout.trim();
  const detached = branch === 'HEAD';

  if (!detached) lastKnownBranch.set(dir, branch);

  return {
    hash: hashRes.stdout.trim(),
    message: messageRes.stdout.trim(),
    branch: detached ? null : branch,
    detached,
    dirty: dirtyRes.stdout.trim().length > 0,
  };
}

/** Requires a prior `git fetch`; returns null if there's no upstream (e.g. detached HEAD). */
export async function getAheadBehind(dir) {
  const { code, stdout } = await run(
    'git',
    ['rev-list', '--left-right', '--count', 'HEAD...@{u}'],
    { cwd: dir },
  );
  if (code !== 0) return null;

  const [ahead, behind] = stdout.trim().split(/\s+/).map(Number);
  return { ahead, behind, checkedAt: new Date().toISOString() };
}

export async function getHistory(dir, limit) {
  const { stdout } = await run(
    'git',
    ['log', '-n', String(limit), '--pretty=%h|%s|%cI'],
    { cwd: dir },
  );

  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, message, date] = line.split('|');
      return { hash, message, date };
    });
}

/**
 * The branch "Return to latest" should check out, resolved without any
 * network call. `refs/remotes/origin/HEAD` is the obvious source but it's
 * only set by `git clone` -- a repo whose remote was added by hand (or that
 * had this ref pruned) won't have it, so we fall back to the last branch
 * this process actually saw the project attached to (see lastKnownBranch).
 */
export async function getDefaultBranch(dir) {
  const { code, stdout } = await run(
    'git',
    ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    { cwd: dir },
  );
  if (code === 0) return stdout.trim().replace('refs/remotes/origin/', '');

  return lastKnownBranch.get(dir) ?? null;
}

export const fetchStep = (dir) => ({ label: 'git fetch', command: 'git', args: ['fetch'], cwd: dir });
export const pullStep = (dir) => ({ label: 'git pull', command: 'git', args: ['pull'], cwd: dir });
export const checkoutStep = (dir, hash) => ({
  label: `git checkout ${hash}`,
  command: 'git',
  args: ['checkout', hash],
  cwd: dir,
});
export const reattachStep = (dir, branch) => ({
  label: `git checkout ${branch}`,
  command: 'git',
  args: ['checkout', branch],
  cwd: dir,
});

/** Quiet, bounded fetch for background checks (no operation record/log). */
export async function fetchQuiet(dir, timeoutMs = 60000) {
  const { code, stderr } = await run('git', ['fetch'], { cwd: dir, timeoutMs });
  if (code !== 0) throw new Error(stderr.trim() || `git fetch exited ${code}`);
}
