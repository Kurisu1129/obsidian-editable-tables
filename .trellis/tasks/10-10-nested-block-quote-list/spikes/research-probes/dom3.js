(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const f = app.vault.getAbstractFileByPath('probe4.md');
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(f);
  await sleep(700);
  const em = leaf.view.editMode;
  const cm = em.cm;
  const content = cm.contentDOM;
  const out = { file: leaf.view.file?.path, sourceMode: em.sourceMode, activeFile: app.workspace.getActiveFile()?.path };
  const lines = Array.from(content.querySelectorAll('.cm-line'));
  out.dump = lines.map((el, i) => {
    const kids = Array.from(el.children).map(c => c.tagName.toLowerCase() + (c.className ? '.' + String(c.className).replace(/\s+/g,'.') : ''));
    return { i, cls: el.className, text: el.textContent.slice(0, 50), kids };
  });
  const callouts = content.querySelectorAll('.callout, .cm-callout');
  out.callouts = Array.from(callouts).map(el => ({ cls: el.className, parentCls: el.parentElement?.className, html: el.outerHTML.slice(0, 400) }));
  const tables = content.querySelectorAll('table');
  out.tables = Array.from(tables).map(t => {
    const ancestors = []; let p = t.parentElement;
    for (let i=0;i<8&&p;i++){ancestors.push(p.tagName.toLowerCase()+(p.className?'.'+String(p.className).replace(/\s+/g,'.'):''));p=p.parentElement;}
    return { cls: t.className, rows: t.rows.length, lineCls: t.closest('.cm-line')?.className ?? null, ancestors };
  });
  return out;
})()
