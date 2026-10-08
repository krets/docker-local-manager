import { Router } from 'express';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { discoverProjects } from '../services/discovery.js';
import * as git from '../services/git.js';
import * as docker from '../services/docker.js';
import { startOperation, isRunning, subscribeToStream } from '../lib/operations.js';
import { isDismissed, setDismissed } from '../lib/state.js';
import { config } from '../config.js';
import { isSelfProject, rebuildStepFor } from '../lib/self.js';

async function composeFileExists(project) {
  if (!project.composeFile) return false;
  return access(path.join(project.dir, project.composeFile))
    .then(() => true)
    .catch(() => false);
}

export const router = Router();

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function assertCleanAndAttached(status) {
  if (!status) throw httpError(400, 'Not a git-managed project');
  if (status.detached) throw httpError(409, 'HEAD is detached; use "Return to latest" first');
  if (status.dirty) throw httpError(409, 'Working tree is dirty; commit or discard changes first');
}

async function findProject(name) {
  const projects = await discoverProjects(config.projectsRoot);
  return projects.find((p) => p.name === name) ?? null;
}

async function buildProjectStatus(project) {
  const [gitStatus, composeFilePresent, isSelf, dismissed] = await Promise.all([
    git.getStatus(project.dir),
    composeFileExists(project),
    isSelfProject(project),
    isDismissed(project.name),
  ]);
  const services = composeFilePresent ? await docker.getServiceStatus(project.dir, project.composeFile) : [];

  return {
    name: project.name,
    git: gitStatus,
    composeFilePresent,
    isSelf,
    dismissed,
    services,
    rollup: docker.rollup(services),
    running: isRunning(project.name),
  };
}

/** Wraps a route handler that starts an operation: 404 if no such project, 409 if busy. */
async function handleStart(req, res, fn) {
  const project = await findProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const op = await fn(project);
    res.status(202).json({ operationId: op.id, status: op.status });
  } catch (err) {
    if (err.code === 'OPERATION_IN_PROGRESS') {
      return res.status(409).json({ error: err.message });
    }
    res.status(err.statusCode ?? 500).json({ error: err.message });
  }
}

router.get('/config', (req, res) => {
  res.json({ pollIntervalMs: config.pollIntervalMs, selfCheckIntervalMs: config.selfCheckIntervalMs });
});

router.get('/projects', async (req, res) => {
  const projects = await discoverProjects(config.projectsRoot);
  res.json(await Promise.all(projects.map(buildProjectStatus)));
});

router.get('/projects/:name', async (req, res) => {
  const project = await findProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(await buildProjectStatus(project));
});

for (const [action, value] of [['dismiss', true], ['restore', false]]) {
  router.post(`/projects/:name/${action}`, async (req, res) => {
    const project = await findProject(req.params.name);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    await setDismissed(project.name, value);
    res.json({ name: project.name, dismissed: value });
  });
}

router.get('/projects/:name/history', async (req, res) => {
  const project = await findProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(await git.getHistory(project.dir, config.historyLimit));
});

router.get('/projects/:name/ahead-behind', async (req, res) => {
  const project = await findProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(await git.getAheadBehind(project.dir));
});

router.post('/projects/:name/fetch', (req, res) =>
  handleStart(req, res, (project) => startOperation(project.name, 'fetch', [git.fetchStep(project.dir)])),
);

router.post('/projects/:name/pull', (req, res) =>
  handleStart(req, res, async (project) => {
    assertCleanAndAttached(await git.getStatus(project.dir));
    return startOperation(project.name, 'pull', [git.pullStep(project.dir)]);
  }),
);

router.post('/projects/:name/rebuild', (req, res) =>
  handleStart(req, res, async (project) => {
    if (!(await composeFileExists(project))) {
      throw httpError(409, 'No compose file at the current commit; "Return to latest" or pick a different commit first');
    }
    const steps = [];
    if (req.body?.pull) {
      assertCleanAndAttached(await git.getStatus(project.dir));
      steps.push(git.pullStep(project.dir));
    }
    steps.push((await rebuildStepFor(project)).step);
    return startOperation(project.name, 'rebuild', steps);
  }),
);

router.post('/projects/:name/checkout', (req, res) => {
  const { hash, rebuild } = req.body ?? {};
  if (!hash) return res.status(400).json({ error: 'hash is required' });

  return handleStart(req, res, async (project) => {
    const status = await git.getStatus(project.dir);
    if (status?.dirty) throw httpError(409, 'Working tree is dirty; commit or discard changes first');

    const steps = [git.checkoutStep(project.dir, hash)];
    if (rebuild) steps.push((await rebuildStepFor(project)).step);
    return startOperation(project.name, 'checkout', steps);
  });
});

router.post('/projects/:name/reattach', (req, res) =>
  handleStart(req, res, async (project) => {
    const branch = await git.getDefaultBranch(project.dir);
    if (!branch) throw httpError(400, "Couldn't resolve the remote's default branch");
    return startOperation(project.name, 'reattach', [git.reattachStep(project.dir, branch)]);
  }),
);

router.get('/projects/:name/stream', async (req, res) => {
  const project = await findProject(req.params.name);
  if (!project) return res.status(404).end();
  subscribeToStream(project.name, res);
});
