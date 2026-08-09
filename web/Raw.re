/* Raw JavaScript bindings and accessors for opaque runtime values.
 *
 * Everything here is a thin shim over JavaScript. Higher-level modules wrap
 * these accessors in semantic helpers. */

open Types;

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
[@mel.get]
external snapshotFirstSequence: sessionSnapshot => int = "firstSequence";
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
  {|name => {
    const n = {
      menu: [['path',{d:'M4 5h16'}],['path',{d:'M4 12h16'}],['path',{d:'M4 19h16'}]],
      search: [['path',{d:'m21 21-4.34-4.34'}],['circle',{cx:11,cy:11,r:8}]],
      plus: [['path',{d:'M5 12h14'}],['path',{d:'M12 5v14'}]],
      more: [['circle',{cx:12,cy:12,r:1}],['circle',{cx:19,cy:12,r:1}],['circle',{cx:5,cy:12,r:1}]],
      chevron: [['path',{d:'m6 9 6 6 6-6'}]],
      up: [['path',{d:'m5 12 7-7 7 7'}],['path',{d:'M12 19V5'}]],
      down: [['path',{d:'M12 5v14'}],['path',{d:'m19 12-7 7-7-7'}]],
      at: [['circle',{cx:12,cy:12,r:4}],['path',{d:'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8'}]],
      activity: [['path',{d:'M3 12h3l3 -9l6 18l3 -9h2'}]],
      bot: [['path',{d:'M12 8V4H8'}],['rect',{width:16,height:12,x:4,y:8,rx:2}],['path',{d:'M2 14h2'}],['path',{d:'M20 14h2'}],['path',{d:'M15 13v2'}],['path',{d:'M9 13v2'}]],
      diff: [['path',{d:'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z'}],['path',{d:'M9 10h6'}],['path',{d:'M12 13V7'}],['path',{d:'M9 17h6'}]],
      gauge: [['path',{d:'m12 14 4-4'}],['path',{d:'M3.34 19a10 10 0 1 1 17.32 0'}]],
      x: [['path',{d:'M18 6 6 18'}],['path',{d:'m6 6 12 12'}]],
      archive: [['rect',{width:20,height:5,x:2,y:3,rx:1}],['path',{d:'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8'}],['path',{d:'M10 12h4'}]],
      copy: [['rect',{width:14,height:14,x:8,y:8,rx:2,ry:2}],['path',{d:'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'}]],
      trash: [['path',{d:'M3 6h18'}],['path',{d:'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'}],['path',{d:'M19 6l-1 14c0 1-1 2-2 2H8c-1 0-2-1-2-2L5 6'}],['path',{d:'M10 11v6'}],['path',{d:'M14 11v6'}]],
      check: [['path',{d:'M20 6 9 17l-5-5'}]],
      external: [['path',{d:'M15 3h6v6'}],['path',{d:'M10 14 21 3'}],['path',{d:'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'}]],
      image: [['rect',{width:18,height:18,x:3,y:3,rx:2,ry:2}],['circle',{cx:9,cy:9,r:2}],['path',{d:'m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21'}]],
      file: [['path',{d:'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z'}],['path',{d:'M14 2v6h6'}]],
      folder: [['path',{d:'M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-4Z'}]],
      clock: [['circle',{cx:12,cy:12,r:10}],['path',{d:'M12 6v6l4 2'}]],
      play: [['path',{d:'M6 4v16l14-8z'}]],
      pause: [['rect',{width:4,height:16,x:6,y:4}],['rect',{width:4,height:16,x:14,y:4}]],
      stop: [['rect',{width:16,height:16,x:4,y:4,rx:1}]],
      refresh: [['path',{d:'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'}],['path',{d:'M21 3v5h-5'}],['path',{d:'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'}],['path',{d:'M3 21v-5h5'}]],
    }[name] || [];
    return React.createElement('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, ...n.map(([tag, attrs]) => React.createElement(tag, { key: `${tag}-${attrs.d || attrs.cx || Math.random()}` }, ...Object.entries(attrs).map(([k, v]) => v === undefined ? null : React.createElement(k === 'd' ? 'path' : k, { key: k, ...(k === 'd' ? { d: v } : v && typeof v === 'object' ? v : {}) })))));
  }|}
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
