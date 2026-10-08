import { run } from '../lib/exec.js';

const composeBaseArgs = (composeFile) => ['compose', '-f', composeFile];

async function getImageCreated(image) {
  const { code, stdout } = await run('docker', ['image', 'inspect', image, '--format', '{{.Created}}']);
  if (code !== 0) return null;
  return stdout.trim();
}

/** One row per service defined in the compose file, per spec.md. */
export async function getServiceStatus(dir, composeFile) {
  const { code, stdout } = await run(
    'docker',
    [...composeBaseArgs(composeFile), 'ps', '-a', '--format', 'json'],
    { cwd: dir },
  );
  if (code !== 0) return [];

  const services = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  return Promise.all(
    services.map(async (svc) => ({
      service: svc.Service,
      image: svc.Image,
      state: svc.State,
      status: svc.Status,
      builtAt: await getImageCreated(svc.Image),
    })),
  );
}

/** Up / Partial / Down rollup for the project card header. */
export function rollup(services) {
  if (services.length === 0) return 'down';
  const runningCount = services.filter((s) => s.state === 'running').length;
  if (runningCount === services.length) return 'up';
  if (runningCount === 0) return 'down';
  return 'partial';
}

export const rebuildStep = (dir, composeFile) => ({
  label: 'docker compose up -d --build',
  command: 'docker',
  args: [...composeBaseArgs(composeFile), 'up', '-d', '--build'],
  cwd: dir,
});

export const CONTAINER_ACTIONS = ['start', 'stop', 'restart'];

/** Compose arguments (after `compose -f <file>`) for a start/stop/restart of the project or one service. */
export function containerArgs(action, service) {
  const target = service ? [service] : [];
  if (action === 'start') return ['up', '-d', ...target]; // no --build: just bring existing images up
  return [action, ...target];
}

export const containerStep = (dir, composeFile, action, service) => ({
  label: `docker compose ${containerArgs(action, service).join(' ')}`,
  command: 'docker',
  args: [...composeBaseArgs(composeFile), ...containerArgs(action, service)],
  cwd: dir,
});

/** Recent combined output of the project's (or one service's) containers. */
export async function getLogs(dir, composeFile, service, tail) {
  const { output } = await run(
    'docker',
    [...composeBaseArgs(composeFile), 'logs', '--no-color', '--tail', String(tail), ...(service ? [service] : [])],
    { cwd: dir },
  );
  return output;
}
