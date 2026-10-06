import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Persisted for the process's lifetime so a project already seen doesn't
// vanish from the dashboard mid-session just because its compose file is
// momentarily absent -- e.g. a rollback (see spec.md) lands on a commit
// before the file was added. Without this, a user could strand themselves:
// the project disappears along with the only "Return to latest" button that
// could undo it. A project is only forgotten once its directory is gone.
const knownProjects = new Map(); // name -> { name, dir, composeFile }

/**
 * Immediate subdirectories of rootDir containing one of the recognized
 * compose filenames (first match wins). See spec.md's Discovery Rule.
 */
export async function discoverProjects(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const seenNow = new Set();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    seenNow.add(entry.name);
    const dir = path.join(rootDir, entry.name);

    for (const filename of COMPOSE_FILENAMES) {
      if (await exists(path.join(dir, filename))) {
        knownProjects.set(entry.name, { name: entry.name, dir, composeFile: filename });
        break;
      }
    }
    // If none of the compose filenames exist right now, we deliberately
    // leave a previously-known entry in place (stale composeFile name and
    // all) rather than deleting it -- see the comment on knownProjects above.
  }

  for (const name of knownProjects.keys()) {
    if (!seenNow.has(name)) knownProjects.delete(name);
  }

  return [...knownProjects.values()].sort((a, b) => a.name.localeCompare(b.name));
}
