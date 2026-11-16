// Entry driver for markdown-render-speed-02-v3r. The harness runs
// `node /bot/main.ts` on Node 22 (erasable TypeScript only). It reads the
// cases from MAKEFUN_INPUT_DIR (or /input), renders each one on its own
// with parse() from parse.js, and writes the HTML strings, in order, to
// MAKEFUN_OUTPUT_DIR (or /output)/html.json.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as Array<{ id: string; markdown: string }>;
const html = cases.map((c) => parse(c.markdown));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
