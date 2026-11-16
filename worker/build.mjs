// 把 schema.sql 轉成 Worker 可以 import 的 schema.js（拿掉註解、切成一句一句）
// 用法：node worker/build.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');

const statements = sql
  .split('\n')
  .filter((line) => !/^\s*--/.test(line))      // 整行註解
  .map((line) => line.replace(/\s+--.*$/, '')) // 行尾註解（欄位後面的說明）
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

const out = [
  '// 由 worker/build.mjs 從 schema.sql 產生，請勿手改。',
  'export const SCHEMA = [',
  ...statements.map((s) => '  `' + s.split('`').join('\\`') + '`,'),
  '];',
  '',
].join('\n');

fs.writeFileSync(path.join(here, 'schema.js'), out);
console.log('寫好 worker/schema.js，共', statements.length, '句');
