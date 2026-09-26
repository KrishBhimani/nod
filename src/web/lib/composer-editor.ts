import { Extension, InputRule } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Plugin } from '@tiptap/pm/state';
import { safeMessageLink } from './message-links';

export function clipboardFiles(clipboard: DataTransfer): File[] {
  const files = Array.from(clipboard.files ?? []);
  if (files.length) return files;
  return Array.from(clipboard.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function createComposerExtensions(callbacks: {
  submit(): void;
  upload(files: File[]): void;
}) {
  return [
    StarterKit.configure({
      link: {
        openOnClick: false,
        isAllowedUri: (url) => Boolean(safeMessageLink(url, window.location.origin)),
      },
    }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: 'Message Sidekick…' }),
    Extension.create({
      name: 'chatInput',
      priority: 1000,
      addInputRules() {
        return [
          new InputRule({
            find: /(?<=\n)[\t ]*([-+*])\s$/,
            handler: ({ state, range, chain }) => {
              const $start = state.doc.resolve(range.from);
              if (
                $start.parent.type.name !== 'paragraph' ||
                $start.nodeBefore?.type.name !== 'hardBreak'
              )
                return null;
              return chain()
                .deleteRange({ from: range.from - 1, to: range.to })
                .setTextSelection(range.from - 1)
                .splitBlock()
                .wrapInList('bulletList')
                .run()
                ? undefined
                : null;
            },
          }),
        ];
      },
      addProseMirrorPlugins() {
        const editor = this.editor;
        return [
          new Plugin({
            props: {
              handleKeyDown(view, event) {
                if (
                  event.key !== 'Enter' ||
                  event.isComposing ||
                  view.composing ||
                  event.keyCode === 229
                )
                  return false;
                if (event.shiftKey) {
                  if (event.metaKey || event.ctrlKey || event.altKey) return false;
                  const { $from, empty } = view.state.selection;
                  const item = $from.depth > 0 ? $from.node(-1).type.name : undefined;
                  if (item !== 'listItem' && item !== 'taskItem') return false;
                  return (
                    editor.commands.splitListItem(item) ||
                    (empty && $from.parent.content.size === 0 && editor.commands.liftListItem(item))
                  );
                }
                event.preventDefault();
                callbacks.submit();
                return true;
              },
              handlePaste(_view, event) {
                const clipboard = event.clipboardData;
                if (!clipboard) return false;
                const files = clipboardFiles(clipboard);
                const text = clipboard.getData('text/plain');
                if (files.length) {
                  event.preventDefault();
                  callbacks.upload(files);
                  if (text) editor.commands.insertContent(text, { contentType: 'markdown' });
                  return true;
                }
                if (text && !clipboard.getData('text/html')) {
                  event.preventDefault();
                  editor.commands.insertContent(text, { contentType: 'markdown' });
                  return true;
                }
                return false;
              },
            },
          }),
        ];
      },
    }),
  ];
}
