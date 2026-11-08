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

/** Shift modifier bit in CDP's `modifiers` mask. */
const SHIFT = 8;

/**
 * A real left click at viewport coordinates.
 *
 * Synthetic `element.dispatchEvent(new MouseEvent(...))` bypasses hit-testing, focus and
 * the browser's event plumbing — the merge feature passed AC4 that way while the natural
 * drag gesture did not actually work. Interaction ACs must go through CDP input.
 */
async function realClick(x, y, modifiers = 0, clickCount = 1) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', clickCount, modifiers,
      buttons: type === 'mousePressed' ? 1 : 0,
    });
    await sleep(60);
  }
  await sleep(300);
}

/** Two real clicks in quick succession, so Chromium emits `dblclick` on the second. */
async function realDoubleClick(x, y) {
  await realClick(x, y, 0, 1);
  await realClick(x, y, 0, 2);
}

/** Press on `from`, move through intermediate points, release on `to`. */
async function realDrag(from, to) {
  await realDragPath([from, to]);
}

/** Press at `points[0]`, move through each later point, release on the last one. */
async function realDragPath(points) {
  const start = points[0];
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1, buttons: 1,
  });
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const steps = 4;
    for (let s = 1; s <= steps; s++) {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + ((to.x - from.x) * s) / steps),
        y: Math.round(from.y + ((to.y - from.y) * s) / steps),
        button: 'left', buttons: 1,
      });
      await sleep(60);
    }
  }
  const end = points[points.length - 1];
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: end.x, y: end.y, button: 'left', clickCount: 1, buttons: 0,
  });
  await sleep(350);
}

/** Center of a cell, in viewport coordinates, or null when it is not rendered. */
async function cellCenter(row, col) {
  const raw = await evaluate(`(() => {
    const cm = app.workspace.activeLeaf.view.editor.cm;
    const el = cm.contentDOM.querySelector('td[data-row="${row}"][data-col="${col}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
  return raw ? JSON.parse(raw) : null;
}

/** Center of a toolbar button by its label, or null when absent. */
async function buttonCenter(label) {
  const raw = await evaluate(`(() => {
    const cm = app.workspace.activeLeaf.view.editor.cm;
    const el = [...cm.contentDOM.querySelectorAll('.mdft-btn')].find((b) => b.textContent === ${JSON.stringify(label)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
  return raw ? JSON.parse(raw) : null;
}

/** Current cell selection count and merge-button state, as rendered. */
async function selectionState() {
  return JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      const merge = [...cm.contentDOM.querySelectorAll('.mdft-btn')].find((b) => b.textContent === '合并');
      return JSON.stringify({
        selected: cm.contentDOM.querySelectorAll('.mdft-selected').length,
        mergeDisabled: merge ? merge.disabled : null,
        mergeTitle: merge ? merge.title : null,
      });
    })()`),
  );
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

    // A reopened file restores its previous scroll position and cursor, and CM6 only
    // renders the viewport. Reset both: callers that measure the whole fixture need it
    // rendered from the top, and a cursor left at the end desyncs the viewport from the
    // scroll position (CM6 keeps rendering around the selection while scrollTop is 0).
    const cmEl = app.workspace.activeLeaf.view.editor.cm;
    if (cmEl?.scrollDOM) {
      cmEl.dispatch({ selection: { anchor: 0 } });
      cmEl.scrollDOM.scrollTop = 0;
    }
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

// ---------------------------------------------------------------- AC4 / AC23 / AC25

const MERGE_SRC = '# 表\n\n| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n';

{
  // Real input, not synthetic events: the whole point of this check is that the user's
  // actual gesture reaches the cell handlers.
  await openFile('ac4.md', MERGE_SRC);

  const a = await cellCenter(1, 0);
  const b = await cellCenter(1, 1);
  await realClick(a.x, a.y);
  await realClick(b.x, b.y, SHIFT);
  const picked = await selectionState();

  const merge = await buttonCenter('合并');
  if (merge) await realClick(merge.x, merge.y);

  const doc = await evaluate(`app.workspace.activeLeaf.view.editor.getValue()`);
  const hasSpan = /colspan="2"/.test(doc);
  const count = (doc.match(/<td/g) || []).length;
  record(
    'AC4',
    '真实鼠标 Shift+单击多选后合并，产生自洽的 colspan',
    picked.selected === 2 && !picked.mergeDisabled && hasSpan && count === 5,
    `选中=${picked.selected} 合并可用=${!picked.mergeDisabled} colspan=${hasSpan} td数=${count}\n${doc}`,
  );

  // Same gesture as AC4, kept as its own record so the PRD's AC numbering stays 1:1.
  record(
    'AC24',
    '真实鼠标 Shift+单击多选（不依赖合成事件）',
    picked.selected === 2 && !picked.mergeDisabled,
    JSON.stringify(picked),
  );

  // ---- AC25: the multi-select gesture must be discoverable before it is needed ----
  await openFile('ac4.md', MERGE_SRC);
  const single = await cellCenter(1, 0);
  await realClick(single.x, single.y);
  const hint = await selectionState();
  const dragTo = await cellCenter(1, 1);
  await realDrag(single, dragTo);
  const afterDrag = await selectionState();
  record(
    'AC25',
    '单选时提示拖拽 / Shift 多选，拖拽后按钮可用',
    /拖拽/.test(hint.mergeTitle ?? '') &&
      /Shift/.test(hint.mergeTitle ?? '') &&
      hint.mergeDisabled === true &&
      afterDrag.mergeDisabled === false,
    JSON.stringify({ singleTitle: hint.mergeTitle, dragSelected: afterDrag.selected, dragTitle: afterDrag.mergeTitle }),
  );

  // ---- AC23: drag a 2×2 rectangle and merge it ----
  await openFile('ac4.md', MERGE_SRC);
  const dragA = await cellCenter(1, 0);
  const dragB = await cellCenter(2, 1);
  // Leaving the anchor and coming back must shrink the range to the anchor again, not
  // leave the stale 2×2 rectangle behind.
  await realDragPath([dragA, dragB, dragA]);
  const returned = await selectionState();
  await realDrag(dragA, dragB);
  const dragged = await selectionState();
  const merge2 = await buttonCenter('合并');
  if (merge2) await realClick(merge2.x, merge2.y);
  const doc2 = await evaluate(`app.workspace.activeLeaf.view.editor.getValue()`);
  const span2 = /colspan="2"/.test(doc2) && /rowspan="2"/.test(doc2);
  const count2 = (doc2.match(/<td/g) || []).length;
  record(
    'AC23',
    '真实拖拽 2×2 多选后合并，产生自洽的 colspan + rowspan（中途回到起点范围收缩）',
    returned.selected === 1 && dragged.selected === 4 && !dragged.mergeDisabled && span2 && count2 === 3,
    `回起点选中=${returned.selected} 拖拽选中=${dragged.selected} 标题=${JSON.stringify(dragged.mergeTitle)} colspan+rowspan=${span2} td数=${count2}\n${doc2}`,
  );
}

// ---------------------------------------------------------------- AC5

{
  // GitHub's sanitiser keeps only an allowlist of table markup. Rather than asking a
  // human to eyeball a rendered page, assert the emitted HTML stays inside that
  // allowlist: no class/style/bgcolor, and only colspan/rowspan/align as attributes.
  await openFile('ac5.md', MERGE_SRC);
  const a = await cellCenter(1, 0);
  const b = await cellCenter(2, 0);
  await realClick(a.x, a.y);
  await realClick(b.x, b.y, SHIFT);
  const merge = await buttonCenter('合并');
  if (merge) await realClick(merge.x, merge.y);

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

  // A pipe table stays pipe syntax, so a successful row insert shows up as one more
  // `| … |` line (header + delimiter + two body rows).
  const pipeRows =
    typeof afterOp === 'string'
      ? afterOp.split('\n').filter((l) => l.trim().startsWith('|')).length
      : 0;
  const structuralOk = pipeRows === 4;
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
  const pipeRows =
    typeof detail.doc === 'string'
      ? detail.doc.split('\n').filter((l) => l.trim().startsWith('|')).length
      : 0;
  // Header + delimiter + two body rows: the pipe table is still Markdown.
  const grew = pipeRows === 4;
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
    '引用块内的表格渲染为可编辑表格（复用正文的 TableEditor），不再是管道源码',
    d.quotes === 1 && d.blockquote && d.table && d.ownTableInside && !d.literalPipe,
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

// ---------------------------------------------------------------- AC26 / AC27

{
  const CLICK_SRC = ['# 引用点击', '', '> 引用第一行', '> 第二行', '', '后文', ''].join('\n');
  await openFile('fx-quote-click.md', CLICK_SRC);
  const rect = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      const p = cm.contentDOM.querySelector('.mdft-quote__body blockquote p');
      if (!p) return JSON.stringify(null);
      const r = p.getBoundingClientRect();
      // Inside the first text line, not on the paragraph's vertical centre: the quote
      // below it may wrap to a second line, and starting between lines selects only the
      // newline between them.
      return JSON.stringify({ x: Math.round(r.left + 6), y: Math.round(r.top + 10) });
    })()`),
  );

  // A plain click must stay in the rendered view so text can be selected/copied.
  await realClick(rect.x, rect.y);
  const afterClick = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      return JSON.stringify({
        widgets: cm.contentDOM.querySelectorAll('.mdft-quote').length,
        quoteLines: cm.contentDOM.querySelectorAll('.HyperMD-quote').length,
      });
    })()`),
  );

  // A drag inside the widget must select text (the widget provides this itself: native
  // selection cannot start inside the editor's non-editable island) without unrendering.
  // The selection is painted with the CSS Custom Highlight API, so verify the highlight
  // and the clipboard payload the widget feeds on `copy`, not `window.getSelection()`.
  await realDrag(rect, { x: rect.x + 300, y: rect.y });
  const afterDrag = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      const wrap = cm.contentDOM.querySelector('.mdft-quote');
      const dt = new DataTransfer();
      const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
      const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
      target.dispatchEvent(ev);
      return JSON.stringify({
        selected: wrap ? wrap.dataset.mdftSelection ?? '' : '',
        highlighted: CSS.highlights?.has?.('mdft-quote-selection') ?? false,
        copied: dt.getData('text/plain'),
        prevented: ev.defaultPrevented,
        widgets: cm.contentDOM.querySelectorAll('.mdft-quote').length,
        quoteLines: cm.contentDOM.querySelectorAll('.HyperMD-quote').length,
      });
    })()`),
  );

  // A double click is the way into source editing.
  await realDoubleClick(rect.x, rect.y);
  const afterDouble = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      const head = cm.state.selection.main.head;
      return JSON.stringify({
        widgets: cm.contentDOM.querySelectorAll('.mdft-quote').length,
        quoteLines: cm.contentDOM.querySelectorAll('.HyperMD-quote').length,
        line: cm.state.doc.lineAt(head).number,
        text: cm.state.doc.lineAt(head).text,
      });
    })()`),
  );

  record(
    'AC26',
    '真实鼠标：单击/拖选保留渲染与文字选择（可复制），双击才还原为源码',
    !!rect &&
      afterClick.widgets === 1 &&
      afterClick.quoteLines === 0 &&
      /引用第一行/.test(afterDrag.selected) &&
      afterDrag.highlighted &&
      afterDrag.prevented &&
      /引用第一行/.test(afterDrag.copied) &&
      afterDrag.widgets === 1 &&
      afterDrag.quoteLines === 0 &&
      afterDouble.widgets === 0 &&
      afterDouble.quoteLines > 0 &&
      afterDouble.text.trimStart().startsWith('>'),
    JSON.stringify({ rect, afterClick, afterDrag, afterDouble }),
  );

  // ---- AC27: links inside the rendered quote keep their own click behaviour ----
  const LINK_SRC =
    '# link\n\n> 引用里有内链 [[probe-link-target]]\n>\n> 还有嵌入 ![[probe-link-target]]\n>\n> 以及外链 [example](https://example.com)\n';
  await openFile('probe-link-target.md', '# 目标\n\n链接目标。\n');
  await openFile('fx-quote-links.md', LINK_SRC);
  const link = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      const el = cm.contentDOM.querySelector('.mdft-quote a.internal-link');
      if (!el) return JSON.stringify(null);
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`),
  );
  await realClick(link?.x ?? 0, link?.y ?? 0);
  await sleep(900);
  const activePath = await evaluate(`app.workspace.activeLeaf.view.file?.path ?? ''`);
  record(
    'AC27',
    '引用块渲染态内链单击仍可跳转（单击不触发源码还原）',
    !!link && activePath === 'probe-link-target.md',
    `link=${JSON.stringify(link)} active=${JSON.stringify(activePath)}`,
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
  const savedSelection = cm.state.selection;
  // Step down and measure. Breaking on scrollTop >= max - 2 races the heightmap: right
  // after widgets render, scrollHeight can still be short, so the loop believes it has
  // reached the bottom while the document's last blocks were never on screen (AC17 flake).
  // The reliable end condition is the scroll element refusing to move further.
  for (let step = 0; step < 60; step++) {
    await sleep(step === 0 ? 200 : 350);
    measure();
    const before = cm.scrollDOM.scrollTop;
    const max = cm.scrollDOM.scrollHeight - cm.scrollDOM.clientHeight;
    cm.scrollDOM.scrollTop = Math.min(max, before + Math.ceil(cm.scrollDOM.clientHeight * 0.6));
    await sleep(150);
    if (Math.abs(cm.scrollDOM.scrollTop - before) < 1) break;
  }
  // The scroller can stop short of the tail: Obsidian leaves the last blocks inside a
  // cm-gap that direct scrollTop writes never materialise (verified — the top-level
  // table/code block stayed out of the DOM at max scroll). Moving the selection to the
  // document end forces CM6 to render that viewport; selection and scroll are restored.
  cm.dispatch({ selection: { anchor: cm.state.doc.length } });
  await sleep(700);
  measure();
  cm.dispatch({ selection: savedSelection });
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

// ---------------------------------------------------------------- AC29 / AC30 / AC31 / AC32

/** Types into the element at (x, y) through the real input path an IME also takes. */
async function typeAt(x, y, text) {
  await realClick(x, y);
  await client.send('Input.insertText', { text });
  await sleep(250);
}

/** Moves the real pointer (so CSS :hover applies) without pressing a button. */
async function realMove(x, y) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await sleep(250);
}

/** The quote whose text contains `quoteText`. */
const quoteByText = (quoteText, inner) => `[...app.workspace.activeLeaf.view.editor.cm.contentDOM.querySelectorAll('.mdft-quote')].find((q) => q.textContent.includes(${JSON.stringify(quoteText)}))${inner}`;

/** Center of a toolbar button inside a specific quote, or null when it is not hovered. */
async function quoteButtonCenter(quoteText, label) {
  const raw = await evaluate(`(() => {
    const quote = ${quoteByText(quoteText, '')};
    if (!quote) return null;
    const el = [...quote.querySelectorAll('.mdft-btn')].find((b) => b.textContent === ${JSON.stringify(label)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
  return raw ? JSON.parse(raw) : null;
}

/** Center of one cell inside a specific quote. */
async function quoteCellCenter(quoteText, row, col) {
  const raw = await evaluate(`(() => {
    const quote = ${quoteByText(quoteText, '')};
    if (!quote) return null;
    const el = quote.querySelector('.mdft-table td[data-row="${row}"][data-col="${col}"] .mdft-cell-wrapper');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
  return raw ? JSON.parse(raw) : null;
}

{
  const QUOTE_TABLE_SRC = [
    '# 引用内表格',
    '',
    '> 引用第一行',
    '>',
    '> | 甲 | 乙 |',
    '> | --- | --- |',
    '> | 1 | 2 |',
    '>',
    '> 结尾',
    '',
    '后文',
    '',
  ].join('\n');

  await openFile('fx-quote-table.md', QUOTE_TABLE_SRC);
  const mounted = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      return JSON.stringify({
        quotes: cm.contentDOM.querySelectorAll('.mdft-quote').length,
        inner: cm.contentDOM.querySelectorAll('.mdft-quote .mdft-table').length,
        tds: cm.contentDOM.querySelectorAll('.mdft-quote .mdft-table td').length,
        // Any table the upgrade missed would still be a plain rendered table.
        staticTables: cm.contentDOM.querySelectorAll('.mdft-quote blockquote table:not(.mdft-table__el)').length,
      });
    })()`),
  );

  const cell = await quoteCellCenter('引用第一行', 1, 1);
  if (cell) await typeAt(cell.x, cell.y, '改');
  const focusState = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      const el = cm.contentDOM.querySelector('.mdft-quote .mdft-table td[data-row="1"][data-col="1"] .mdft-cell-wrapper');
      const ae = document.activeElement;
      return JSON.stringify({
        text: el ? el.textContent : null,
        inCell: ae instanceof Element && !!ae.closest('.mdft-quote .mdft-table'),
      });
    })()`),
  );
  await pressKey('Enter', 0, 'Enter', 13);
  await sleep(1600);

  const after = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      return JSON.stringify({
        doc: app.workspace.activeLeaf.view.editor.getValue(),
        quotes: cm.contentDOM.querySelectorAll('.mdft-quote').length,
        inner: cm.contentDOM.querySelectorAll('.mdft-quote .mdft-table').length,
        quoteLines: cm.contentDOM.querySelectorAll('.HyperMD-quote').length,
      });
    })()`),
  );

  const docLines = after.doc.split('\n');
  const tableLines = docLines.filter((l) => l.startsWith('> |'));
  const allPrefixed = tableLines.length === 3 && tableLines.every((l) => l.startsWith('> '));
  // The source of truth stays Markdown: header + delimiter + the edited body row.
  const markdownShape =
    tableLines[0] === '> | 甲 | 乙 |' &&
    tableLines[1] === '> | --- | --- |' &&
    tableLines[2] === '> | 1 | 2改 |';
  const noHtml = !after.doc.includes('<table>');
  const outsideIntact =
    after.doc.startsWith('# 引用内表格\n\n> 引用第一行\n') && after.doc.endsWith('\n\n后文\n');

  record(
    'AC29',
    '引用块内表格渲染为可编辑表格：真实点击输入 + Enter 后写回 Markdown 管道语法，每行保留 "> " 前缀',
    mounted.inner === 1 && mounted.tds === 2 && mounted.staticTables === 0 &&
      !!cell && focusState.inCell && /改/.test(focusState.text ?? '') &&
      allPrefixed && markdownShape && noHtml &&
      outsideIntact && after.quotes === 1 && after.inner === 1 && after.quoteLines === 0,
    JSON.stringify({ mounted, cell, focusState, tableLines, markdownShape, noHtml, outsideIntact, quotes: after.quotes, inner: after.inner, quoteLines: after.quoteLines }),
  );
}

{
  // ---- AC30: a structural action on the embedded table, then undo ----
  const before = await evaluate(`app.workspace.activeLeaf.view.editor.getValue()`);
  const beforePipe = before.split('\n').filter((l) => l.startsWith('> |')).length;

  // The toolbar only renders on hover, so move the real pointer over the table first.
  const hover = await quoteCellCenter('引用第一行', 1, 0);
  if (hover) await realMove(hover.x, hover.y);
  const addRow = await quoteButtonCenter('引用第一行', '↓行');
  if (addRow) await realClick(addRow.x, addRow.y);
  await sleep(1600);

  const mid = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      const doc = app.workspace.activeLeaf.view.editor.getValue();
      const tableLines = doc.split('\\n').filter((l) => l.startsWith('> |'));
      return JSON.stringify({
        doc,
        pipeLines: tableLines.length,
        allPrefixed: tableLines.length > 0 && tableLines.every((l) => l.startsWith('> ')),
        noHtml: !doc.includes('<table>'),
        inner: cm.contentDOM.querySelectorAll('.mdft-quote .mdft-table').length,
      });
    })()`),
  );

  await pressKey('z', 2, 'KeyZ', 90);
  await sleep(1500);
  const undone = await evaluate(`app.workspace.activeLeaf.view.editor.getValue()`);

  record(
    'AC30',
    '引用内表格结构操作（插入行）写回管道语法，Ctrl+Z 恢复原状',
    !!addRow && mid.pipeLines === beforePipe + 1 && mid.allPrefixed && mid.noHtml &&
      mid.inner === 1 && undone === before,
    JSON.stringify({ addRow, beforePipe, midPipe: mid.pipeLines, allPrefixed: mid.allPrefixed, noHtml: mid.noHtml, inner: mid.inner, undone: undone === before }),
  );
}

{
  // ---- AC31: list-nested quote and nested quote ----
  const NESTED_QUOTE_SRC = [
    '# 嵌套引用表格',
    '',
    '- 列表项',
    '',
    '  > 列表里的引用',
    '  >',
    '  > | a | b |',
    '  > | --- | --- |',
    '  > | 1 | 2 |',
    '',
    '> 外层',
    '> > 内层',
    '> >',
    '> > | c | d |',
    '> > | --- | --- |',
    '> > | 3 | 4 |',
    '',
  ].join('\n');

  await openFile('fx-quote-nested-table.md', NESTED_QUOTE_SRC);
  const mounted = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      return JSON.stringify({
        quotes: cm.contentDOM.querySelectorAll('.mdft-quote').length,
        inner: cm.contentDOM.querySelectorAll('.mdft-quote .mdft-table').length,
      });
    })()`),
  );

  const cellA = await quoteCellCenter('列表里的引用', 1, 1);
  if (cellA) await typeAt(cellA.x, cellA.y, 'A');
  await pressKey('Enter', 0, 'Enter', 13);
  await sleep(1600);

  // The second quote's DOM is reused while the document shifted under it; its write must
  // still land on its own range (a stale captured offset would be rejected or corrupt).
  const cellB = await quoteCellCenter('内层', 1, 1);
  if (cellB) await typeAt(cellB.x, cellB.y, 'B');
  await pressKey('Enter', 0, 'Enter', 13);
  await sleep(1600);

  const finalDoc = await evaluate(`app.workspace.activeLeaf.view.editor.getValue()`);
  const lines = finalDoc.split('\n');
  // Both tables must still be Markdown: three pipe lines each, with their own prefix.
  const listTable = lines.filter((l) => l.startsWith('  > |'));
  const nestedTable = lines.filter((l) => l.startsWith('> > |'));

  const listPrefixed = listTable.length === 3 && listTable.every((l) => l.startsWith('  > '));
  const nestedPrefixed = nestedTable.length === 3 && nestedTable.every((l) => l.startsWith('> > '));
  const noHtml = !finalDoc.includes('<table>');
  const structureIntact =
    finalDoc.includes('- 列表项') &&
    finalDoc.includes('  > 列表里的引用') &&
    finalDoc.includes('> 外层') &&
    finalDoc.includes('> > 内层');
  const firstEditKept = /A/.test(listTable.join('\n'));
  const secondEditKept = /B/.test(nestedTable.join('\n'));

  const afterState = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      return JSON.stringify({
        quotes: cm.contentDOM.querySelectorAll('.mdft-quote').length,
        inner: cm.contentDOM.querySelectorAll('.mdft-quote .mdft-table').length,
      });
    })()`),
  );

  record(
    'AC31',
    '列表内引用与嵌套引用中的表格可编辑：写回管道语法，前缀/层级保留，偏移漂移后仍写对区间',
    mounted.quotes === 2 && mounted.inner === 2 &&
      listPrefixed && nestedPrefixed && noHtml && firstEditKept && secondEditKept && structureIntact &&
      afterState.quotes === 2 && afterState.inner === 2,
    JSON.stringify({ mounted, listTable, nestedTable, listPrefixed, nestedPrefixed, noHtml, firstEditKept, secondEditKept, structureIntact, afterState }),
  );
}

{
  // ---- AC32: the quote's own text gestures must be unaffected by the embedded table ----
  const QUOTE_MIX_SRC = [
    '# 引用交互',
    '',
    '> 引用文字一',
    '> 引用文字二',
    '>',
    '> | a | b |',
    '> | --- | --- |',
    '> | 1 | 2 |',
    '',
    '后文',
    '',
  ].join('\n');

  await openFile('fx-quote-mix.md', QUOTE_MIX_SRC);
  const rect = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      const p = cm.contentDOM.querySelector('.mdft-quote__body blockquote p');
      if (!p) return JSON.stringify(null);
      const r = p.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + 6), y: Math.round(r.top + 10) });
    })()`),
  );

  await realClick(rect.x, rect.y);
  const afterClick = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      return JSON.stringify({
        widgets: cm.contentDOM.querySelectorAll('.mdft-quote').length,
        quoteLines: cm.contentDOM.querySelectorAll('.HyperMD-quote').length,
      });
    })()`),
  );

  await realDrag(rect, { x: rect.x + 260, y: rect.y });
  const afterDrag = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      const wrap = cm.contentDOM.querySelector('.mdft-quote');
      const dt = new DataTransfer();
      const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
      const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
      target.dispatchEvent(ev);
      return JSON.stringify({
        selected: wrap ? wrap.dataset.mdftSelection ?? '' : '',
        highlighted: CSS.highlights?.has?.('mdft-quote-selection') ?? false,
        copied: dt.getData('text/plain'),
        prevented: ev.defaultPrevented,
        widgets: cm.contentDOM.querySelectorAll('.mdft-quote').length,
      });
    })()`),
  );

  // Double-clicking the embedded table belongs to the table, not to the quote.
  const cell = await quoteCellCenter('引用文字一', 1, 0);
  if (cell) await realDoubleClick(cell.x, cell.y);
  const afterCellDouble = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      return JSON.stringify({
        widgets: cm.contentDOM.querySelectorAll('.mdft-quote').length,
        quoteLines: cm.contentDOM.querySelectorAll('.HyperMD-quote').length,
      });
    })()`),
  );

  await realDoubleClick(rect.x, rect.y);
  const afterTextDouble = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      return JSON.stringify({
        widgets: cm.contentDOM.querySelectorAll('.mdft-quote').length,
        quoteLines: cm.contentDOM.querySelectorAll('.HyperMD-quote').length,
        text: cm.state.doc.lineAt(cm.state.selection.main.head).text,
      });
    })()`),
  );

  record(
    'AC32',
    '引用块文字交互无回归：单击/拖选复制保留渲染，双击文字进源码，双击表格不进源码',
    !!rect &&
      afterClick.widgets === 1 && afterClick.quoteLines === 0 &&
      /引用文字一/.test(afterDrag.selected) && afterDrag.highlighted && afterDrag.prevented &&
      /引用文字一/.test(afterDrag.copied) && afterDrag.widgets === 1 &&
      !!cell && afterCellDouble.widgets === 1 && afterCellDouble.quoteLines === 0 &&
      afterTextDouble.widgets === 0 && afterTextDouble.quoteLines > 0 &&
      afterTextDouble.text.trimStart().startsWith('>'),
    JSON.stringify({ rect, afterClick, afterDrag, cell, afterCellDouble, afterTextDouble }),
  );
}

// ---------------------------------------------------------------- AC34 / AC35

{
  const SRC = [
    '# 管道写回',
    '',
    '| 甲 | 乙 |',
    '| :--- | ---: |',
    '| 1 | 2 |',
    '',
    '后文',
    '',
  ].join('\n');

  await openFile('fx-pipe-writeback.md', SRC);
  const cell = await cellCenter(1, 1);
  if (cell) await typeAt(cell.x, cell.y, '改');
  await pressKey('Enter', 0, 'Enter', 13);
  await sleep(1600);

  const after = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      return JSON.stringify({
        doc: app.workspace.activeLeaf.view.editor.getValue(),
        widgets: cm.contentDOM.querySelectorAll('.mdft-table').length,
      });
    })()`),
  );

  const lines = after.doc.split('\n');
  const tableLines = lines.filter((l) => l.startsWith('|'));
  const body = tableLines[2] ?? '';
  const markdownShape =
    tableLines.length === 3 &&
    tableLines[0] === '| 甲 | 乙 |' &&
    tableLines[1] === '| :--- | ---: |' &&
    body.startsWith('| 1 |') && body.includes('改');
  const noHtml = !after.doc.includes('<table>');
  const outsideIntact = after.doc.startsWith('# 管道写回\n\n') && after.doc.endsWith('\n\n后文\n');

  record(
    'AC34',
    '顶层管道表格编辑后仍写回 Markdown 管道语法（对齐保留、无 HTML），表格外字节不变',
    !!cell && markdownShape && noHtml && outsideIntact && after.widgets === 1,
    JSON.stringify({ cell, tableLines, markdownShape, noHtml, outsideIntact, widgets: after.widgets }),
  );
}

{
  // ---- AC35: merge forces HTML; split stays HTML; 转 MD returns to Markdown; undo ----
  const SRC = [
    '# 合并与转回',
    '',
    '| 甲 | 乙 |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '后文',
    '',
  ].join('\n');

  await openFile('fx-convert.md', SRC);

  const a = await cellCenter(1, 0);
  const b = await cellCenter(1, 1);
  await realClick(a.x, a.y);
  await realClick(b.x, b.y, SHIFT);
  const merge = await buttonCenter('合并');
  if (merge) await realClick(merge.x, merge.y);
  await sleep(1200);

  const mergedDoc = await evaluate(`app.workspace.activeLeaf.view.editor.getValue()`);
  const mergedHtml = mergedDoc.includes('<table>') && /colspan="2"/.test(mergedDoc);

  // Split the merged cell: select it, then use the toolbar.
  const mergedCell = await cellCenter(1, 0);
  if (mergedCell) await realClick(mergedCell.x, mergedCell.y);
  const split = await buttonCenter('拆分');
  if (split) await realClick(split.x, split.y);
  await sleep(1200);

  const splitDoc = await evaluate(`app.workspace.activeLeaf.view.editor.getValue()`);
  const stillHtml =
    splitDoc.includes('<table>') &&
    !splitDoc.split('\n').some((l) => l.startsWith('|'));

  // Hover the table so the toolbar is visible, then convert back to Markdown.
  const hover = await cellCenter(1, 0);
  if (hover) await realMove(hover.x, hover.y);
  const toMd = await buttonCenter('转 MD');
  if (toMd) await realClick(toMd.x, toMd.y);
  await sleep(1400);

  const pipeDoc = await evaluate(`app.workspace.activeLeaf.view.editor.getValue()`);
  const pipeLines = pipeDoc.split('\n').filter((l) => l.startsWith('|'));
  const pipeBody = pipeLines[2] ?? '';
  // mergeCells() concatenates the merged cells' text into the anchor (space-separated),
  // and splitCell() keeps that text in the first cell and empties the second. The point
  // here is the storage format, not restoring pre-merge text, so assert the merged text
  // survives and the row is well-formed.
  const backToMarkdown =
    !pipeDoc.includes('<table>') &&
    pipeLines.length === 3 &&
    pipeLines[0] === '| 甲 | 乙 |' &&
    pipeBody.startsWith('| 1 2 |') &&
    pipeBody.endsWith('|');

  await pressKey('z', 2, 'KeyZ', 90);
  await sleep(1400);
  const undoneDoc = await evaluate(`app.workspace.activeLeaf.view.editor.getValue()`);
  const undoRestoresHtml = undoneDoc === splitDoc;

  record(
    'AC35',
    '合并降级 HTML；拆分后仍为 HTML；工具栏「转 MD」写回管道语法；Ctrl+Z 恢复 HTML',
    mergedHtml && stillHtml && !!toMd && backToMarkdown && undoRestoresHtml,
    JSON.stringify({ mergedHtml, stillHtml, toMd, pipeLines, backToMarkdown, undoRestoresHtml }),
  );
}

// ---------------------------------------------------------------- AC36

{
  const SRC = [
    '# 引用内 HTML 转 MD',
    '',
    '> 引用文字',
    '>',
    '> <table>',
    '>   <tr><th>甲</th></tr>',
    '>   <tr><td>1</td></tr>',
    '> </table>',
    '',
    '后文',
    '',
  ].join('\n');

  await openFile('fx-quote-html-convert.md', SRC);
  const mounted = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      return JSON.stringify({
        inner: cm.contentDOM.querySelectorAll('.mdft-quote .mdft-table').length,
        staticTables: cm.contentDOM.querySelectorAll('.mdft-quote blockquote table:not(.mdft-table__el)').length,
      });
    })()`),
  );

  const cell = await quoteCellCenter('引用文字', 1, 0);
  if (cell) await realMove(cell.x, cell.y);
  const toMd = await quoteButtonCenter('引用文字', '转 MD');
  if (toMd) await realClick(toMd.x, toMd.y);
  await sleep(1600);

  const after = JSON.parse(
    await evaluate(`(() => {
      const cm = app.workspace.activeLeaf.view.editor.cm;
      return JSON.stringify({
        doc: app.workspace.activeLeaf.view.editor.getValue(),
        inner: cm.contentDOM.querySelectorAll('.mdft-quote .mdft-table').length,
        quoteLines: cm.contentDOM.querySelectorAll('.HyperMD-quote').length,
      });
    })()`),
  );

  const tableLines = after.doc.split('\n').filter((l) => l.startsWith('> |'));
  const converted =
    tableLines.length === 3 &&
    tableLines[0] === '> | 甲 |' &&
    tableLines[1] === '> | --- |' &&
    tableLines[2] === '> | 1 |';
  const noHtml = !after.doc.includes('<table>');
  const structureIntact = after.doc.includes('> 引用文字') && after.doc.endsWith('\n\n后文\n');

  record(
    'AC36',
    '引用内 HTML 表格可通过「转 MD」写回带 "> " 前缀的管道语法，引用结构不变',
    mounted.inner === 1 && mounted.staticTables === 0 && !!toMd && converted && noHtml &&
      structureIntact && after.inner === 1 && after.quoteLines === 0,
    JSON.stringify({ mounted, toMd, tableLines, converted, noHtml, structureIntact, inner: after.inner, quoteLines: after.quoteLines }),
  );
}

// ---------------------------------------------------------------- AC37 / AC38

{
  const SRC = [
    '---',
    'title: 导出测试',
    '---',
    '',
    '# 导出',
    '',
    '<table>',
    '  <tr><th>甲</th></tr>',
    '  <tr><td>1</td></tr>',
    '</table>',
    '',
    '<table>',
    '  <tr><th colspan="2">合并</th></tr>',
    '  <tr><td>a</td><td>b</td></tr>',
    '</table>',
    '',
    '| x | y |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
  ].join('\n');

  await openFile('fx-export.md', SRC);

  // Intercept both export sinks: the clipboard and the anchor download.
  // In this Electron build `writeText` is an **own** property of the clipboard
  // instance, so patching the prototype alone silently misses it.
  const patched = await evaluate(`(() => {
    window.__mdftClipboard = null;
    if (navigator.clipboard) {
      const clip = navigator.clipboard;
      window.__mdftWriteTarget = Object.hasOwn(clip, 'writeText')
        ? clip
        : Object.getPrototypeOf(clip);
      window.__mdftOrigWrite = window.__mdftWriteTarget.writeText;
      Object.defineProperty(window.__mdftWriteTarget, 'writeText', {
        configurable: true,
        writable: true,
        value: async function (text) { window.__mdftClipboard = text; },
      });
    }
    window.__mdftOrigExec = document.execCommand.bind(document);
    document.execCommand = function (cmd, ...rest) {
      if (cmd === 'copy') {
        const area = document.querySelector('textarea');
        window.__mdftClipboard = area ? area.value : null;
        return true;
      }
      return window.__mdftOrigExec(cmd, ...rest);
    };

    window.__mdftDownload = null;
    window.__mdftOrigClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) window.__mdftDownload = { name: this.download, href: this.href };
      else window.__mdftOrigClick.call(this);
    };
    return 'ok';
  })()`);

  const copyRan = await evaluate(`app.commands.executeCommandById('editable-tables:copy-as-markdown')`);
  await sleep(700);
  const clipboard = await evaluate(`window.__mdftClipboard`);

  const exportRan = await evaluate(`app.commands.executeCommandById('editable-tables:export-as-markdown')`);
  await sleep(700);
  const download = await evaluate(`(window.__mdftDownload ? JSON.stringify(window.__mdftDownload) : null)`);
  const downloaded = download
    ? await evaluate(`(async () => {
        const res = await fetch(${JSON.stringify(JSON.parse(download).href)});
        return await res.text();
      })()`)
    : null;

  // Restore the sinks before asserting, so later ACs are unaffected either way.
  await evaluate(`(() => {
    if (window.__mdftWriteTarget) {
      Object.defineProperty(window.__mdftWriteTarget, 'writeText', {
        configurable: true,
        writable: true,
        value: window.__mdftOrigWrite,
      });
    }
    delete document.execCommand; // fall back to the prototype implementation
    HTMLAnchorElement.prototype.click = window.__mdftOrigClick;
    return 'restored';
  })()`);

  const original = await evaluate(`app.workspace.activeLeaf.view.editor.getValue()`);
  const stillOriginal = original === SRC;
  const mdText = typeof clipboard === 'string' ? clipboard : '';

  const simpleConverted = mdText.includes('| 甲 |') && mdText.includes('| 1 |');
  const mergedKept = mdText.includes('<table>') && /colspan="2"/.test(mdText);
  const pipeKept = mdText.includes('| x | y |') && mdText.includes('| 1 | 2 |');
  const frontMatterKept = mdText.startsWith('---\ntitle: 导出测试\n---\n');
  const downloadedOk =
    download !== null &&
    JSON.parse(download).name === 'fx-export.md' &&
    downloaded === mdText;

  record(
    'AC37',
    '复制为 Markdown：可转换的 HTML 表格变管道语法，合并表格保持 HTML，原笔记不变',
    patched === 'ok' && copyRan !== false && simpleConverted && mergedKept && pipeKept &&
      frontMatterKept && stillOriginal,
    JSON.stringify({ copyRan, simpleConverted, mergedKept, pipeKept, frontMatterKept, stillOriginal, text: mdText.slice(0, 400) }),
  );

  record(
    'AC38',
    '导出为 Markdown 文件：下载名为 <笔记名>.md，blob 内容与复制的 Markdown 一致',
    exportRan !== false && downloadedOk,
    JSON.stringify({ exportRan, download, downloadedMatches: downloaded === mdText }),
  );
}

// ---------------------------------------------------------------- AC33

{
  // The suite's numbering goes AC1–AC27, then AC29–AC38 (AC28 was never defined).
  // AC33 is this summary itself.
  const prior = [];
  for (let i = 1; i <= 38; i++) {
    if (i === 28 || i === 33) continue;
    prior.push('AC' + i);
  }
  const missing = prior.filter((id) => !results.some((r) => r.id === id));
  const failed = prior.filter((id) => results.some((r) => r.id === id && !r.pass));
  record(
    'AC33',
    '既有 AC1–AC27、AC29–AC32 与新增 AC34–AC38 全部通过',
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
