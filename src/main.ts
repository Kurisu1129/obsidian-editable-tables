import { Plugin } from 'obsidian';
import { editableTablesExtension } from './editor';
import { configureWriteback } from './editor/writeback';

interface PluginData {
  /** R8: whether the HTML-conversion disclosure has already been shown. */
  htmlNoticeSeen?: boolean;
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

    console.log('[md-formatter] editable tables extension registered');
  }

  onunload(): void {
    console.log('[md-formatter] unloaded');
  }
}
