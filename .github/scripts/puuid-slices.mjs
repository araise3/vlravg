// Whole-table reads over rr_history run in PUUID ranges on the primary key,
// so each statement stays short and leaves room for the site's queries.
// A PUUID falls in exactly one slice, so per-slice counts and distinct
// players add up.
export function puuidSliceBounds(slices){
  if(!Number.isSafeInteger(slices)||slices<1||slices>4096)throw new Error('Invalid PUUID slice count');
  let width=0;while(16**width<slices)width++;
  const bounds=[];
  for(let i=1;i<slices;i++)bounds.push(Math.floor(i*16**width/slices).toString(16).padStart(width,'0'));
  // Open-ended first and last slices cover any PUUID outside lowercase hex.
  return Array.from({length:slices},(_,i)=>({from:i?bounds[i-1]:null,to:i<slices-1?bounds[i]:null}));
}

// The WHERE condition and parameters (?1, ?2) that keep one statement to a slice.
export function puuidSliceWhere({from,to},column='h.puuid'){
  const where=[from!=null?`${column}>=?1`:null,to!=null?`${column}<?${from!=null?2:1}`:null].filter(Boolean);
  return {where:where.join(' AND '),params:[from,to].filter(value=>value!=null)};
}
