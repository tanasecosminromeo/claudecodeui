import type { Link, Nodes, Parent, PhrasingContent, Root, Text } from 'mdast';

import { findTextFileReferences, inlineCodeFileReference } from '@/modules/chat/utils/fileReferences';

// Nodes whose text is never re-read for paths: links already go somewhere,
// and code blocks, math and raw HTML are shown as written.
const SKIPPED_NODE_TYPES = new Set(['link', 'linkReference', 'definition', 'code', 'math', 'inlineMath', 'html']);

// The path travels as `data-file-ref` beside the href: turning the URL into an
// href percent-encodes it, and the click handler needs the path as written.
const fileLink = (reference: string, children: PhrasingContent[]): Link => ({
  type: 'link',
  url: reference,
  children,
  data: { hProperties: { dataFileRef: reference } },
});

const splitText = (node: Text): PhrasingContent[] | null => {
  const references = findTextFileReferences(node.value);
  if (references.length === 0) {
    return null;
  }

  const pieces: PhrasingContent[] = [];
  let offset = 0;
  for (const { start, end, reference } of references) {
    if (start > offset) {
      pieces.push({ type: 'text', value: node.value.slice(offset, start) });
    }
    pieces.push(fileLink(reference, [{ type: 'text', value: node.value.slice(start, end) }]));
    offset = end;
  }
  if (offset < node.value.length) {
    pieces.push({ type: 'text', value: node.value.slice(offset) });
  }
  return pieces;
};

const linkFileReferences = (parent: Parent): void => {
  const children: Nodes[] = [];
  for (const child of parent.children as Nodes[]) {
    if (child.type === 'inlineCode') {
      const reference = inlineCodeFileReference(child.value);
      children.push(reference ? fileLink(reference, [child]) : child);
    } else if (child.type === 'text') {
      children.push(...(splitText(child) ?? [child]));
    } else {
      if (!SKIPPED_NODE_TYPES.has(child.type) && 'children' in child) {
        linkFileReferences(child);
      }
      children.push(child);
    }
  }
  parent.children = children as Parent['children'];
};

/**
 * Remark plugin used by the chat's Markdown renderer: file paths in inline
 * code and in plain text become links, which the renderer's `a` component
 * opens in the editor (or, for a folder, the file tree) like any markdown link
 * to a file. Which strings count as paths is decided in `fileReferences`.
 */
export default function remarkFileReferences() {
  return (tree: Root) => {
    linkFileReferences(tree);
  };
}
