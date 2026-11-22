type Submit = () => unknown;
type Editor = {getExpandedText(): string; handleInput(key: string): void; submitValue: Submit; actionHandlers: Map<string, Submit>};
type Tui = {getFocusedComponent?: () => Partial<Editor> | null};
export interface EditorUI {
  setWidget?(key: string, factory?: (tui: Tui) => {render(): string[]; invalidate(): void}): void;
  onTerminalInput?(handler: (key: string) => void): () => void;
}
const controls = /^(?:\/(?:settings|scoped-models|share|copy|session|changelog|hotkeys|fork|clone|tree|trust|logout|new|reload|debug|arminsayshi|dementedelves|resume|quit)$|\/(?:model|thinking|export|import|bug|name|login|compact|permission-system)(?: |$))/;
/** Pi 1.3.0：用空 widget 拿到 TUI，不更换编辑器；只旁听主编辑器已确认的提交。 */
export function watchPiEditor(ui: EditorUI | undefined, record: (text: string) => void) {
  if (!ui?.setWidget || !ui.onTerminalInput) return;
  let tui: Tui | undefined, restore: (() => void) | undefined, pending: string | undefined, dispatching = false;
  ui.setWidget("dev-loop-window", view => { tui = view; return {render: () => [], invalidate() {}}; }); ui.setWidget("dev-loop-window");
  const action = "app.message.followUp", off = ui.onTerminalInput(key => {
    pending = key; queueMicrotask(() => { pending = undefined; });
    if (restore) return;
    const editor = tui?.getFocusedComponent?.(), input = editor?.handleInput, submit = editor?.submitValue, actions = editor?.actionHandlers;
    const follow = actions instanceof Map && actions.get(action);
    if (!editor || typeof editor.getExpandedText !== "function" || typeof input !== "function" || typeof submit !== "function" || typeof follow !== "function") return;
    editor.handleInput = key => {
      if (dispatching || key !== pending) return input.call(editor, key);
      pending = undefined; dispatching = true;
      try { input.call(editor, key); } finally { dispatching = false; }
    };
    const tap = (next: Submit) => () => {
      if (dispatching && tui?.getFocusedComponent?.() === editor) try {
        const text = editor.getExpandedText!(), trimmed = text.trim(), shell = trimmed.startsWith("!") && trimmed.replace(/^!!?\s*/, "");
        if (trimmed && !shell && !controls.test(trimmed)) record(text);
      } catch (e) { console.error("记录窗口原话失败：", e); }
      return next.call(editor);
    };
    editor.submitValue = tap(submit); actions!.set(action, tap(follow));
    restore = () => { editor.handleInput = input; editor.submitValue = submit; actions!.set(action, follow); };
  });
  return () => { pending = undefined; off(); restore?.(); };
}
