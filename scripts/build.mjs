import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await copyFile('index.html', 'dist/index.html');
await copyFile('public/_headers', 'dist/_headers');
const api = await readFile('API.md', 'utf8');
await copyFile('index.html', 'dist/api-docs.html');
await writeFile('dist/llms.txt', api);
