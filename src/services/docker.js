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
    [...composeBaseArgs(composeFile), 'ps', '--format', 'json'],
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
