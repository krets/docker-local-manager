const projectsRoot = process.env.PROJECTS_ROOT ?? '/docker';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  projectsRoot,
  stateFile: process.env.STATE_FILE ?? `${projectsRoot}/.docker-local-manager.json`,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 15000),
  operationTimeoutMs: Number(process.env.OPERATION_TIMEOUT_MS ?? 10 * 60 * 1000),
  selfCheckIntervalMs: Number(process.env.SELF_CHECK_INTERVAL_MS ?? 5 * 60 * 1000),
  historyLimit: Number(process.env.HISTORY_LIMIT ?? 20),
};
