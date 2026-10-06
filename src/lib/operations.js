import { spawnTracked } from './exec.js';
import { config } from '../config.js';

/**
 * One operation (fetch/pull/rebuild/checkout/reattach) for a single project.
 * A "steps" array lets us chain commands (e.g. pull-then-build,
 * checkout-then-build) under one id/log/lock, matching the "optional pull
 * first" / "checkout + rebuild" behavior in spec.md.
 */
class Operation {
  constructor(id, type) {
    this.id = id;
    this.type = type;
    this.lines = [];
    this.status = 'running'; // running | success | error
    this.exitCode = null;
    this.startedAt = new Date();
    this.finishedAt = null;
    this.subscribers = new Set();
  }

  pushLine(line) {
    this.lines.push(line);
    this.broadcast({ event: 'line', data: line });
  }

  finish(status, exitCode) {
    this.status = status;
    this.exitCode = exitCode;
    this.finishedAt = new Date();
    this.broadcast({ event: 'done', data: { status, exitCode } });
  }

  broadcast(message) {
    for (const res of this.subscribers) {
      writeSSE(res, message);
    }
  }

  subscribe(res) {
    this.subscribers.add(res);
    for (const line of this.lines) {
      writeSSE(res, { event: 'line', data: line });
    }
    if (this.status !== 'running') {
      writeSSE(res, { event: 'done', data: { status: this.status, exitCode: this.exitCode } });
    }
  }

  unsubscribe(res) {
    this.subscribers.delete(res);
  }
}

function writeSSE(res, { event, data }) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const operationsByProject = new Map();
let nextId = 1;

export function getOperation(projectName) {
  return operationsByProject.get(projectName) ?? null;
}

export function isRunning(projectName) {
  return operationsByProject.get(projectName)?.status === 'running';
}

/**
 * Start a chained operation for a project. Throws (code: OPERATION_IN_PROGRESS)
 * if one is already running -- callers should turn that into a 409.
 */
export function startOperation(projectName, type, steps) {
  if (isRunning(projectName)) {
    const err = new Error(`An operation is already running for "${projectName}"`);
    err.code = 'OPERATION_IN_PROGRESS';
    throw err;
  }

  const op = new Operation(nextId++, type);
  operationsByProject.set(projectName, op);

  runSteps(op, steps).catch((err) => {
    op.pushLine({ stream: 'stderr', text: String(err.message ?? err) });
    op.finish('error', null);
  });

  return op;
}

async function runSteps(op, steps) {
  for (const step of steps) {
    if (steps.length > 1) {
      op.pushLine({ stream: 'stdout', text: `--- ${step.label} ---` });
    }

    const { emitter, done, child } = spawnTracked(step.command, step.args, { cwd: step.cwd });
    emitter.on('line', (line) => op.pushLine(line));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, step.timeoutMs ?? config.operationTimeoutMs);

    const { code } = await done;
    clearTimeout(timer);

    if (code !== 0) {
      op.finish('error', code);
      return;
    }
  }

  op.finish('success', 0);
}

/**
 * Attach an SSE response to a project's current/most-recent operation,
 * replaying buffered output so a reconnecting client catches up.
 */
export function subscribeToStream(projectName, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');

  const op = operationsByProject.get(projectName);
  if (!op) {
    writeSSE(res, { event: 'done', data: { status: 'idle' } });
    return;
  }

  op.subscribe(res);
  res.on('close', () => op.unsubscribe(res));
}
