import type { Root, Text, Link, Parent } from 'mdast';
import { SKIP, visit } from 'unist-util-visit';

export function remarkLocalLinks() {
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (node.type === 'link' || node.type === 'linkReference') return SKIP;
      if (node.type !== 'text' || index === undefined || !parent) return;
      const parts: (Text | Link)[] = [];
      const pattern =
        /(?<![\w/:])\/(?:api\/artifacts|vault|credentials|browser-connect)\/[A-Za-z0-9_-]+(?:[?#][^\s<>"'\[\]()]+)?/g;
      let cursor = 0;
      for (const match of node.value.matchAll(pattern)) {
        if (match.index > cursor)
          parts.push({ type: 'text', value: node.value.slice(cursor, match.index) });
        const destination = match[0].replace(/[.,;:!?]+$/, '');
        parts.push({
          type: 'link',
          url: destination,
          children: [{ type: 'text', value: destination }],
        });
        if (destination.length < match[0].length)
          parts.push({ type: 'text', value: match[0].slice(destination.length) });
        cursor = match.index + match[0].length;
      }
      if (!parts.length) return;
      if (cursor < node.value.length) parts.push({ type: 'text', value: node.value.slice(cursor) });
      (parent as Parent).children.splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}
