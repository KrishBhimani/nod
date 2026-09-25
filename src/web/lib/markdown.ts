import type { Root, Text, Link, Parent } from 'mdast';
import { visit } from 'unist-util-visit';

export function remarkLocalLinks() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (index === undefined || !parent || ['link', 'linkReference'].includes(parent.type)) return;
      const parts: (Text | Link)[] = [];
      const pattern =
        /(?<![\w/:])\/(?:api\/artifacts|vault|credentials|approvals)\/[A-Za-z0-9_-]+/g;
      let cursor = 0;
      for (const match of node.value.matchAll(pattern)) {
        if (match.index > cursor)
          parts.push({ type: 'text', value: node.value.slice(cursor, match.index) });
        parts.push({ type: 'link', url: match[0], children: [{ type: 'text', value: match[0] }] });
        cursor = match.index + match[0].length;
      }
      if (!parts.length) return;
      if (cursor < node.value.length) parts.push({ type: 'text', value: node.value.slice(cursor) });
      (parent as Parent).children.splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}
