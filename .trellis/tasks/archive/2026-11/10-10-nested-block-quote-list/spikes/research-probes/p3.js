(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(app.vault.getAbstractFileByPath('probe3.md'));
  await sleep(900);
  const cm = leaf.view.editMode.cm;
  const content = cm.contentDOM;
  const lines = Array.from(content.querySelectorAll('.cm-line'));
  const summary = lines.map((el) => ({
    cls: el.className.replace('cm-line', '').trim(),
    raw: el.textContent.slice(0, 40),
  }));
  const embeds = Array.from(content.children).filter(c => c.classList && c.classList.contains('cm-embed-block')).map(c => ({ cls: c.className, text: c.textContent.slice(0, 24) }));
  return { summary, embeds };
})()
