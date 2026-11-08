(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const src = [
    '# blockonly',
    '',
    '-',
    '  > 引用作为第一个子块',
    '  > 第二行',
    '',
    '-',
    '  | a | b |',
    '  | --- | --- |',
    '  | 1 | 2 |',
    '',
    '-',
    '  ```js',
    '  const first = 1;',
    '  ```',
    '',
    '-',
    '  -',
    '    > 二级的第一个子块',
    '',
    '- 有正文',
    '  > 正文后的引用',
    '',
  ].join('\n');
  const f = app.vault.getAbstractFileByPath('probe-blockonly.md') || await app.vault.create('probe-blockonly.md', '');
  await app.vault.modify(f, src); await sleep(300);
  await app.workspace.getLeaf('tab').openFile(f); await sleep(1500);
  const view = app.workspace.activeLeaf.view; const cm = view.editor.cm;
  if (view.editor.getValue() !== src) { view.editor.setValue(src); await sleep(1200); }
  cm.dispatch({ selection: { anchor: 0 } }); await sleep(600);
  const el = cm.contentDOM;
  const textLeft = (lineEl) => {
    if (!lineEl) return null;
    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent || '';
      if (!t.trim()) continue;
      const p = n.parentElement;
      if (p && p.closest('.cm-formatting, .code-block-flair, .cm-fold-indicator')) continue;
      const i = t.search(/\S/);
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1);
      return +r.getBoundingClientRect().left.toFixed(2);
    }
    return null;
  };
  const left = (n) => (n ? +n.getBoundingClientRect().left.toFixed(2) : null);
  const lines = [...el.querySelectorAll('.cm-line')];
  const itemLines = lines.filter((l) => l.classList.contains('HyperMD-list-line') && !l.classList.contains('HyperMD-list-line-nobullet'));
  const quotes = [...el.querySelectorAll('.mdft-quote')];
  const tables = [...el.querySelectorAll('.mdft-table')];
  const code = lines.filter((l) => l.classList.contains('HyperMD-codeblock') && l.textContent.includes('const first'));
  return JSON.stringify({
    contentLeft: +el.getBoundingClientRect().left.toFixed(2),
    markers: itemLines.map((l) => ({ text: l.textContent.slice(0, 8), textLeft: textLeft(l), rect: left(l), pad: getComputedStyle(l).paddingLeft })),
    quotes: quotes.map((q) => ({ pad: getComputedStyle(q).paddingLeft, left: left(q.querySelector('blockquote')) })),
    tables: tables.map((t) => ({ pad: getComputedStyle(t).paddingLeft, left: left(t.querySelector('table')) })),
    code: code.map((l) => ({ style: l.getAttribute('style'), left: left(l) })),
    quoteCount: quotes.length,
    tableCount: tables.length,
  });
})()
