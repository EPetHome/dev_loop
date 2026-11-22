type Submit = () => unknown;
type Editor = {getExpandedText(): string; handleInput(key: string): void; submitValue: Submit; actionHandlers: Map<string, Submit>};
type Tui = {getFocusedComponent?: () => Partial<Editor> | null};
export interface EditorUI {
  setWidget?(key: string, factory?: (tui: Tui) => {render(): string[]; invalidate(): void}): void;
  onTerminalInput?(handler: (key: string) => void): () => void;
}
const controls = /^(?:!(?!$|!$)|\/(?:settings|scoped-models|share|copy|session|changelog|hotkeys|fork|clone|tree|trust|logout|new|reload|debug|arminsayshi|dementedelves|resume|quit)$|\/(?:model|thinking|export|import|bug|name|login|compact)(?: |$))/;
/** Pi 1.3.0：旁听主编辑器；忙时 Alt+Enter 绕过 TUI 命令，isIdle 正好是未流式且未压缩。 */
export function watchPiEditor(ctx: {ui?: EditorUI; isIdle?(): boolean}, record: (text: string) => void, isExtensionCommand: (name: string) => boolean) {
  const {ui} = ctx; if (!ui?.setWidget || !ui.onTerminalInput) return;
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
    const tap = (next: Submit, followUp = false) => () => {
      if (dispatching && tui?.getFocusedComponent?.() === editor) try {
        const text = editor.getExpandedText!(), trimmed = text.trim(), direct = !followUp || ctx.isIdle?.() !== false;
        if (trimmed && !(direct && controls.test(trimmed)) && !(trimmed.startsWith("/") && isExtensionCommand(trimmed.slice(1).split(" ", 1)[0]))) record(text);
      } catch (e) { console.error("记录窗口原话失败：", e); }
      return next.call(editor);
    };
    editor.submitValue = tap(submit); actions!.set(action, tap(follow, true));
    restore = () => { editor.handleInput = input; editor.submitValue = submit; actions!.set(action, follow); };
  });
  return () => { pending = undefined; off(); restore?.(); };
}
