import { mkdir, copyFile, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await copyFile('inbox.html', 'dist/index.html');
await copyFile('public/_headers', 'dist/_headers');
