(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const target = app.vault.getAbstractFileByPath('probe-link-target.md') || await app.vault.create('probe-link-target.md', '# 目标笔记\n\n目标正文\n');
  const src = [
    '# link',
    '',
    '> 引用里有内链 [[probe-link-target]]',
    '>',
    '> 还有嵌入 ![[probe-link-target]]',
    '>',
    '> 以及外链 [example](https://example.com)',
    '',
  ].join('\n');
  const f = app.vault.getAbstractFileByPath('fx-quote-links.md') || await app.vault.create('fx-quote-links.md', '');
  await app.vault.modify(f, src); await sleep(300);
  await app.workspace.getLeaf('tab').openFile(f); await sleep(1800);
  const view = app.workspace.activeLeaf.view; const cm = view.editor.cm;
  if (view.editor.getValue() !== src) { view.editor.setValue(src); await sleep(1400); }
  cm.dispatch({ selection: { anchor: 0 }, scrollIntoView: false }); await sleep(700);
  const el = cm.contentDOM;
  const q = el.querySelector('.mdft-quote');
  if (!q) return JSON.stringify({ error: 'no quote widget' });
  const anchors = [...q.querySelectorAll('a')].map((a) => ({
    cls: a.className,
    text: a.textContent,
    href: a.getAttribute('href'),
    dataHref: a.getAttribute('data-href') || (a.dataset && a.dataset.href) || null,
    rect: (() => { const r = a.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    pointer: getComputedStyle(a).pointerEvents,
  }));
  const embed = q.querySelector('.internal-embed, .file-embed, .markdown-embed');
  return JSON.stringify({
    anchors,
    embedTag: embed ? embed.className : null,
    embedText: embed ? embed.textContent.slice(0, 40) : null,
    active: app.workspace.activeLeaf.view.file && app.workspace.activeLeaf.view.file.path,
  });
})()
