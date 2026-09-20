import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('function nameHistoryActAt(');
const end=html.indexOf('function updateDetailPages(',start);
assert.ok(start>0&&end>start);

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.attributes={};this.text='';this.className='';this.classList={add:name=>{this.className+=' '+name;}};}
  set textContent(value){this.text=String(value);this.children=[];}
  get textContent(){return this.text+this.children.map(child=>child.textContent).join('');}
  append(...children){this.children.push(...children);}
  appendChild(child){this.append(child);}
  replaceChildren(...children){this.children=children;this.text='';}
  setAttribute(name,value){this.attributes[name]=value;}
  addEventListener(name,callback){this['on'+name]=callback;}
}
const findAll=(root,className)=>[root,...root.children.flatMap(child=>findAll(child,className))]
  .filter(node=>node.className.split(' ').includes(className));

test('name records show readable act endpoints, current identity, and re-sort without a wide table',()=>{
  const elements=new Map();
  const document={createElement:tag=>new Element(tag),getElementById:id=>{
    if(!elements.has(id))elements.set(id,new Element('div'));
    return elements.get(id);
  }};
  const context={document,Intl,Date,
    HARDCODED_ACT_META:{a:{start:Date.parse('2021-01-01')},b:{start:Date.parse('2021-03-01')},c:{start:Date.parse('2021-05-01')},d:{start:Date.parse('2021-07-01')}},
    nameHistoryState:'ready',nameHistorySort:'newest',nameHistoryBackfill:{available:true},
    nameBackfillBusy:false,nameBackfillError:false,nameBackfillStopRequested:false,nameBackfillStopped:false,nameBackfillPages:0,
    nameHistoryRows:[
      {name:'Old',tag:'EU',first_seen:'2021-01-10',last_seen:'2021-03-10',ended_at:'2021-03-11'},
      {name:'Current',tag:'NOW',first_seen:'2021-07-10',last_seen:'2021-07-10',ended_at:null},
    ],
  };
  const render=runInNewContext(html.slice(start,end)+'\nrenderNameHistory',context);
  render();
  const root=elements.get('name-history-table');
  const list=findAll(root,'name-history-list')[0];
  assert.equal(list.children.length,2);
  assert.match(list.children[0].textContent,/Current#NOW/);
  assert.equal(findAll(list.children[0],'name-history-current').length,1);
  assert.equal(findAll(list.children[0],'name-history-era').length,1);
  assert.match(list.children[0].textContent,/Episode 2Act 1/);
  assert.equal(findAll(list.children[1],'name-history-era').length,2);
  assert.match(list.children[1].textContent,/Episode 1Act 1.*Episode 1Act 2/);
  assert.equal(findAll(root,'rank-table').length,0);

  const sort=findAll(root,'name-history-sort')[0].children[0];
  sort.value='oldest';sort.onchange();
  const reordered=findAll(elements.get('name-history-table'),'name-history-list')[0];
  assert.match(reordered.children[0].textContent,/Old#EU/);
});
