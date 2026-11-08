import { MarkdownView, Notice, Plugin } from 'obsidian';
import { editableTablesExtension } from './editor';
import { configureWriteback } from './editor/writeback';
import { exportMarkdown, type MarkdownExport } from './model/exportMarkdown';

interface PluginData {
  /** R8: whether the HTML-conversion disclosure has already been shown. */
  htmlNoticeSeen?: boolean;
}

/** Human-readable summary for the export notices. */
function describeExport(result: MarkdownExport): string {
  const parts = [`转换 ${result.converted} 张表格`];
  if (result.skipped > 0) parts.push(`${result.skipped} 张保持 HTML`);
  return parts.join('，');
}

/** Clipboard write with a legacy fallback for environments that refuse the async API. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export default class EditableTablesPlugin extends Plugin {
  private data: PluginData = {};

  async onload(): Promise<void> {
    // Register before the first `await`. `registerEditorExtension` only affects editors
    // created *after* the call, so awaiting first can leave notes that are already open
    // permanently unrendered until the user reopens them.
    this.registerEditorExtension(editableTablesExtension);

    this.data = ((await this.loadData()) as PluginData | null) ?? {};

    configureWriteback({
      noticeSeen: this.data.htmlNoticeSeen === true,
      onNoticeShown: () => {
        this.data.htmlNoticeSeen = true;
        void this.saveData(this.data);
      },
    });

    this.addCommand({
      id: 'copy-as-markdown',
      name: '复制当前笔记为 Markdown（表格转为管道语法）',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (!checking) void this.copyAsMarkdown(view);
        return true;
      },
    });

    this.addCommand({
      id: 'export-as-markdown',
      name: '导出当前笔记为 Markdown 文件（表格转为管道语法）',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (!checking) this.exportAsMarkdownFile(view);
        return true;
      },
    });

    console.log('[md-formatter] editable tables extension registered');
  }

  /**
   * Copies a Markdown-native version of the active note (all convertible HTML tables
   * become pipe tables). Read-only with respect to the vault.
   */
  private async copyAsMarkdown(view: MarkdownView): Promise<void> {
    const result = exportMarkdown(view.editor.getValue());
    if (await copyText(result.text)) {
      new Notice(`已复制 Markdown（${describeExport(result)}）。`);
    } else {
      new Notice('复制失败：无法访问剪贴板。');
    }
  }

  /**
   * Downloads a Markdown-native version of the active note as `<basename>.md`.
   * Obsidian runs in Electron, so an object-URL download is enough; no vault write.
   */
  private exportAsMarkdownFile(view: MarkdownView): void {
    const result = exportMarkdown(view.editor.getValue());
    const name = `${view.file?.basename ?? 'note'}.md`;

    const blob = new Blob([result.text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);

    new Notice(`已导出 ${name}（${describeExport(result)}）。`);
  }
}
