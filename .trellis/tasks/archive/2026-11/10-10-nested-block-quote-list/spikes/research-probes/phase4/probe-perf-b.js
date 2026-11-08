(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cm = app.workspace.activeLeaf.view.editor.cm;
  const el = cm.contentDOM;
  cm.dispatch({ selection: { anchor: 0 }, scrollIntoView: false });
  await sleep(300);
  const firstWidgets = [...el.querySelectorAll('.mdft-quote, .mdft-table')];
  const times = [];
  const lineCount = cm.state.doc.lines;
  for (let i = 0; i < 60; i++) {
    const line = 1 + Math.floor(((i + 0.5) / 60) * (lineCount - 1));
    const t0 = performance.now();
    cm.dispatch({ selection: { anchor: cm.state.doc.line(line).from }, scrollIntoView: false });
    times.push(+(performance.now() - t0).toFixed(2));
  }
  await sleep(600);
  const after = [...el.querySelectorAll('.mdft-quote, .mdft-table')];
  const sorted = [...times].sort((a, b) => a - b);
  return JSON.stringify({
    lines: lineCount,
    avg: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2),
    p95: sorted[Math.floor(times.length * 0.95)], max: sorted[sorted.length - 1],
    widgetsBefore: firstWidgets.length, widgetsAfter: after.length,
    reused: firstWidgets.filter((n) => n.isConnected && after.includes(n)).length,
  });
})()
