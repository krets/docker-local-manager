import { readFile, writeFile, rename } from 'node:fs/promises';
import { config } from '../config.js';

// The only persisted state: which projects the user has dismissed. Kept in a
// single file in the projects root (a bind mount that survives rebuilds, and
// a plain file so project discovery ignores it) rather than in the browser,
// so the choice follows the user across devices.
let dismissed = null; // Set<string>, loaded lazily

async function load() {
  if (dismissed) return dismissed;
  try {
    const data = JSON.parse(await readFile(config.stateFile, 'utf8'));
    dismissed = new Set(Array.isArray(data.dismissed) ? data.dismissed : []);
  } catch {
    dismissed = new Set();
  }
  return dismissed;
}

async function save() {
  const tmp = `${config.stateFile}.tmp`;
  await writeFile(tmp, JSON.stringify({ dismissed: [...dismissed].sort() }, null, 2));
  await rename(tmp, config.stateFile);
}

export async function isDismissed(name) {
  return (await load()).has(name);
}

export async function setDismissed(name, value) {
  const set = await load();
  if (value === set.has(name)) return;
  value ? set.add(name) : set.delete(name);
  await save();
}
