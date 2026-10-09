(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const { MarkdownRenderer, Component } = window.__probe;
  const out = {};

  // --- callout collapse on cursor entry ---
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(app.vault.getAbstractFileByPath('probe4.md'));
  await sleep(900);
  const cm = leaf.view.editMode.cm;
  const content = cm.contentDOM;
  const lineCount = cm.state.doc.lines;
  // find the line index of "> [!note]"
  let calloutLine = -1;
  for (let i = 1; i <= lineCount; i++) if (cm.state.doc.line(i).text.includes('[!note]')) calloutLine = i;
  out.calloutLine = calloutLine;
  out.calloutText = cm.state.doc.line(calloutLine).text;
  // put cursor on the callout header line
  const pos = cm.state.doc.line(calloutLine).from + 2;
  cm.dispatch({ selection: { anchor: pos } });
  cm.focus();
  await sleep(500);
  out.afterCursorInCallout = {
    embedBlocks: Array.from(content.children).filter(c => c.classList.contains('cm-embed-block')).map(c => c.className),
    lines: Array.from(content.querySelectorAll('.cm-line')).map(el => ({ cls: el.className.replace('cm-line', '').trim(), raw: el.textContent.slice(0, 30) })).filter(l => l.cls.includes('quote') || l.cls === ''),
  };
  // move cursor far away (first line)
  cm.dispatch({ selection: { anchor: 1 } });
  await sleep(500);
  out.afterCursorAway = {
    embedBlocks: Array.from(content.children).filter(c => c.classList.contains('cm-embed-block')).map(c => c.className),
  };

  // --- MarkdownRenderer edge cases ---
  const comp = new Component(); comp.load();
  const detached = document.createElement('div'); // NOT in document
  const p1 = MarkdownRenderer.render(app, '**bold** and [[probe4]]', detached, 'probe4.md', comp);
  out.detachedReturnsPromise = p1 && typeof p1.then === 'function';
  await p1; await sleep(150);
  out.detachedHTMLLen = detached.innerHTML.length;
  out.detachedHasLink = !!detached.querySelector('a.internal-link');

  // double render into the SAME el (duplicate risk)
  const dup = document.createElement('div');
  document.body.appendChild(dup);
  await MarkdownRenderer.render(app, 'first', dup, 'probe4.md', comp);
  await MarkdownRenderer.render(app, 'second', dup, 'probe4.md', comp);
  out.doubleRenderHTML = dup.innerHTML.slice(0, 80);

  // component child accounting + unload
  out.childrenBeforeUnload = comp._children ? comp._children.length : null;
  const host = document.createElement('div'); document.body.appendChild(host);
  await MarkdownRenderer.render(app, '![[probe4]]', host, 'probe4.md', comp);
  await sleep(300);
  out.childrenAfterEmbed = comp._children ? comp._children.length : null;
  comp.unload();
  out.childrenAfterUnload = comp._children ? comp._children.length : null;

  dup.remove(); host.remove(); detached.remove();
  return out;
})()
