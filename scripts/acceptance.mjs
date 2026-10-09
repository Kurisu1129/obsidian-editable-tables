/**
 * Automated acceptance suite for the Editable Tables plugin.
 *
 * Drives a real, running Obsidian over the DevTools Protocol and asserts the
 * acceptance criteria from prd.md. Nothing here is a mock: the plugin is loaded
 * into a vault, tables are rendered by the real editor, and structural edits are
 * committed to real files.
 *
 * Prerequisites
 *   1. Obsidian running with a debug port and pointed at a scratch vault:
 *        cmd /c start "" "D:\obsidian\Obsidian.exe" --remote-debugging-port=9222
 *   2. The plugin built and deployed into that vault:
 *        npm run build && ./scripts/deploy.sh
 *
 * Run: node scripts/acceptance.mjs
 */
import { connect, sleep } from '../tools/cdp.mjs';

const results = [];
const record = (id, title, pass, detail) => {
  results.push({ id, title, pass, detail });
  const mark = pass ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(`${mark}  ${id}  ${title}${detail ? `\n        ${String(detail).replace(/\n/g, '\n        ')}` : ''}`);
};

const client = await connect();
const { evaluate } = client;

// Always reload the plugin, so the suite exercises the bundle that was just built
// rather than whatever Obsidian happened to have loaded.
await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  app.plugins.disablePlugin('editable-tables');
  await sleep(400);
  await app.plugins.enablePlugin('editable-tables');
  await sleep(700);
  return 'reloaded';
})()`);

/** Presses a key (e.g. Ctrl+Z) with real key events — Obsidian binds undo to a keymap, not a command. */
async function pressKey(key, modifiers, code, vk) {
  for (const type of ['keyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type, modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
    await sleep(60);
  }
  await sleep(700);
}

/**
 * Opens `path`, optionally forcing its content to `source`.
 *
 * `vault.modify` races Obsidian's debounced autosave: the editor's stale buffer can be
 * written back over the new content. Setting the editor value directly and verifying the
 * result keeps the suite deterministic instead of intermittently testing yesterday's text.
 */
async function openFile(path, source) {
  return evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let f = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
    if (!f) {
      f = await app.vault.create(${JSON.stringify(path)}, ${JSON.stringify(source ?? '')});
      await sleep(400);
    }
    await app.workspace.getLeaf(false).openFile(f);
    await sleep(1000);

    ${
      source !== undefined
        ? `const ed = app.workspace.activeLeaf.view.editor;
    if (ed.getValue() !== ${JSON.stringify(source)}) {
      ed.setValue(${JSON.stringify(source)});
      ed.setCursor({ line: 0, ch: 0 });
      await sleep(900);
    }`
        : ''
    }

    await sleep(800);
    const el = app.workspace.activeLeaf.view.editor.cm.contentDOM;
    return JSON.stringify({
      widgets: el.querySelectorAll('.mdft-table').length,
      native: el.querySelectorAll('.cm-table-widget').length,
      doc: app.workspace.activeLeaf.view.editor.getValue(),
    });
  })()`);
}

// ---------------------------------------------------------------- AC1 / AC10

{
  const { widgets, native } = JSON.parse(
    await openFile('top-level.md', '# 顶层\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n'),
  );
  record('AC1', '顶层表格被我们的 widget 接管', widgets === 1 && native === 0, `mdft=${widgets} native=${native}`);
}

{
  const detail = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cm = () => app.workspace.activeLeaf.view.editor.cm;
      const snap = () => cm().contentDOM.querySelectorAll('.mdft-table').length + '/' +
                          cm().contentDOM.querySelectorAll('.cm-table-widget').length;
      const top = app.vault.getAbstractFileByPath('top-level.md');
      const nested = app.vault.getAbstractFileByPath('nested.md');
      const before = snap();
      cm().dispatch({ changes: { from: 0, insert: 'x' } }); await sleep(500);
      const afterEdit = snap();
      cm().dispatch({ changes: { from: 0, to: 1, insert: '' } }); await sleep(500);
      const afterUndo = snap();
      await app.workspace.getLeaf(false).openFile(nested); await sleep(1100);
      const other = snap();
      await app.workspace.getLeaf(false).openFile(top); await sleep(1100);
      const back = snap();
      return JSON.stringify({ before, afterEdit, afterUndo, other, back });
    })()`),
  );
  const ok = Object.values(detail).every((v) => v.endsWith('/0'));
  record('AC10', '三种时机下均稳定压过原生渲染器', ok, JSON.stringify(detail));
}

// ---------------------------------------------------------------- AC2

{
  const nestedSrc = [
    '# 列表内嵌表格',
    '',
    '- 第一项',
    '  - 子项一，下面嵌一个表格：',
    '',
    '    | 姓名 | 年龄 |',
    '    | --- | --- |',
    '    | 张三 | 28 |',
    '',
    '  - 子项二',
    '- 第二项',
    '',
  ].join('\n');
  const { widgets } = JSON.parse(await openFile('nested.md', nestedSrc));

  const detail = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cm = () => app.workspace.activeLeaf.view.editor.cm;
      const cell = cm().contentDOM.querySelector('td[data-row="1"][data-col="0"]');
      cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await sleep(200);
      const btn = [...cm().contentDOM.querySelectorAll('.mdft-btn')].find((b) => b.textContent === '↓行');
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await sleep(900);
      const doc = app.workspace.activeLeaf.view.editor.getValue();
      const tableLines = doc.split('\\n').filter((l) => l.trim().startsWith('<') || l.trim().startsWith('|'));
      return JSON.stringify({
        doc,
        unindented: tableLines.filter((l) => !l.startsWith('    ')).length,
        listIntact: doc.includes('- 第一项') && doc.includes('  - 子项一') && doc.includes('  - 子项二') && doc.includes('- 第二项'),
      });
    })()`),
  );

  record(
    'AC2',
    '列表项内嵌表格渲染 + 写回保留缩进上下文',
    widgets === 1 && detail.unindented === 0 && detail.listIntact,
    `widgets=${widgets} 未缩进行=${detail.unindented} 列表完好=${detail.listIntact}`,
  );
}

// ---------------------------------------------------------------- AC3

{
  await openFile('ac3.md', '# 前\n\n表前段落\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n表后段落\n');
  const detail = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cm = () => app.workspace.activeLeaf.view.editor.cm;
      const inner = cm().contentDOM.querySelector('td[data-row="1"][data-col="1"] .mdft-cell-wrapper');
      inner.focus();
      inner.textContent = '改过了';
      inner.dispatchEvent(new InputEvent('input', { bubbles: true }));
      inner.blur();
      await sleep(1000);
      const doc = app.workspace.activeLeaf.view.editor.getValue();
      const outside = doc.split('\\n').filter((l) => !l.trim().startsWith('<'));
      return JSON.stringify({ doc, outside });
    })()`),
  );
  const untouched =
    detail.doc.startsWith('# 前\n\n表前段落\n') && detail.doc.endsWith('\n\n表后段落\n');
  record('AC3', '单元格编辑只改动该表格，其余字节不变', untouched, detail.doc);
}

// ---------------------------------------------------------------- AC4

{
  await openFile('ac4.md', '# 表\n\n| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n');
  const detail = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cm = () => app.workspace.activeLeaf.view.editor.cm;
      const md = (ev, extra = {}) => new MouseEvent(ev, { bubbles: true, cancelable: true, ...extra });
      const btn = (t) => [...cm().contentDOM.querySelectorAll('.mdft-btn')].find((b) => b.textContent === t);
      cm().contentDOM.querySelector('td[data-row="1"][data-col="0"]').dispatchEvent(md('mousedown'));
      await sleep(150);
      cm().contentDOM.querySelector('td[data-row="1"][data-col="1"]').dispatchEvent(md('mousedown', { shiftKey: true }));
      await sleep(250);
      btn('合并').dispatchEvent(md('mousedown'));
      await sleep(900);
      return JSON.stringify({ doc: app.workspace.activeLeaf.view.editor.getValue() });
    })()`),
  );
  const hasSpan = /colspan="2"/.test(detail.doc);
  const count = (detail.doc.match(/<td/g) || []).length;
  record('AC4', '合并产生自洽的 colspan', hasSpan && count === 5, `colspan=${hasSpan} td数=${count}\n${detail.doc}`);
}

// ---------------------------------------------------------------- AC5

{
  // GitHub's sanitiser keeps only an allowlist of table markup. Rather than asking a
  // human to eyeball a rendered page, assert the emitted HTML stays inside that
  // allowlist: no class/style/bgcolor, and only colspan/rowspan/align as attributes.
  await openFile('ac5.md', '# 合并\n\n| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n');
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const cm = app.workspace.activeLeaf.view.editor.cm;
    const md = (ev, extra = {}) => new MouseEvent(ev, { bubbles: true, cancelable: true, ...extra });
    cm.contentDOM.querySelector('td[data-row="1"][data-col="0"]').dispatchEvent(md('mousedown'));
    await sleep(150);
    cm.contentDOM.querySelector('td[data-row="2"][data-col="0"]').dispatchEvent(md('mousedown', { shiftKey: true }));
    await sleep(250);
    [...cm.contentDOM.querySelectorAll('.mdft-btn')].find((b) => b.textContent === '合并')
      .dispatchEvent(md('mousedown'));
    await sleep(1000);
    return 'ok';
  })()`);

  const html = await evaluate(`app.workspace.activeLeaf.view.editor.getValue()`);
  const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());
  const attrsInFile = [...html.matchAll(/\s([a-zA-Z-]+)\s*=/g)].map((m) => m[1].toLowerCase());
  const badTags = [...new Set(tags)].filter((t) => !['table', 'tr', 'th', 'td'].includes(t));
  const badAttrs = [...new Set(attrsInFile)].filter((a) => !['colspan', 'rowspan', 'align'].includes(a));
  const hasSpan = /rowspan="2"/.test(html);

  record(
    'AC5',
    '产出 HTML 落在 GitHub 白名单内（无 class/style，仅 colspan/rowspan/align）',
    badTags.length === 0 && badAttrs.length === 0 && hasSpan,
    `标签=${[...new Set(tags)].join(',')} 属性=${[...new Set(attrsInFile)].join(',') || '(无)'} rowspan=${hasSpan}`,
  );
}

// ---------------------------------------------------------------- AC6

{
  const doc = [
    '# AC6',
    '',
    'L1',
    'L2',
    '',
    '| 甲 | 乙 |',
    '| --- | --- |',
    '| a | b |',
    '| c | d |',
    '',
    '锚点甲',
    '锚点乙',
    '锚点丙',
  ].join('\n');
  await openFile('ac6.md', doc);

  const geo = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      const el = cm.contentDOM;
      const lines = [...el.querySelectorAll('.cm-line')].map((l) => {
        const r = l.getBoundingClientRect();
        return { text: l.textContent.slice(0, 20), top: Math.round(r.top), h: Math.round(r.height) };
      });
      const widget = el.querySelector('.mdft-table');
      const wr = widget ? widget.getBoundingClientRect() : null;
      return JSON.stringify({
        lines,
        left: Math.round(cm.dom.getBoundingClientRect().left),
        widgetHeight: wr ? Math.round(wr.height) : null,
        widgetBottom: wr ? Math.round(wr.bottom) : null,
      });
    })()`),
  );

  const target = geo.lines.find((l) => l.text.includes('锚点乙'));
  // The line immediately after the widget may be a blank line whose top coincides with
  // the widget's bottom, so a strict `>` would skip it and report a whole line of drift.
  const below = geo.lines.find((l) => l.top >= geo.widgetBottom - 2);
  const gap = below ? below.top - geo.widgetBottom : null;

  if (target) {
    const y = target.top + Math.round(target.h / 2);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await client.send('Input.dispatchMouseEvent', {
        type, x: geo.left + 40, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
      });
      await sleep(80);
    }
    await sleep(400);
  }

  const landed = await evaluate(`(() => {
    const cm = app.workspace.activeLeaf.view.editor.cm;
    const head = cm.state.selection.main.head;
    return cm.state.doc.lineAt(head).text;
  })()`);

  record(
    'AC6',
    'widget 高度准确，点击落点与源码行一致',
    landed.includes('锚点乙') && Math.abs(gap) <= 2,
    `落点=${JSON.stringify(landed)} widget高度=${geo.widgetHeight}px 底到下一行=${gap}px`,
  );
}

// ---------------------------------------------------------------- AC7

{
  // Two distinct cases, because "malformed" splits into "cannot be parsed at all" and
  // "parses, but under a rule we must not get wrong".
  const detail = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      // (a) an unterminated <table> is genuinely unparseable — refuse, and never write.
      const existing = app.vault.getAbstractFileByPath('ac7.md');
      if (existing) await app.vault.delete(existing);
      const bad = '# 未闭合的 HTML 表格\\n\\n<table>\\n<tr><td>a</td></tr>\\n';
      const f = await app.vault.create('ac7.md', bad);
      await sleep(400);
      await app.workspace.getLeaf(false).openFile(f);
      await sleep(1400);
      const el = app.workspace.activeLeaf.view.editor.cm.contentDOM;
      const refusals = el.querySelectorAll('.mdft-table').length;
      const unchanged = (await app.vault.read(f)) === bad;

      // (b) a pipe table whose rows disagree on column count IS rendered by Obsidian
      // (verified at runtime), so we must render it too — and must not drop the cells
      // that only the longer rows have, since we write the grid back to disk.
      const f2 = app.vault.getAbstractFileByPath('ac7b.md') || await app.vault.create('ac7b.md', '');
      await app.vault.modify(f2, '# 列数不一致\\n\\n| a | b |\\n| --- | --- |\\n| 1 | 2 | 3 |\\n');
      await sleep(400);
      await app.workspace.getLeaf(false).openFile(f2);
      await sleep(1500);
      const el2 = app.workspace.activeLeaf.view.editor.cm.contentDOM;
      const rendered = el2.querySelectorAll('.mdft-table').length;
      const cellTexts = [...el2.querySelectorAll('.mdft-cell')].map((c) => c.textContent.trim());
      return JSON.stringify({ refusals, unchanged, rendered, cellTexts });
    })()`),
  );
  const noLoss = ['a', 'b', '1', '2', '3'].every((t) => detail.cellTexts.includes(t));
  record(
    'AC7',
    '无法解析的输入拒绝渲染且不改写；可解析的按原生规则渲染且不丢单元格',
    detail.refusals === 0 && detail.unchanged && detail.rendered === 1 && noLoss,
    JSON.stringify(detail),
  );
}

// ---------------------------------------------------------------- AC8

{
  const lines = ['# 50 张表'];
  for (let i = 0; i < 50; i++) {
    lines.push('', `## 表 ${i}`, '', '| 一 | 二 | 三 |', '| --- | --- | --- |');
    for (let r = 0; r < 5; r++) lines.push(`| a${r} | b${r} | c${r} |`);
  }
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const f = app.vault.getAbstractFileByPath('ac8.md') || await app.vault.create('ac8.md', '');
    await app.vault.modify(f, ${JSON.stringify(lines.join('\n'))});
    await sleep(400);
    await app.workspace.getLeaf(false).openFile(f);
    await sleep(2000);
    return 'ok';
  })()`);

  const detail = JSON.parse(
    await evaluate(`(async () => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) {
        cm.dispatch({ selection: { anchor: 5 + i * 40 } });
      }
      const per = (performance.now() - t0) / 20;
      return JSON.stringify({
        widgets: cm.contentDOM.querySelectorAll('.mdft-table').length,
        perDispatch: Number(per.toFixed(2)),
      });
    })()`),
  );
  record(
    'AC8',
    '50 张表时仅构建视口内的 widget，光标移动保持在帧预算内',
    detail.widgets < 50 && detail.perDispatch < 8,
    `widgets=${detail.widgets}/50 每次 dispatch=${detail.perDispatch}ms`,
  );
}

// ---------------------------------------------------------------- AC9

{
  const detail = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const adapter = app.vault.adapter;
      const ow = adapter.write.bind(adapter);
      const ob = adapter.writeBinary.bind(adapter);
      const touched = [];
      adapter.write = (p, ...r) => { touched.push(p); return ow(p, ...r); };
      adapter.writeBinary = (p, ...r) => { touched.push(p); return ob(p, ...r); };
      try {
        const top = app.vault.getAbstractFileByPath('top-level.md');
        await app.workspace.getLeaf(false).openFile(top); await sleep(1200);
        touched.length = 0;
        app.workspace.activeLeaf.view.editor.cm.scrollDOM.scrollTop = 30; await sleep(300);
        app.workspace.activeLeaf.view.editor.cm.scrollDOM.scrollTop = 0; await sleep(300);
        await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('nested.md')); await sleep(1000);
        await app.workspace.getLeaf(false).openFile(top); await sleep(1000);
        return JSON.stringify({ touched });
      } finally {
        adapter.write = ow;
        adapter.writeBinary = ob;
      }
    })()`),
  );
  const noteWrites = detail.touched.filter((p) => /\.md$/.test(p));
  record(
    'AC9',
    '打开 / 滚动 / 切换文件期间对笔记零写入',
    noteWrites.length === 0,
    `全部写入=${JSON.stringify(detail.touched)} 其中笔记=${noteWrites.length}`,
  );
}

// ---------------------------------------------------------------- AC11

{
  const SRC = '# 标题\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n';
  await openFile('ac11.md', SRC);

  const afterOp = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const cm = app.workspace.activeLeaf.view.editor.cm;
    const md = (ev) => new MouseEvent(ev, { bubbles: true, cancelable: true });
    const cell = cm.contentDOM.querySelector('td[data-row="1"][data-col="0"]');
    if (!cell) return 'NO_CELL';
    cell.dispatchEvent(md('mousedown'));
    await sleep(300);
    const btn = [...cm.contentDOM.querySelectorAll('.mdft-btn')].find((b) => b.textContent === '↓行');
    if (!btn || btn.disabled) return 'NO_BUTTON';
    btn.dispatchEvent(md('mousedown'));
    await sleep(1000);
    cm.focus();
    return app.workspace.activeLeaf.view.editor.getValue();
  })()`);

  const structuralOk = typeof afterOp === 'string' && afterOp.includes('<table>');
  if (structuralOk) {
    await pressKey('z', 2, 'KeyZ', 90);
    const undone = await evaluate('app.workspace.activeLeaf.view.editor.getValue()');
    await pressKey('y', 2, 'KeyY', 89); // CodeMirror binds redo to Mod-y on Windows
    const redone = await evaluate('app.workspace.activeLeaf.view.editor.getValue()');
    record(
      'AC11',
      '结构操作进入撤销历史，Ctrl+Z / Ctrl+Y 可回退与重做',
      undone === SRC && redone === afterOp,
      `撤销回退=${undone === SRC} 重做恢复=${redone === afterOp}`,
    );
  } else {
    record('AC11', '结构操作进入撤销历史', false, `无法触发结构操作: ${afterOp}`);
  }
}

// ---------------------------------------------------------------- AC12

{
  // A bare `---` satisfies the one-cell delimiter grammar. Without an explicit pipe
  // requirement the YAML front-matter fence parses as a table, and one edit replaces the
  // closing `---` — leaving the whole note as unterminated YAML.
  const FRONT_MATTER = '---\ntitle: A | B\ntags: [x, y]\n---\n';
  const SRC = `${FRONT_MATTER}\n# 正文\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n`;
  await openFile('ac12.md', SRC);

  const detail = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cm = () => app.workspace.activeLeaf.view.editor.cm;
      const md = (ev, extra = {}) => new MouseEvent(ev, { bubbles: true, cancelable: true, ...extra });
      const widgetsOnLoad = cm().contentDOM.querySelectorAll('.mdft-table').length;

      const cell = cm().contentDOM.querySelector('td[data-row="1"][data-col="0"]');
      if (!cell) return JSON.stringify({ widgetsOnLoad, error: 'NO_CELL' });
      cell.dispatchEvent(md('mousedown'));
      await sleep(250);
      [...cm().contentDOM.querySelectorAll('.mdft-btn')].find((b) => b.textContent === '↓行')
        .dispatchEvent(md('mousedown'));
      await sleep(1000);
      return JSON.stringify({ widgetsOnLoad, doc: app.workspace.activeLeaf.view.editor.getValue() });
    })()`),
  );

  const fmIntact = typeof detail.doc === 'string' && detail.doc.startsWith(FRONT_MATTER);
  record(
    'AC12',
    'YAML front matter 不被识别为表格，且编辑真表格后逐字节不变',
    detail.widgetsOnLoad === 1 && fmIntact,
    `widget 数=${detail.widgetsOnLoad}（应恰为 1，即只识别到正文里的真表格）front matter 完好=${fmIntact}`,
  );
}

// ---------------------------------------------------------------- AC13

{
  const SRC = '# 表\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n';
  await openFile('ac13.md', SRC);

  const detail = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cm = () => app.workspace.activeLeaf.view.editor.cm;
      const md = (ev, extra = {}) => new MouseEvent(ev, { bubbles: true, cancelable: true, ...extra });

      const inner = cm().contentDOM.querySelector('td[data-row="1"][data-col="1"] .mdft-cell-wrapper');
      if (!inner) return JSON.stringify({ error: 'NO_CELL' });
      inner.focus();
      inner.textContent = '临时输入';
      inner.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await sleep(250);

      // Deliberately do NOT blur: the toolbar's mousedown suppresses the blur that would
      // otherwise commit the cell, so the structural action must carry the text itself.
      [...cm().contentDOM.querySelectorAll('.mdft-btn')].find((b) => b.textContent === '↓行')
        .dispatchEvent(md('mousedown'));
      await sleep(1200);
      return JSON.stringify({ doc: app.workspace.activeLeaf.view.editor.getValue() });
    })()`),
  );

  const kept = typeof detail.doc === 'string' && detail.doc.includes('临时输入');
  const grew = typeof detail.doc === 'string' && (detail.doc.match(/<tr>/g) || []).length === 3;
  record(
    'AC13',
    '工具栏操作不丢弃未提交的单元格输入，且两者同时落盘',
    kept && grew,
    `输入保留=${kept} 新行已插入=${grew}\n${detail.doc ?? detail.error}`,
  );
}

// ---------------------------------------------------------------- report

client.close();
const failed = results.filter((r) => !r.pass);
console.log('\n' + '─'.repeat(60));
console.log(`${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败：' + failed.map((f) => f.id).join(', '));
  process.exitCode = 1;
}
