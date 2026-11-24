// D1 overload retry for the site's own queries.
//
// D1 rejects every query of a database for a few seconds once that database
// has used too much CPU and memory within ten seconds, or when its queue is
// full ("D1 DB is overloaded. ..."). On 24 Nov 2026 such a window lasted
// about 6 s and every quota-gate query in it failed, so searches got 503s
// although their own queries are single-row (docs/rr-collector-d1-load.md).
// The scripts' governor keeps their share of D1 small
// (.github/scripts/d1-query.mjs); this covers what it cannot see (another
// process, an ad-hoc wrangler query, D1 itself).
//
// withD1Retry(db) returns a binding of the same shape whose statements retry
// only that error, with growing jittered waits (Cloudflare's advice for
// 7429), about 4 s in all. Any other error, or an overload that outlasts the
// waits, is thrown unchanged, so the quota gate still fails closed.
//
// Inference, not documented by Cloudflare: an overloaded database rejects a
// statement before running it. Retried writes are safe either way here: they
// are upserts, conditional updates, or quota-gate leases, and an extra lease
// only holds units back until it expires.
export const D1_RETRY_DELAYS_MS=[150,400,1000,2500];
export const isD1Overloaded=error=>/D1 DB is overloaded/i.test(String(error?.message||error||''));

const STATEMENT_METHODS=new Set(['first','run','all','raw']);
export function withD1Retry(db,{delays=D1_RETRY_DELAYS_MS,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  random=Math.random}={}){
  if(!db||db[RAW])return db;
  async function retrying(call){
    for(let attempt=0;;attempt++){
      try{return await call();}
      catch(error){
        if(!isD1Overloaded(error)||attempt>=delays.length)throw error;
        await sleep(Math.round(delays[attempt]*(0.75+random()*0.5)));
      }
    }
  }
  const wrapStatement=statement=>new Proxy(statement,{get(target,prop){
    if(prop===RAW)return target;
    const value=Reflect.get(target,prop);
    if(typeof value!=='function')return value;
    if(prop==='bind')return (...args)=>wrapStatement(value.apply(target,args));
    if(STATEMENT_METHODS.has(prop))return (...args)=>retrying(()=>value.apply(target,args));
    return value.bind(target);
  }});
  return new Proxy(db,{get(target,prop){
    if(prop===RAW)return target;
    const value=Reflect.get(target,prop);
    if(typeof value!=='function')return value;
    if(prop==='prepare')return sql=>wrapStatement(value.call(target,sql));
    // A batch is one request: retried whole, with the bindings' own statements.
    if(prop==='batch')return statements=>retrying(()=>value.call(target,statements.map(s=>s?.[RAW]??s)));
    return value.bind(target);
  }});
}
const RAW=Symbol('d1RetryRaw');

// A Pages Function context whose env.APP_DB retries; everything else, such
// as waitUntil, still acts on the original context.
export function withD1RetryContext(context,options){
  if(!context?.env?.APP_DB)return context;
  const env={...context.env,APP_DB:withD1Retry(context.env.APP_DB,options)};
  return new Proxy(context,{get(target,prop){
    if(prop==='env')return env;
    const value=Reflect.get(target,prop);
    return typeof value==='function'?value.bind(target):value;
  }});
}
