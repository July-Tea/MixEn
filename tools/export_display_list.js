#!/usr/bin/env node
/*
Export Chinese -> English pairs from the built dictionary as CSV, mirroring
the runtime behavior (choose the shortest English sense). No extra filtering
is applied here beyond what the builder emitted.

Usage:
  node tools/export_display_list.js [--out export/display.csv] [--allSenses] [--withMeta]
    --allSenses : export all English senses (multiple rows per Chinese)
    --withMeta  : include extra columns (pinyin,pos,proper,tag)
*/
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
function flag(name){ return argv.includes(name); }
function val(name, def){ const i=argv.indexOf(name); return i>=0? (argv[i+1]||''): def; }

const outPath = val('--out', 'export/display.csv');
const allSenses = flag('--allSenses');
const withMeta = flag('--withMeta');

function chooseSense(entry){
  const list = entry.en || [];
  if(!list.length) return '';
  let best = list[0];
  for(const s of list){ if(s && s.length < best.length) best = s; }
  return best;
}

function csvEscape(s){
  const t = String(s==null?'':s);
  if(/[",\n]/.test(t)) return '"' + t.replace(/"/g, '""') + '"';
  return t;
}
function writeRow(cols){ return cols.map(csvEscape).join(','); }

const base = path.join(__dirname, '..', 'extension', 'data');
const idx = JSON.parse(fs.readFileSync(path.join(base, 'index.json'), 'utf8'));
const rows = [];
// header
const header = withMeta ? ['zh','en','pinyin','pos','proper','tag'] : ['zh','en'];
rows.push(writeRow(header));

for(const gid of Object.keys(idx.groups)){
  const file = path.join(base, 'chunks', idx.groups[gid].file);
  const chunk = JSON.parse(fs.readFileSync(file, 'utf8'));
  for(const [zh, entry] of chunk.entries){
    const ens = (entry.en||[]).slice();
    if(!ens.length) continue;
    const picks = allSenses ? ens : [chooseSense(entry)].filter(Boolean);
    for(const en of picks){
      if(!withMeta) rows.push(writeRow([zh, en]));
      else rows.push(writeRow([zh, en, entry.py||'', entry.pos||'', entry.proper? 'true':'', entry.tag||'']));
    }
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, rows.join('\n'), 'utf8');
console.log(`Wrote ${rows.length-1} rows to ${outPath}`);
