import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { router as projectsRouter } from './routes/projects.js';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use('/api', projectsRouter);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(config.port, () => {
  console.log(`docker-local-manager listening on :${config.port}`);
  console.log(`watching ${config.projectsRoot} for compose projects`);
});
