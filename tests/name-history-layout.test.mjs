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
  set innerHTML(value){this.replaceChildren();if(value.includes('<tbody>'))this.appendChild(new Element('tbody'));}
  querySelector(tag){return this.children.find(child=>child.tag===tag)||this.children.map(child=>child.querySelector(tag)).find(Boolean)||null;}
  setAttribute(name,value){this.attributes[name]=value;}
  addEventListener(name,callback){this['on'+name]=callback;}
}
const findAll=(root,className)=>[root,...root.children.flatMap(child=>findAll(child,className))]
  .filter(node=>node.className.split(' ').includes(className));

test('name history table shows dates and acts, marks the current identity, and sorts newest first',()=>{
  const elements=new Map();
  const document={createElement:tag=>new Element(tag),getElementById:id=>{
    if(!elements.has(id))elements.set(id,new Element('div'));
    return elements.get(id);
  }};
  const context={document,Intl,Date,
    HARDCODED_ACT_META:{a:{start:Date.parse('2021-01-01')},b:{start:Date.parse('2021-03-01')},c:{start:Date.parse('2021-05-01')},d:{start:Date.parse('2021-07-01')}},
    nameHistoryState:'ready',nameHistoryBackfill:{available:true},
    nameBackfillBusy:false,nameBackfillError:false,nameBackfillStopRequested:false,nameBackfillStopped:false,nameBackfillPages:0,
    nameHistoryRows:[
      {name:'Old',tag:'EU',first_seen:'2021-01-10',last_seen:'2021-03-10',ended_at:'2021-03-11'},
      {name:'Current',tag:'NOW',first_seen:'2021-07-10',last_seen:'2021-07-10',ended_at:null},
    ],
  };
  const render=runInNewContext(html.slice(start,end)+'\nrenderNameHistory',context);
  render();
  const root=elements.get('name-history-table');
  const table=findAll(root,'name-history-table')[0];
  const list=table.querySelector('tbody');
  assert.equal(list.children.length,2);
  assert.ok(list.children.every(row=>row.children.length===4),'each row has Riot ID, first date, last date, and act');
  assert.match(list.children[0].textContent,/Current#NOW/);
  assert.equal(findAll(list.children[0],'name-history-current').length,1);
  assert.match(list.children[0].textContent,/10 Jul 2021.*E2A1/);
  assert.equal((list.children[0].textContent.match(/10 Jul 2021/g)||[]).length,2,'first and last observations each have a date column');
  assert.match(list.children[1].textContent,/10 Jan 2021.*10 Mar 2021.*E1A1 — A2/);
  assert.equal(findAll(list.children[0],'name-history-date').length,2);
  assert.equal(findAll(root,'name-history-table-scroll').length,1);
  assert.equal(context.nameHistoryRows[0].name,'Old','rendering must not reorder stored history');
});
