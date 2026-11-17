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
