import test from 'node:test';
import assert from 'node:assert/strict';
import {getSearchText,getSnapshot,setSearchText,subscribe,subscribeSearch} from '../src/engine/core.mjs';

const flush=()=>new Promise(resolve=>setTimeout(resolve,0));

// Typing used to emit a new engine snapshot per keystroke, re-rendering every
// page (about 440 ms per key with 169 match cards shown in a dev build).
test('typing in the search field notifies only the search listeners',async()=>{
  let page=0,search=0;
  const offPage=subscribe(()=>page++);
  const offSearch=subscribeSearch(()=>search++);
  try{
    const before=getSnapshot();
    for(const text of ['c','cl','cla','clancy','clancy#','clancy#2222']){
      setSearchText(text);
      assert.equal(getSearchText(),text);
    }
    assert.equal(search,6,'each keystroke reaches the search field at once');
    await flush();
    assert.equal(page,0,'no keystroke re-renders the pages');
    assert.equal(getSnapshot(),before);
    assert.equal('searchText' in before,false,'the snapshot does not carry the text');
    setSearchText('clancy#2222');
    assert.equal(search,6,'an unchanged value notifies nobody');
  }finally{
    offPage();offSearch();
  }
});
