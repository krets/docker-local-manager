import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './exec.js';
import * as docker from '../services/docker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ownPackageJson = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));

// Used to recognize the manager's own project among the discovered ones.
export const selfName = ownPackageJson.name;

// Changes on every process start. The dashboard compares it across a
// restart to tell "the new instance is up" from "the old one hasn't died yet".
export const bootId = randomUUID();

/** Detects the manager's own project dir by matching its package.json name. */
export async function isSelfProject(project) {
  try {
    const pkg = JSON.parse(await readFile(path.join(project.dir, 'package.json'), 'utf8'));
    return pkg.name === selfName;
  } catch {
    return false;
  }
}

export async function findSelfProject(projects) {
  for (const project of projects) {
    if (await isSelfProject(project)) return project;
  }
  return null;
}

let selfContainer = null;

/**
 * The container this process is running in, via the docker socket: a
 * container's default hostname is its short id. Returns null when not
 * containerised (local dev) or the hostname doesn't resolve to a container
 * (e.g. host networking), in which case self-restart falls back to a plain
 * rebuild. Only successful lookups are cached.
 */
export async function getSelfContainer() {
  if (selfContainer) return selfContainer;
  const ref = process.env.SELF_CONTAINER ?? os.hostname();
  const { code, stdout } = await run('docker', ['inspect', '--format', '{{.Id}}|{{.Image}}', ref]).catch(() => ({ code: 1 }));
  if (code !== 0) return null;
  const [id, image] = stdout.trim().split('|');
  selfContainer = { id, image };
  return selfContainer;
}

/**
 * Rebuilding the manager from inside the manager would kill the very process
 * running `docker compose up`, possibly mid-recreate. Instead, launch a
 * short-lived sibling container (same image, same mounts via --volumes-from)
 * that outlives us and performs the rebuild; `docker run -d` returns at once,
 * so the operation completes cleanly and the dashboard takes over from there.
 */
function selfRestartStep(project, container) {
  return {
    label: 'restart manager (detached helper container)',
    command: 'docker',
    args: [
      'run', '-d', '--rm',
      '--name', `docker-local-manager-restart-${Date.now()}`,
      '--volumes-from', container.id,
      '--workdir', project.dir,
      '--entrypoint', 'sh',
      container.image,
      '-c', 'sleep 3; exec docker compose -f "$1" up -d --build',
      'sh', project.composeFile,
    ],
    cwd: project.dir,
  };
}

/** The rebuild step for a project: the detached-helper variant for the manager's own. */
export async function rebuildStepFor(project) {
  if (await isSelfProject(project)) {
    const container = await getSelfContainer();
    if (container) return { step: selfRestartStep(project, container), selfRestart: true };
  }
  return { step: docker.rebuildStep(project.dir, project.composeFile), selfRestart: false };
}
