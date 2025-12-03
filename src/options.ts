(function(){
  const DEFAULTS = {
    enabled: true,
    ratio: 0.15,
    onlyNouns: true,
    blacklist: [] as string[]
  } as const;
  function getEls(){
    return {
      enabled: document.getElementById('enabled'),
      ratio: document.getElementById('ratio'),
      ratioVal: document.getElementById('ratioVal'),
      onlyNouns: document.getElementById('onlyNouns') as HTMLInputElement,
      blacklist: document.getElementById('blacklist'),
      save: document.getElementById('save'),
      reset: document.getElementById('reset')
    };
  }
  function readUI(els){
    const bl = els.blacklist.value.split(/\n+/).map(s=>s.trim()).filter(Boolean);
    return {
      enabled: !!els.enabled.checked,
      ratio: Math.max(0.05, Math.min(0.5, (parseInt(els.ratio.value,10)||15)/100)),
      onlyNouns: !!els.onlyNouns.checked,
      blacklist: bl
    };
  }
  function writeUI(els, cfg){
    els.enabled.checked = !!cfg.enabled;
    const pct = Math.round((cfg.ratio||0.15)*100);
    els.ratio.value = String(pct);
    els.ratioVal.textContent = pct + '%';
    els.onlyNouns.checked = !!cfg.onlyNouns;
    els.blacklist.value = (cfg.blacklist||[]).join('\n');
  }
  function load(){
    const els = getEls();
    chrome.storage.sync.get(DEFAULTS, (cfg)=>{
      cfg = Object.assign({}, DEFAULTS, cfg);
      writeUI(els, cfg);
    });
    els.ratio.addEventListener('input', ()=>{
      els.ratioVal.textContent = els.ratio.value + '%';
    });
    els.save.addEventListener('click', ()=>{
      const cfg = readUI(els);
      chrome.storage.sync.set(cfg, ()=>{
        els.save.textContent = 'Saved';
        setTimeout(()=>{ els.save.textContent = 'Save'; }, 800);
      });
    });
    els.reset.addEventListener('click', ()=>{
      chrome.storage.sync.set(DEFAULTS, ()=>{
        writeUI(els, DEFAULTS);
      });
    });
  }
  document.addEventListener('DOMContentLoaded', load);
})();
