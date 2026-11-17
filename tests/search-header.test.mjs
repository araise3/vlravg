import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {closeRenderer,renderHtml} from './helpers/react-render.mjs';

after(closeRenderer);

test('search bar is a shadcn input group with a submit button beside a button group',async()=>{
  const html=await renderHtml('/src/app/SearchHeader.jsx','SearchHeader');
  assert.match(html,/<form[^>]*role="search"/);
  assert.match(html,/data-slot="input-group"/);
  assert.match(html,/data-slot="input-group-control"[^>]*aria-label="Player name and tag, pro player, or PUUID"|aria-label="Player name and tag, pro player, or PUUID"[^>]*data-slot="input-group-control"/);
  assert.match(html,/<button[^>]*type="submit"[^>]*aria-label="Search"/);
  // Engine state is shared across test files (isolation=none), so the header
  // may render empty or with an account already loaded: the input's right
  // end then holds either the shortcut hint or the account badges, never both.
  const end=html.slice(html.indexOf('data-align="inline-end"'),html.indexOf('data-slot="button-group"'));
  assert.equal(/data-slot="kbd"/.test(end)+/data-slot="account-badges"/.test(end),1);
  const group=html.slice(html.indexOf('data-slot="button-group"'));
  assert.match(group,/Pro players/);
  assert.match(group,/aria-label="Act: /);
});

test('a loaded account slides its rank, region and Tracker.gg link into the search input',async()=>{
  const source=(await import('node:fs')).readFileSync(new URL('../src/app/SearchHeader.jsx',import.meta.url),'utf8');
  // Inside the InputGroup's inline-end addon, replacing the Ctrl/⌘ K hint.
  const addon=source.slice(source.indexOf('<InputGroupAddon align="inline-end">'),source.indexOf('</InputGroupAddon>',source.indexOf('align="inline-end"')));
  assert.match(addon,/info\s*\n?\s*\?<span key=\{info\.riotId\}[^>]*data-slot="account-badges"><AccountBadges info=\{info\}\/>/);
  assert.match(addon,/:<KbdGroup/);
  // Each item slides in from the right, staggered, and respects reduced motion.
  assert.match(source,/const SLIDE='animate-in fade-in-0 slide-in-from-right-4 duration-300[^']*fill-mode-backwards motion-reduce:animate-none'/);
  assert.match(source,/\[animation-delay:90ms\]/);
  assert.match(source,/\[animation-delay:180ms\]/);
  // Rank, region and Tracker.gg are three separate pills sharing one style,
  // rounded like the rest of the controls (rounded-md, not fully round).
  assert.match(source,/const PILL='inline-flex[^']*rounded-md border[^']*'/);
  const badges=source.slice(source.indexOf('function AccountBadges'),source.indexOf('function StatusBar'));
  assert.equal(badges.match(/data-slot="account-pill" [^>]*?className=\{cn\(SLIDE,PILL,/gs)?.length,3);
  assert.match(badges,/aria-label=\{`Current rank: /);
  assert.match(badges,/aria-label=\{`Region: /);
  assert.match(badges,/aria-label=\{`Open \$\{info\.riotId\} on Tracker\.gg`\}/);
});

test('the pro player list shrinks to the space beside the search instead of running off screen',async()=>{
  const source=(await import('node:fs')).readFileSync(new URL('../src/app/SearchHeader.jsx',import.meta.url),'utf8');
  const content=source.slice(source.indexOf('<PopoverContent align="start"'),source.indexOf('<ProLibraryPanel onPick'));
  assert.match(content,/collisionPadding=\{12\}/);
  assert.match(content,/flex max-h-\[var\(--radix-popover-content-available-height\)\][^"]*flex-col/);
  // The list, not the search box above it, gives up height.
  assert.match(source,/<Command shouldFilter=\{false\} label="Pro player library" className="min-h-0 flex-1/);
  assert.match(source,/<CommandList className="max-h-\[min\(56vh,520px\)\] min-h-0 flex-1/);
});

test('focus border and glow animate together, so a click shows one outline, not two in a row',async()=>{
  const {readdirSync,readFileSync}=await import('node:fs');
  const dir=new URL('../src/components/ui/',import.meta.url);
  for(const file of readdirSync(dir)){
    const source=readFileSync(new URL(file,dir),'utf8');
    // Controls whose border changes on focus must transition border-color with the ring.
    if(!/focus-visible:border-ring|:focus-visible\]:border-ring/.test(source))continue;
    assert.doesNotMatch(source,/transition-\[color,box-shadow\]/,`${file} snaps its border before the ring fades in`);
  }
  const group=readFileSync(new URL('input-group.jsx',dir),'utf8');
  assert.match(group,/transition-\[color,border-color,box-shadow\]/);
});

test('text boxes use a slim 1px focus ring around the 1px border',async()=>{
  const {readFileSync}=await import('node:fs');
  const read=file=>readFileSync(new URL('../src/components/ui/'+file,import.meta.url),'utf8');
  assert.match(read('input-group.jsx'),/has-\[\[data-slot=input-group-control\]:focus-visible\]:ring-1 /);
  for(const file of ['input.jsx','textarea.jsx']){
    assert.match(read(file),/focus-visible:ring-1 /,file);
    assert.doesNotMatch(read(file),/focus-visible:ring-\[3px\]/,file);
  }
});
