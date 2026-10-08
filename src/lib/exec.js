import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * Run a command to completion and collect its output. For short, quiet
 * commands used to answer status/history queries -- not for long-running
 * pull/build/checkout commands, which should use spawnTracked() instead so
 * their output can be streamed.
 */
export function run(command, args, { cwd, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = '';
    let stderr = '';
    let output = ''; // stdout + stderr interleaved in arrival order

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Command timed out: ${command} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      output += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, output });
    });
  });
}

/**
 * Spawn a long-running command and stream its output line by line via the
 * returned emitter ('line' events, { stream: 'stdout'|'stderr', text }).
 * `done` resolves with the exit code once the process closes. The caller
 * owns the child (needed so operations.js can enforce a timeout).
 */
export function spawnTracked(command, args, { cwd } = {}) {
  const child = spawn(command, args, { cwd });
  const emitter = new EventEmitter();

  const forwardLines = (stream, streamName) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        emitter.emit('line', { stream: streamName, text: line });
      }
    });
    stream.on('end', () => {
      if (buffer.length) {
        emitter.emit('line', { stream: streamName, text: buffer });
        buffer = '';
      }
    });
  };

  forwardLines(child.stdout, 'stdout');
  forwardLines(child.stderr, 'stderr');

  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', (err) => {
      emitter.emit('line', { stream: 'stderr', text: String(err.message ?? err) });
      resolve({ code: null, signal: null });
    });
  });

  return { child, emitter, done };
}
