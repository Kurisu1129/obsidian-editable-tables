import { connect, sleep } from '../tools/cdp.mjs';
const { evaluate, send, close } = await connect();

const geo = JSON.parse(await evaluate(`(() => {
  const q = app.workspace.activeLeaf.view.editor.cm.contentDOM.querySelector('.mdft-quote');
  const a = q.querySelector('a.internal-link');
  const r = a.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), path: app.workspace.activeLeaf.view.file.path, leaves: app.workspace.getLeavesOfType('markdown').length });
})()`));
console.log('before', JSON.stringify(geo));

for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', {
    type, x: geo.x, y: geo.y, button: 'left', clickCount: 1,
    buttons: type === 'mousePressed' ? 1 : 0,
  });
  await sleep(80);
}
await sleep(900);

const after = await evaluate(`(() => {
  const leaves = app.workspace.getLeavesOfType('markdown').map((l) => l.view.file && l.view.file.path);
  return JSON.stringify({ active: app.workspace.activeLeaf.view.file && app.workspace.activeLeaf.view.file.path, leaves });
})()`);
console.log('after ', after);
close();
