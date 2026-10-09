(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const { MarkdownRenderer, Component } = window.__probe;
  const out = {};
  out.renderFullSig = String(MarkdownRenderer.render);
  out.renderReturnsPromise = null;

  // 1) table + heading + code + list + link + embed
  const md = [
    '## Heading',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '- item',
    '',
    '[[probe4]] and ![[probe4]]',
    '',
    '$x^2$',
  ].join('\n');

  const host = document.createElement('div');
  document.body.appendChild(host);
  const comp = new Component();
  comp.load();
  let ret;
  try {
    ret = MarkdownRenderer.render(app, md, host, 'probe4.md', comp);
    out.renderReturnsPromise = ret && typeof ret.then === 'function';
    if (out.renderReturnsPromise) await ret;
  } catch (e) { out.renderErr = String(e && e.message || e); }
  await sleep(200);
  out.hostHTML = host.innerHTML.slice(0, 2500);
  out.childClasses = Array.from(host.children).map(c => c.tagName.toLowerCase() + (c.className ? '.' + String(c.className).replace(/\s+/g, '.') : ''));
  // component children tracking
  out.compChildCount = comp._children ? comp._children.length : null;
  // internal link resolution
  const link = host.querySelector('a.internal-link');
  out.linkInfo = link ? { href: link.getAttribute('href'), text: link.textContent, cls: link.className } : null;
  // embed
  const emb = host.querySelector('.internal-embed, .markdown-embed');
  out.embedInfo = emb ? { cls: emb.className, text: emb.textContent.slice(0, 40) } : null;
  // mermaid/math
  out.hasMath = !!host.querySelector('.math, .cm-math, mjx-container, .mjx-chtml');
  // cleanup
  comp.unload();
  host.remove();
  return out;
})()
