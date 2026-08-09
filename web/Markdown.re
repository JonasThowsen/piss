/* Markdown rendering for assistant messages.
 *
 * Renders fenced code blocks with copy buttons and parses inline markdown
 * (code spans, bold, links) plus block-level patterns (lists, headings,
 * blockquotes, paragraphs). Inline `copy` / `check` glyphs are inlined as
 * React elements so we don't pull in a full markdown dependency. */

open Types;

let render:
  (string, string, (string, string) => unit, string) => array(React.element) = [%raw
  {|(text, itemId, onCopy, feedback) => {
        const copyGlyph = () => React.createElement('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, React.createElement('rect', { width: 14, height: 14, x: 8, y: 8, rx: 2 }), React.createElement('path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }));
        const checkGlyph = () => React.createElement('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, React.createElement('path', { d: 'M20 6 9 17l-5-5' }));
        const inline = (value, key) => {
          const parts = [];
          const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
          let cursor = 0, match, index = 0;
          while ((match = pattern.exec(value))) {
            if (match.index > cursor) parts.push(value.slice(cursor, match.index));
            const token = match[0];
            if (token.startsWith('`')) parts.push(React.createElement('code', { key: `${key}-i${index}` }, token.slice(1, -1)));
            else if (token.startsWith('**')) parts.push(React.createElement('strong', { key: `${key}-i${index}` }, token.slice(2, -2)));
            else { const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/); const href = link?.[2] || ''; parts.push(/^https?:\/\//.test(href) ? React.createElement('a', { key: `${key}-i${index}`, href, target: '_blank', rel: 'noreferrer' }, link[1]) : link?.[1] || token); }
            cursor = match.index + token.length; index++;
          }
          if (cursor < value.length) parts.push(value.slice(cursor));
          return parts;
        };
        const copyButton = (key, value, label) => { const copied = feedback === key; const failed = feedback === `error:${key}`; return React.createElement('button', { type: 'button', className: `markdown-copy ${copied ? 'copied' : failed ? 'failed' : ''}`, onClick: () => onCopy(key, value), 'aria-label': `${copied ? 'Copied' : failed ? 'Copy failed' : 'Copy'} ${label}` }, copied ? checkGlyph() : copyGlyph(), React.createElement('b', null, copied ? 'Copied' : failed ? 'Failed' : 'Copy')); };
        const blocks = [];
        const addPlain = source => {
          for (const raw of source.split(/\n{2,}/)) {
            const value = raw.trim(); if (!value) continue;
            const index = blocks.length; const key = `${itemId}-block-${index}`;
            const lines = value.split('\n');
            let content;
            if (lines.every(line => /^\s*[-*]\s+/.test(line))) content = React.createElement('ul', null, ...lines.map((line, i) => React.createElement('li', { key: i }, ...inline(line.replace(/^\s*[-*]\s+/, ''), `${key}-${i}`))));
            else if (lines.every(line => /^\s*\d+\.\s+/.test(line))) content = React.createElement('ol', null, ...lines.map((line, i) => React.createElement('li', { key: i }, ...inline(line.replace(/^\s*\d+\.\s+/, ''), `${key}-${i}`))));
            else if (/^#{1,4}\s+/.test(value)) { const mark = value.match(/^(#{1,4})\s+([\s\S]*)$/); const level = Math.min(4, mark[1].length + 2); content = React.createElement(`h${level}`, null, ...inline(mark[2], key)); }
            else if (lines.every(line => /^>\s?/.test(line))) content = React.createElement('blockquote', null, ...inline(lines.map(line => line.replace(/^>\s?/, '')).join('\n'), key));
            else content = React.createElement('p', null, ...lines.flatMap((line, i) => i === 0 ? inline(line, `${key}-${i}`) : [React.createElement('br', { key: `${key}-br-${i}` }), ...inline(line, `${key}-${i}`)]));
            blocks.push(React.createElement('section', { className: 'markdown-block markdown-text-block', key }, content));
          }
        };
        const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
        let cursor = 0, match;
        while ((match = fence.exec(text))) {
          addPlain(text.slice(cursor, match.index));
          const language = match[1].trim() || 'Text'; const code = match[2].replace(/\n$/, ''); const index = blocks.length; const key = `${itemId}-block-${index}`;
          blocks.push(React.createElement('section', { className: 'markdown-block markdown-code-block', key }, React.createElement('span', { className: 'markdown-code-language', 'aria-hidden': true }, language), copyButton(key, code, 'code block'), React.createElement('pre', null, React.createElement('code', null, code))));
          cursor = match.index + match[0].length;
        }
        addPlain(text.slice(cursor));
        return blocks;
      }|}
];
