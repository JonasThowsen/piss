type requestInit;

type timelineItem;
type artifactItem;
type permissionOption;
type sessionSnapshot;
type sessionSummary;
type workspaceSummary;
type directoryCandidate;
type configOption;
type configChoice;
type outboxItem;
type composerImage;
type browserFile;
type fileMention;
type activeMention;
type disposer = unit => unit;

[@mel.get] external itemId: timelineItem => string = "id";
[@mel.get] external itemRole: timelineItem => string = "role";
[@mel.get] external itemTitle: timelineItem => string = "title";
[@mel.get] external itemText: timelineItem => string = "text";
[@mel.get] external itemStatus: timelineItem => string = "status";
let itemKind: timelineItem => string = [%raw
  "item => typeof item.kind === 'string' ? item.kind : ''"
];
let itemArtifacts: timelineItem => array(artifactItem) = [%raw
  "item => Array.isArray(item.artifacts) ? item.artifacts : []"
];
let itemImageCount: timelineItem => int = [%raw
  "item => Number.isInteger(item.imageCount) ? item.imageCount : 0"
];
let itemLocations: timelineItem => array(artifactItem) = [%raw
  "item => Array.isArray(item.locations) ? item.locations : []"
];
[@mel.get] external artifactType: artifactItem => string = "type";
[@mel.get] external artifactPath: artifactItem => string = "path";
[@mel.get] external artifactText: artifactItem => string = "text";
[@mel.get] external artifactOldText: artifactItem => string = "oldText";
[@mel.get] external artifactNewText: artifactItem => string = "newText";
[@mel.get] external artifactSource: artifactItem => string = "src";
[@mel.get]
external itemOptions: timelineItem => array(permissionOption) = "options";
[@mel.get] external optionId: permissionOption => string = "optionId";
[@mel.get] external optionName: permissionOption => string = "name";
[@mel.get] external snapshotStatus: sessionSnapshot => string = "status";
[@mel.get] external snapshotAgentName: sessionSnapshot => string = "agentName";
[@mel.get] external snapshotWorkerPid: sessionSnapshot => int = "workerPid";
[@mel.get] external snapshotHarnessPid: sessionSnapshot => int = "harnessPid";
[@mel.get] external snapshotSequence: sessionSnapshot => int = "lastSequence";
[@mel.get] external snapshotFirstSequence: sessionSnapshot => int = "firstSequence";
let snapshotRetentionPruned: sessionSnapshot => bool = [%raw
  "snapshot => snapshot?.retentionPruned === true"
];
let snapshotAcceptsImages: sessionSnapshot => bool = [%raw
  "snapshot => snapshot?.acceptsImages === true"
];
[@mel.get] external sessionId: sessionSummary => string = "id";
[@mel.get] external sessionTitle: sessionSummary => string = "title";
[@mel.get] external sessionHarness: sessionSummary => string = "harness";
[@mel.get] external sessionStatus: sessionSummary => string = "status";
[@mel.get]
external sessionWorkspaceId: sessionSummary => string = "workspaceId";
[@mel.get] external workspaceId: workspaceSummary => string = "id";
[@mel.get] external workspaceName: workspaceSummary => string = "name";
[@mel.get] external workspaceRoot: workspaceSummary => string = "root";
[@mel.get] external directoryPath: directoryCandidate => string = "path";
[@mel.get] external directoryName: directoryCandidate => string = "name";
[@mel.get] external configId: configOption => string = "id";
[@mel.get] external configCategory: configOption => string = "category";
[@mel.get] external configName: configOption => string = "name";
[@mel.get]
external configCurrentValue: configOption => string = "currentValue";
[@mel.get]
external configChoices: configOption => array(configChoice) = "options";
[@mel.get] external choiceValue: configChoice => string = "value";
[@mel.get] external outboxId: outboxItem => string = "id";
[@mel.get] external outboxAction: outboxItem => string = "action";
[@mel.get] external outboxText: outboxItem => string = "text";
[@mel.get] external outboxState: outboxItem => string = "state";
[@mel.get] external imageId: composerImage => string = "id";
[@mel.get] external imageName: composerImage => string = "name";
[@mel.get] external imagePreview: composerImage => string = "preview";
[@mel.get] external imageSize: composerImage => int = "size";
[@mel.get] external mentionPath: fileMention => string = "path";
[@mel.get] external mentionName: fileMention => string = "name";
[@mel.get] external mentionKind: fileMention => string = "kind";
[@mel.get] external activeMentionQuery: activeMention => string = "query";

[@mel.scope "String"] external fromCodePoint: int => string = "fromCodePoint";

let icon: string => React.element = [%raw
  "name => { const n = { menu: [['path',{d:'M4 5h16'}],['path',{d:'M4 12h16'}],['path',{d:'M4 19h16'}]], search: [['path',{d:'m21 21-4.34-4.34'}],['circle',{cx:11,cy:11,r:8}]], plus: [['path',{d:'M5 12h14'}],['path',{d:'M12 5v14'}]], more: [['circle',{cx:12,cy:12,r:1}],['circle',{cx:19,cy:12,r:1}],['circle',{cx:5,cy:12,r:1}]], chevron: [['path',{d:'m6 9 6 6 6-6'}]], up: [['path',{d:'m5 12 7-7 7 7'}],['path',{d:'M12 19V5'}]], down: [['path',{d:'M12 5v14'}],['path',{d:'m19 12-7 7-7-7'}]], at: [['circle',{cx:12,cy:12,r:4}],['path',{d:'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8'}]], activity: [['path',{d:'M3 12h3l3 -9l6 18l3 -9h2'}]], bot: [['path',{d:'M12 8V4H8'}],['rect',{width:16,height:12,x:4,y:8,rx:2}],['path',{d:'M2 14h2'}],['path',{d:'M20 14h2'}],['path',{d:'M15 13v2'}],['path',{d:'M9 13v2'}]], diff: [['path',{d:'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z'}],['path',{d:'M9 10h6'}],['path',{d:'M12 13V7'}],['path',{d:'M9 17h6'}]], gauge: [['path',{d:'m12 14 4-4'}],['path',{d:'M3.34 19a10 10 0 1 1 17.32 0'}]], x: [['path',{d:'M18 6 6 18'}],['path',{d:'m6 6 12 12'}]], archive: [['rect',{width:20,height:5,x:2,y:3,rx:1}],['path',{d:'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8'}],['path',{d:'M10 12h4'}]], copy: [['rect',{width:14,height:14,x:8,y:8,rx:2,ry:2}],['path',{d:'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'}]], trash: [['path',{d:'M3 6h18'}],['path',{d:'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'}],['path',{d:'M19 6l-1 14c0 1-1 2-2 2H8c-1 0-2-1-2-2L5 6'}],['path',{d:'M10 11v6'}],['path',{d:'M14 11v6'}]], check: [['path',{d:'M20 6 9 17l-5-5'}]], external: [['path',{d:'M15 3h6v6'}],['path',{d:'M10 14 21 3'}],['path',{d:'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'}]], image: [['rect',{width:18,height:18,x:3,y:3,rx:2,ry:2}],['circle',{cx:9,cy:9,r:2}],['path',{d:'m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21'}]], file: [['path',{d:'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z'}],['polyline',{points:'14 2 14 8 20 8'}]] }; return React.createElement('svg',{viewBox:'0 0 24 24',width:24,height:24,fill:'none',stroke:'currentColor',strokeWidth:2,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},...(n[name]||[]).map(([tag,props],i)=>React.createElement(tag,{...props,key:i}))); }"
];

let copyToClipboard: string => Js.Promise.t(unit) = [%raw
  {|async text => {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return; } catch (_) {}
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const selection = previous && 'selectionStart' in previous
      ? { start: previous.selectionStart, end: previous.selectionEnd }
      : null;
    const field = document.createElement('textarea');
    field.value = text;
    field.readOnly = true;
    field.setAttribute('aria-hidden', 'true');
    Object.assign(field.style, { position: 'fixed', top: '0', left: '-9999px', opacity: '0' });
    document.body.append(field);
    let copied = false;
    try {
      field.focus({ preventScroll: true });
      field.select();
      copied = document.execCommand('copy');
    } finally {
      field.remove();
      previous?.focus({ preventScroll: true });
      if (selection) previous.setSelectionRange(selection.start, selection.end);
    }
    if (!copied) throw new Error('Clipboard access was denied');
  }|}
];
let scheduleCopyReset: ((string => string) => unit, string) => unit = [%raw
  {|(setFeedback, key) => {
    globalThis.__pissCopyTimers ||= new WeakMap();
    const previous = globalThis.__pissCopyTimers.get(setFeedback);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      setFeedback(current => current === key || current === `error:${key}` ? '' : current);
      globalThis.__pissCopyTimers.delete(setFeedback);
    }, 1800);
    globalThis.__pissCopyTimers.set(setFeedback, timer);
  }|}
];
let renderMarkdown:
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

let getText: string => Js.Promise.t(string) = [%raw
  "url => fetch(url).then(async response => { const text = await response.text(); if (!response.ok) throw new Error(text || `HTTP ${response.status}`); return text; })"
];

let postText: (string, string) => Js.Promise.t(string) = [%raw
  "(url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then(async response => { const text = await response.text(); if (!response.ok) throw new Error(text || `HTTP ${response.status}`); return text; })"
];
let waitForSession: string => Js.Promise.t(string) = [%raw
  {|id => new Promise((resolve, reject) => {
    let attempts = 0;
    const poll = async () => {
      try {
        const response = await fetch(`/api/v2/session?session=${encodeURIComponent(id)}`);
        const text = await response.text();
        if (response.ok) { resolve(text); return; }
      } catch (_) {}
      if (++attempts >= 40) { reject(new Error('Restored worker did not become ready')); return; }
      setTimeout(poll, 250);
    };
    poll();
  })|}
];

let errorMessage: Js.Promise.error => string = [%raw
  "error => { try { const parsed = JSON.parse(error?.message || ''); return parsed.error || error.message; } catch (_) { return error?.message || 'Request failed'; } }"
];

let promptValue: unit => string = [%raw
  "() => document.getElementById('prompt-input')?.value?.trim() || ''"
];
let activeMentionFromEvent: 'a => option(activeMention) = [%raw
  {|event => {
    const field = event.currentTarget;
    const text = field?.value || '';
    const cursor = field?.selectionStart ?? text.length;
    if (Date.now() < (globalThis.__pissSuppressMentionUntil || 0)) return undefined;
    const completed = globalThis.__pissCompletedMention;
    if (completed?.text === text && completed.cursor === cursor) return undefined;
    globalThis.__pissCompletedMention = null;
    const lineStart = text.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
    const match = text.slice(lineStart, cursor).match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
    const prefix = match?.[1];
    if (!prefix) return undefined;
    return { query: prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1), start: cursor - prefix.length, end: cursor };
  }|}
];
let activeMentionKey: activeMention => string = [%raw
  "active => `${active.start}:${active.end}:${active.query}`"
];
let insertMentionTrigger: unit => option(activeMention) = [%raw
  {|() => {
    const field = document.getElementById('prompt-input');
    if (!field) return undefined;
    const text = field.value || '';
    const start = field.selectionStart ?? text.length;
    const end = field.selectionEnd ?? start;
    const separator = start > 0 && !/[ \t\n]/.test(text[start - 1] || '') ? ' ' : '';
    globalThis.__pissCompletedMention = null;
    field.value = `${text.slice(0, start)}${separator}@${text.slice(end)}`;
    const cursor = start + separator.length + 1;
    field.focus();
    field.setSelectionRange(cursor, cursor);
    return { query: '', start: cursor - 1, end: cursor };
  }|}
];
let applyFileMention: (activeMention, string) => bool = [%raw
  {|(active, path) => {
    const field = document.getElementById('prompt-input');
    if (!field || !field.value.slice(active.start, active.end).startsWith('@')) return false;
    const value = /\s/u.test(path) ? `@"${path}"` : `@${path}`;
    field.value = `${field.value.slice(0, active.start)}${value}${field.value.slice(active.end)}`;
    const cursor = active.start + value.length;
    globalThis.__pissCompletedMention = { text: field.value, cursor };
    globalThis.__pissSuppressMentionUntil = Date.now() + 100;
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(cursor, cursor); });
    return true;
  }|}
];
let addMentionResource:
  (array(fileMention), fileMention) => array(fileMention) = [%raw
  "(resources, mention) => resources.some(current => current.path === mention.path) ? resources : [...resources, mention]"
];
let resourcesJson: (string, array(fileMention)) => Js.Json.t = [%raw
  {|(text, resources) => {
    const seen = new Set();
    return resources.filter(resource => {
      const token = /\s/u.test(resource.path) ? `@"${resource.path}"` : `@${resource.path}`;
      if (!text.includes(token) || seen.has(resource.path)) return false;
      seen.add(resource.path);
      return true;
    }).map(resource => ({ path: resource.path }));
  }|}
];
let requestFileMentions: (string, string) => Js.Promise.t(string) = [%raw
  {|(sessionId, query) => {
    const current = (globalThis.__pissMentionGeneration || 0) + 1;
    globalThis.__pissMentionGeneration = current;
    globalThis.__pissMentionController?.abort();
    const controller = new AbortController();
    globalThis.__pissMentionController = controller;
    return fetch(`/api/v2/file-mentions?session=${encodeURIComponent(sessionId)}&query=${encodeURIComponent(query)}`, { signal: controller.signal }).then(async response => {
      const text = await response.text();
      if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
      if (current !== globalThis.__pissMentionGeneration) throw new DOMException('Stale file search', 'AbortError');
      return text;
    });
  }|}
];
let cancelFileMentionSearch: unit => unit = [%raw
  "() => { globalThis.__pissMentionGeneration = (globalThis.__pissMentionGeneration || 0) + 1; globalThis.__pissMentionController?.abort(); globalThis.__pissMentionController = null; }"
];
let isAbortError: Js.Promise.error => bool = [%raw
  "error => error?.name === 'AbortError'"
];
let nextMentionIndex: (int, int, int) => int = [%raw
  "(current, count, direction) => count <= 0 ? 0 : (current + direction + count) % count"
];
let fieldValue: string => string = [%raw
  "id => document.getElementById(id)?.value?.trim() || ''"
];
let confirmRename: string => option(string) = [%raw
  "current => { const value = window.prompt('Rename session', current); return value && value.trim() ? value.trim() : undefined; }"
];

let clearPrompt: unit => unit = [%raw
  "() => { globalThis.__pissCompletedMention = null; const field = document.getElementById('prompt-input'); if (field) { field.value = ''; field.focus(); } }"
];
let openImagePicker: unit => unit = [%raw
  "() => document.getElementById('composer-image-input')?.click()"
];
let clearImagePicker: unit => unit = [%raw
  "() => { const input = document.getElementById('composer-image-input'); if (input) input.value = ''; }"
];
let imageFilesFromInput: 'a => array(browserFile) = [%raw
  "event => { const files = Array.from(event.currentTarget?.files || []); if (event.currentTarget) event.currentTarget.value = ''; return files; }"
];
let imageFilesFromPaste: 'a => array(browserFile) = [%raw
  "event => Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean)"
];
let readComposerImages:
  (array(browserFile), array(composerImage)) =>
  Js.Promise.t(array(composerImage)) = [%raw
  {|(files, current) => new Promise(async (resolve, reject) => {
      const selected = Array.from(files || []);
      if (!selected.length) { resolve(current); return; }
      if (current.length + selected.length > 4) { reject(new Error('At most four images may be attached')); return; }
      const supported = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
      const unsupported = selected.find(file => !supported.has(file.type));
      if (unsupported) { reject(new Error(`Unsupported image type: ${unsupported.type || unsupported.name}`)); return; }
      const total = current.reduce((sum, image) => sum + image.size, 0) + selected.reduce((sum, file) => sum + file.size, 0);
      if (total > 10 * 1024 * 1024) { reject(new Error('Image attachments exceed the 10 MiB limit')); return; }
      try {
        const additions = await Promise.all(selected.map(file => new Promise((resolveFile, rejectFile) => {
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result !== 'string') { rejectFile(new Error('Could not read image')); return; }
            const comma = reader.result.indexOf(',');
            if (comma < 0) { rejectFile(new Error('Could not read image')); return; }
            resolveFile({ id: crypto.randomUUID?.() || `image-${Date.now()}-${Math.random()}`, mimeType: file.type, data: reader.result.slice(comma + 1), name: file.name || 'Pasted image', preview: reader.result, size: file.size });
          };
          reader.onerror = () => rejectFile(reader.error || new Error('Could not read image'));
          reader.readAsDataURL(file);
        })));
        resolve([...current, ...additions]);
      } catch (error) { reject(error); }
    })|}
];
let imagesJson: array(composerImage) => Js.Json.t = [%raw
  "images => images.map(({ mimeType, data, name }) => ({ mimeType, data, name }))"
];
let removeComposerImage:
  (array(composerImage), string) => array(composerImage) = [%raw
  "(images, id) => images.filter(image => image.id !== id)"
];
let formatImageSize: int => string = [%raw
  "size => size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`"
];
let eventValue: 'a => string = [%raw
  "event => event.currentTarget?.value || ''"
];
let eventKey: 'a => string = [%raw "event => event.key || ''"];
let preventAnyDefault: 'a => unit = [%raw "event => event.preventDefault()"];
let updateTimelineFollowFromScroll: 'a => bool = [%raw
  {|event => {
    const timeline = event.currentTarget;
    const away = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight > 80;
    timeline.dataset.follow = away ? 'false' : 'true';
    return away;
  }|}
];
let jumpTimelineToBottom: unit => unit = [%raw
  {|() => {
    const timeline = document.getElementById('timeline');
    if (!timeline) return;
    timeline.dataset.follow = 'true';
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: 'auto' });
  }|}
];
let resetTimelineFollow: unit => unit = [%raw
  {|() => requestAnimationFrame(() => {
    const timeline = document.getElementById('timeline');
    if (!timeline) return;
    timeline.dataset.follow = 'true';
    timeline.scrollTop = timeline.scrollHeight;
  })|}
];
let installTimelineFollower: unit => disposer = [%raw
  {|() => {
    const timeline = document.getElementById('timeline');
    const stream = timeline?.querySelector('.timeline-stream');
    if (!timeline || !stream) return () => {};
    let frame = 0;
    const follow = () => {
      if (timeline.dataset.follow === 'false') return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { timeline.scrollTop = timeline.scrollHeight; });
    };
    const mutations = new MutationObserver(follow);
    mutations.observe(stream, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(follow);
    resize.observe(stream);
    timeline.dataset.follow = 'true';
    follow();
    return () => { cancelAnimationFrame(frame); mutations.disconnect(); resize.disconnect(); };
  }|}
];
let searchShortcutLabel: unit => string = [%raw
  "() => /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'"
];
let watchSearchShortcut: (unit => unit) => disposer = [%raw
  {|open => {
    const handler = event => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }|}
];
let watchVisibleViewport: (unit, unit) => unit = [%raw
  "() => { const sync = () => { const viewport = window.visualViewport; const height = viewport?.height || window.innerHeight; document.documentElement.style.setProperty('--app-height', `${height}px`); }; sync(); requestAnimationFrame(sync); const timer = setTimeout(sync, 250); window.addEventListener('resize', sync); window.addEventListener('pageshow', sync); window.visualViewport?.addEventListener('resize', sync); return () => { clearTimeout(timer); window.removeEventListener('resize', sync); window.removeEventListener('pageshow', sync); window.visualViewport?.removeEventListener('resize', sync); }; }"
];

let preventDefault: React.Event.Form.t => unit = [%raw
  "event => event.preventDefault()"
];
let isRejectOption: string => bool = [%raw
  "value => value.includes('reject')"
];
let scrollTimeline: unit => unit = [%raw
  "() => requestAnimationFrame(() => { const timeline = document.getElementById('timeline'); if (timeline && timeline.dataset.follow !== 'false') timeline.scrollTop = timeline.scrollHeight; })"
];
let composerKeyDown: React.Event.Keyboard.t => unit = [%raw
  "event => { if (event.key === 'Enter' && !event.shiftKey && (event.metaKey || event.ctrlKey || !matchMedia('(max-width: 760px)').matches)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }"
];

let parseSnapshot: string => sessionSnapshot = [%raw
  "text => { try { return JSON.parse(text); } catch (_) { return { status: 'offline', agentName: 'ACP agent', workerPid: 0, harnessPid: 0, lastSequence: 0 }; } }"
];
let parseSessions: string => array(sessionSummary) = [%raw
  "text => { try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch (_) { return []; } }"
];
let parseWorkspaces: string => array(workspaceSummary) = [%raw
  "text => { try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch (_) { return []; } }"
];
let parseDirectories: string => array(directoryCandidate) = [%raw
  "text => { try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch (_) { return []; } }"
];
let parseConfigOptions: string => array(configOption) = [%raw
  "text => { try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch (_) { return []; } }"
];
let parseFileMentions: string => array(fileMention) = [%raw
  "text => { try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch (_) { return []; } }"
];
let configOptionsFromSnapshot: string => string = [%raw
  "text => { try { const value = JSON.parse(text).configOptions; return JSON.stringify(Array.isArray(value) ? value : []); } catch (_) { return '[]'; } }"
];
let findConfigOption: (array(configOption), string) => option(configOption) = [%raw
  "(options, category) => options.find(option => option.category === category)"
];
let configCurrentName: configOption => string = [%raw
  "option => { const name = option.options?.find(choice => choice.value === option.currentValue)?.name || option.currentValue || 'Choose'; return name.includes('/') ? name.slice(name.indexOf('/') + 1) : name; }"
];
let choiceDisplayName: configChoice => string = [%raw
  "choice => choice.name.includes('/') ? choice.name.slice(choice.name.indexOf('/') + 1) : choice.name"
];
let sessionsForWorkspace:
  (array(sessionSummary), string) => array(sessionSummary) = [%raw
  "(sessions, workspaceId) => sessions.filter(session => session.workspaceId === workspaceId)"
];
let searchSessions:
  (array(sessionSummary), array(workspaceSummary), string) =>
  array(sessionSummary) = [%raw
  "(sessions, workspaces, query) => { const needle = query.trim().toLocaleLowerCase(); const workspaceById = new Map(workspaces.map(workspace => [workspace.id, workspace])); const ordered = [...sessions].sort((left, right) => left.title.localeCompare(right.title)); if (!needle) return ordered; return ordered.filter(session => { const workspace = workspaceById.get(session.workspaceId); return [session.title, session.id, session.harness, session.status, workspace?.name, workspace?.root].some(value => String(value || '').toLocaleLowerCase().includes(needle)); }); }"
];
let sessionWorkspaceName: (sessionSummary, array(workspaceSummary)) => string = [%raw
  "(session, workspaces) => workspaces.find(workspace => workspace.id === session.workspaceId)?.name || 'Unknown workspace'"
];
let idInJson: (string, string) => bool = [%raw
  "(text, id) => { try { return JSON.parse(text).includes(id); } catch (_) { return false; } }"
];
let toggleIdJson: (string, string) => string = [%raw
  "(text, id) => { let values = []; try { values = JSON.parse(text); } catch (_) {} return JSON.stringify(values.includes(id) ? values.filter(value => value !== id) : [...values, id]); }"
];
let selectedWorkspaceName:
  (array(sessionSummary), array(workspaceSummary), string) => string = [%raw
  "(sessions, workspaces, id) => { const workspaceId = sessions.find(session => session.id === id)?.workspaceId; return workspaces.find(workspace => workspace.id === workspaceId)?.name || 'PISS'; }"
];
let workspaceNameById: (array(workspaceSummary), string) => string = [%raw
  "(workspaces, id) => workspaces.find(workspace => workspace.id === id)?.name || 'workspace'"
];
let sessionTitleById: (array(sessionSummary), string) => string = [%raw
  "(sessions, id) => sessions.find(session => session.id === id)?.title || 'Session'"
];
let sessionHarnessById: (array(sessionSummary), string) => string = [%raw
  "(sessions, id) => sessions.find(session => session.id === id)?.harness || 'unknown'"
];
let selectSessionId: (string, string) => string = [%raw
  "(text, current) => { try { const sessions = JSON.parse(text); if (!Array.isArray(sessions) || sessions.length === 0) return ''; return sessions.some(session => session.id === current) ? current : sessions[0].id; } catch (_) { return ''; } }"
];
let sessionUrl: (string, string) => string = [%raw
  "(path, id) => `${path}${path.includes('?') ? '&' : '?'}session=${encodeURIComponent(id)}`"
];
let archiveUrl: string => string = [%raw
  "id => `/api/v2/sessions/${encodeURIComponent(id)}/archive`"
];
let restoreUrl: string => string = [%raw
  "id => `/api/v2/sessions/${encodeURIComponent(id)}/restore`"
];
let directorySearchUrl: string => string = [%raw
  "query => `/api/v2/workspace-directories?query=${encodeURIComponent(query)}`"
];
let createdSessionId: string => string = [%raw
  "text => { try { return JSON.parse(text).id || ''; } catch (_) { return ''; } }"
];
let settledNotice: string => string = [%raw
  "current => current === 'Connecting to the durable worker...' || current === 'Switching durable session...' || current === 'Isolated session worker is starting.' || current === 'Event stream reconnecting...' || current.startsWith('Eio.Io ') ? '' : current"
];
let mergeSessionSnapshot: (string, string, string) => string = [%raw
  "(sessionsText, id, snapshotText) => { try { const sessions = JSON.parse(sessionsText); const snapshot = JSON.parse(snapshotText); if (!Array.isArray(sessions)) return sessionsText; return JSON.stringify(sessions.map(session => session.id === id ? { ...session, ...snapshot } : session)); } catch (_) { return sessionsText; } }"
];
let queueTimelineEvent: ((string => string) => unit, string) => unit = [%raw
  {|(setEvents, eventText) => {
    globalThis.__pissTimelineEventQueue ||= [];
    globalThis.__pissTimelineEventQueue.push(eventText);
    if (globalThis.__pissTimelineEventTimer) return;
    globalThis.__pissTimelineEventTimer = setTimeout(() => {
      const batch = globalThis.__pissTimelineEventQueue.splice(0);
      globalThis.__pissTimelineEventTimer = null;
      setEvents(current => {
        try {
          const bySequence = new Map(JSON.parse(current).filter(event => Number.isSafeInteger(event.sequence)).map(event => [event.sequence, event]));
          for (const text of batch) {
            const event = JSON.parse(text);
            if (Number.isSafeInteger(event.sequence)) bySequence.set(event.sequence, event);
          }
          return JSON.stringify([...bySequence.values()].sort((left, right) => left.sequence - right.sequence).slice(-4096));
        } catch (_) { return current; }
      });
    }, 40);
  }|}
];
let cancelQueuedTimelineEvents: unit => unit = [%raw
  {|() => {
    if (globalThis.__pissTimelineEventTimer) clearTimeout(globalThis.__pissTimelineEventTimer);
    globalThis.__pissTimelineEventTimer = null;
    globalThis.__pissTimelineEventQueue = [];
  }|}
];
let eventPageLength: string => int = [%raw
  "text => { try { const events = JSON.parse(text); return Array.isArray(events) ? events.length : 0; } catch (_) { return 0; } }"
];
let oldestEventSequence: string => int = [%raw
  "text => { try { const events = JSON.parse(text); return Array.isArray(events) && events.length ? Math.min(...events.map(event => Number(event.sequence) || Number.MAX_SAFE_INTEGER)) : 0; } catch (_) { return 0; } }"
];
let prependEventPage: (string, string) => string = [%raw
  "(eventsText, pageText) => { try { const events = JSON.parse(eventsText); const page = JSON.parse(pageText); if (!Array.isArray(events) || !Array.isArray(page)) return eventsText; const merged = new Map([...page, ...events].filter(event => Number.isSafeInteger(event.sequence)).map(event => [event.sequence, event])); return JSON.stringify([...merged.values()].sort((a, b) => a.sequence - b.sequence).slice(-4096)); } catch (_) { return eventsText; } }"
];
let timelineScrollHeight: unit => int = [%raw
  "() => document.getElementById('timeline')?.scrollHeight || 0"
];
let preserveTimelineAfterPrepend: int => unit = [%raw
  "height => requestAnimationFrame(() => { const timeline = document.getElementById('timeline'); if (timeline) timeline.scrollTop += timeline.scrollHeight - height; })"
];
let eventChangesRuntime: string => bool = [%raw
  "text => { try { const kind = JSON.parse(text).kind || ''; return kind === 'command.state' || kind.startsWith('acp.permission.') || kind === 'acp.session.loaded' || kind === 'acp.session.load_failed'; } catch (_) { return false; } }"
];
let eventCompletesTurn: string => bool = [%raw
  "text => { try { const event = JSON.parse(text); return event.kind === 'command.state' && ['completed', 'cancelled', 'rejected', 'ambiguous'].includes(event.payload?.state); } catch (_) { return false; } }"
];
let projectOutbox: string => array(outboxItem) = [%raw
  "text => { let events; try { events = JSON.parse(text); } catch (_) { return []; } if (!Array.isArray(events)) return []; const items = new Map(); for (const event of events) { const payload = event.payload || {}; if (event.kind === 'command.accepted' && ['steer', 'follow_up'].includes(payload.action)) items.set(payload.commandId, { id: payload.commandId, action: payload.action, text: payload.text || '', state: 'accepted', sequence: event.sequence }); else if (event.kind === 'command.state' && items.has(payload.commandId)) items.get(payload.commandId).state = payload.state || 'accepted'; else if (event.kind === 'command.reconciled' && items.has(payload.commandId)) items.get(payload.commandId).state = payload.state || 'ambiguous'; } return [...items.values()].filter(item => !['completed', 'cancelled', 'rejected'].includes(item.state)).sort((a, b) => a.sequence - b.sequence).slice(-32); }"
];
let connectEventStream:
  (string, string => unit, string => unit, unit => unit, unit => unit, unit) =>
  unit = [%raw
  {|(id, onInitial, onEvent, onOpen, onError) => {
    let closed = false;
    let source = null;
    let retryTimer = null;
    const close = () => { closed = true; if (retryTimer) clearTimeout(retryTimer); if (source) source.close(); };
    const connect = async () => {
      try {
        const response = await fetch(`/api/v2/events?recent=500&session=${encodeURIComponent(id)}`);
        const text = await response.text();
        if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
        if (closed) return;
        let events;
        try { events = JSON.parse(text); } catch (_) { events = []; }
        if (!Array.isArray(events)) events = [];
        onInitial(JSON.stringify(events));
        const after = events.reduce((cursor, event) => Math.max(cursor, Number(event.sequence) || 0), 0);
        source = new EventSource(`/api/v2/event-stream?session=${encodeURIComponent(id)}&after=${after}`);
        source.onmessage = event => { if (!closed) onEvent(event.data); };
        source.onopen = () => { if (!closed) onOpen(); };
        source.onerror = () => { if (!closed) onError(); };
      } catch (_) {
        if (!closed) { onError(); retryTimer = setTimeout(connect, 500); }
      }
    };
    connect();
    return close;
  }|}
];

let projectTimeline: (string, string) => array(timelineItem) = [%raw
  {|(text, agentName) => {
    let events;
    try { events = JSON.parse(text); } catch (_) { return []; }
    if (!Array.isArray(events)) return [];
    const resetIndex = events.findLastIndex(event => event.kind === 'timeline.reset');
    if (resetIndex >= 0) events = events.slice(resetIndex + 1);
    const items = [];
    const messages = new Map();
    const tools = new Map();
    const permissions = new Map();
    const acpUserTexts = new Set(events
      .filter(event => event.kind === 'acp.user_message_chunk')
      .map(event => event.payload?.params?.update?.content?.text)
      .filter(Boolean));
    const acceptedImageTexts = new Set(events
      .filter(event => event.kind === 'command.accepted' && (event.payload?.imageCount || 0) > 0)
      .map(event => event.payload?.text || ''));
    let currentAgent = null;
    const contentText = content => {
      if (!content) return '';
      if (typeof content.text === 'string') return content.text;
      if (content.type === 'content') return contentText(content.content);
      return '';
    };
    const classifyKind = update => {
      const kind = update.kind || 'other';
      const command = typeof update.rawInput?.command === 'string' ? update.rawInput.command : '';
      const label = `${update.title || ''} ${command}`;
      return kind === 'execute' && /(^|\s|\/)(test|tests|pytest|runtest|jest|vitest)(\s|$)/i.test(label) ? 'test' : kind;
    };
    const describeInput = (kind, input) => {
      if (!input || typeof input !== 'object') return '';
      if (['execute', 'test'].includes(kind) && typeof input.command === 'string') return input.command;
      if (['read', 'edit', 'delete', 'move'].includes(kind) && typeof input.path === 'string') return input.path;
      if (kind === 'search' && typeof (input.query || input.pattern) === 'string') return input.query || input.pattern;
      return Object.keys(input).length ? JSON.stringify(input, null, 2) : '';
    };
    const contentArtifact = content => {
      if (!content || typeof content !== 'object') return null;
      if (content.type === 'diff' && typeof content.path === 'string') return { type: 'diff', path: content.path, oldText: content.oldText || '', newText: content.newText || '' };
      if (content.type === 'terminal') return { type: 'terminal', path: content.terminalId || 'terminal', text: 'Live terminal output is retained by the agent.' };
      const inner = content.type === 'content' ? content.content : content;
      if (inner?.type === 'image' && typeof inner.data === 'string') return { type: 'image', path: inner.mimeType || 'image', src: `data:${inner.mimeType || 'image/png'};base64,${inner.data}`, text: 'Agent-produced image' };
      if (inner?.type === 'resource' || inner?.resource) { const resource = inner.resource || inner; return { type: 'resource', path: resource.uri || resource.name || 'resource', text: resource.name || resource.description || '' }; }
      return null;
    };
    const normalizeLocations = locations => Array.isArray(locations) ? locations.filter(location => typeof location?.path === 'string').map(location => ({ type: 'location', path: location.path, text: Number.isFinite(location.line) ? `line ${location.line}` : '' })) : [];
    for (const event of events) {
      const payload = event.payload || {};
      const update = payload.params?.update || {};
      if (event.kind.startsWith('session.ask.')) {
        const direction = event.kind === 'session.ask.sent' ? 'Sent to' : event.kind === 'session.ask.queued' ? 'Queued for' : event.kind === 'session.ask.dispatched' ? 'Dispatched to' : event.kind === 'session.ask.received' ? 'Request from' : event.kind === 'session.ask.failed' ? 'Failed for' : 'Response from';
        items.push({
          id: `${event.kind}-${payload.requestId || event.sequence}`,
          role: 'peer',
          title: `${direction} ${payload.peerId || 'session'}`,
          text: payload.text || '',
          status: event.kind === 'session.ask.completed' ? 'completed' : event.kind === 'session.ask.failed' ? 'failed' : event.kind === 'session.ask.queued' ? 'pending' : event.kind === 'session.ask.dispatched' ? 'in_progress' : '',
          options: [],
          sequence: event.sequence
        });
        currentAgent = null;
      } else if (event.kind === 'command.accepted' && (payload.text || payload.imageCount > 0) && (!acpUserTexts.has(payload.text) || payload.imageCount > 0)) {
        const isWake = (payload.text || '').startsWith('PISS durable collaboration wake-up.');
        const item = { id: payload.commandId || `user-${event.sequence}`, role: isWake ? 'peer' : 'user', title: isWake ? 'PISS wake-up' : 'You', text: payload.text || '', imageCount: payload.imageCount || 0, status: '', options: [], sequence: event.sequence };
        items.push(item);
        currentAgent = null;
      } else if (event.kind === 'acp.user_message_chunk' || event.kind === 'acp.agent_message_chunk') {
        const role = event.kind === 'acp.user_message_chunk' ? 'user' : 'agent';
        const chunkText = contentText(update.content);
        if (role === 'user' && (update.content?.type !== 'text' || chunkText.startsWith('Inter-session request from ') || acceptedImageTexts.has(chunkText))) continue;
        const id = update.messageId || (role === 'agent' && currentAgent ? currentAgent.id : `${role}-${event.sequence}`);
        const isWake = role === 'user' && chunkText.startsWith('PISS durable collaboration wake-up.');
        let item = messages.get(id);
        if (!item) {
          item = { id, role: isWake ? 'peer' : role, title: isWake ? 'PISS wake-up' : role === 'user' ? 'You' : agentName, text: '', status: '', options: [], sequence: event.sequence };
          messages.set(id, item);
          items.push(item);
        }
        item.text += chunkText;
        if (role === 'agent') currentAgent = item;
      } else if (event.kind === 'acp.tool_call') {
        currentAgent = null;
        const id = update.toolCallId || `tool-${event.sequence}`;
        const kind = classifyKind(update);
        const artifacts = Array.isArray(update.content) ? update.content.map(contentArtifact).filter(Boolean) : [];
        const item = {
          id,
          role: 'tool',
          kind,
          title: update.title || 'Tool call',
          text: describeInput(kind, update.rawInput),
          status: update.status || 'pending',
          artifacts,
          locations: normalizeLocations(update.locations),
          options: [],
          sequence: event.sequence
        };
        tools.set(id, item);
        items.push(item);
      } else if (event.kind === 'acp.tool_call_update') {
        const id = update.toolCallId || `tool-${event.sequence}`;
        let item = tools.get(id);
        if (!item) {
          item = { id, role: 'tool', kind: update.kind || 'other', title: 'Tool call', text: '', status: 'pending', artifacts: [], locations: [], options: [], sequence: event.sequence };
          tools.set(id, item);
          items.push(item);
        }
        if (update.kind || update.rawInput || update.title) item.kind = classifyKind({ ...update, kind: update.kind || item.kind });
        if (update.title) item.title = update.title;
        if (update.status) item.status = update.status;
        if (update.rawInput) item.text = describeInput(item.kind, update.rawInput);
        if (update.locations) item.locations = normalizeLocations(update.locations);
        const content = Array.isArray(update.content) ? update.content : [];
        const addition = content.map(contentText).filter(Boolean).join('\n');
        if (addition) item.text = item.text ? `${item.text}\n${addition}` : addition;
        if (!addition && update.rawOutput && typeof update.rawOutput === 'object') { const output = JSON.stringify(update.rawOutput, null, 2); if (output !== '{}') item.text = item.text ? `${item.text}\n${output}` : output; }
        if (item.kind === 'test') { const passed = item.text.match(/(\d+)\s+(?:tests?\s+)?passed/i)?.[1]; const failed = item.text.match(/(\d+)\s+(?:tests?\s+)?failed/i)?.[1]; if (passed || failed) item.title = `Test run · ${passed || '0'} passed${failed ? ` / ${failed} failed` : ''}`; }
        item.artifacts.push(...content.map(contentArtifact).filter(Boolean));
      } else if (event.kind === 'acp.permission.requested') {
        const id = String(payload.id ?? event.sequence);
        const params = payload.params || {};
        const tool = params.toolCall || {};
        const item = {
          id,
          role: 'permission',
          title: tool.title || 'Permission required',
          text: tool.rawInput ? JSON.stringify(tool.rawInput, null, 2) : 'The agent is waiting for your decision.',
          status: 'pending',
          options: Array.isArray(params.options) ? params.options : [],
          sequence: event.sequence
        };
        permissions.set(id, item);
        items.push(item);
      } else if (event.kind === 'acp.permission.resolved' || event.kind === 'acp.permission.cancelled') {
        const id = String(payload.requestId ?? '');
        const item = permissions.get(id);
        if (item) item.status = 'resolved';
      }
    }
    return items.sort((a, b) => a.sequence - b.sequence);
  }|}
];

let activeToolFromTimeline: array(timelineItem) => option(timelineItem) = [%raw
  {|items => {
    if (!Array.isArray(items)) return null;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item && item.role === 'tool' && (item.status === 'pending' || item.status === 'in_progress')) {
        return item;
      }
    }
    return null;
  }|}
];

let recentToolsFromTimeline:
  (array(timelineItem), int) => array(timelineItem) =
  [%raw
    {|(items, limit) => {
      if (!Array.isArray(items) || !Number.isInteger(limit) || limit <= 0) return [];
      const result = [];
      for (let i = items.length - 1; i >= 0 && result.length < limit; i--) {
        const item = items[i];
        if (item && item.role === 'tool') result.push(item);
      }
      return result.reverse();
    }|}
  ];

let agentThinkingFromTimeline: array(timelineItem) => bool = [%raw
  {|items => {
    if (!Array.isArray(items) || items.length === 0) return false;
    const last = items[items.length - 1];
    return !!(last && last.role === 'agent');
  }|}
];

let optionHasValue: option('a) => bool =
  fun
  | Some(_) => true
  | None => false;

let jsonBody = pairs =>
  Js.Json.stringify(Js.Json.object_(Js.Dict.fromArray(pairs)));

let thenPromise = (promise, callback) => Js.Promise.then_(callback, promise);
let catchPromise = (promise, callback) =>
  Js.Promise.catch(callback, promise);

let ignorePromise = promise =>
  promise->catchPromise(_ => Js.Promise.resolve())->ignore;

module CopyButton = {
  [@react.component]
  let make = (~copyKey, ~label, ~text, ~onCopy, ~feedback) => {
    let copied = feedback == copyKey;
    let failed = feedback == "error:" ++ copyKey;
    <button
      className={
        "timeline-copy " ++ (copied ? "copied" : failed ? "failed" : "")
      }
      type_="button"
      ariaLabel={
        copied
          ? "Copied " ++ label
          : failed ? "Copy failed " ++ label : "Copy " ++ label
      }
      onClick={_ => onCopy(copyKey, text)}>
      {copied ? icon("check") : icon("copy")}
      <b> {React.string(copied ? "Copied" : failed ? "Failed" : "Copy")} </b>
    </button>;
  };
};

module TimelineContents = {
  [@react.component]
  let make =
      (~item, ~role, ~text, ~onPermission, ~onCopy, ~copyFeedback, ~toolCopy) =>
    <div className="timeline-contents">
      {toolCopy && text != ""
         ? <div className="tool-copy-row">
             <CopyButton
               copyKey={itemId(item)}
               label="tool output"
               text
               onCopy
               feedback=copyFeedback
             />
           </div>
         : React.null}
      {text == ""
         ? React.null
         : role == "tool"
             ? <pre className="message-body"> {React.string(text)} </pre>
             : <div className="message-body markdown-body">
                 {renderMarkdown(text, itemId(item), onCopy, copyFeedback)
                  ->React.array}
               </div>}
      {itemImageCount(item) == 0
         ? React.null
         : <div className="message-images">
             {icon("image")}
             <span>
               {React.string(
                  string_of_int(itemImageCount(item))
                  ++ (
                    itemImageCount(item) == 1
                      ? " image attached" : " images attached"
                  ),
                )}
             </span>
           </div>}
      {Array.length(itemLocations(item)) == 0
         ? React.null
         : <div className="artifact-locations">
             {Array.map(
                location =>
                  <span key={artifactPath(location)}>
                    {React.string(
                       artifactPath(location)
                       ++ (
                         artifactText(location) == ""
                           ? "" : " / " ++ artifactText(location)
                       ),
                     )}
                  </span>,
                itemLocations(item),
              )
              ->React.array}
           </div>}
      {Array.map(
         artifact =>
           switch (artifactType(artifact)) {
           | "diff" =>
             <details
               className="artifact-card artifact-diff"
               key={"diff-" ++ artifactPath(artifact)}>
               <summary>
                 <span> {React.string("File change")} </span>
                 <b> {React.string(artifactPath(artifact))} </b>
               </summary>
               <div className="artifact-diff-columns">
                 <section>
                   <span> {React.string("Before")} </span>
                   <pre> {React.string(artifactOldText(artifact))} </pre>
                 </section>
                 <section>
                   <span> {React.string("After")} </span>
                   <pre> {React.string(artifactNewText(artifact))} </pre>
                 </section>
               </div>
             </details>
           | "image" =>
             <figure
               className="artifact-card artifact-image"
               key={"image-" ++ artifactPath(artifact)}>
               <img
                 src={artifactSource(artifact)}
                 alt={artifactText(artifact)}
               />
               <figcaption>
                 {React.string(artifactText(artifact))}
               </figcaption>
             </figure>
           | "terminal" =>
             <section
               className="artifact-card artifact-terminal"
               key={"terminal-" ++ artifactPath(artifact)}>
               <span> {React.string("Terminal")} </span>
               <b> {React.string(artifactPath(artifact))} </b>
               <p> {React.string(artifactText(artifact))} </p>
             </section>
           | "resource" =>
             <section
               className="artifact-card artifact-resource"
               key={"resource-" ++ artifactPath(artifact)}>
               <span> {React.string("Resource")} </span>
               <b> {React.string(artifactPath(artifact))} </b>
               <p> {React.string(artifactText(artifact))} </p>
             </section>
           | _ => React.null
           },
         itemArtifacts(item),
       )
       ->React.array}
      {role == "permission" && itemStatus(item) == "pending"
         ? <div className="permission-actions">
             {Array.map(
                option =>
                  <button
                    key={optionId(option)}
                    className={
                      isRejectOption(optionId(option))
                        ? "permission-button reject"
                        : "permission-button allow"
                    }
                    type_="button"
                    onClick={_ =>
                      onPermission(itemId(item), Some(optionId(option)))
                    }>
                    {React.string(optionName(option))}
                  </button>,
                itemOptions(item),
              )
              ->React.array}
             <button
               className="permission-button reject"
               type_="button"
               onClick={_ => onPermission(itemId(item), None)}>
               {React.string("Cancel")}
             </button>
           </div>
         : React.null}
    </div>;
};

module TimelineItem = {
  [@react.component]
  let make = (~item, ~onPermission=_ => _ => (), ~expanded=false) => {
    let role = itemRole(item);
    let status = itemStatus(item);
    let kind = itemKind(item);
    let text = itemText(item);
    let copyable = text != "" && (role == "agent" || role == "peer");
    let (copyFeedback, setCopyFeedback) = React.useState(() => "");
    let copyText = (key, value) => {
      copyToClipboard(value)
      ->thenPromise(_ => {
          setCopyFeedback(_ => key);
          scheduleCopyReset(setCopyFeedback, key);
          Js.Promise.resolve();
        })
      ->catchPromise(_ => {
          let failedKey = "error:" ++ key;
          setCopyFeedback(_ => failedKey);
          scheduleCopyReset(setCopyFeedback, key);
          Js.Promise.resolve();
        })
      ->ignore;
    };
    role == "tool"
      ? <article
          className={
            "timeline-item timeline-tool"
            ++ (expanded ? " timeline-tool-expanded" : "")
          }>
          <details className="tool-disclosure" open_={expanded}>
            <summary>
              <span className="tool-disclosure-icon">
                {icon("chevron")}
              </span>
              <span className="message-role">
                {React.string(itemTitle(item))}
              </span>
              <span className="message-classification">
                {kind == ""
                   ? React.null
                   : <span className={"artifact-kind kind-" ++ kind}>
                       {React.string(kind)}
                     </span>}
                {status == ""
                   ? React.null
                   : <span className={"message-status status-" ++ status}>
                       {React.string(status)}
                     </span>}
              </span>
            </summary>
            <TimelineContents
              item
              role
              text
              onPermission
              onCopy=copyText
              copyFeedback
              toolCopy=true
            />
          </details>
        </article>
      : <article className={"timeline-item timeline-" ++ role}>
          <div className="message-meta">
            <span className="message-role">
              {React.string(itemTitle(item))}
            </span>
            <span className="message-classification">
              {copyable
                 ? <CopyButton
                     copyKey={itemId(item)}
                     label="message"
                     text
                     onCopy=copyText
                     feedback=copyFeedback
                   />
                 : React.null}
              {status == ""
                 ? React.null
                 : <span className={"message-status status-" ++ status}>
                     {React.string(status)}
                   </span>}
            </span>
          </div>
          <TimelineContents
            item
            role
            text
            onPermission
            onCopy=copyText
            copyFeedback
            toolCopy=false
          />
        </article>;
  };
};

module WorkingView = {
  let pulseState: (string, bool, option(timelineItem)) => string =
    (status, running, activeTool) =>
      switch (activeTool) {
      | Some(_) => "running"
      | None =>
        running ? "thinking" : status == "requires_action" ? "awaiting"
        : status == "offline" || status == "connecting" ? "connecting"
        : "idle"
      };

  let pulseLabel: string => string =
    fun
    | "running" => "Working…"
    | "thinking" => "Thinking…"
    | "awaiting" => "Awaiting your decision"
    | "connecting" => "Connecting to the worker"
    | _ => "Ready";

  let safeTitle = (t: option(timelineItem)) =>
    switch (t) {
    | Some(item) => itemTitle(item)
    | None => ""
    };

  let pulseDetail:
    (string, option(timelineItem), string) => string =
    (pulse, activeTool, agentName) => {
      let agentWorking = agentName ++ " is working.";
      let workingTitle = safeTitle(activeTool);
      switch (pulse) {
      | "running" =>
        if (workingTitle !== "") {
          workingTitle
        } else {
          agentWorking
        }
      | "thinking" => agentName ++ " is composing the next step."
      | "awaiting" =>
        "The harness is waiting for your permission decision."
      | "connecting" => "Establishing the durable worker session."
      | _ => agentName ++ " is ready for your next prompt."
      };
    };

  let pulseNote: (string, option(timelineItem)) => string =
    (pulse, activeTool) => {
      let preparing = "The harness is preparing a tool call.";
      let liveNote = "Output streams live as the harness reports it.";
      switch (pulse) {
      | "running" =>
        let isActive = safeTitle(activeTool) !== "";
        if (isActive) {
          liveNote
        } else {
          preparing
        }
      | "thinking" => "Streaming tokens will appear in the Agent tab."
      | "awaiting" =>
        "Approve or reject from the Agent tab; nothing runs until you decide."
      | "connecting" =>
        "Events replay from the durable ledger on attach."
      | _ =>
        "Send a prompt or queue a follow-up; the worker owns the turn end-to-end."
      };
    };

  let metaLine: sessionSnapshot => string =
    snapshot => {
      let workerPid = snapshotWorkerPid(snapshot);
      let harnessPid = snapshotHarnessPid(snapshot);
      let sequence = snapshotSequence(snapshot);
      "Worker · PID "
      ++ string_of_int(workerPid)
      ++ " · Harness · PID "
      ++ string_of_int(harnessPid)
      ++ " · Sequence "
      ++ string_of_int(sequence);
    };

  [@react.component]
  let make =
      (
        ~status: string,
        ~running: bool,
        ~agentName: string,
        ~snapshot: sessionSnapshot,
        ~activeTool: option(timelineItem),
        ~recentTools: array(timelineItem),
      ) => {
    let pulse = pulseState(status, running, activeTool);
    let label = pulseLabel(pulse);
    let detail = pulseDetail(pulse, activeTool, agentName);
    let note = pulseNote(pulse, activeTool);
    let meta = metaLine(snapshot);
    <section
      className={"working-view working-view-" ++ pulse}
      role="tabpanel"
      ariaLabel="Working">
      <header className="working-header">
        <div className="working-status">
          <span className={"working-pulse working-pulse-" ++ pulse}>
            <span className="working-pulse-dot" />
          </span>
          <span className="working-status-label">
            {React.string(label)}
          </span>
        </div>
        <h2 className="working-detail"> {React.string(detail)} </h2>
        <p className="working-note"> {React.string(note)} </p>
        <p className="working-meta"> {React.string(meta)} </p>
      </header>
      <section className="working-current" ariaLabel="Current operation">
        {switch (activeTool) {
         | Some(item) =>
           <article className="working-current-card">
             <TimelineItem item expanded=true />
           </article>
         | None =>
           <article
             className={
               "working-current-card working-current-card-empty working-current-card-"
               ++ pulse
             }>
             <p className="working-current-empty-message">
               {React.string(
                  pulse == "running"
                    ? "The harness is preparing the next tool call."
                    : pulse == "thinking"
                        ? agentName ++ " is composing the next response."
                        : pulse == "awaiting"
                            ? "A permission request is waiting for you."
                            : pulse == "connecting"
                                ? "Waiting for the worker to publish its first events."
                                : "No work in flight. The worker is idle.",
                )}
             </p>
           </article>
         }}
      </section>
      {Array.length(recentTools) > 0
         ? <section
             className="working-recent"
             ariaLabel="Recent tool calls">
             <h3> {React.string("Recent activity")} </h3>
             <ol className="working-recent-list">
               {Array.map(
                  item =>
                    <li
                      key={itemId(item)}
                      className={
                        "working-recent-row working-recent-row-"
                        ++ itemStatus(item)
                      }>
                      <span
                        className={
                          "artifact-kind kind-"
                          ++ (
                            itemKind(item) == ""
                              ? "other" : itemKind(item)
                          )
                        }>
                        {React.string(
                           itemKind(item) == ""
                             ? "tool" : itemKind(item),
                         )}
                      </span>
                      <span className="working-recent-title">
                        {React.string(itemTitle(item))}
                      </span>
                      <span
                        className={
                          "message-status status-" ++ itemStatus(item)
                        }>
                        {React.string(itemStatus(item))}
                      </span>
                    </li>,
                  recentTools,
                )
                ->React.array}
             </ol>
           </section>
         : React.null}
    </section>;
  };
};

module App = {
  [@react.component]
  let make = () => {
    let (sessionJson, setSessionJson) =
      React.useState(() =>
        "{\"status\":\"connecting\",\"agentName\":\"ACP agent\",\"workerPid\":0,\"harnessPid\":0,\"lastSequence\":0}"
      );
    let (eventsJson, setEventsJson) = React.useState(() => "[]");
    let (eventsLoaded, setEventsLoaded) = React.useState(() => false);
    let (eventsLoadError, setEventsLoadError) = React.useState(() => "");
    let (sessionsJson, setSessionsJson) = React.useState(() => "[]");
    let (archivedSessionsJson, setArchivedSessionsJson) =
      React.useState(() => "[]");
    let (workspacesJson, setWorkspacesJson) = React.useState(() => "[]");
    let (configOptionsJson, setConfigOptionsJson) =
      React.useState(() => "[]");
    let (configMenu, setConfigMenu) = React.useState(() => "");
    let (delivery, setDelivery) = React.useState(() => "steer");
    let (activeSessionId, setActiveSessionId) = React.useState(() => "");
    let (activeView, setActiveView) = React.useState(() => "agent");
    let (lastObservedStatus, setLastObservedStatus) = React.useState(() => "");
    let (drawerOpen, setDrawerOpen) = React.useState(() => false);
    let (searchOpen, setSearchOpen) = React.useState(() => false);
    let (searchQuery, setSearchQuery) = React.useState(() => "");
    let (searchScope, setSearchScope) = React.useState(() => "active");
    let (searchHighlight, setSearchHighlight) = React.useState(() => 0);
    let (showJumpToBottom, setShowJumpToBottom) = React.useState(() => false);
    let (hasOlderEvents, setHasOlderEvents) = React.useState(() => false);
    let (loadingOlderEvents, setLoadingOlderEvents) =
      React.useState(() => false);
    let (creatorOpen, setCreatorOpen) = React.useState(() => false);
    let (creatorWorkspaceId, setCreatorWorkspaceId) =
      React.useState(() => "");
    let (workspaceCreatorOpen, setWorkspaceCreatorOpen) =
      React.useState(() => false);
    let (directoriesJson, setDirectoriesJson) = React.useState(() => "[]");
    let (selectedWorkspacePath, setSelectedWorkspacePath) =
      React.useState(() => "");
    let (collapsedWorkspacesJson, setCollapsedWorkspacesJson) =
      React.useState(() => "[]");
    let (sessionMenuId, setSessionMenuId) = React.useState(() => "");
    let (workspaceMenuId, setWorkspaceMenuId) = React.useState(() => "");
    let (removeWorkspaceId, setRemoveWorkspaceId) = React.useState(() => "");
    let (removeWorkspaceName, setRemoveWorkspaceName) =
      React.useState(() => "");
    let (removeWorkspaceRoot, setRemoveWorkspaceRoot) =
      React.useState(() => "");
    let (removeWorkspaceError, setRemoveWorkspaceError) =
      React.useState(() => "");
    let (archiveTargetId, setArchiveTargetId) = React.useState(() => "");
    let (archiveTargetTitle, setArchiveTargetTitle) =
      React.useState(() => "");
    let (notice, setNotice) =
      React.useState(() => "Connecting to the durable worker...");
    let (submitting, setSubmitting) = React.useState(() => false);
    let (images, setImages) = React.useState(() => [||]);
    let (imageSelectionPending, setImageSelectionPending) =
      React.useState(() => false);
    let (mentionActive, setMentionActive) = React.useState(() => None);
    let (mentionsJson, setMentionsJson) = React.useState(() => "[]");
    let (mentionResources, setMentionResources) = React.useState(() => [||]);
    let (mentionLoading, setMentionLoading) = React.useState(() => false);
    let (mentionError, setMentionError) = React.useState(() => "");
    let (mentionHighlighted, setMentionHighlighted) = React.useState(() => 0);

    let refreshSession = id =>
      if (id != "") {
        getText(sessionUrl("/api/v2/session", id))
        ->thenPromise(text => {
            setSessionJson(_ => text);
            setConfigOptionsJson(_ => configOptionsFromSnapshot(text));
            setSessionsJson(current =>
              mergeSessionSnapshot(current, id, text)
            );
            setNotice(current => settledNotice(current));
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            setNotice(_ => errorMessage(error));
            Js.Promise.resolve();
          })
        ->ignore;
      };

    let refresh = () => {
      getText("/api/v2/sessions")
      ->thenPromise(text => {
          setSessionsJson(_ => text);
          let selected = selectSessionId(text, activeSessionId);
          if (selected != activeSessionId) {
            setActiveSessionId(_ => selected);
            setEventsJson(_ => "[]");
          };
          if (selected == "") {
            setSessionJson(_ =>
              "{\"status\":\"offline\",\"agentName\":\"ACP agent\",\"workerPid\":0,\"harnessPid\":0,\"lastSequence\":0}"
            );
            setConfigOptionsJson(_ => "[]");
            setConfigMenu(_ => "");
            setNotice(_ =>
              "No active sessions. Create one from a workspace to continue."
            );
          };
          refreshSession(selected);
          Js.Promise.resolve();
        })
      ->catchPromise(error => {
          setNotice(_ => errorMessage(error));
          Js.Promise.resolve();
        })
      ->ignore;
      getText("/api/v2/sessions?archived=true")
      ->thenPromise(text => {
          setArchivedSessionsJson(_ => text);
          Js.Promise.resolve();
        })
      ->ignorePromise;
      getText("/api/v2/workspaces")
      ->thenPromise(text => {
          setWorkspacesJson(_ => text);
          Js.Promise.resolve();
        })
      ->ignorePromise;
    };

    React.useEffect0(() => {
      refresh();
      let stopWatchingViewport = watchVisibleViewport();
      Some(stopWatchingViewport);
    });

    React.useEffect1(
      () => {
        cancelQueuedTimelineEvents();
        resetTimelineFollow();
        setShowJumpToBottom(_ => false);
        setImages(_ => [||]);
        setImageSelectionPending(_ => false);
        setMentionActive(_ => None);
        setMentionsJson(_ => "[]");
        setMentionResources(_ => [||]);
        setMentionLoading(_ => false);
        setMentionError(_ => "");
        setMentionHighlighted(_ => 0);
        cancelFileMentionSearch();
        clearImagePicker();
        None;
      },
      [|activeSessionId|],
    );

    React.useEffect1(
      () =>
        if (activeSessionId == "") {
          None;
        } else {
          setEventsLoaded(_ => false);
          setEventsLoadError(_ => "");
          let close =
            connectEventStream(
              activeSessionId,
              text => {
                cancelQueuedTimelineEvents();
                setEventsJson(_ => text);
                setEventsLoaded(_ => true);
                setEventsLoadError(_ => "");
                setHasOlderEvents(_ => eventPageLength(text) >= 500);
                scrollTimeline();
              },
              event => {
                queueTimelineEvent(setEventsJson, event);
                if (eventChangesRuntime(event)) {
                  refreshSession(activeSessionId);
                };
                if (eventCompletesTurn(event)) {
                  setNotice(_ => "");
                };
              },
              () => refreshSession(activeSessionId),
              () => {
                setEventsLoadError(_ => "Event stream is reconnecting…");
                setNotice(_ => "Event stream reconnecting...");
              },
            );
          Some(
            () => {
              close();
              cancelQueuedTimelineEvents();
            },
          );
        },
      [|activeSessionId|],
    );

    React.useEffect1(
      () => activeView == "agent" ? Some(installTimelineFollower()) : None,
      [|activeView|],
    );

    let snapshot = parseSnapshot(sessionJson);
    let status = snapshotStatus(snapshot);
    /* A command is only "in flight" when status is "running". "requires_action"
       means the harness is waiting for the user to answer a permission dialog
       (or, when the harness has gone silent, it can mean a stale permission
       request was never resolved). In either case no command is in flight, so
       the composer should default to "prompt", not "steer". */
    let running = status == "running";
    let awaitingPermission = status == "requires_action";
    let workerUnavailable = status == "offline" || status == "connecting";
    let agentName = snapshotAgentName(snapshot);
    let timeline =
      React.useMemo2(
        () => projectTimeline(eventsJson, agentName),
        (eventsJson, agentName),
      );
    let activeTool = activeToolFromTimeline(timeline);
    let hasActiveTool = optionHasValue(activeTool);
    let recentTools = recentToolsFromTimeline(timeline, 10);

    /* Auto-switch to the Working view when the agent starts a new turn while
       the user is browsing the Agent timeline. The transition only fires when
       the status changes from anything other than "running" into "running";
       staying on Working or Details is never overridden, and once the user
       manually returns to Agent we resume the auto-switch behavior. */
    React.useEffect1(
      () => {
        if (lastObservedStatus != ""
            && lastObservedStatus != "running"
            && status == "running"
            && activeView == "agent") {
          setActiveView(_ => "working");
        };
        if (lastObservedStatus != status) {
          setLastObservedStatus(_ => status);
        };
        None;
      },
      [|status, activeView|],
    );
    let outbox =
      React.useMemo1(() => projectOutbox(eventsJson), [|eventsJson|]);
    let sessions = parseSessions(sessionsJson);
    let archivedSessions = parseSessions(archivedSessionsJson);
    let workspaces = parseWorkspaces(workspacesJson);
    let configOptions = parseConfigOptions(configOptionsJson);
    let mentions = parseFileMentions(mentionsJson);
    let modelOption = findConfigOption(configOptions, "model");
    let thinkingOption = findConfigOption(configOptions, "thought_level");
    let searchResults =
      searchSessions(
        searchScope == "archived" ? archivedSessions : sessions,
        workspaces,
        searchQuery,
      );

    let openSearch = () => {
      setDrawerOpen(_ => false);
      setSearchScope(_ =>
        Array.length(sessions) == 0 ? "archived" : "active"
      );
      setSearchOpen(_ => true);
    };

    React.useEffect1(
      () => Some(watchSearchShortcut(openSearch)),
      [|sessionsJson|],
    );

    let applyConfig = (option, value) =>
      if (!running && !awaitingPermission && !submitting) {
        setSubmitting(_ => true);
        setConfigMenu(_ => "");
        let body =
          jsonBody([|
            ("configId", Js.Json.string(configId(option))),
            ("value", Js.Json.string(value)),
          |]);
        postText(sessionUrl("/api/v2/config-options", activeSessionId), body)
        ->thenPromise(text => {
            let resultOptions: string => string = [%raw
              "text => { try { return JSON.stringify(JSON.parse(text).configOptions || []); } catch (_) { return '[]'; } }"
            ];
            setConfigOptionsJson(_ => resultOptions(text));
            setSubmitting(_ => false);
            setNotice(_ => "Session configuration updated.");
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            setSubmitting(_ => false);
            setNotice(_ => errorMessage(error));
            Js.Promise.resolve();
          })
        ->ignore;
      };

    let selectImages = files =>
      if (Array.length(files) > 0
          && snapshotAcceptsImages(snapshot)
          && !imageSelectionPending
          && !submitting) {
        setImageSelectionPending(_ => true);
        setNotice(_ => "Preparing image attachments...");
        readComposerImages(files, images)
        ->thenPromise(nextImages => {
            setImages(_ => nextImages);
            setImageSelectionPending(_ => false);
            setNotice(_ =>
              string_of_int(Array.length(nextImages))
              ++ (
                Array.length(nextImages) == 1
                  ? " image ready to send." : " images ready to send."
              )
            );
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            setImageSelectionPending(_ => false);
            setNotice(_ => errorMessage(error));
            Js.Promise.resolve();
          })
        ->ignore;
      };

    let dismissMention = () => {
      cancelFileMentionSearch();
      setMentionActive(_ => None);
      setMentionsJson(_ => "[]");
      setMentionLoading(_ => false);
      setMentionError(_ => "");
      setMentionHighlighted(_ => 0);
    };

    let searchMention = active =>
      if (activeSessionId == ""
          || String.length(activeMentionQuery(active)) > 200) {
        dismissMention();
      } else {
        setMentionActive(_ => Some(active));
        setMentionsJson(_ => "[]");
        setMentionLoading(_ => true);
        setMentionError(_ => "");
        setMentionHighlighted(_ => 0);
        requestFileMentions(activeSessionId, activeMentionQuery(active))
        ->thenPromise(text => {
            setMentionsJson(_ => text);
            setMentionLoading(_ => false);
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            if (!isAbortError(error)) {
              setMentionLoading(_ => false);
              setMentionError(_ => errorMessage(error));
            };
            Js.Promise.resolve();
          })
        ->ignore;
      };

    let updateMentionFromEvent = event =>
      switch (activeMentionFromEvent(event), mentionActive) {
      | (Some(active), Some(current))
          when activeMentionKey(active) == activeMentionKey(current) =>
        ()
      | (Some(active), _) => searchMention(active)
      | (None, None) => ()
      | (None, Some(_)) => dismissMention()
      };

    let chooseMention = mention =>
      switch (mentionActive) {
      | Some(active) =>
        if (applyFileMention(active, mentionPath(mention))) {
          setMentionResources(current =>
            addMentionResource(current, mention)
          );
          dismissMention();
        }
      | None => ()
      };

    let handleComposerKeyDown = event =>
      switch (mentionActive) {
      | Some(_) =>
        switch (eventKey(event)) {
        | "ArrowDown" =>
          preventAnyDefault(event);
          setMentionHighlighted(current =>
            nextMentionIndex(current, Array.length(mentions), 1)
          );
        | "ArrowUp" =>
          preventAnyDefault(event);
          setMentionHighlighted(current =>
            nextMentionIndex(current, Array.length(mentions), -1)
          );
        | "Enter" =>
          preventAnyDefault(event);
          if (Array.length(mentions) > 0) {
            chooseMention(
              mentions[min(mentionHighlighted, Array.length(mentions) - 1)],
            );
          };
        | "Escape" =>
          preventAnyDefault(event);
          dismissMention();
        | _ => composerKeyDown(event)
        }
      | None => composerKeyDown(event)
      };

    let submitPrompt = event => {
      preventDefault(event);
      let text = promptValue();
      if ((text != "" || Array.length(images) > 0)
          && !imageSelectionPending
          && !submitting) {
        let action = running ? delivery : "prompt";
        setSubmitting(_ => true);
        setNotice(_ =>
          action == "steer"
            ? "Delivering guidance after the current tool call..."
            : action == "follow_up"
                ? "Queueing a durable follow-up..."
                : "Dispatching prompt durably..."
        );
        let commandId = "web-" ++ string_of_float(Js.Date.now());
        let body =
          jsonBody([|
            ("commandId", Js.Json.string(commandId)),
            ("text", Js.Json.string(text)),
            ("images", imagesJson(images)),
            ("resources", resourcesJson(text, mentionResources)),
            ("action", Js.Json.string(action)),
          |]);
        postText(sessionUrl("/api/v2/commands", activeSessionId), body)
        ->thenPromise(_ => {
            clearPrompt();
            setImages(_ => [||]);
            setMentionResources(_ => [||]);
            dismissMention();
            clearImagePicker();
            setNotice(_ =>
              action == "steer"
                ? "Steering message delivered."
                : action == "follow_up"
                    ? "Follow-up queued durably."
                    : "Prompt accepted. The worker owns this turn."
            );
            setSubmitting(_ => false);
            refresh();
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            setNotice(_ => errorMessage(error));
            setSubmitting(_ => false);
            Js.Promise.resolve();
          })
        ->ignore;
      };
    };

    let newSession = event => {
      preventDefault(event);
      if (!submitting) {
        let harness = fieldValue("new-session-harness");
        let workspaceId = creatorWorkspaceId;
        let title = fieldValue("new-session-title");
        if (workspaceId != "" && title != "") {
          setSubmitting(_ => true);
          setNotice(_ => "Starting an isolated " ++ harness ++ " worker...");
          let body =
            jsonBody([|
              ("harness", Js.Json.string(harness)),
              ("workspaceId", Js.Json.string(workspaceId)),
              ("title", Js.Json.string(title)),
            |]);
          postText("/api/v2/sessions", body)
          ->thenPromise(text => {
              let selected = createdSessionId(text);
              setNotice(_ => "Isolated session worker is starting.");
              waitForSession(selected)
              ->thenPromise(_ => Js.Promise.resolve(selected));
            })
          ->thenPromise(selected => {
              setSubmitting(_ => false);
              setCreatorOpen(_ => false);
              setDrawerOpen(_ => false);
              setActiveSessionId(_ => selected);
              setEventsJson(_ => "[]");
              setHasOlderEvents(_ => false);
              setLoadingOlderEvents(_ => false);
              setConfigOptionsJson(_ => "[]");
              setConfigMenu(_ => "");
              setShowJumpToBottom(_ => false);
              refreshSession(selected);
              refresh();
              Js.Promise.resolve();
            })
          ->catchPromise(error => {
              setNotice(_ => errorMessage(error));
              setSubmitting(_ => false);
              Js.Promise.resolve();
            })
          ->ignore;
        };
      };
    };

    let renameSession = session =>
      switch (confirmRename(sessionTitle(session))) {
      | None => ()
      | Some(title) =>
        let body = jsonBody([|("title", Js.Json.string(title))|]);
        postText(
          "/api/v2/sessions/" ++ sessionId(session) ++ "/rename",
          body,
        )
        ->thenPromise(_ => {
            refresh();
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            setNotice(_ => errorMessage(error));
            Js.Promise.resolve();
          })
        ->ignore;
      };

    let selectSession = id => {
      setActiveSessionId(_ => id);
      setEventsJson(_ => "[]");
      setEventsLoaded(_ => false);
      setEventsLoadError(_ => "");
      setHasOlderEvents(_ => false);
      setLoadingOlderEvents(_ => false);
      setConfigOptionsJson(_ => "[]");
      setConfigMenu(_ => "");
      setNotice(_ => "Switching durable session...");
      setDrawerOpen(_ => false);
      setSearchOpen(_ => false);
      setSearchQuery(_ => "");
      setShowJumpToBottom(_ => false);
      refreshSession(id);
    };

    let restoreSession = id =>
      if (!submitting && id != "") {
        setSubmitting(_ => true);
        setNotice(_ => "Restoring durable session...");
        postText(restoreUrl(id), "{}")
        ->thenPromise(_ => {
            setNotice(_ => "Session restored; reconnecting its worker...");
            waitForSession(id);
          })
        ->thenPromise(_ => {
            setSubmitting(_ => false);
            setSearchScope(_ => "active");
            refresh();
            selectSession(id);
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            setNotice(_ => errorMessage(error));
            setSubmitting(_ => false);
            Js.Promise.resolve();
          })
        ->ignore;
      };

    let archiveSession = id =>
      if (!submitting && id != "") {
        setSubmitting(_ => true);
        postText(archiveUrl(id), "{}")
        ->thenPromise(_ => {
            if (id == activeSessionId) {
              setActiveSessionId(_ => "");
              setEventsJson(_ => "[]");
              setHasOlderEvents(_ => false);
              setLoadingOlderEvents(_ => false);
              setSessionJson(_ =>
                "{\"status\":\"offline\",\"agentName\":\"ACP agent\",\"workerPid\":0,\"harnessPid\":0,\"lastSequence\":0}"
              );
              setConfigOptionsJson(_ => "[]");
              setConfigMenu(_ => "");
            };
            setArchiveTargetId(_ => "");
            setSessionMenuId(_ => "");
            setNotice(_ => "Session archived; its ledger remains durable.");
            setSubmitting(_ => false);
            refresh();
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            setNotice(_ => errorMessage(error));
            setSubmitting(_ => false);
            Js.Promise.resolve();
          })
        ->ignore;
      };

    let removeWorkspace = id =>
      if (!submitting && id != "") {
        setSubmitting(_ => true);
        setRemoveWorkspaceError(_ => "");
        postText("/api/v2/workspaces/" ++ id ++ "/delete", "{}")
        ->thenPromise(_ => {
            setSubmitting(_ => false);
            setWorkspaceMenuId(_ => "");
            setRemoveWorkspaceId(_ => "");
            setNotice(_ =>
              "Workspace removed. Its directory and files were not changed."
            );
            refresh();
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            setSubmitting(_ => false);
            setRemoveWorkspaceError(_ => errorMessage(error));
            Js.Promise.resolve();
          })
        ->ignore;
      };

    let loadOlderEvents = _ =>
      if (!loadingOlderEvents && hasOlderEvents && activeSessionId != "") {
        let before = oldestEventSequence(eventsJson);
        if (before <= 0) {
          setHasOlderEvents(_ => false);
        } else {
          let previousHeight = timelineScrollHeight();
          setLoadingOlderEvents(_ => true);
          getText(
            sessionUrl(
              "/api/v2/events?before="
              ++ string_of_int(before)
              ++ "&limit=200",
              activeSessionId,
            ),
          )
          ->thenPromise(page => {
              let count = eventPageLength(page);
              setEventsJson(current => prependEventPage(current, page));
              setHasOlderEvents(_ => count >= 200);
              setLoadingOlderEvents(_ => false);
              preserveTimelineAfterPrepend(previousHeight);
              Js.Promise.resolve();
            })
          ->catchPromise(error => {
              setNotice(_ => errorMessage(error));
              setLoadingOlderEvents(_ => false);
              Js.Promise.resolve();
            })
          ->ignore;
        };
      };

    let searchDirectories = _ => {
      let query = fieldValue("workspace-search");
      setSelectedWorkspacePath(_ => "");
      getText(directorySearchUrl(query))
      ->thenPromise(text => {
          setDirectoriesJson(_ => text);
          Js.Promise.resolve();
        })
      ->catchPromise(error => {
          setNotice(_ => errorMessage(error));
          Js.Promise.resolve();
        })
      ->ignore;
    };

    let registerWorkspace = event => {
      preventDefault(event);
      let path = selectedWorkspacePath;
      if (path != "" && !submitting) {
        setSubmitting(_ => true);
        postText(
          "/api/v2/workspaces",
          jsonBody([|("path", Js.Json.string(path))|]),
        )
        ->thenPromise(_ => {
            setSubmitting(_ => false);
            setWorkspaceCreatorOpen(_ => false);
            setNotice(_ => "Local workspace added.");
            refresh();
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            setSubmitting(_ => false);
            setNotice(_ => errorMessage(error));
            Js.Promise.resolve();
          })
        ->ignore;
      };
    };

    let cancel = _ => {
      setNotice(_ => "Cancellation requested...");
      postText(sessionUrl("/api/v2/cancel", activeSessionId), "{}")
      ->thenPromise(_ => {
          setNotice(_ => "Cancellation delivered to the agent.");
          Js.Promise.resolve();
        })
      ->catchPromise(error => {
          setNotice(_ => errorMessage(error));
          Js.Promise.resolve();
        })
      ->ignore;
    };

    let resolvePermission = (requestId, optionId) => {
      let optionJson =
        switch (optionId) {
        | Some(value) => Js.Json.string(value)
        | None => Js.Json.null
        };
      let body =
        jsonBody([|
          ("requestId", Js.Json.string(requestId)),
          ("optionId", optionJson),
        |]);
      postText(sessionUrl("/api/v2/permissions", activeSessionId), body)
      ->thenPromise(_ => {
          setNotice(_ => "Permission decision delivered.");
          refresh();
          Js.Promise.resolve();
        })
      ->catchPromise(error => {
          setNotice(_ => errorMessage(error));
          Js.Promise.resolve();
        })
      ->ignore;
    };

    <main className="control-room">
      <header className="app-header">
        <button
          className="mobile-menu"
          type_="button"
          ariaLabel={
            drawerOpen
              ? "Close workspaces and sessions"
              : "Open workspaces and sessions"
          }
          ariaExpanded=drawerOpen
          onClick={_ => setDrawerOpen(current => !current)}>
          {icon("menu")}
        </button>
        <div className="brand-lockup">
          <span className="brand-mark">
            {React.string(fromCodePoint(0x03c0))}
          </span>
          <div>
            <h1>
              {React.string(
                 selectedWorkspaceName(sessions, workspaces, activeSessionId),
               )}
            </h1>
            <p className="eyebrow">
              {React.string("Durable agent workbench")}
            </p>
          </div>
        </div>
        <button
          className="search-trigger"
          type_="button"
          title="Search sessions"
          ariaLabel="Search sessions"
          ariaExpanded=searchOpen
          onClick={_ => openSearch()}>
          {icon("search")}
          <span> {React.string("Search sessions")} </span>
          <kbd> {React.string(searchShortcutLabel())} </kbd>
        </button>
        <div className={"connection-pill connection-" ++ status}>
          <i />
          <span> {React.string(status)} </span>
        </div>
      </header>
      <section className="workspace-grid">
        {drawerOpen
           ? <button
               className="sidebar-scrim visible"
               type_="button"
               ariaLabel="Close navigation"
               onClick={_ => setDrawerOpen(_ => false)}
             />
           : React.null}
        <aside
          className={"runtime-rail " ++ (drawerOpen ? "mobile-open" : "")}>
          <div className="rail-heading">
            <div>
              <h2> {React.string("Workspaces")} </h2>
              <p> {React.string("Sessions grouped by project")} </p>
            </div>
            <button
              className="create-session-trigger"
              type_="button"
              ariaLabel="Add workspace"
              onClick={_ => {
                setWorkspaceCreatorOpen(_ => true);
                searchDirectories();
              }}>
              {icon("plus")}
            </button>
          </div>
          <nav className="session-index" ariaLabel="Workspaces and sessions">
            {Array.map(
               workspace => {
                 let workspaceSessions =
                   sessionsForWorkspace(sessions, workspaceId(workspace));
                 let collapsed =
                   idInJson(collapsedWorkspacesJson, workspaceId(workspace));
                 <section
                   className="workspace-group" key={workspaceId(workspace)}>
                   <header className="workspace-heading">
                     <button
                       className="workspace-toggle"
                       type_="button"
                       ariaExpanded={!collapsed}
                       onClick={_ =>
                         setCollapsedWorkspacesJson(current =>
                           toggleIdJson(current, workspaceId(workspace))
                         )
                       }>
                       <span
                         className={
                           "workspace-chevron "
                           ++ (collapsed ? "collapsed" : "")
                         }>
                         {icon("chevron")}
                       </span>
                       <span>
                         <strong>
                           {React.string(workspaceName(workspace))}
                         </strong>
                         <small title={workspaceRoot(workspace)}>
                           {React.string(workspaceRoot(workspace))}
                         </small>
                       </span>
                     </button>
                     <div className="workspace-actions">
                       <button
                         className="workspace-more"
                         type_="button"
                         ariaLabel={
                           "Workspace settings for "
                           ++ workspaceName(workspace)
                         }
                         ariaExpanded={
                           workspaceMenuId == workspaceId(workspace)
                         }
                         onClick={_ =>
                           setWorkspaceMenuId(current =>
                             current == workspaceId(workspace)
                               ? "" : workspaceId(workspace)
                           )
                         }>
                         {icon("more")}
                       </button>
                       {workspaceMenuId == workspaceId(workspace)
                          ? <div
                              className="workspace-menu"
                              role="menu"
                              ariaLabel={
                                "Workspace actions for "
                                ++ workspaceName(workspace)
                              }>
                              <button
                                type_="button"
                                role="menuitem"
                                onClick={_ => {
                                  setRemoveWorkspaceId(_ =>
                                    workspaceId(workspace)
                                  );
                                  setRemoveWorkspaceName(_ =>
                                    workspaceName(workspace)
                                  );
                                  setRemoveWorkspaceRoot(_ =>
                                    workspaceRoot(workspace)
                                  );
                                  setRemoveWorkspaceError(_ => "");
                                  setWorkspaceMenuId(_ => "");
                                }}>
                                {icon("trash")}
                                {React.string("Remove workspace")}
                              </button>
                            </div>
                          : React.null}
                     </div>
                     <button
                       type_="button"
                       ariaLabel={
                         "New session in " ++ workspaceName(workspace)
                       }
                       onClick={_ => {
                         setCreatorWorkspaceId(_ => workspaceId(workspace));
                         setCreatorOpen(_ => true);
                       }}>
                       {icon("plus")}
                     </button>
                   </header>
                   {collapsed
                      ? React.null
                      : <div className="session-list">
                          {Array.length(workspaceSessions) == 0
                             ? <p className="empty-workspace">
                                 {React.string("No sessions")}
                               </p>
                             : Array.map(
                                 session => {
                                   let id = sessionId(session);
                                   <div className="session-row-wrap" key=id>
                                     <button
                                       type_="button"
                                       className={
                                         "session-row "
                                         ++ (
                                           id == activeSessionId
                                             ? "session-row-active" : ""
                                         )
                                       }
                                       disabled=submitting
                                       onClick={_ => selectSession(id)}>
                                       <i
                                         className={
                                           "session-dot status-"
                                           ++ sessionStatus(session)
                                         }
                                       />
                                       <span>
                                         <strong>
                                           {React.string(
                                              sessionTitle(session),
                                            )}
                                         </strong>
                                         <small>
                                           {React.string(
                                              sessionStatus(session)
                                              ++ " / "
                                              ++ sessionHarness(session),
                                            )}
                                         </small>
                                       </span>
                                     </button>
                                     <div className="session-menu-wrap">
                                       <button
                                         className="session-more"
                                         type_="button"
                                         ariaLabel={
                                           "Session settings for "
                                           ++ sessionTitle(session)
                                         }
                                         ariaExpanded={sessionMenuId == id}
                                         onClick={_ =>
                                           setSessionMenuId(current =>
                                             current == id ? "" : id
                                           )
                                         }>
                                         {icon("more")}
                                       </button>
                                       {sessionMenuId == id
                                          ? <div
                                              className="session-menu"
                                              role="menu">
                                              <button
                                                type_="button"
                                                role="menuitem"
                                                onClick={_ => {
                                                  setSessionMenuId(_ => "");
                                                  renameSession(session);
                                                }}>
                                                {React.string("Rename")}
                                              </button>
                                              <button
                                                className="danger"
                                                type_="button"
                                                role="menuitem"
                                                onClick={_ => {
                                                  setArchiveTargetId(_ => id);
                                                  setArchiveTargetTitle(_ =>
                                                    sessionTitle(session)
                                                  );
                                                  setSessionMenuId(_ => "");
                                                }}>
                                                {icon("archive")}
                                                {React.string("Archive")}
                                              </button>
                                            </div>
                                          : React.null}
                                     </div>
                                   </div>;
                                 },
                                 workspaceSessions,
                               )
                               ->React.array}
                        </div>}
                 </section>;
               },
               workspaces,
             )
             ->React.array}
          </nav>
          <dl className="runtime-facts">
            <div>
              <dt> {React.string("Worker")} </dt>
              <dd> {React.int(snapshotWorkerPid(snapshot))} </dd>
            </div>
            <div>
              <dt> {React.string("Harness")} </dt>
              <dd> {React.int(snapshotHarnessPid(snapshot))} </dd>
            </div>
            <div>
              <dt> {React.string("Events")} </dt>
              <dd> {React.int(snapshotSequence(snapshot))} </dd>
            </div>
          </dl>
          <div className="boundary-note">
            <span> {React.string("Replaceable control plane")} </span>
            <p>
              {React.string(
                 "This page may disappear. Session workers, harnesses, tools, and SQLite timelines continue independently.",
               )}
            </p>
          </div>
        </aside>
        <section className="conversation-panel">
          <nav className="capability-tabs" ariaLabel="Session views">
            <button
              className={activeView == "agent" ? "active" : ""}
              type_="button"
              ariaPressed={activeView == "agent" ? "true" : "false"}
              onClick={_ => setActiveView(_ => "agent")}>
              {icon("bot")}
              {React.string("Agent")}
            </button>
            <button
              className={
                "working-tab"
                ++ (activeView == "working" ? " active" : "")
                ++ (hasActiveTool ? " has-activity" : "")
              }
              type_="button"
              ariaPressed={activeView == "working" ? "true" : "false"}
              onClick={_ => setActiveView(_ => "working")}
              title={
                hasActiveTool
                  ? "Show what the agent is doing right now"
                  : "Show current agent state"
              }>
              <span
                className={
                  "working-tab-pulse working-tab-pulse-"
                  ++ (
                    hasActiveTool
                      ? "running" : running ? "thinking" : "idle"
                  )
                }
              />
              {icon("activity")}
              {React.string("Working")}
            </button>
            <button
              disabled=true type_="button" title="Changes view is coming next">
              {icon("diff")}
              {React.string("Changes")}
            </button>
            <button
              className={activeView == "details" ? "active" : ""}
              type_="button"
              ariaPressed={activeView == "details" ? "true" : "false"}
              onClick={_ => setActiveView(_ => "details")}>
              {icon("gauge")}
              {React.string("Details")}
            </button>
          </nav>
          {activeView == "working"
             ? <WorkingView
                 status
                 running
                 agentName
                 snapshot
                 activeTool
                 recentTools
               />
             : activeView == "details"
               ? <section
                   className="session-details"
                   role="tabpanel"
                   ariaLabel="Session details">
                 <header>
                   <span> {React.string("Session details")} </span>
                   <h2>
                     {React.string(
                        sessionTitleById(sessions, activeSessionId),
                      )}
                   </h2>
                   <p>
                     {React.string(
                        "Live values reported by the independently supervised worker.",
                      )}
                   </p>
                 </header>
                 <dl>
                   <div>
                     <dt> {React.string("Status")} </dt>
                     <dd> {React.string(status)} </dd>
                   </div>
                   <div>
                     <dt> {React.string("Workspace")} </dt>
                     <dd>
                       {React.string(
                          selectedWorkspaceName(
                            sessions,
                            workspaces,
                            activeSessionId,
                          ),
                        )}
                     </dd>
                   </div>
                   <div>
                     <dt> {React.string("Harness")} </dt>
                     <dd>
                       {React.string(
                          sessionHarnessById(sessions, activeSessionId),
                        )}
                     </dd>
                   </div>
                   <div>
                     <dt> {React.string("Agent")} </dt>
                     <dd> {React.string(snapshotAgentName(snapshot))} </dd>
                   </div>
                   <div>
                     <dt> {React.string("Worker PID")} </dt>
                     <dd> {React.int(snapshotWorkerPid(snapshot))} </dd>
                   </div>
                   <div>
                     <dt> {React.string("Harness PID")} </dt>
                     <dd> {React.int(snapshotHarnessPid(snapshot))} </dd>
                   </div>
                   <div>
                     <dt> {React.string("Event sequence")} </dt>
                     <dd> {React.int(snapshotSequence(snapshot))} </dd>
                   </div>
                   <div>
                     <dt> {React.string("Session ID")} </dt>
                     <dd title=activeSessionId>
                       {React.string(activeSessionId)}
                     </dd>
                   </div>
                 </dl>
                 <section className="details-config">
                   <h3> {React.string("ACP configuration")} </h3>
                   {Array.length(configOptions) == 0
                      ? <p>
                          {React.string(
                             "This worker generation does not expose ACP configuration options.",
                           )}
                        </p>
                      : <div>
                          {Array.map(
                             option =>
                               <p key={configId(option)}>
                                 <span>
                                   {React.string(configName(option))}
                                 </span>
                                 <b>
                                   {React.string(configCurrentName(option))}
                                 </b>
                               </p>,
                             configOptions,
                           )
                           ->React.array}
                        </div>}
                 </section>
               </section>
             : <div className="timeline-wrap">
                 <div
                   id="timeline"
                   className="timeline"
                   tabIndex=0
                   ariaLive="polite"
                   onScroll={event => {
                     let away = updateTimelineFollowFromScroll(event);
                     setShowJumpToBottom(current =>
                       current == away ? current : away
                     );
                   }}>
                    <div className="timeline-stream">
                      {snapshotRetentionPruned(snapshot)
                         ? <p className="timeline-trimmed-notice" role="status">
                             {React.string(
                                "Earlier activity was compacted from the durable session log. The worker retained every permission, command, and harness error; ordinary tool/agent updates before "
                                ++ string_of_int(snapshotFirstSequence(snapshot))
                                ++ " are no longer in this view."
                              )}
                           </p>
                         : React.null}
                      {hasOlderEvents
                         ? <button
                             className="load-earlier"
                             type_="button"
                             disabled=loadingOlderEvents
                             onClick=loadOlderEvents>
                            {React.string(
                               loadingOlderEvents
                                 ? "Loading earlier activity…"
                                 : "Load earlier activity",
                             )}
                          </button>
                        : React.null}
                      {Array.length(timeline) == 0
                         ? <div className="empty-state">
                             <span>
                               {React.string(
                                  !eventsLoaded
                                    ? fromCodePoint(0x23F3)
                                    : fromCodePoint(0x2198),
                                )}
                             </span>
                             <h3>
                               {React.string(
                                  activeSessionId == ""
                                    ? "No active sessions."
                                    : !eventsLoaded
                                      ? eventsLoadError == ""
                                        ? "Loading session activity…"
                                        : eventsLoadError
                                      : "Give the worker something real to do.",
                                )}
                             </h3>
                             <p>
                               {React.string(
                                  activeSessionId == ""
                                    ? "Create a session from a workspace to start a new durable agent."
                                    : !eventsLoaded
                                      ? "Waiting for the worker to publish its first events."
                                      : "Ask the agent to inspect code, run tests, or implement a focused change. Output and tool calls stream back here.",
                                )}
                             </p>
                           </div>
                         : Array.map(
                             item =>
                               <TimelineItem
                                key={itemId(item)}
                                item
                                onPermission=resolvePermission
                              />,
                            timeline,
                          )
                          ->React.array}
                   </div>
                 </div>
                 {showJumpToBottom
                    ? <button
                        className="timeline-jump"
                        type_="button"
                        ariaLabel="Jump to latest message"
                        onClick={_ => {
                          jumpTimelineToBottom();
                          setShowJumpToBottom(_ => false);
                        }}>
                        {icon("down")}
                      </button>
                    : React.null}
               </div>}
          <div className="composer-wrap">
            {Array.length(outbox) > 0
               ? <section
                   className="outbox-tray"
                   ariaLabel="Outgoing messages"
                   ariaLive="polite">
                   <header>
                     <span> {React.string("Outgoing queue")} </span>
                     <b>
                       {React.string(string_of_int(Array.length(outbox)))}
                     </b>
                   </header>
                   {Array.map(
                      item =>
                        <article
                          className={"outbox-message " ++ outboxState(item)}
                          key={outboxId(item)}>
                          <i />
                          <div>
                            <header>
                              <b>
                                {React.string(
                                   outboxAction(item) == "follow_up"
                                     ? "Follow-up" : "Steer",
                                 )}
                              </b>
                              <small>
                                {React.string(
                                   outboxState(item) == "ambiguous"
                                     ? "Delivery needs review"
                                     : outboxAction(item) == "follow_up"
                                         ? "Queued in Pi" : "Sending to Pi",
                                 )}
                              </small>
                            </header>
                            <p> {React.string(outboxText(item))} </p>
                          </div>
                        </article>,
                      outbox,
                    )
                    ->React.array}
                 </section>
               : React.null}
            <p className="notice" role="status"> {React.string(notice)} </p>
            <form className="composer" onSubmit=submitPrompt>
              <input
                id="composer-image-input"
                className="composer-image-input"
                type_="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple=true
                tabIndex=(-1)
                ariaHidden=true
                onChange={event => selectImages(imageFilesFromInput(event))}
              />
              {Array.length(images) == 0
                 ? React.null
                 : <section
                     className="composer-images"
                     role="list"
                     ariaLabel="Image attachments">
                     {Array.map(
                        image =>
                          <figure role="listitem" key={imageId(image)}>
                            <img
                              src={imagePreview(image)}
                              alt={imageName(image)}
                            />
                            <button
                              type_="button"
                              ariaLabel={"Remove " ++ imageName(image)}
                              title={"Remove " ++ imageName(image)}
                              onClick={_ => {
                                setImages(current =>
                                  removeComposerImage(
                                    current,
                                    imageId(image),
                                  )
                                );
                                setNotice(_ => "Image removed.");
                              }}>
                              {icon("x")}
                            </button>
                            <figcaption>
                              <b> {React.string(imageName(image))} </b>
                              <small>
                                {React.string(
                                   formatImageSize(imageSize(image)),
                                 )}
                              </small>
                            </figcaption>
                          </figure>,
                        images,
                      )
                      ->React.array}
                   </section>}
              {switch (mentionActive) {
               | None => React.null
               | Some(_) =>
                 <section
                   id="file-mention-options"
                   className="file-mention-menu"
                   role={Array.length(mentions) > 0 ? "listbox" : "status"}
                   ariaLabel="Workspace files"
                   ariaLive="polite">
                   <header>
                     <span> {React.string("Workspace files")} </span>
                     <small>
                       {React.string(
                          mentionLoading
                            ? "Searching…"
                            : string_of_int(Array.length(mentions))
                              ++ " matches",
                        )}
                     </small>
                   </header>
                   {mentionLoading
                      ? <p className="file-mention-state">
                          {React.string("Searching files…")}
                        </p>
                      : mentionError != ""
                          ? <p className="file-mention-state error">
                              {React.string(mentionError)}
                            </p>
                          : Array.length(mentions) == 0
                              ? <p className="file-mention-state">
                                  {React.string("No matching files")}
                                </p>
                              : Array.mapi(
                                  (index, mention) =>
                                    <button
                                      id={
                                        "file-mention-"
                                        ++ string_of_int(index)
                                      }
                                      className={
                                        index == mentionHighlighted
                                          ? "active" : ""
                                      }
                                      type_="button"
                                      role="option"
                                      ariaSelected={
                                        index == mentionHighlighted
                                      }
                                      key={mentionPath(mention)}
                                      onMouseDown=preventAnyDefault
                                      onMouseEnter={_ =>
                                        setMentionHighlighted(_ => index)
                                      }
                                      onClick={_ => chooseMention(mention)}>
                                      <i> {icon("file")} </i>
                                      <span>
                                        <b>
                                          {React.string(mentionName(mention))}
                                        </b>
                                        <small>
                                          {React.string(mentionPath(mention))}
                                        </small>
                                      </span>
                                    </button>,
                                  mentions,
                                )
                                ->React.array}
                 </section>
               }}
              <textarea
                id="prompt-input"
                name="prompt"
                rows=2
                maxLength=65536
                ariaLabel="Message agent"
                ariaControls="file-mention-options"
                ariaExpanded={Option.is_some(mentionActive)}
                ariaActivedescendant={
                  Option.is_some(mentionActive) && Array.length(mentions) > 0
                    ? "file-mention-" ++ string_of_int(mentionHighlighted)
                    : ""
                }
                disabled={
                  submitting
                  || imageSelectionPending
                  || activeSessionId == ""
                  || workerUnavailable
                }
                onInput=updateMentionFromEvent
                onSelect=updateMentionFromEvent
                onKeyDown=handleComposerKeyDown
                onPaste={event => selectImages(imageFilesFromPaste(event))}
                placeholder={
                  activeSessionId == ""
                    ? "Create or select a session"
                    : workerUnavailable
                        ? "Connecting to the session worker..."
                        : awaitingPermission
                            ? "Resolve the permission prompt above first…"
                            : running
                                ? "Message Pi while it works..."
                                : "Message agent / commands @ files"
                }
              />
              <div className="composer-footer">
                <div className="composer-insertions">
                  <button
                    type_="button"
                    disabled={
                      submitting
                      || imageSelectionPending
                      || activeSessionId == ""
                      || workerUnavailable
                      || !snapshotAcceptsImages(snapshot)
                    }
                    title={
                      snapshotAcceptsImages(snapshot)
                        ? "Attach up to four images"
                        : "This agent does not accept image prompts"
                    }
                    ariaLabel={
                      imageSelectionPending
                        ? "Preparing images" : "Attach images"
                    }
                    onClick={_ => openImagePicker()}>
                    {imageSelectionPending
                       ? React.string("...") : icon("plus")}
                  </button>
                  <button
                    type_="button"
                    disabled={
                      submitting
                      || imageSelectionPending
                      || activeSessionId == ""
                      || workerUnavailable
                    }
                    title="Mention a workspace file"
                    ariaLabel="Mention a workspace file"
                    onClick={_ =>
                      switch (insertMentionTrigger()) {
                      | Some(active) => searchMention(active)
                      | None => ()
                      }
                    }>
                    {icon("at")}
                  </button>
                </div>
                <div
                  className="composer-config"
                  role="group"
                  ariaLabel="Model configuration">
                  {switch (modelOption) {
                   | None =>
                     activeSessionId == ""
                       ? React.null
                       : <div className="config-control">
                           <button
                             className="composer-config-trigger model"
                             type_="button"
                             disabled=true
                             ariaLabel="Model unavailable"
                             title="This agent has not exposed a model option through ACP">
                             <span>
                               <small> {React.string("Model")} </small>
                               <b> {React.string("Not available")} </b>
                             </span>
                           </button>
                         </div>
                   | Some(option) =>
                     <div className="config-control">
                       <button
                         className="composer-config-trigger model"
                         type_="button"
                         disabled={running || awaitingPermission || submitting || workerUnavailable}
                         ariaExpanded={configMenu == "model"}
                         ariaLabel={"Model: " ++ configCurrentName(option)}
                         onClick={_ =>
                           setConfigMenu(current =>
                             current == "model" ? "" : "model"
                           )
                         }>
                         <span>
                           <small> {React.string("Model")} </small>
                           <b> {React.string(configCurrentName(option))} </b>
                         </span>
                         {icon("chevron")}
                       </button>
                       {configMenu == "model"
                          ? <div
                              className="composer-config-menu model-menu"
                              role="menu"
                              ariaLabel="Model options">
                              <header>
                                <span>
                                  {React.string("Available models")}
                                </span>
                                <small>
                                  {React.int(
                                     Array.length(configChoices(option)),
                                   )}
                                </small>
                              </header>
                              {Array.map(
                                 choice =>
                                   <button
                                     className={
                                       choiceValue(choice)
                                       == configCurrentValue(option)
                                         ? "selected" : ""
                                     }
                                     type_="button"
                                     role="menuitemradio"
                                     ariaChecked={
                                       choiceValue(choice)
                                       == configCurrentValue(option)
                                         ? "true" : "false"
                                     }
                                     key={choiceValue(choice)}
                                     onClick={_ =>
                                       applyConfig(
                                         option,
                                         choiceValue(choice),
                                       )
                                     }>
                                     <i
                                       className={
                                         "composer-option-check "
                                         ++ (
                                           choiceValue(choice)
                                           == configCurrentValue(option)
                                             ? "checked" : ""
                                         )
                                       }>
                                       {choiceValue(choice)
                                        == configCurrentValue(option)
                                          ? icon("check") : React.null}
                                     </i>
                                     <span>
                                       <b>
                                         {React.string(
                                            choiceDisplayName(choice),
                                          )}
                                       </b>
                                       <small>
                                         {React.string(choiceValue(choice))}
                                       </small>
                                     </span>
                                     <em>
                                       {React.string(
                                          switch (thinkingOption) {
                                          | Some(_) => "Thinking"
                                          | None => "Direct"
                                          },
                                        )}
                                     </em>
                                   </button>,
                                 configChoices(option),
                               )
                               ->React.array}
                            </div>
                          : React.null}
                     </div>
                   }}
                  {switch (thinkingOption) {
                   | None =>
                     activeSessionId == ""
                       ? React.null
                       : <div className="config-control">
                           <button
                             className="composer-config-trigger thinking"
                             type_="button"
                             disabled=true
                             ariaLabel="Thinking unavailable"
                             title="This agent has not exposed a thinking option through ACP">
                             <span>
                               <small> {React.string("Thinking")} </small>
                               <b> {React.string("Unavailable")} </b>
                             </span>
                           </button>
                         </div>
                   | Some(option) =>
                     <div className="config-control">
                       <button
                         className="composer-config-trigger thinking"
                         type_="button"
                         disabled={running || awaitingPermission || submitting || workerUnavailable}
                         ariaExpanded={configMenu == "thinking"}
                         ariaLabel={"Thinking: " ++ configCurrentName(option)}
                         onClick={_ =>
                           setConfigMenu(current =>
                             current == "thinking" ? "" : "thinking"
                           )
                         }>
                         <span>
                           <small> {React.string("Thinking")} </small>
                           <b> {React.string(configCurrentName(option))} </b>
                         </span>
                         {icon("chevron")}
                       </button>
                       {configMenu == "thinking"
                          ? <div
                              className="composer-config-menu thinking-menu"
                              role="menu"
                              ariaLabel="Thinking options">
                              <header>
                                <span>
                                  {React.string("Thinking level")}
                                </span>
                                <small> {React.string("Reasoning")} </small>
                              </header>
                              {Array.map(
                                 choice =>
                                   <button
                                     className={
                                       choiceValue(choice)
                                       == configCurrentValue(option)
                                         ? "selected" : ""
                                     }
                                     type_="button"
                                     role="menuitemradio"
                                     ariaChecked={
                                       choiceValue(choice)
                                       == configCurrentValue(option)
                                         ? "true" : "false"
                                     }
                                     key={choiceValue(choice)}
                                     onClick={_ =>
                                       applyConfig(
                                         option,
                                         choiceValue(choice),
                                       )
                                     }>
                                     <i
                                       className={
                                         "composer-option-check "
                                         ++ (
                                           choiceValue(choice)
                                           == configCurrentValue(option)
                                             ? "checked" : ""
                                         )
                                       }>
                                       {choiceValue(choice)
                                        == configCurrentValue(option)
                                          ? icon("check") : React.null}
                                     </i>
                                     <span>
                                       {React.string(
                                          choiceDisplayName(choice),
                                        )}
                                     </span>
                                   </button>,
                                 configChoices(option),
                               )
                               ->React.array}
                            </div>
                          : React.null}
                     </div>
                   }}
                </div>
                <button
                  className="send-action"
                  type_="submit"
                  disabled={
                    submitting
                    || imageSelectionPending
                    || activeSessionId == ""
                    || workerUnavailable
                  }
                  ariaLabel={
                    running
                      ? delivery == "steer" ? "Steer Pi" : "Queue follow-up"
                      : "Send message"
                  }>
                  {submitting ? React.string("...") : icon("up")}
                </button>
              </div>
            </form>
            {running
               ? <div className="active-run-controls">
                   <div
                     className="delivery-toggle"
                     role="group"
                     ariaLabel="Message delivery">
                     <button
                       className={delivery == "steer" ? "active" : ""}
                       type_="button"
                       ariaPressed={delivery == "steer" ? "true" : "false"}
                       onClick={_ => setDelivery(_ => "steer")}>
                       {React.string("Steer next")}
                     </button>
                     <button
                       className={delivery == "follow_up" ? "active" : ""}
                       type_="button"
                       ariaPressed={delivery == "follow_up" ? "true" : "false"}
                       onClick={_ => setDelivery(_ => "follow_up")}>
                       {React.string("Follow-up")}
                     </button>
                   </div>
                   <button className="abort-run" type_="button" onClick=cancel>
                     <i />
                     {React.string("Abort run")}
                   </button>
                 </div>
               : React.null}
          </div>
        </section>
      </section>
{searchOpen
         ? <ModalSurface
             ariaLabel="Search sessions"
             onClose={_ => {
               setSearchOpen(_ => false);
               setSearchQuery(_ => "");
             }}>
             <ModalSurface.Header
               label="Session switcher"
               title="Go to a session"
               onClose={_ => {
                 setSearchOpen(_ => false);
                 setSearchQuery(_ => "");
               }}
             />
             <ModalSurface.Body>
               <div
                 className="global-search-scope"
                 role="group"
                 ariaLabel="Session state">
                 <button
                   className={searchScope == "active" ? "active" : ""}
                   type_="button"
                   ariaPressed={searchScope == "active" ? "true" : "false"}
                   onClick={_ => setSearchScope(_ => "active")}>
                   {React.string(
                      "Active " ++ string_of_int(Array.length(sessions)),
                    )}
                 </button>
                 <button
                   className={searchScope == "archived" ? "active" : ""}
                   type_="button"
                   ariaPressed={
                     searchScope == "archived" ? "true" : "false"
                   }
                   onClick={_ => setSearchScope(_ => "archived")}>
                   {React.string(
                      "Archived "
                      ++ string_of_int(Array.length(archivedSessions)),
                    )}
                 </button>
               </div>
               <div className="global-search-field">
                 {icon("search")}
                 <input
                   autoFocus=true
                   ariaLabel="Search sessions"
                   placeholder="Search sessions and workspaces..."
                   onInput={event => {
                     let value = eventValue(event);
                     setSearchQuery(_ => value);
                   }}
                   onKeyDown={event => {
                     let _ = ModalSurface.remapControlNavigation(event);
                     switch (eventKey(event)) {
                     | "Escape" =>
                       preventAnyDefault(event);
                       setSearchOpen(_ => false);
                       setSearchQuery(_ => "");
                     | "Enter" =>
                       if (Array.length(searchResults) > 0) {
                         preventAnyDefault(event);
                         searchScope == "archived"
                           ? restoreSession(sessionId(searchResults[0]))
                           : selectSession(sessionId(searchResults[0]));
                       }
                     | "ArrowDown" =>
                       preventAnyDefault(event);
                       setSearchHighlight(current =>
                         nextMentionIndex(
                           current,
                           Array.length(searchResults),
                           1,
                         )
                       );
                     | "ArrowUp" =>
                       preventAnyDefault(event);
                       setSearchHighlight(current =>
                         nextMentionIndex(
                           current,
                           Array.length(searchResults),
                           (-1),
                         )
                       );
                     | _ => ()
                     }
                   }}
                 />
               </div>
               <div
                 className="global-search-results"
                 role="listbox"
                 ariaLabel="Matching sessions">
                 {Array.length(searchResults) == 0
                    ? <div className="global-search-empty">
                        {icon("search")}
                        <b> {React.string("No matching sessions")} </b>
                        <span>
                          {React.string(
                             "Try a session name, workspace, harness, or status.",
                           )}
                        </span>
                      </div>
                    : Array.map(
                        session => {
                          let id = sessionId(session);
                          let isCurrent = id == activeSessionId;
                          let _ = searchHighlight;
                          <button
                            type_="button"
                            role="option"
                            ariaSelected=isCurrent
                            ariaActivedescendant={isCurrent ? id : ""}
                            key=id
                            disabled=submitting
                            onClick={_ =>
                              searchScope == "archived"
                                ? restoreSession(id)
                                : selectSession(id)
                            }>
                            <i className="global-search-glyph">
                              {icon(
                                 searchScope == "archived"
                                   ? "archive" : "external",
                               )}
                            </i>
                            <span>
                              <b> {React.string(sessionTitle(session))} </b>
                              <small>
                                {React.string(
                                   sessionWorkspaceName(session, workspaces)
                                   ++ " / "
                                   ++ sessionHarness(session),
                                 )}
                              </small>
                            </span>
                            <em>
                              {React.string(
                                 searchScope == "archived"
                                   ? submitting ? "restoring" : "restore"
                                   : sessionStatus(session),
                               )}
                            </em>
                          </button>;
                        },
                        searchResults,
                      )
                      ->React.array}
               </div>
             </ModalSurface.Body>
             <ModalSurface.Footer>
               <span>
                 {React.string(
                    searchScope == "archived"
                      ? "Enter to restore" : "Enter to open",
                  )}
               </span>
               <b>
                 {React.string(
                    string_of_int(Array.length(searchResults)) ++ " sessions",
                  )}
               </b>
             </ModalSurface.Footer>
           </ModalSurface>
         : React.null}
      {creatorOpen
         ? <ModalSurface
             ariaLabel="New session"
             onClose={_ => setCreatorOpen(_ => false)}>
             <form
               id="new-session-form"
               onSubmit=newSession
               style={ReactDOM.Style.make()}>
               <ModalSurface.Header
                 label="New session"
                 title="Start an agent"
                 onClose={_ => setCreatorOpen(_ => false)}
               />
               <ModalSurface.Body>
                 <label htmlFor="new-session-title">
                   {React.string("Name")}
                 </label>
                 <input
                   id="new-session-title"
                   name="title"
                   maxLength=120
                   required=true
                   autoFocus=true
                   placeholder="Implementation agent"
                 />
                 <p className="fixed-workspace">
                   {React.string("Creating in ")}
                   <strong>
                     {React.string(
                        workspaceNameById(workspaces, creatorWorkspaceId),
                      )}
                   </strong>
                 </p>
                 <label htmlFor="new-session-harness">
                   {React.string("Harness")}
                 </label>
                 <select id="new-session-harness" name="harness">
                   <option value="pi"> {React.string("Pi")} </option>
                   <option value="opencode">
                     {React.string("OpenCode")}
                   </option>
                 </select>
               </ModalSurface.Body>
               <ModalSurface.Footer>
                 <button
                   type_="button" onClick={_ => setCreatorOpen(_ => false)}>
                   {React.string("Cancel")}
                 </button>
                 <button
                   className="launch-session"
                   type_="submit"
                   form="new-session-form"
                   disabled=submitting>
                   {React.string(submitting ? "Starting…" : "Start session")}
                 </button>
               </ModalSurface.Footer>
             </form>
           </ModalSurface>
         : React.null}
      {workspaceCreatorOpen
         ? <ModalSurface
             className="workspace-dialog"
             ariaLabel="Add workspace"
             onClose={_ => setWorkspaceCreatorOpen(_ => false)}>
             <form
               id="workspace-form"
               onSubmit=registerWorkspace
               style={ReactDOM.Style.make()}>
               <ModalSurface.Header
                 label="Add workspace"
                 title="Choose a local directory"
                 onClose={_ => setWorkspaceCreatorOpen(_ => false)}
               />
               <ModalSurface.Body>
                 <label htmlFor="workspace-search">
                   {React.string("Search this computer")}
                 </label>
                  <div className="directory-search">
                    <input
                      id="workspace-search"
                      placeholder="Search directories..."
                      onInput=searchDirectories
                      onKeyDown={event => {
                        let _ = ModalSurface.remapControlNavigation(event);
                      }}
                    />
                    {icon("search")}
                  </div>
                 <span className="dialog-field-label">
                   {React.string("Directory")}
                 </span>
                 <div
                   className="directory-options"
                   role="listbox"
                   ariaLabel="Local directories">
                   {Array.map(
                      directory => {
                        let path = directoryPath(directory);
                        <button
                          type_="button"
                          role="option"
                          ariaSelected={selectedWorkspacePath == path}
                          className={
                            selectedWorkspacePath == path ? "selected" : ""
                          }
                          key=path
                          onClick={_ => setSelectedWorkspacePath(_ => path)}>
                          <strong>
                            {React.string(directoryName(directory))}
                          </strong>
                          <small> {React.string(path)} </small>
                        </button>;
                      },
                      parseDirectories(directoriesJson),
                    )
                    ->React.array}
                 </div>
                 <p className="dialog-help">
                   {React.string(
                      "Only directories inside administrator-approved local roots are available.",
                    )}
                 </p>
               </ModalSurface.Body>
               <ModalSurface.Footer>
                 <button
                   type_="button"
                   onClick={_ => setWorkspaceCreatorOpen(_ => false)}>
                   {React.string("Cancel")}
                 </button>
                 <button
                   className="launch-session"
                   type_="submit"
                   form="workspace-form"
                   disabled={submitting || selectedWorkspacePath == ""}>
                   {React.string(submitting ? "Adding…" : "Add workspace")}
                 </button>
               </ModalSurface.Footer>
             </form>
           </ModalSurface>
         : React.null}
      {removeWorkspaceId != ""
         ? <ModalSurface
             className="workspace-remove-dialog"
             modifier=ModalSurface.Alert
             ariaLabel="Remove workspace"
             onClose={_ => setRemoveWorkspaceId(_ => "")}>
             <ModalSurface.Header
               label="Remove workspace"
               title={"Remove " ++ removeWorkspaceName ++ "?"}
               onClose={_ => setRemoveWorkspaceId(_ => "")}
             />
             <ModalSurface.Body>
               <p>
                 {React.string(
                    "The workspace will be removed from PISS. Its directory and files will remain untouched.",
                  )}
               </p>
               <small className="workspace-remove-path">
                 {React.string(removeWorkspaceRoot)}
               </small>
               {removeWorkspaceError == ""
                  ? React.null
                  : <p className="dialog-error" role="alert">
                      {React.string(removeWorkspaceError)}
                    </p>}
             </ModalSurface.Body>
             <ModalSurface.Footer>
               <button
                 type_="button"
                 disabled=submitting
                 onClick={_ => setRemoveWorkspaceId(_ => "")}>
                 {React.string("Cancel")}
               </button>
               <button
                 className="danger-action"
                 type_="button"
                 disabled=submitting
                 onClick={_ => removeWorkspace(removeWorkspaceId)}>
                 {React.string(
                    submitting ? "Removing…" : "Remove workspace",
                  )}
               </button>
             </ModalSurface.Footer>
           </ModalSurface>
         : React.null}
      {archiveTargetId != ""
         ? <ModalSurface
             className="archive-dialog"
             modifier=ModalSurface.Alert
             ariaLabel="Archive session"
             onClose={_ => setArchiveTargetId(_ => "")}>
             <ModalSurface.Header
               label="Archive session"
               title={"Archive " ++ archiveTargetTitle ++ "?"}
               onClose={_ => setArchiveTargetId(_ => "")}
             />
             <ModalSurface.Body>
               <p>
                 {React.string(
                    "The worker will stop, but its durable ledger will remain available for a future restoration interface.",
                  )}
               </p>
             </ModalSurface.Body>
             <ModalSurface.Footer>
               <button
                 type_="button"
                 className="dialog-cancel"
                 onClick={_ => setArchiveTargetId(_ => "")}>
                 {React.string("Cancel")}
               </button>
               <button
                 className="danger-action"
                 type_="button"
                 disabled=submitting
                 onClick={_ => archiveSession(archiveTargetId)}>
                 {React.string(
                    submitting ? "Archiving…" : "Archive session",
                  )}
               </button>
             </ModalSurface.Footer>
           </ModalSurface>
         : React.null}
    </main>;
  };
};

let () =
  switch (ReactDOM.querySelector("#root")) {
  | None => Js.Console.error("Missing #root element")
  | Some(element) =>
    let root = ReactDOM.Client.createRoot(element);
    ReactDOM.Client.render(root, <App />);
  };
