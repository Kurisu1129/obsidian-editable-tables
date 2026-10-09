(() => {
  const out = {};
  out.activeFile = app.workspace.getActiveFile()?.path ?? null;
  out.mdLeaves = app.workspace.getLeavesOfType('markdown').map(l => l.view?.file?.path ?? null);
  out.appKeys = Object.keys(app).slice(0, 80);
  out.globals = ['MarkdownRenderer','MarkdownRenderChild','Component','Plugin','obsidian','require'].map(k => k + '=' + (typeof window[k]));
  try { const ob = window.require('obsidian'); out.obsidianKeys = ob ? Object.keys(ob).slice(0,150) : null; } catch(e) { out.requireErr = String(e); }
  out.plugins = app.plugins ? Object.keys(app.plugins.plugins || {}) : null;
  return out;
})()
