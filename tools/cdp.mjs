/**
 * Minimal Chrome DevTools Protocol client for driving a running Obsidian.
 *
 * Zero dependencies — Node 22+ ships a global WebSocket.
 *
 * Usage:
 *   node tools/cdp.mjs "<js expression>"     evaluate in the renderer, print the result
 *   node tools/cdp.mjs -f <file.js>          same, but read the expression from a file
 *   node tools/cdp.mjs --shot <out.png>      capture a screenshot of the window
 *
 * Obsidian must be running with --remote-debugging-port=9222.
 */

const ENDPOINT = 'http://127.0.0.1:9222';

export async function connect() {
  const list = await (await fetch(`${ENDPOINT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && String(t.url).includes('obsidian.md'));
  if (!page) throw new Error('no Obsidian page target — is the debug port open?');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== id) return;
        ws.removeEventListener('message', onMsg);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails, null, 2));
    return r.result.value;
  };

  const screenshot = async (outPath) => {
    const { writeFileSync } = await import('node:fs');
    await send('Page.enable');
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(outPath, Buffer.from(r.data, 'base64'));
    return outPath;
  };

  return { send, evaluate, screenshot, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  const { readFileSync } = await import('node:fs');
  const client = await connect();
  try {
    if (args[0] === '--shot') {
      console.log('saved', await client.screenshot(args[1]));
    } else {
      const expr = args[0] === '-f' ? readFileSync(args[1], 'utf8') : args.join(' ');
      const value = await client.evaluate(expr);
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    }
  } finally {
    client.close();
  }
}
