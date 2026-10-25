import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { handleRequest } from '../server/handler.mjs';
import { loadAssets, recipeContext } from './assets.mjs';
const port = Number(process.env.PORT || 4173);
const runtime = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-flash' };
if (process.argv.includes('--secrets-stdin')) {
  console.log('Ready for local runtime JSON on stdin (input is hidden).');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true });
  const input = await new Promise(resolve => rl.once('line', resolve));
  runtime.DEEPSEEK_API_KEY = JSON.parse(input).DEEPSEEK_API_KEY;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  rl.close(); process.stdin.pause();
}
createServer(async (req, res) => {
  try {
    const assets = await loadAssets();
    const catalog = JSON.parse(assets['/data/foods.json']);
    const recipes = recipeContext(JSON.parse(assets['/data/diary.json']));
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 24000) { res.writeHead(413).end('Request too large'); return; } chunks.push(chunk); }
    const url = `http://${req.headers.host || `127.0.0.1:${port}`}${req.url}`;
    const request = new Request(url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
    const result = await handleRequest(request, runtime, { assets, catalog, recipes });
    res.writeHead(result.status, Object.fromEntries(result.headers));
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch { res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '本地服务暂时不可用。' } })); }
}).listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
