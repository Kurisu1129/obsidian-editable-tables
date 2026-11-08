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

    // A reopened file restores its previous scroll position, and CM6 only renders the
    // viewport. Callers that measure the whole fixture need it rendered from the top.
    const cmEl = app.workspace.activeLeaf.view.editor.cm;
    if (cmEl?.scrollDOM) cmEl.scrollDOM.scrollTop = 0;
    await sleep(400);

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
        return { text: l.textContent.slice(0, 20), top: Math.round(r.top), h: Math.round(r.height), left: Math.round(r.left) };
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
    // Click inside the text column (the line's own left edge), not at the editor's left
    // edge: that area is the gutter/padding and a mousedown there never reaches the
    // content, leaving the selection at position 0 while the test looks like a height bug.
    const y = target.top + Math.round(target.h / 2);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await client.send('Input.dispatchMouseEvent', {
        type, x: target.left + 8, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
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

// ---------------------------------------------------------------- AC14 / AC15 / AC16

/** Top-level quote containing every block kind the PRD calls out. */
const QUOTE_SRC = [
  '# 引用块',
  '',
  '> 引用第一行',
  '>',
  '> ## 引用内标题',
  '>',
  '> | 甲 | 乙 |',
  '> | --- | --- |',
  '> | 1 | 2 |',
  '>',
  '> ```js',
  '> const inQuote = 1;',
  '> ```',
  '>',
  '> - 列表项 x',
  '> - 列表项 y',
  '',
  'after',
  '',
].join('\n');

{
  await openFile('fx-quote-basic.md', QUOTE_SRC);
  const d = JSON.parse(
    await evaluate(`(() => {
      const el = app.workspace.activeLeaf.view.editor.cm.contentDOM;
      const q = el.querySelector('.mdft-quote');
      const body = q ? q.querySelector('.mdft-quote__body') : null;
      const literal = [...el.querySelectorAll('.cm-line')].map((l) => l.textContent).join(' ');
      const fence = String.fromCharCode(96).repeat(3);
      return JSON.stringify({
        quotes: el.querySelectorAll('.mdft-quote').length,
        blockquote: !!body && !!body.querySelector('blockquote'),
        table: !!body && !!body.querySelector('blockquote table'),
        heading: body && body.querySelector('blockquote h2') ? body.querySelector('blockquote h2').textContent : null,
        listItems: body ? body.querySelectorAll('blockquote ul li').length : 0,
        code: !!body && !!body.querySelector('blockquote pre code.language-js'),
        ownTableInside: !!body && !!body.querySelector('.mdft-table'),
        literalFence: literal.indexOf(fence + 'js') >= 0,
        literalPipe: literal.indexOf('| --- |') >= 0,
      });
    })()`),
  );
  record(
    'AC14',
    '引用块内的表格渲染为 <table>，不再是管道源码',
    d.quotes === 1 && d.blockquote && d.table && !d.literalPipe && !d.ownTableInside,
    JSON.stringify(d),
  );
  record(
    'AC15',
    '引用块内的围栏代码块渲染，字面围栏行不再出现',
    d.code && !d.literalFence,
    JSON.stringify(d),
  );
  record(
    'AC16',
    '引用块内的标题与列表不再显示标记符源码',
    d.heading === '引用内标题' && d.listItems === 2,
    JSON.stringify(d),
  );
}

// ---------------------------------------------------------------- AC18 / AC22

{
  const d = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const leaf = app.workspace.activeLeaf;
      const cm = leaf.view.editor.cm;
      const el = cm.contentDOM;
      const snap = () => ({
        widgets: el.querySelectorAll('.mdft-quote').length,
        quoteLines: el.querySelectorAll('.cm-line.HyperMD-quote').length,
      });
      const out = { initial: snap() };

      // Enter the quote (line 3 is its first line).
      cm.dispatch({ selection: { anchor: cm.state.doc.line(3).from + 2 } });
      await sleep(400);
      out.inside = snap();

      // Leave.
      cm.dispatch({ selection: { anchor: 0 } });
      await sleep(500);
      out.left = snap();

      // Edit outside the quote.
      cm.dispatch({ changes: { from: 0, insert: 'x' } });
      await sleep(400);
      out.afterEdit = snap();
      cm.dispatch({ changes: { from: 0, to: 1, insert: '' } });
      await sleep(400);
      out.afterEditUndo = snap();

      // Switch away and back.
      await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('top-level.md'));
      await sleep(900);
      await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('fx-quote-basic.md'));
      await sleep(1200);
      out.back = snap();
      return JSON.stringify(out);
    })()`),
  );
  const ok =
    d.initial.widgets === 1 &&
    d.inside.widgets === 0 &&
    d.inside.quoteLines > 0 &&
    d.left.widgets === 1 &&
    d.afterEdit.widgets === 1 &&
    d.afterEditUndo.widgets === 1 &&
    d.back.widgets === 1;
  record('AC18', '引用块接管在三种时机下稳定，光标进出还原/重渲染', ok, JSON.stringify(d));
}

{
  const d = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('fx-quote-basic.md'));
      await sleep(1300);
      const view = app.workspace.activeLeaf.view;
      const cm = view.editor.cm;
      const el = cm.contentDOM;
      const file = app.vault.getAbstractFileByPath('fx-quote-basic.md');
      const before = await app.vault.read(file);
      const line = cm.state.doc.line(3);

      cm.dispatch({ selection: { anchor: line.from + 2 } });
      await sleep(400);
      const insideWidgets = el.querySelectorAll('.mdft-quote').length;

      cm.dispatch({ changes: { from: line.from + 2, insert: '★' } });
      await sleep(400);
      cm.dispatch({ selection: { anchor: 0 } });
      await sleep(300);

      const q = el.querySelector('.mdft-quote');
      const rendered = q ? q.textContent : '';
      const after = await app.vault.read(file);
      const result = {
        insideWidgets,
        outWidgets: el.querySelectorAll('.mdft-quote').length,
        markerRendered: rendered.indexOf('★') >= 0,
        diskUnchanged: after === before,
      };

      // Restore the fixture so later checks see the original text.
      view.editor.setValue(before);
      await sleep(700);
      return JSON.stringify(result);
    })()`),
  );
  record(
    'AC22',
    '光标进入引用块可编辑源码，离开后重渲染且渲染路径不改写磁盘',
    d.insideWidgets === 0 && d.outWidgets === 1 && d.markerRendered && d.diskUnchanged,
    JSON.stringify(d),
  );
}

// ---------------------------------------------------------------- AC17 / AC17b / AC17c

const INDENT_SRC = [
  '# 缩进',
  '',
  '- 一级项',
  '',
  '  > 引用在一级项里',
  '  > 第二行',
  '',
  '  | t1 | t2 |',
  '  | --- | --- |',
  '  | 1 | 2 |',
  '',
  '  一级项里的正文',
  '',
  '  ```js',
  '  const level1 = 1;',
  '  ```',
  '',
  '  - 二级项',
  '',
  '    > 引用在二级项里',
  '',
  '    | t3 | t4 |',
  '    | --- | --- |',
  '    | 3 | 4 |',
  '',
  '    二级项正文',
  '',
  '    ```js',
  '    const level2 = 2;',
  '    ```',
  '',
  // A block that follows a *sub-item* inside its parent. Walking backwards from the block
  // reaches the sub-item first; using it as the anchor would over-indent by one level.
  // The owner must still be resolved as the parent (content column 2, not 4).
  '- 父项A',
  '',
  '  - 子项A',
  '',
  '  > 子项之后的引用',
  '  > 第二行',
  '',
  '  ```js',
  '  const afterSub = 1;',
  '  ```',
  '',
  '- 顶层后的列表',
  '',
  '顶层表',
  '',
  '| top | t |',
  '| --- | --- |',
  '| 0 | 0 |',
  '',
  '顶层代码块',
  '',
  '```js',
  'const top = 0;',
  '```',
  '',
].join('\n');

/**
 * Geometry of every block the PRD's AC17 names, measured with Range glyph boxes.
 *
 * The fixture is taller than the editor viewport, and CM6 only renders what is visible,
 * so a single pass measures whichever half happens to be on screen. This walks the
 * document in viewport-sized steps, accumulating a value for each element whenever it is
 * rendered, then restores the scroll position. Values are taken last-wins: a code line can
 * be measured in the same frame its indent decoration is applied, and the later reading
 * is the settled one.
 */
const INDENT_PROBE = `async function collectIndent() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cm = app.workspace.activeLeaf.view.editor.cm;
  const el = cm.contentDOM;
  const out = {
    contentLeft: +el.getBoundingClientRect().left.toFixed(2),
    parent1: null, parent2: null, parentA: null,
    quote1: null, quote2: null, quoteA: null,
    table1: null, table2: null, tableTop: null,
    code1: null, code2: null, codeA: null, codeTop: null,
    codeTopMargin: null, quote1Pad: null, quote2Pad: null,
    widgetOverCode: 0, flairs: 0,
  };
  const tokens = new Set();
  const widgets = new Set();
  const setNum = (key, v) => { if (typeof v === 'number') out[key] = v; };

  const measure = () => {
    const lines = [...el.querySelectorAll('.cm-line')];
    const textLeft = (lineEl) => {
      if (!lineEl) return null;
      const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.textContent || '';
        if (!t.trim()) continue;
        const p = n.parentElement;
        if (p && p.closest('.cm-formatting, .code-block-flair, .cm-fold-indicator')) continue;
        const i = t.search(/\\S/);
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        return +r.getBoundingClientRect().left.toFixed(2);
      }
      return null;
    };
    const itemLine = (needle) => lines.find((l) =>
      l.classList.contains('HyperMD-list-line') &&
      !l.classList.contains('HyperMD-list-line-nobullet') &&
      l.textContent.includes(needle));
    const left = (node) => (node ? +node.getBoundingClientRect().left.toFixed(2) : null);
    const codeLine = (needle) => lines.find((l) =>
      l.classList.contains('HyperMD-codeblock') && l.textContent.includes(needle));
    const quote = (needle) => [...el.querySelectorAll('.mdft-quote')].find((n) => n.textContent.includes(needle));
    const table = (needle) => [...el.querySelectorAll('.mdft-table')].find((n) => n.textContent.includes(needle));

    setNum('parent1', textLeft(itemLine('一级项')));
    setNum('parent2', textLeft(itemLine('二级项')));
    setNum('parentA', textLeft(itemLine('父项A')));

    const q1 = quote('引用在一级项里');
    const q2 = quote('引用在二级项里');
    const qa = quote('子项之后的引用');
    setNum('quote1', left(q1 && q1.querySelector('blockquote')));
    setNum('quote2', left(q2 && q2.querySelector('blockquote')));
    setNum('quoteA', left(qa && qa.querySelector('blockquote')));
    if (q1) { widgets.add('q1'); out.quote1Pad = getComputedStyle(q1).paddingLeft; }
    if (q2) { widgets.add('q2'); out.quote2Pad = getComputedStyle(q2).paddingLeft; }
    if (qa) widgets.add('qa');

    const t1 = table('t1');
    const t2 = table('t3');
    const tt = table('top');
    setNum('table1', left(t1 && t1.querySelector('table')));
    setNum('table2', left(t2 && t2.querySelector('table')));
    setNum('tableTop', left(tt && tt.querySelector('table')));
    if (t1) widgets.add('t1');
    if (t2) widgets.add('t2');
    if (tt) widgets.add('tt');

    setNum('code1', left(codeLine('const level1')));
    setNum('code2', left(codeLine('const level2')));
    setNum('codeA', left(codeLine('const afterSub')));
    setNum('codeTop', left(codeLine('const top')));
    const top = codeLine('const top');
    if (top) out.codeTopMargin = getComputedStyle(top).marginLeft;

    for (const needle of ['const level1', 'const level2', 'const afterSub', 'const top']) {
      const line = codeLine(needle);
      if (line && line.querySelector('.cm-keyword, .cm-def')) tokens.add(needle);
    }
    out.flairs = Math.max(out.flairs, el.querySelectorAll('.code-block-flair').length);

    const wr = [...el.querySelectorAll('.mdft-table, .mdft-quote')].map((n) => n.getBoundingClientRect());
    const cr = [...el.querySelectorAll('.cm-line.HyperMD-codeblock')].map((n) => n.getBoundingClientRect());
    if (wr.some((a) => cr.some((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom))) out.widgetOverCode = 1;
  };

  const saved = cm.scrollDOM.scrollTop;
  for (let step = 0; step < 40; step++) {
    measure();
    const max = cm.scrollDOM.scrollHeight - cm.scrollDOM.clientHeight;
    if (cm.scrollDOM.scrollTop >= max - 2) break;
    cm.scrollDOM.scrollTop = Math.min(max, cm.scrollDOM.scrollTop + Math.floor(cm.scrollDOM.clientHeight * 0.7));
    await sleep(250);
  }
  cm.scrollDOM.scrollTop = saved;
  await sleep(300);
  out.tokens = tokens.size;
  out.widgets = widgets.size;
  return JSON.stringify(out);
}`;

/**
 * True when `a` sits on the same text column as `b` within subpixel tolerance.
 *
 * Lower bound alone is not enough: a block indented to the *sub-item* behind it would
 * still be "not earlier". The upper bound is what distinguishes alignment with the
 * owning item from over-indentation.
 */
const aligned = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1;

{
  await openFile('fx-indent-list.md', INDENT_SRC);
  const d = JSON.parse(await evaluate(`(${INDENT_PROBE})()`));
  const ok =
    aligned(d.quote1, d.parent1) &&
    aligned(d.quote2, d.parent2) &&
    aligned(d.table1, d.parent1) &&
    aligned(d.table2, d.parent2) &&
    aligned(d.code1, d.parent1) &&
    aligned(d.code2, d.parent2) &&
    aligned(d.quoteA, d.parentA) &&
    aligned(d.codeA, d.parentA) &&
    Math.abs(d.tableTop - d.contentLeft) < 1;
  record(
    'AC17',
    '列表项内嵌的表格 / 引用块 / 原生代码块与父项正文对齐（含二级、子项之后）',
    ok,
    JSON.stringify(d),
  );

  const okNative =
    d.widgets === 6 &&
    d.widgetOverCode === 0 &&
    d.tokens === 4 &&
    d.flairs >= 1 &&
    d.codeTopMargin === '0px';
  record('AC17c', '代码块零接管：widget 数准确、不覆盖代码行、原生高亮/语言标签仍在、顶层未加缩进', okNative, JSON.stringify(d));

  // AC17b: the same geometry must survive edits and a file switch.
  const after = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cm = app.workspace.activeLeaf.view.editor.cm;
      cm.dispatch({ changes: { from: 0, insert: 'x' } });
      await sleep(500);
      const edited = JSON.parse(await (${INDENT_PROBE})());
      cm.dispatch({ changes: { from: 0, to: 1, insert: '' } });
      await sleep(500);
      const undone = JSON.parse(await (${INDENT_PROBE})());
      await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('fx-quote-basic.md'));
      await sleep(900);
      await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('fx-indent-list.md'));
      await sleep(1400);
      const back = JSON.parse(await (${INDENT_PROBE})());
      return JSON.stringify({ edited, undone, back });
    })()`),
  );
  const stable = [after.edited, after.undone, after.back].every(
    (s) => aligned(s.code1, s.parent1) && aligned(s.code2, s.parent2) && aligned(s.table1, s.parent1)
  );
  record('AC17b', '行装饰缩进在编辑外围文本与切换文件后仍稳定', stable, JSON.stringify({
    edited: { code1: after.edited.code1, code2: after.edited.code2, p1: after.edited.parent1, p2: after.edited.parent2 },
    undone: { code1: after.undone.code1, code2: after.undone.code2 },
    back: { code1: after.back.code1, code2: after.back.code2, p1: after.back.parent1, p2: after.back.parent2 },
  }));
}

// ---------------------------------------------------------------- AC20

{
  const HEIGHT_SRC = [
    '# 引用高度',
    '',
    '前文',
    '',
    '> 引用第一行',
    '>',
    '> 引用第二行',
    '>',
    '> | 甲 | 乙 |',
    '> | --- | --- |',
    '> | 1 | 2 |',
    '',
    '锚点甲',
    '锚点乙',
    '锚点丙',
    '',
  ].join('\n');

  await openFile('fx-quote-height.md', HEIGHT_SRC);
  const geo = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      const el = cm.contentDOM;
      const widget = el.querySelector('.mdft-quote');
      const wr = widget.getBoundingClientRect();
      const lines = [...el.querySelectorAll('.cm-line')].map((l) => {
        const r = l.getBoundingClientRect();
        return { text: l.textContent.slice(0, 12), top: Math.round(r.top), h: Math.round(r.height), left: Math.round(r.left) };
      });
      const below = lines.find((l) => l.top >= wr.bottom - 2);
      const target = lines.find((l) => l.text.includes('锚点乙'));
      return JSON.stringify({
        widgetBottom: Math.round(wr.bottom),
        widgetHeight: Math.round(wr.height),
        gap: below ? below.top - Math.round(wr.bottom) : null,
        target,
        left: Math.round(cm.dom.getBoundingClientRect().left),
      });
    })()`),
  );

  const hasTarget = geo.target;
  if (hasTarget) {
    const y = geo.target.top + Math.round(geo.target.h / 2);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await client.send('Input.dispatchMouseEvent', {
        type, x: geo.target.left + 8, y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      });
      await sleep(80);
    }
    await sleep(400);
  }
  const landed = await evaluate(`(() => {
    const cm = app.workspace.activeLeaf.view.editor.cm;
    return cm.state.doc.lineAt(cm.state.selection.main.head).text;
  })()`);
  record(
    'AC20',
    '引用块与前后文本行的高度同步准确，点击落点与源码行一致',
    !!hasTarget && Math.abs(geo.gap) <= 2 && landed.includes('锚点乙'),
    `落点=${JSON.stringify(landed)} gap=${geo.gap}px height=${geo.widgetHeight}px`,
  );
}

// ---------------------------------------------------------------- AC19

{
  const d = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const adapter = app.vault.adapter;
      const ow = adapter.write.bind(adapter);
      const ob = adapter.writeBinary.bind(adapter);
      const touched = [];
      adapter.write = (p, ...r) => { touched.push(p); return ow(p, ...r); };
      adapter.writeBinary = (p, ...r) => { touched.push(p); return ob(p, ...r); };
      try {
        const top = app.vault.getAbstractFileByPath('fx-quote-basic.md');
        await app.workspace.getLeaf(false).openFile(top);
        await sleep(1200);
        touched.length = 0;
        const cm = app.workspace.activeLeaf.view.editor.cm;
        cm.scrollDOM.scrollTop = 120; await sleep(300);
        cm.scrollDOM.scrollTop = 0; await sleep(300);
        await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath('fx-indent-list.md'));
        await sleep(1000);
        await app.workspace.getLeaf(false).openFile(top);
        await sleep(1000);
        return JSON.stringify({ touched });
      } finally {
        adapter.write = ow;
        adapter.writeBinary = ob;
      }
    })()`),
  );
  const notes = d.touched.filter((p) => !p.endsWith('workspace.json'));
  record('AC19', '仅打开 / 滚动 / 切换文件时，引用块与嵌套块的笔记写入数为 0', notes.length === 0, JSON.stringify(d));
}

// ---------------------------------------------------------------- AC21

{
  const prior = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7', 'AC8', 'AC9', 'AC10', 'AC11', 'AC12', 'AC13'];
  const missing = prior.filter((id) => !results.some((r) => r.id === id));
  const failed = prior.filter((id) => results.some((r) => r.id === id && !r.pass));
  record(
    'AC21',
    '既有 AC1–AC13 全部仍然通过',
    missing.length === 0 && failed.length === 0,
    `missing=${missing.join(',') || 'none'} failed=${failed.join(',') || 'none'}`,
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
