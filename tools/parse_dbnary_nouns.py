#!/usr/bin/env python3
import sys, os, bz2, re, json

def load_nouns_bz2(path):
    nouns=set()
    noun_cf=set()  # canonicalForm ids that are noun entries
    with bz2.open(path, 'rt', encoding='utf-8', errors='ignore') as f:
        buf=[]
        for line in f:
            t=line.rstrip('\n')
            if not t.strip():
                continue
            buf.append(t)
            if t.strip().endswith('.'):
                block='\n'.join(buf)
                buf=[]
                if 'ontolex:LexicalEntry' in block and 'lexinfo:partOfSpeech' in block and 'lexinfo:noun' in block and 'ontolex:canonicalForm' in block:
                    m=re.search(r'ontolex:canonicalForm\s+([\w:_.-]+)', block)
                    if m:
                        noun_cf.add(m.group(1))
                else:
                    # check if this block is a canonical form with writtenRep
                    mcf=re.match(r'^(\S+)\s', block)
                    if mcf:
                        subj=mcf.group(1)
                        if subj in noun_cf and 'ontolex:writtenRep' in block and '@zh' in block:
                            m=re.search(r'ontolex:writtenRep\s+\"([^\"]+)\"@zh', block)
                            if m:
                                nouns.add(m.group(1))
    return sorted(nouns)

def main():
    if len(sys.argv)<2:
        print('Usage: parse_dbnary_nouns.py zh_dbnary_ontolex.ttl.bz2', file=sys.stderr)
        sys.exit(2)
    path=sys.argv[1]
    res=load_nouns_bz2(path)
    json.dump(res, sys.stdout, ensure_ascii=False)

if __name__=='__main__':
    main()
