"""Additional data-quality, display-policy, and time-confounding diagnostics."""
from pathlib import Path
import collections, importlib.util, json, math, sys
import numpy as np

spec=importlib.util.spec_from_file_location('rr_analysis',Path(__file__).with_name('analyze-rr-curves.py'))
R=importlib.util.module_from_spec(spec);spec.loader.exec_module(R)
rows,groups,summary=R.build_corpus()
results=R.load(R.OUT/'results.json')
ids=['act_mean','hard_s30_k5_p8','hard_s40_k5_p8','gaussian_h60_p0','gaussian_h80_p0','gaussian_h100_p0','tricube_h150_d1_p0']
models=[m for m in R.configurations() if m['id'] in ids]
output={}


def regroup(rows):
    by=collections.defaultdict(list)
    for r in rows:by[(r['player'],r['season'],r['won'])].append(r)
    lookup={g['key']:g['tuning'] for g in groups}
    out=[]
    for key,seq in by.items():
        if len(seq)<6 or key not in lookup:continue
        seq.sort(key=lambda r:r['date'])
        out.append(dict(key=key,rows=seq,x=np.array([r['x'] for r in seq]),y=np.array([r['y'] for r in seq]),tuning=lookup[key]))
    return out


for label, subset in [
    ('production_detail',[r for r in rows if r['production_detail']]),
    ('known_party_size',[r for r in rows if r['party_known']]),
    ('coordinate_consistent',[r for r in rows if not r['coordinate_discrepancy']]),
    ('wide_rank_span',None),('at_least_15_outcomes',None),
    ('derived_coordinates',[dict(r,x=r['derived_x']) for r in rows]),
]:
    if label=='wide_rank_span':gg=[g for g in groups if np.ptp(g['x'])>=100]
    elif label=='at_least_15_outcomes':gg=[g for g in groups if len(g['x'])>=15]
    else:gg=regroup(subset)
    values=R.evaluate(gg,models)
    output[label]={id:{k:v for k,v in R.summarize(values[id],'holdout','blocked').items() if k!='player_mse'} for id in ids}

# The existing JavaScript estimator is checked against the Python benchmark,
# including equal-RR ties, penalties filtered before estimation, and sparse data.
parity=[]
base=next(m for m in models if m['id']=='hard_s30_k5_p8')
for g in groups[::13]:
    x,y=g['x'],g['y'];centers=np.unique(x)
    pred,supported,_=R.predict(x,y,centers,base)
    parity.append(dict(x=x.tolist(),y=y.tolist(),centers=centers.tolist(),
                       predicted=[float(p) if s else None for p,s in zip(pred,supported)]))
(R.OUT/'parity.json').write_text(json.dumps(parity),encoding='utf-8')

span=np.array([np.ptp(g['x']) for g in groups])
correlations=[]
for g in groups:
    if len(g['x'])>=10 and np.std(g['x'])>0:
        correlations.append(abs(float(np.corrcoef(np.arange(len(g['x'])),g['x'])[0,1])))
output['data_structure']=dict(
    rank_span_percentiles=np.percentile(span,[10,25,50,75,90,100]).tolist(),
    abs_rank_time_correlation_percentiles=np.percentile(correlations,[25,50,75,90]).tolist(),
    correlation_groups=len(correlations),
    core_discrepancy_count=sum(r['coordinate_discrepancy'] for r in rows),
    core_discrepancy_gt30=sum(abs(r['coordinate_delta'])>30 for r in rows),
    dates=summary['dates'],
    outcome_groups_below6=sum(v<6 for v in collections.Counter((r['player'],r['season'],r['won']) for r in rows).values()),
)

# Quantify display support on observed ranges, separately from predictive
# accuracy. Effective n is 1/sum(normalized weight squared), not raw match count.
kernel=next(m for m in models if m['id']=='gaussian_h80_p0')
support_policies={}
for minimum_eff in [3,5,8]:
    for radius in [80,100,120]:
        coverage=[];fragments=[];weak=[]
        for g in groups:
            if g['tuning'] or len(g['x'])<10:continue
            x,y=g['x'],g['y'];grid=np.arange(x.min(),x.max()+1,5)
            pred,support,eff=R.predict(x,y,grid,kernel)
            local=((np.abs(grid[:,None]-x[None,:]))<=radius).sum(axis=1)
            supported=support&(eff>=minimum_eff)&(local>=3)
            coverage.append(float(np.mean(supported)))
            fragments.append(int(np.sum(supported & ~np.r_[False,supported[:-1]])))
            weak.append(float(np.mean(eff<8)))
        support_policies[f'eff{minimum_eff}_radius{radius}']=dict(
            groups=len(coverage),mean_grid_coverage=float(np.mean(coverage)),
            fragmented_fraction=float(np.mean(np.array(fragments)>1)),
            low_effective_n_fraction=float(np.mean(weak)))
output['support_policies']=support_policies

# Outcome-specific moving-block resampling preserves short match dependence.
# Bands measure estimation stability conditional on this collected history;
# they are not a calibrated confidence interval for future Riot payouts.
sx={}
random=np.random.default_rng(7813)
for g in groups:
    if g['key'][0]!='sxllow#vapo' or g['key'][1]!='e11a5':continue
    x,y=g['x'],g['y'];grid=np.arange(math.ceil(x.min()/5)*5,x.max()+1,5)
    pred,support,eff=R.predict(x,y,grid,kernel)
    samples=[]
    for _ in range(500):
        starts=random.integers(0,len(x),math.ceil(len(x)/4))
        index=np.concatenate([(s+np.arange(4))%len(x) for s in starts])[:len(x)]
        samples.append(R.predict(x[index],y[index],grid,kernel)[0])
    lo,hi=np.percentile(samples,[2.5,97.5],axis=0)
    sx['wins' if g['key'][2] else 'losses']=dict(n=len(x),act_mean=float(y.mean()),
        kernel_range=[float(pred.min()),float(pred.max())],
        effective_n_range=[float(eff.min()),float(eff.max())],
        bootstrap_mean_half_width=float(np.mean((hi-lo)/2)),
        points=[dict(x=float(a),y=float(b)) for a,b in zip(x,y)],
        curve=[dict(x=float(a),y=float(b),low=float(c),high=float(d),effective_n=float(e)) for a,b,c,d,e in zip(grid,pred,lo,hi,eff)])
output['sxllow']=sx

(R.OUT/'sensitivity.json').write_text(json.dumps(output,indent=2),encoding='utf-8')
print(json.dumps({'structure':output['data_structure'],'sxllow':{k:{kk:vv for kk,vv in v.items() if kk not in ['points','curve']} for k,v in sx.items()},'policies':support_policies},indent=2))
