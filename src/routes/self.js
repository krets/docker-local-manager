import { Router } from 'express';
import { discoverProjects } from '../services/discovery.js';
import * as git from '../services/git.js';
import { startOperation } from '../lib/operations.js';
import { bootId, findSelfProject, getSelfContainer, rebuildStepFor } from '../lib/self.js';
import { config } from '../config.js';

export const router = Router();

// Polled by the dashboard's restart countdown; must stay trivial and
// dependency-free so it answers the instant the new instance is listening.
router.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, bootId });
});

async function resolveSelf() {
  const [project, container] = await Promise.all([
    discoverProjects(config.projectsRoot).then(findSelfProject),
    getSelfContainer(),
  ]);
  return { project, container, detected: Boolean(project && container) };
}

router.get('/self', async (req, res) => {
  const { project, detected } = await resolveSelf();
  res.json({ detected, project: project?.name ?? null, bootId });
});

// Coalesce concurrent checks and reuse a recent result so several open tabs
// don't each hit the git remote.
let inFlight = null;
let last = null; // { at, result }

async function checkForUpdates(project) {
  await git.fetchQuiet(project.dir);
  const ab = await git.getAheadBehind(project.dir);
  return { available: Boolean(ab && ab.behind > 0), ...ab };
}

router.post('/self/check', async (req, res) => {
  const { project, detected } = await resolveSelf();
  if (!detected) return res.json({ detected: false, available: false });

  if (last && Date.now() - last.at < Math.min(30000, config.selfCheckIntervalMs / 2)) {
    return res.json({ detected: true, ...last.result });
  }
  try {
    inFlight ??= checkForUpdates(project).finally(() => {
      inFlight = null;
    });
    const result = await inFlight;
    last = { at: Date.now(), result };
    res.json({ detected: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/self/update', async (req, res) => {
  const { project, detected } = await resolveSelf();
  if (!detected) return res.status(409).json({ error: "Couldn't identify the manager's own container/project" });

  try {
    const status = await git.getStatus(project.dir);
    if (!status) throw Object.assign(new Error('Not a git-managed project'), { statusCode: 400 });
    if (status.detached) throw Object.assign(new Error('HEAD is detached; use "Return to latest" first'), { statusCode: 409 });
    if (status.dirty) throw Object.assign(new Error('Working tree is dirty; commit or discard changes first'), { statusCode: 409 });

    const { step } = await rebuildStepFor(project);
    const op = startOperation(project.name, 'self-update', [git.pullStep(project.dir), step]);
    last = null;
    res.status(202).json({ operationId: op.id, status: op.status, project: project.name });
  } catch (err) {
    res.status(err.code === 'OPERATION_IN_PROGRESS' ? 409 : (err.statusCode ?? 500)).json({ error: err.message });
  }
});
