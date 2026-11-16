import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { marked } from 'marked';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await copyFile('inbox.html', 'dist/index.html');
await copyFile('public/_headers', 'dist/_headers');
const api = await readFile('API.md', 'utf8');
const template = await readFile('public/api-docs.html', 'utf8');
const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
await writeFile('dist/api-docs.html', template
  .replace('{{API_HTML}}', () => marked.parse(api))
  .replace('{{API_TEXT}}', () => escape(api)));
await writeFile('dist/llms.txt', api);
