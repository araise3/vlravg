/* ════════════════════════════════════════════════════════════════════════
   LOBBY GAP — removed from index.html, parked here on purpose.

   NOT LOADED BY ANYTHING. This file is a shelf, not a module: nothing
   imports it, index.html never references it, and it is not part of the
   deploy in any meaningful sense. It exists so the logic can be put back
   without reconstructing it from git history.

   WHAT IT DID
   -----------
   The RR Gains & Losses card used to carry a "Lobby gap" section: how far
   your lobbies averaged above or below your own rank (in divisions), and —
   the actual point of it — the same win/loss/net RR arithmetic split into
   lobbies that averaged ABOVE your rank vs those that didn't. That split
   answered "what was a harder lobby actually worth to me in RR", measured
   rather than modelled.

   It was cut when RR Gains moved into the header rank-compare card (opposite
   Avg Lobby) and the standalone RR card was dropped. Nothing about the logic
   went stale — there was just no longer a surface wide enough for a
   three-row breakdown.

   WHAT IT DEPENDS ON
   ------------------
   - `m.lobbyAvgTier`  — raw lobby average tier INCLUDING low-rated lobbies,
                         set in processMatch(). Still computed in index.html;
                         see the comment there about why it skips the strict
                         MIN_RATED gate the Avg Lobby card uses.
   - `m.myTierId`      — my tier that match. Still set in processMatch().
   - `computeRRStats`  — still in index.html. The gap fields below (lobbyN,
                         meanGap, split) were spliced out of its return value;
                         re-adding them is the block marked (2) below.
   - `rrSigned`        — still in index.html.

   HOW TO PUT IT BACK
   ------------------
   1. Add `gap` to the row objects computeRRStats() pushes (block 1).
   2. Add the lobbyN/meanGap/split fields to its return value (block 2).
   3. Paste rrRow/rrTone/rrBucketSub/rrRenderLobby (block 3) into index.html.
   4. Paste the CSS (block 4) into the <style> block.
   5. Paste the markup (block 5) wherever the section should live, and call
      rrRenderLobby(res) from renderRRCard() after the existing renders.
   Note the CSS custom properties --rr-dim / --rr-dimmer: they were scoped to
   `#rr-card`, which no longer exists. Re-scope them to whatever container
   the section lands in, or the secondary copy renders at full opacity.
   ════════════════════════════════════════════════════════════════════════ */

// ── (1) inside computeRRStats' matches.forEach, on each pushed row ───────
//
//   rows.push({
//     rr:m.myRR,
//     won:...,
//     penalty:m.myPartyPenalty||0,
//     // ↓ this field
//     // Lobby strength for this match in divisions relative to my own rank.
//     // null when the lobby had no rated players to average at all (see
//     // lobbyAvgTier in processMatch) — essentially only right after a reset.
//     gap:m.lobbyAvgTier!=null?m.lobbyAvgTier-m.myTierId:null,
//   });

// ── (2) inside computeRRStats, after the RR_MIN_MATCHES gate ─────────────
// A lobby-strength bucket needs this many matches before its averages are
// worth printing beside the other bucket's.
const RR_BUCKET_MIN=3;

function computeLobbyGap(rows){
  const gapRows=rows.filter(r=>r.gap!=null);
  const meanGap=gapRows.length?gapRows.reduce((s,r)=>s+r.gap,0)/gapRows.length:null;
  // Split at zero rather than around a dead zone: "did the lobby average above
  // my rank" is the whole question, and a neutral band would only thin out both
  // buckets on samples this size.
  const above=gapRows.filter(r=>r.gap>0),atOrBelow=gapRows.filter(r=>r.gap<=0);
  const split=(above.length>=RR_BUCKET_MIN&&atOrBelow.length>=RR_BUCKET_MIN)
    ?{above:rrBucketStats(above),below:rrBucketStats(atOrBelow)}
    :null;
  // These three merged into computeRRStats' return object.
  return{lobbyN:gapRows.length,meanGap,split};
}

// ── (3) renderers ────────────────────────────────────────────────────────
// Signs use U+2212 so columns line up under font-variant-numeric:tabular-nums.
const rrTone=(x,eps)=>x>(eps||0)?'rr-pos':x<-(eps||0)?'rr-neg':'rr-neu';
// One row: a label with its detail underneath, and one number in RR.
function rrRow(o){
  return `<div class="rr-r">`+
    `<div class="rr-r-name">${o.name}<span class="rr-r-sub">${o.sub}</span></div>`+
    `<div class="rr-r-val ${o.valCls||''}">${o.val}${o.valSub?`<small>${o.valSub}</small>`:''}</div>`+
  `</div>`;
}

// ── Lobby gap, priced in RR ───────────────────────────────────────────────
// First the gap itself (how far your lobbies averaged above or below your own
// rank), then the same win/loss/net arithmetic as the card's headline,
// restricted to lobbies that averaged ABOVE your rank vs those that didn't.
// That comparison is the point of the section: it says what a harder lobby was
// actually worth to you in RR — measured, rather than asserting what Riot's
// formula ought to pay.
//
// Party-dragged lobbies are NOT excluded here (an earlier hidden-MMR version
// dropped them, to protect an inference this card no longer makes): those
// lobbies really were below your rank and really did pay what they paid, and a
// descriptive stat that quietly drops matches isn't descriptive. Matches
// carrying Riot's party RR penalty are disclosed in the note instead.
function rrBucketSub(b){
  const parts=[`${b.count} match${b.count===1?'':'es'}`];
  if(b.winRate!=null)parts.push(`${Math.round(b.winRate)}% win`);
  if(b.avgGain!=null)parts.push(`${rrSigned(b.avgGain,1)} won`);
  if(b.avgLoss!=null)parts.push(`${rrSigned(-b.avgLoss,1)} lost`);
  return parts.join(' · ');
}
function rrRenderLobby(res){
  const host=document.getElementById('rr-lobby');
  const note=document.getElementById('rr-lobby-note');
  if(!host)return;
  if(note)note.textContent=res.lobbyN?`${res.lobbyN} of ${res.n} matches with lobby rank data`:'';
  if(res.meanGap==null){
    host.innerHTML=`<div class="rr-note">No lobby in this sample had enough ranked players to average, so there's no gap to compare against.</div>`;
    return;
  }
  const g=res.meanGap,mag=Math.abs(g).toFixed(1);
  const gapWord=Math.abs(g)<0.05
    ?'level with your rank'
    :`${mag} division${mag==='1.0'?'':'s'} ${g>0?'above':'below'} your rank`;
  let rows=rrRow({
    name:'Avg lobby gap',sub:`your lobbies averaged ${gapWord}`,
    val:rrSigned(g,1),valSub:'divisions',
    valCls:rrTone(g,0.05),
  });
  let tail='';
  if(res.split){
    const a=res.split.above,b=res.split.below;
    rows+=rrRow({
      name:'Lobbies above your rank',sub:rrBucketSub(a),
      val:rrSigned(a.net,1),valSub:'RR / match',valCls:rrTone(a.net,0.05),
    })+rrRow({
      name:'Lobbies at or below',sub:rrBucketSub(b),
      val:rrSigned(b.net,1),valSub:'RR / match',valCls:rrTone(b.net,0.05),
    });
    tail=`<div class="rr-note">Playing above your rank was worth <b>${rrSigned(a.net-b.net,1)} RR per match</b> compared with lobbies at or below it.</div>`;
  }else if(res.lobbyN){
    tail=`<div class="rr-note">Not enough matches on both sides of your rank yet to compare what harder and easier lobbies paid.</div>`;
  }
  if(res.partyMatches){
    tail+=`<div class="rr-note">${res.partyMatches} of these match${res.partyMatches===1?' was':'es were'} played in a party — Riot trims RR gains there, and they're counted above.</div>`;
  }
  host.innerHTML=`<div class="rr-rows">${rows}</div>`+tail;
}

/* ── (4) CSS ──────────────────────────────────────────────────────────────
#rr-card{--rr-dim:rgba(232,234,240,.58);--rr-dimmer:rgba(232,234,240,.38);}
.rr-sec{margin-top:18px;padding-top:14px;border-top:.5px solid var(--glass-border);}
.rr-sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;}
.rr-sec-title{font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--text);font-family:var(--font-display);}
.rr-sec-note{font-size:10.5px;color:var(--rr-dimmer);font-family:var(--font-body);}
.rr-rows{display:flex;flex-direction:column;}
.rr-r{display:grid;grid-template-columns:minmax(120px,1fr) auto;align-items:center;gap:14px;padding:10px 2px;font-size:12px;color:var(--rr-dim);font-family:var(--font-body);border-bottom:.5px solid rgba(255,255,255,.05);}
.rr-r:last-child{border-bottom:none;}
.rr-r-name{min-width:0;color:var(--text);font-weight:600;font-size:12.5px;}
.rr-r-sub{display:block;font-size:10.5px;color:var(--rr-dimmer);font-weight:400;margin-top:2px;}
.rr-r-val{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--font-display);font-weight:800;font-size:15px;color:var(--text);white-space:nowrap;}
.rr-r-val small{display:block;font-size:9.5px;font-weight:500;color:var(--rr-dimmer);margin-top:1px;white-space:nowrap;}
.rr-pos{color:#22c55e;}.rr-neg{color:#ef4444;}.rr-neu{color:var(--rr-dim);}
.rr-note{margin-top:11px;font-size:10.5px;line-height:1.65;color:var(--rr-dim);}
.rr-note b{color:var(--text);}
@media(max-width:640px){.rr-r{padding:11px 2px;}}
─────────────────────────────────────────────────────────────────────────── */

/* ── (5) markup ───────────────────────────────────────────────────────────
<div class="rr-sec">
  <div class="rr-sec-head">
    <div class="rr-sec-title">Lobby gap</div>
    <div class="rr-sec-note" id="rr-lobby-note"></div>
  </div>
  <div id="rr-lobby"></div>
</div>
─────────────────────────────────────────────────────────────────────────── */
