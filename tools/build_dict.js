#!/usr/bin/env node
/*
Builds a compact Chinese→English dictionary from CC-CEDICT, with optional AWL/NGSL tags.
- Downloads CC-CEDICT gz file
- Parses entries; keeps simplified form, pinyin, first few short English senses
- Tags entries: 'academic' if headword in AWL, 'common' if in NGSL, else 'other' (or defaultTag)
- Outputs:
  extension/data/index.json
  extension/data/chunks/g{n}.json (bucketed by first char codepoint in 512-size groups)

Usage:
  node tools/build_dict.js [--awl pathOrUrl] [--ngsl pathOrUrl] [--minLen 2] [--maxLen 4] [--maxSenses 3]
*/
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
let WORDNET_DIR = '';
try {
  // Optional: wordnet-db for noun list and exceptions
  const wndb = require('wordnet-db');
  WORDNET_DIR = (wndb && wndb.path) || path.join(path.dirname(require.resolve('wordnet-db')), 'dict');
} catch (e) {
  WORDNET_DIR = '';
}

const CEDICT_URL = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz';

const argv = process.argv.slice(2);
function argVal(name, def){
  const i = argv.indexOf(name);
  if(i>=0 && i<argv.length-1) return argv[i+1];
  return def;
}
function hasFlag(name){ return argv.includes(name); }

const MIN_LEN = parseInt(argVal('--minLen','2'),10);
const MAX_LEN = parseInt(argVal('--maxLen','4'),10);
const MAX_SENSES = parseInt(argVal('--maxSenses','2'),10);
const AWL_SRC = argVal('--awl','');
const NGSL_SRC = argVal('--ngsl','');
const USE_WORDNET = !hasFlag('--noWordNet');
const DEFAULT_TAG = argVal('--defaultTag','common'); // for lightweight fallback

const outDir = path.join(__dirname, '..', 'extension', 'data');
const chunksDir = path.join(outDir, 'chunks');
fs.mkdirSync(chunksDir, { recursive: true });

function fetchBuffer(url){
  return new Promise((resolve, reject)=>{
    https.get(url, (res)=>{
      if(res.statusCode && res.statusCode>=300 && res.statusCode<400 && res.headers.location){
        return resolve(fetchBuffer(res.headers.location));
      }
      if(res.statusCode !== 200){
        return reject(new Error('HTTP '+res.statusCode+' for '+url));
      }
      const chunks=[];
      res.on('data', d=>chunks.push(d));
      res.on('end', ()=>resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function readTextMaybeUrl(src){
  if(!src) return Promise.resolve('');
  if(/^https?:\/\//.test(src)){
    return fetchBuffer(src).then(b=>b.toString('utf8'));
  } else {
    return fs.promises.readFile(src, 'utf8');
  }
}

async function fetchToFile(url, outPath){
  return new Promise((resolve, reject)=>{
    const fs2 = require('fs');
    const f = fs2.createWriteStream(outPath);
    https.get(url, (res)=>{
      if(res.statusCode && res.statusCode>=300 && res.statusCode<400 && res.headers.location){
        f.close(); fs2.unlinkSync(outPath); return fetchToFile(res.headers.location, outPath).then(resolve, reject);
      }
      if(res.statusCode !== 200){ f.close(); try{ fs2.unlinkSync(outPath);}catch{} return reject(new Error('HTTP '+res.statusCode+' for '+url)); }
      res.pipe(f);
      f.on('finish', ()=>{ f.close(); resolve(); });
    }).on('error', (e)=>{ try{ f.close(); fs2.unlinkSync(outPath);}catch{}; reject(e); });
  });
}

async function loadDbnaryNounSet(src){
  // Supports local .bz2 path or URL; prefers Python parser (tools/parse_dbnary_nouns.py)
  const os = require('os');
  const cp = require('child_process');
  let pathLocal = src;
  if(/^https?:\/\//.test(src)){
    const tmp = path.join(os.tmpdir(), 'zh_dbnary_ontolex.ttl.bz2');
    await fetchToFile(src, tmp);
    pathLocal = tmp;
  }
  if(!fs.existsSync(pathLocal)) throw new Error('DBnary file not found: '+pathLocal);
  // Try Python helper
  try{
    const out = cp.execFileSync('python3', [path.join(__dirname, 'parse_dbnary_nouns.py'), pathLocal], {encoding:'utf8', maxBuffer: 1024*1024*128});
    const arr = JSON.parse(out);
    return new Set(arr);
  }catch(e){
    console.warn('Python parse failed, falling back to naive scan:', e.message);
  }
  // Fallback: naive scan (may miss some)
  const nounSet = new Set();
  const proc = cp.spawn('bzcat', [pathLocal]);
  const readline = require('readline');
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line)=>{
    // very naive: capture writtenRep and preceding noun in buffer outside block logic (best-effort)
    const m = line.match(/ontolex:writtenRep\s+\"([^\"]+)\"@zh/);
    if(m){ nounSet.add(m[1]); }
  });
  await new Promise((resolve)=> rl.on('close', resolve));
  return nounSet;
}

async function loadWordSet(name, src){
  if(!src) return new Set();
  try{
    const text = await readTextMaybeUrl(src);
    const set = new Set();
    for(const line of text.split(/\r?\n/)){
      const w = line.trim().toLowerCase();
      if(!w) continue;
      // CSV first field if needed
      const first = w.split(/[\s,;\t]/)[0];
      if(first && /^[a-zA-Z-]+$/.test(first)) set.add(first.toLowerCase());
    }
    console.log(`Loaded ${set.size} ${name} words from ${src}`);
    return set;
  }catch(e){
    console.warn(`Failed to load ${name} from ${src}:`, e.message);
    return new Set();
  }
}

function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Filtering removed by request: no blocklist at build time.


function parseCedictLine(line){
  // Format: trad simp [pinyin] /sense1/sense2/
  const m = line.match(/^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+\/(.+)\/$/);
  if(!m) return null;
  const trad = m[1], simp = m[2], py = m[3];
  const sensesRaw = m[4];
  if(!simp || simp.length < MIN_LEN || simp.length > MAX_LEN) return null;
  if(/CL:/.test(sensesRaw)) return null; // skip classifier-only lines
  const senses = sensesRaw.split('/').filter(Boolean).slice(0, 6);
  const enShort = [];
  const allowEnglishToken = (tok) => {
    if(!tok) return false;
    if(/\s/.test(tok)) return false; // single-token only
    if(tok.includes('-')) return false; // exclude hyphenated
    if(/^[A-Z]/.test(tok)) return false; // exclude capitalized (proper)
    return true;
  };
  for(const s of senses){
    let t = s; // keep original case for proper nouns (NetEase, Chinese Super League)
    if(/^(variant of|see also|see\b|surname|old variant of|abbr\.|abbr)/i.test(t)) continue;
    t = t.replace(/\([^)]*\)/g, ' ');
    t = t.replace(/\[[^\]]*\]/g, ' ');
    // keep letters, spaces and hyphens; but do not force lower-case here
    t = t.replace(/[^A-Za-z\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if(!t) continue;
    // Split by separators into phrases
    for(const part of t.split(/[;,]/)){
      const p = part.trim();
      if(!p) continue;
      if(/^(see\b|variant\b|abbr\b|surname\b)/i.test(p)) continue; // drop low-value cross-refs
      const words = p.split(/\s+/);
      // Only keep single-token English (e.g., drop "to discover", "home page")
      if(words.length !== 1) continue;
      const tok = words[0];
      if(!allowEnglishToken(tok)) continue;
      enShort.push(tok);
      if(enShort.length >= MAX_SENSES) break;
    }
    if(enShort.length >= MAX_SENSES) break;
  }
  if(enShort.length === 0) return null;
  return { trad, simp, py, en: Array.from(new Set(enShort)) };
}

function bucketIdForChar(ch){
  const code = ch.codePointAt(0);
  if(code < 0x4E00 || code > 0x9FFF) return null;
  const idx = Math.floor((code - 0x4E00) / 512);
  return `g${idx}`;
}

async function main(){
  const awl = await loadWordSet('AWL', AWL_SRC);
  const ngsl = await loadWordSet('NGSL', NGSL_SRC);
  const dbnarySrc = argVal('--dbnary','');
  let dbnaryNouns = null;
  if(dbnarySrc){
    try{
      dbnaryNouns = await loadDbnaryNounSet(dbnarySrc);
      console.log('DBnary noun entries loaded:', dbnaryNouns.size);
    }catch(e){ console.warn('Failed to load DBnary nouns:', e.message); }
  }

  console.log('Downloading CC-CEDICT ...');
  const gzBuf = await fetchBuffer(CEDICT_URL);
  const txtBuf = zlib.gunzipSync(gzBuf);
  const txt = txtBuf.toString('utf8');
  console.log('Parsing CEDICT ...');

  const groups = new Map(); // gid -> {entries: Map(word->obj), maxLen}
  const { nounSet, exc } = loadWordNetNouns();
  let kept = 0, seen = 0;

  for(const line of txt.split(/\r?\n/)){
    if(!line || line.startsWith('#')) continue;
    seen++;
    const e = parseCedictLine(line);
    if(!e) continue;
    const gid = bucketIdForChar(e.simp[0]);
    if(!gid) continue;
    // Tagging
    let tag = 'other';
    // choose a headword for tagging (first token of first en)
    const head = e.en[0].split(/\s+/)[0];
    if(awl.size && awl.has(head)) tag = 'academic';
    else if(ngsl.size && ngsl.has(head)) tag = 'common';
    else if(!awl.size && !ngsl.size) tag = DEFAULT_TAG;

    // POS: noun via WordNet check or DBnary noun list
    let pos = undefined;
    if(nounSet){
      for(const en of e.en){
        const s = (en||'').trim().toLowerCase();
        if(!s || s.startsWith('to ')) continue; // skip verb infinitives
        if(isWordNetNoun(s, nounSet, exc)) { pos = 'n'; break; }
      }
    }
    if(!pos && dbnaryNouns){
      if(dbnaryNouns.has(e.simp) || dbnaryNouns.has(e.trad)) pos = 'n';
    }

    const val = { en: e.en, py: e.py, tag };
    if(pos) val.pos = pos;
    if(!groups.has(gid)) groups.set(gid, { entries: new Map(), maxLen: 0 });
    const g = groups.get(gid);
    g.entries.set(e.simp, val);
    if(e.simp.length > g.maxLen) g.maxLen = e.simp.length;
    kept++;
  }

  console.log(`Kept ${kept} entries out of ${seen} lines.`);

  const index = { groupSize: 512, groups: {} };
  for(const [gid, g] of groups){
    const file = `${gid}.json`;
    const entries = Array.from(g.entries.entries());
    // Sort by word length desc then lexicographically to improve matching stability
    entries.sort((a,b)=> b[0].length - a[0].length || a[0].localeCompare(b[0]));
    const payload = { maxLen: g.maxLen, entries };
    fs.writeFileSync(path.join(chunksDir, file), JSON.stringify(payload));
    index.groups[gid] = { file, count: entries.length, maxLen: g.maxLen };
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`Wrote ${Object.keys(index.groups).length} chunk files and index.`);
}

main().catch(err=>{
  console.error(err);
  process.exit(1);
});
// ---------- WordNet noun utilities ----------
function loadWordNetNouns(){
  if(!USE_WORDNET || !WORDNET_DIR) return { nounSet: null, exc: null };
  const nounIdxPath = path.join(WORDNET_DIR, 'index.noun');
  const excPath = path.join(WORDNET_DIR, 'noun.exc');
  try{
    const idx = fs.readFileSync(nounIdxPath, 'utf8');
    const set = new Set();
    for(const line of idx.split(/\r?\n/)){
      if(!line || line[0] === ' ') continue;
      if(line.startsWith(' ')) continue;
      if(line.startsWith('#')) continue;
      const lemma = line.split(' ')[0];
      if(lemma) set.add(lemma.toLowerCase());
    }
    const excMap = new Map();
    if(fs.existsSync(excPath)){
      const exct = fs.readFileSync(excPath, 'utf8');
      for(const line of exct.split(/\r?\n/)){
        if(!line) continue;
        const [inflected, base] = line.trim().split(/\s+/);
        if(inflected && base) excMap.set(inflected.toLowerCase(), base.toLowerCase());
      }
    }
    return { nounSet: set, exc: excMap };
  }catch(e){
    console.warn('WordNet not available:', e.message);
    return { nounSet: null, exc: null };
  }
}

function simpleLemmaNoun(word, exc){
  if(!word) return '';
  let w = word.toLowerCase().replace(/[^a-z\-\s]/g,' ').trim();
  // take head: last token
  const parts = w.split(/\s+/);
  let head = parts[parts.length - 1];
  head = head.replace(/^-+|-+$/g,'');
  if(!head) return '';
  if(exc && exc.has(head)) return exc.get(head);
  // naive plural rules
  if(head.endsWith('ies')) return head.slice(0,-3) + 'y';
  if(head.endsWith('ses') || head.endsWith('xes') || head.endsWith('zes') || head.endsWith('ches') || head.endsWith('shes')) return head.slice(0,-2);
  if(head.endsWith('ves')) return head.slice(0,-3) + 'f';
  if(head.endsWith('s') && head.length > 3) return head.slice(0,-1);
  return head;
}

function isWordNetNoun(eng, nounSet, exc){
  if(!nounSet) return false;
  const lemma = simpleLemmaNoun(eng, exc);
  if(!lemma) return false;
  return nounSet.has(lemma);
}
