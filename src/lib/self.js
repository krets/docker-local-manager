import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ownPackageJson = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));

// Used to flag the manager's own project in the dashboard: rebuilding it
// from its own UI tears down the very container running the request that
// triggered the rebuild, which can leave a stale container behind if
// interrupted mid-teardown (see spec.md's "Deploying the Manager Itself").
export const selfName = ownPackageJson.name;
