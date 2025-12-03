/*
MixEn content script (MV3)
- Scans text nodes for Chinese, replaces a fraction with English equivalents from CEDICT-derived dict.
- Lightweight: lazy-load dict chunks on demand; minimal DOM changes; reversible.
*/
(function(){
  // Debug toggle via localStorage: set localStorage['mixen_debug']='1' on the page to enable logs
  const DEBUG = (()=>{ try { return localStorage.getItem('mixen_debug') === '1'; } catch(e){ return false; } })();
  const log = (...args:any[]) => { if (DEBUG) console.log('[MixEn]', ...args); };
  const extAlive = (): boolean => {
    try { return typeof chrome !== 'undefined' && !!(chrome as any).runtime && !!(chrome as any).runtime.id; } catch { return false; }
  };
  const DEFAULT_SETTINGS = {
    enabled: true,
    ratio: 0.15, // 15% of eligible tokens
    onlyNouns: true, // replace nouns only (POS if available; fallback heuristic)
    // URL blacklist with wildcards. Default is ON for all pages; any matching pattern disables.
    // Patterns support '*' (any chars) and '?' (single char), case-insensitive, matched against full URL.
    blacklist: [],
    minNodeLen: 4, // skip very short nodes (chars)
    minChineseRatio: 0.3 // only process node if >=30% CJK
  };

  const IGNORED_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','IFRAME','OBJECT','CANVAS','SVG','MATH','CODE','KBD','SAMP','VAR','PRE','TEXTAREA','INPUT','SELECT','OPTION','BUTTON','TITLE','HEAD']);

  // Global state
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  const DICT = new Map(); // word -> {en:[...], py:string, tag:'common'|'academic'|'other'}
  let MAX_WORD_LEN = 4; // will be updated when loading chunks
  const loadedGroups = new Set();
  let indexMeta = null; // {groupSize, groups: {"g0": {file, count, maxLen}}}
  let processing = false;
  let stats = { nodes: 0, tokens: 0, replaced: 0 };
  const spanClass = 'mixen-word';

  // Utility: detect if string has CJK Unified Ideographs
  function hasCJK(s){
    return /[\u4E00-\u9FFF]/.test(s);
  }
  function chineseRatio(s){
    if(!s) return 0;
    let cjk=0, total=0;
    for(const ch of s){
      const code = ch.codePointAt(0);
      if(code === 32) continue;
      total++;
      if(code>=0x4E00 && code<=0x9FFF) cjk++;
    }
    return total? cjk/total : 0;
  }
  function isEditable(node){
    if(!node) return false;
    if(node.nodeType === Node.ELEMENT_NODE){
      const el = node;
      const name = el.nodeName;
      if(IGNORED_TAGS.has(name)) return true;
      const ce = el.getAttribute('contenteditable');
      if(ce === '' || ce === 'true') return true;
    }
    return false;
  }

  // Visible element heuristic: has layout boxes and not hidden
  function isVisible(el: Element): boolean {
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) return false;
      const rects = el.getClientRects();
      if (!rects || rects.length === 0) return false;
      return true;
    } catch { return true; }
  }

  // Grouping scheme: 512-codepoint buckets starting from 0x4E00
  function groupIdForChar(ch){
    const code = ch.codePointAt(0);
    if(code < 0x4E00 || code > 0x9FFF) return null;
    const idx = Math.floor((code - 0x4E00) / 512);
    return `g${idx}`;
  }

  async function ensureIndex(){
    if(indexMeta) return;
    if(!extAlive()) return; // extension context is gone
    try{
      const url = chrome.runtime.getURL('data/index.json');
      const res = await fetch(url);
      if(!res.ok) throw new Error('index fetch failed');
      indexMeta = await res.json();
      log('Index loaded groups=', Object.keys(indexMeta.groups||{}).length);
    }catch(e){
      // Fallback: no index available (dev mode). We'll rely on tiny inline DICT if any.
      indexMeta = { groupSize: 512, groups: {} };
      log('Index missing; using inline tiny dict only');
    }
  }

  async function ensureGroupLoaded(ch){
    if(!extAlive()) return;
    const gid = groupIdForChar(ch);
    if(!gid || loadedGroups.has(gid)) return;
    await ensureIndex();
    const meta = indexMeta.groups[gid];
    if(!meta) { loadedGroups.add(gid); return; }
    try{
      const url = chrome.runtime.getURL(`data/chunks/${meta.file}`);
      const res = await fetch(url);
      if(!res.ok) throw new Error('chunk fetch failed');
      const chunk = await res.json();
      // chunk: {maxLen:number, entries: [[word, {en:[...], py, tag}], ...]}
      if(chunk.maxLen && chunk.maxLen > MAX_WORD_LEN) MAX_WORD_LEN = chunk.maxLen;
      for(const [w, v] of chunk.entries){
        DICT.set(w, v);
      }
      loadedGroups.add(gid);
      log('Loaded chunk', meta.file, 'entries=', (chunk.entries&&chunk.entries.length)||0, 'maxLen=', chunk.maxLen);
    }catch(e){
      loadedGroups.add(gid);
      log('Failed chunk', meta.file, e);
    }
  }

  function chooseSense(entry){
    // Choose display English: prefer shortest meaningful item
    const list = entry.en || [];
    if(!list.length) return '';
    let best = list[0];
    for(const s of list){ if(s && s.length < best.length) best = s; }
    return best;
  }

  // Heuristic English POS classifier to prefer nouns
  const NOUN_SUFFIX = ['tion','ment','ness','ity','ship','ance','ence','ism','ist','age','ery','or','er','ment','dom','hood','acy','tude','ure'];
  const NOUN_HEADS = new Set(['club','league','game','year','page','subscription','team','player','policy','system','city','country','company','people','market','law','right','time','university','school','teacher','student','government','manager','engineer','result','research','study','data','method','model','problem','solution','case','issue','service','product','plan','project','area','region','river','mountain','province','county','district','airport','station','museum','library','network','computer','program','software','hardware','mobile','phone','car','bus','train','plane','house','room','home','office','doctor','hospital','money','price','cost','salary','contract','agreement','league','match','coach','referee','stadium']);
  function isNounLike(en: string): boolean {
    if(!en) return false;
    const s = en.trim().toLowerCase();
    if(!s) return false;
    if(s.startsWith('to ')) return false; // verb infinitive
    // crude: exclude common verb-ish endings if single token
    const parts = s.split(/\s+/);
    const head = parts[parts.length-1];
    if(parts.length === 1){
      if(head.endsWith('ing')) return false; // treat as verb/gerund for safety
      for(const suf of NOUN_SUFFIX){ if(head.endsWith(suf)) return true; }
      // common short nouns
      if(NOUN_HEADS.has(head)) return true;
      // one-word fallback: assume noun if length>3 and not containing hyphen
      if(head.length >= 4 && !head.includes('-')) return true;
      return false;
    } else {
      // Noun phrase: prefer if last head is a known noun, else accept multiword as noun phrase
      if(NOUN_HEADS.has(head)) return true;
      // reject if first token is 'to'
      if(parts[0] === 'to') return false;
      return true;
    }
  }
  function tokenAllowed(entry): boolean {
    // Drop multi-word English displays
    const en = chooseSense(entry);
    if(!en || /\s/.test(en)) return false;
    if(!settings.onlyNouns) return true;
    // Prefer POS if provided by dictionary build
    if(entry && (entry.pos === 'n' || entry.pos === 'noun')) return true;
    // Fallback heuristic on English sense
    return isNounLike(en);
  }

  function* iterateTextNodes(root){
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node){
        if(!node || !node.nodeValue) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if(!p) return NodeFilter.FILTER_REJECT;
        if(IGNORED_TAGS.has(p.nodeName)) return NodeFilter.FILTER_REJECT;
        if(p.closest('[contenteditable]')) return NodeFilter.FILTER_REJECT;
        if(!isVisible(p)) return NodeFilter.FILTER_REJECT;
        const text = node.nodeValue;
        if(text.length < settings.minNodeLen) return NodeFilter.FILTER_REJECT;
        if(!hasCJK(text)) return NodeFilter.FILTER_REJECT;
        if(chineseRatio(text) < settings.minChineseRatio) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while((n = walker.nextNode())){
      yield n;
    }
  }

  // Also walk open shadow roots
  function* iterateAllTextNodesDeep(root: Node | Document | DocumentFragment): Generator<Text> {
    // Yield direct text nodes under root
    for (const n of (iterateTextNodes as any)(root)) yield n as Text;
    // Find elements with open shadow roots and recurse
    const it = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT);
    let el: Element | null;
    while ((el = it.nextNode() as Element | null)) {
      const sr = (el as any).shadowRoot as ShadowRoot | undefined;
      if (sr) {
        for (const n of (iterateTextNodes as any)(sr)) yield n as Text;
        for (const n of iterateAllTextNodesDeep(sr)) yield n as Text; // nested
      }
    }
  }

  function segmentChinese(text){
    // Forward maximum matching using DICT; only considers CJK spans, leaves others as-is.
    const out = [];
    let i = 0;
    const N = text.length;
    while(i < N){
      const ch = text[i];
      const code = ch.codePointAt(0);
      if(code >= 0x4E00 && code <= 0x9FFF){
        // Try longest match up to MAX_WORD_LEN
        let matched = null;
        let maxL = Math.min(MAX_WORD_LEN, N - i);
        for(let l = maxL; l >= 1; l--){
          const w = text.slice(i, i + l);
          if(DICT.has(w)) { matched = {w, entry: DICT.get(w)}; break; }
        }
        if(matched){
          out.push(matched);
          i += matched.w.length;
        } else {
          // No match, keep single char as plain
          out.push(text[i]);
          i++;
        }
      } else {
        out.push(ch);
        i++;
      }
    }
    return out;
  }

  function sampleIndices(n, ratio){
    // Return a Set of indices in [0..n) to replace, using simple Bernoulli with cap
    const target = Math.max(1, Math.floor(n * ratio));
    const idxs = new Set();
    // Use reservoir-like sampling
    let i = 0;
    while(idxs.size < target && i < n*3){
      const r = Math.floor(Math.random() * n);
      idxs.add(r);
      i++;
    }
    return idxs;
  }

  function createSpan(word: string, entry: any, leadingSpace = false, trailingSpace = false){
    const en = chooseSense(entry) || word;
    // Production: show English • 中文原词；不显示拼音
    const tip = `${en} • ${word}`;
    const span = document.createElement('span');
    span.className = spanClass;
    span.textContent = (leadingSpace ? ' ' : '') + en + (trailingSpace ? ' ' : '');
    span.setAttribute('data-original', word);
    span.setAttribute('data-tip', tip);
    return span;
  }

  type CharKind = 'CJK'|'LATIN'|'SPACE'|'PUNCT'|'OTHER';
  function charKind(ch: string): CharKind {
    if(!ch) return 'OTHER';
    const code = ch.codePointAt(0)!;
    if (code === 32 || ch === '\n' || ch === '\t' || ch === '\r') return 'SPACE';
    if (code >= 0x4E00 && code <= 0x9FFF) return 'CJK';
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return 'LATIN';
    // treat everything else as punctuation-like for spacing purposes
    return 'PUNCT';
  }

  function replaceInNode(textNode){
    const text = textNode.nodeValue;
    const segments = segmentChinese(text);
    // Collect eligible token positions
    const tokens = [];
    for(let i=0;i<segments.length;i++){
      const seg = segments[i];
      if(typeof seg === 'object' && tokenAllowed(seg.entry)) tokens.push(i);
    }
    if(tokens.length === 0) return;
    const idxs = sampleIndices(tokens.length, settings.ratio);
    const replaceSet = new Set(Array.from(idxs).map(k => tokens[k]));
    // Build a fragment
    const frag = document.createDocumentFragment();
    let lastKind: CharKind = 'OTHER';
    for(let i=0;i<segments.length;i++){
      const seg = segments[i];
      if(typeof seg === 'object' && replaceSet.has(i)){
        // Determine spacing based on neighbors (avoid cramping with CJK or LATIN on both sides)
        // prev kind
        let prevKind: CharKind = 'OTHER';
        if(i > 0){
          const prev = segments[i-1];
          if(typeof prev === 'object'){
            prevKind = replaceSet.has(i-1) ? 'LATIN' : 'CJK';
          } else {
            prevKind = charKind(prev);
          }
        } else {
          prevKind = 'SPACE';
        }
        // next kind
        let nextKind: CharKind = 'OTHER';
        let nextIsReplaced = false;
        if(i < segments.length - 1){
          const next = segments[i+1];
          if(typeof next === 'object'){
            nextIsReplaced = replaceSet.has(i+1);
            nextKind = nextIsReplaced ? 'LATIN' : 'CJK';
          } else {
            nextKind = charKind(next);
          }
        } else {
          nextKind = 'SPACE';
        }
        const leading = (prevKind === 'CJK' || prevKind === 'LATIN');
        // trailing only when next is CJK/LATIN and the next token is not another replaced token (to avoid double spaces)
        const trailing = (nextKind === 'CJK' || nextKind === 'LATIN') && !nextIsReplaced;
        frag.appendChild(createSpan(seg.w, seg.entry, leading, trailing));
        lastKind = trailing ? 'SPACE' : 'LATIN';
      } else if(typeof seg === 'object'){
        frag.appendChild(document.createTextNode(seg.w));
        lastKind = 'CJK';
      } else {
        frag.appendChild(document.createTextNode(seg));
        lastKind = charKind(seg);
      }
    }
    textNode.parentNode.replaceChild(frag, textNode);
    stats.tokens += tokens.length;
    stats.replaced += replaceSet.size;
  }

  function revertAll(root){
    const spans = root.querySelectorAll(`span.${spanClass}[data-original]`);
    for(const sp of spans){
      const text = sp.getAttribute('data-original');
      const tn = document.createTextNode(text);
      sp.replaceWith(tn);
    }
  }

  let mo = null;
  function startObserve(){
    if(mo) return;
    mo = new MutationObserver((mutList)=>{
      if(processing) return;
      for(const m of mutList){
        if(m.type === 'childList'){
          scheduleProcess(m.target);
          for(const n of m.addedNodes){
            if(n.nodeType === Node.ELEMENT_NODE) scheduleProcess(n);
          }
        } else if(m.type === 'characterData'){
          scheduleProcess(m.target.parentNode || document.body);
        }
      }
    });
    const opts: MutationObserverInit = {subtree:true, childList:true, characterData:true};
    mo.observe(document.documentElement || document.body, opts);
    // Observe open shadow roots as well (won't see closed roots)
    const it = document.createNodeIterator(document, NodeFilter.SHOW_ELEMENT);
    let el: Element | null;
    while ((el = it.nextNode() as Element | null)){
      const sr = (el as any).shadowRoot as ShadowRoot | undefined;
      if (sr) mo.observe(sr, opts);
    }
  }

  let processTimer = null;
  function scheduleProcess(root){
    if(processTimer) return;
    processTimer = setTimeout(async ()=>{
      processTimer = null;
      processing = true;
      try{
        if(!extAlive()) { processing = false; return; }
        await ensureIndex();
        // Warm-up: load group for common first char in page to avoid many small fetches
        // We'll lazy-load per token as needed in ensureGroupLoaded inside segmentation path below.
        let nodeCount = 0;
        const scanRoot = document.body || root;
        for(const node of iterateAllTextNodesDeep(scanRoot)){
          const text = node.nodeValue;
          // Preload dict groups for all unique CJK group ids in this node
          const gids = new Set();
          for(const ch of text){
            const gid = groupIdForChar(ch);
            if(gid) gids.add(gid);
          }
          for(const gid of gids){
            if(!loadedGroups.has(gid)){
              const meta = (indexMeta && indexMeta.groups) ? indexMeta.groups[gid] : null;
              if(meta){
                try{
                  const url = chrome.runtime.getURL(`data/chunks/${meta.file}`);
                  const res = await fetch(url);
                  if(res.ok){
                    const chunk = await res.json();
                    if(chunk.maxLen && chunk.maxLen > MAX_WORD_LEN) MAX_WORD_LEN = chunk.maxLen;
                    for(const [w, v] of chunk.entries){ DICT.set(w, v); }
                  }
                }catch(e){
                  log('Prefetch chunk failed for', gid, meta.file, e);
                } finally {
                  loadedGroups.add(gid);
                }
              } else {
                // If index not ready yet, try ensureIndex + ensureGroupLoaded on first CJK char as fallback
                try {
                  await ensureIndex();
                  const m = text.match(/[\u4E00-\u9FFF]/);
                  if(m) await ensureGroupLoaded(m[0]);
                } catch(e) {
                  log('ensureGroupLoaded fallback failed', e);
                }
              }
            }
          }
          replaceInNode(node);
          nodeCount++;
        }
        stats.nodes += nodeCount;
        log('Processed batch', {nodes: nodeCount, tokens: stats.tokens, replaced: stats.replaced, url: location.href});
      } finally {
        processing = false;
      }
    }, 200);
  }

  // Suppress noisy console error when extension is reloaded while page stays open
  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent)=>{
    const msg = String((ev as any).reason || '');
    if(msg.includes('Extension context invalidated')){
      ev.preventDefault();
      log('Suppressed rejection after extension reload');
    }
  });

  function currentHost(){
    try { return location.hostname || ''; } catch(e){ return ''; }
  }

  // --- URL pattern matching (wildcards) ---
  function escapeRe(s: string){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function patToRegExp(pat: string): RegExp | null {
    const raw = (pat||'').trim();
    if(!raw || raw.startsWith('#')) return null;
    // Convert simple wildcards to regex, match full URL (case-insensitive)
    const escaped = escapeRe(raw).replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
    try{ return new RegExp('^' + escaped + '$', 'i'); }catch{ return null; }
  }
  let blacklistRe: RegExp[] = [];
  function compilePatternLists(cfg: any){
    const bl = Array.isArray(cfg.blacklist) ? cfg.blacklist : [];
    blacklistRe = bl.map(patToRegExp).filter(Boolean) as RegExp[];
  }

  async function loadSettings(){
    return new Promise((resolve)=>{
      chrome.storage.sync.get(DEFAULT_SETTINGS, (res)=>{
        const cfg = Object.assign({}, DEFAULT_SETTINGS, res);
        compilePatternLists(cfg);
        resolve(cfg);
      });
    });
  }

  function urlMatchesAny(reList: RegExp[], url: string): boolean {
    for(const re of reList){ if(re.test(url)) return true; }
    return false;
  }
  function settingsAllow(){
    const href = (location && location.href) ? location.href : '';
    // Default ON, blacklist disables
    if(!settings.enabled) return false; // keep switch semantics
    if(blacklistRe.length && urlMatchesAny(blacklistRe, href)) return false;
    return true;
  }

  function onStorageChanged(changes){
    let relevant = false;
    for(const k of Object.keys(changes)){
      if(k in DEFAULT_SETTINGS){
        settings[k] = changes[k].newValue;
        relevant = true;
      }
    }
    if(!relevant) return;
    compilePatternLists(settings);
    if(settingsAllow()){
      scheduleProcess(document.body);
    } else {
      revertAll(document.body);
    }
  }

  async function init(){
    log('Init on', location.href);
    settings = await loadSettings();
    chrome.storage.onChanged.addListener(onStorageChanged);
    if(!settingsAllow()) return;
    // Kick off initial processing & observer
    scheduleProcess(document.body);
    startObserve();
    // Expose debugging helpers for inspect
    (window as any).MixEn = {
      version: '0.1.0',
      get settings(){ return settings; },
      stats(){ return { ...stats, dictSize: DICT.size, groupsLoaded: Array.from(loadedGroups) }; },
      list(){ return Array.from(document.querySelectorAll('span.mixen-word')); },
      highlight(){ const nodes = Array.from(document.querySelectorAll('span.mixen-word')) as HTMLElement[]; nodes.forEach((el,i)=>{ el.style.outline='2px solid #ff9800'; el.style.background='rgba(255,235,59,.35)'; el.setAttribute('data-idx', String(i+1)); }); return nodes.length; },
      clearHighlight(){ const nodes = Array.from(document.querySelectorAll('span.mixen-word')) as HTMLElement[]; nodes.forEach((el)=>{ el.style.outline=''; el.style.background=''; el.removeAttribute('data-idx'); }); },
      processNow(){ scheduleProcess(document.body); },
      relax(threshold=0.1){ settings.minChineseRatio = threshold; scheduleProcess(document.body); },
      setRatio(pct:number){ settings.ratio = Math.max(0, Math.min(1, pct)); scheduleProcess(document.body); }
    };

    // Allow page Console to control via postMessage (content scripts run in isolated world)
    window.addEventListener('message', (ev: MessageEvent)=>{
      const data = (ev && (ev as any).data) || {};
      if(!data || data.source !== 'MixEnCmd') return;
      const cmd = data.cmd as string;
      const arg = data.arg;
      log('Recv cmd', cmd, arg);
      const respond = (payload: any)=> window.postMessage({source:'MixEn', kind:'resp', cmd, payload}, '*');
      try{
        switch(cmd){
          case 'stats': respond({ ...stats, dictSize: DICT.size, groupsLoaded: Array.from(loadedGroups) }); break;
          case 'highlight': {
            const nodes = Array.from(document.querySelectorAll('span.mixen-word')) as HTMLElement[];
            nodes.forEach((el,i)=>{ el.style.outline='2px solid #ff9800'; el.style.background='rgba(255,235,59,.35)'; el.setAttribute('data-idx', String(i+1)); });
            respond({count: nodes.length});
            break;
          }
          case 'clearHighlight': {
            const nodes = Array.from(document.querySelectorAll('span.mixen-word')) as HTMLElement[];
            nodes.forEach((el)=>{ el.style.outline=''; el.style.background=''; el.removeAttribute('data-idx'); });
            respond({ok:true});
            break;
          }
          case 'relax': settings.minChineseRatio = Math.max(0, Math.min(1, (arg ?? 0.1))); scheduleProcess(document.body); respond({minChineseRatio: settings.minChineseRatio}); break;
          case 'setRatio': settings.ratio = Math.max(0, Math.min(1, (arg ?? 0.2))); scheduleProcess(document.body); respond({ratio: settings.ratio}); break;
          case 'processNow': scheduleProcess(document.body); respond({ok:true}); break;
        }
      }catch(err){ respond({error: String(err)}); }
    });
  }

  // Dev tiny inline dict for first-run if no data files (only a few words)
  DICT.set('你好', {en:['hello'], py:'ni3 hao3', tag:'common'});
  DICT.set('学习', {en:['study','learn'], py:'xue2 xi2', tag:'common'});
  DICT.set('研究', {en:['research'], py:'yan2 jiu1', tag:'academic'});
  MAX_WORD_LEN = 2;

  init();
})();
