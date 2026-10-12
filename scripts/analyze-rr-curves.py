"""Read-only RR curve benchmark. Uses local research snapshots, never calls an API.

Run with a Python runtime containing numpy. Output is an analysis artifact, not
a production model: all parameter selection is separated by player identity.
"""
from pathlib import Path
import argparse, collections, csv, hashlib, json, math, sys, time
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/rr-curve-analysis'
OUT.mkdir(parents=True, exist_ok=True)
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
RNG = np.random.default_rng(17431)


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def build_corpus():
    base = ROOT / 'hidden-mmr-research'
    histories, matches, names = {}, {}, {}
    audit = collections.Counter()
    sources = []
    hfiles = ['all_players.json', 'targets_hist.json', 'scrape_hist.json', 'kv_hist.json']
    hfiles += [f'wave{i}_hist.json' for i in range(2, 7)]
    if (ROOT/'.local/rr-curve-prod/production-hist.json').exists():
        hfiles.append(str(ROOT/'.local/rr-curve-prod/production-hist.json'))
    mfiles = ['all_matches.json', 'all_matches2.json', 'targets_matches.json', 'scrape_matches.json', 'kv_matches.json']
    mfiles += [f'wave{i}_matches.json' for i in range(2, 7)]
    if (ROOT/'.local/rr-curve-prod/production-matches.json').exists():
        mfiles.append(str(ROOT/'.local/rr-curve-prod/production-matches.json'))

    def add_history(name, entries):
        key = name.casefold()
        names[key] = name
        target = histories.setdefault(key, {})
        for e in entries:
            mid = e.get('match_id')
            if not mid:
                audit['history_missing_id'] += 1
                continue
            if mid in target:
                audit['duplicate_history_snapshots'] += 1
                if target[mid].get('last_change') != e.get('last_change'):
                    audit['history_payout_conflicts'] += 1
            target[mid] = e

    def add_match(name, m):
        key = name.casefold()
        mid = m['mid']
        target = matches.setdefault(key, {})
        # Older CSV evidence only has an eight-character match ID. Keep it as
        # fallback, while joins prefer full UUIDs from later collection waves.
        target[mid] = {**target.get(mid, {}), **m}

    for fname in hfiles:
        path = base / fname
        if not path.exists():
            continue
        blob = load(path)
        count = 0
        for name, rec in blob.items():
            entries = rec if isinstance(rec, list) else rec.get('history', [])
            count += len(entries)
            add_history(name, entries)
        sources.append({'file': path.name, 'players': len(blob), 'entries': count})
    for fname in mfiles:
        path = base / fname
        if path.exists():
            for name, entries in load(path).items():
                for m in entries:
                    if path.name=='production-matches.json':m['production_detail']=True
                    add_match(name, m)
    for r in csv.DictReader((base / 'joined.csv').open(encoding='utf-8')):
        add_match('Sxllow#vapo', dict(mid=r['mid'], won=r['won'] == 'True', rw=int(r['rw']),
                  rl=int(r['rl']), rd=int(r['rd']), acs_z=float(r['acs_z']), party=int(r['party']),
                  pen=float(r['party_pen']), my_tier=int(r['tier_id'])))

    # Include the separately pulled current sxllow data from this investigation.
    latest = ROOT / 'artifacts/sxllow-rr'
    if (latest / 'mmr-history.json').exists():
        add_history('Sxllow#vapo', load(latest / 'mmr-history.json')['data']['history'])
        for path in latest.glob('archive-*.json'):
            for m in load(path)['data']:
                me = next((p for p in m['players'] if p['puuid'] == '5ae2603f-6a31-5a1e-9ca0-67b51f9301d9'), None)
                if me is None:
                    continue
                team = next(t for t in m['teams'] if t['team_id'] == me['team_id'])
                rw, rl = team['rounds']['won'], team['rounds']['lost']
                party = sum(p['team_id'] == me['team_id'] and p['party_id'] == me['party_id'] for p in m['players']) if me['party_id'] else 1
                pen = next((p['penalty'] for p in m['metadata'].get('party_rr_penaltys', []) if p['party_id'] == me['party_id']), 0)
                add_match('Sxllow#vapo', dict(mid=m['metadata']['match_id'], won=team['won'], rw=rw, rl=rl,
                          rd=rw-rl, party=party, pen=pen, my_tier=me['tier']['id']))

    rows = []
    history_dates = []
    for key, entries in histories.items():
        prev = None
        joined = matches.get(key, {})
        for e in sorted(entries.values(), key=lambda r: r['date']):
            audit['history_unique_player_match'] += 1
            history_dates.append(e['date'])
            mid, tier = e['match_id'], e['tier']['id']
            season = e['season']['short']
            same = prev is not None and prev['season']['short'] == season
            total = lambda h: 2100 + h['rr'] if h['tier']['id'] >= 24 else h['elo']
            change, refund = e.get('last_change'), e.get('refunded_rr') or 0
            applied = 0 if e.get('was_derank_protected') and change < 0 else change
            derived = total(e) - applied - refund
            x = total(prev) if same else derived
            pre_tier = prev['tier']['id'] if same else tier
            delta = total(e) - (x + applied + refund)
            gap = same and abs(delta) > 0.01
            if gap:
                audit['coordinate_discrepancy'] += 1
                if tier >= 24 and pre_tier >= 24:
                    audit['immortal_coordinate_discrepancy'] += 1
            transition = prev is not None and not same
            prev = e
            m = joined.get(mid) or joined.get(mid[:8])
            if not m:
                audit['unjoined_history'] += 1
                continue
            audit['joined_history'] += 1
            if tier < 3 or pre_tier < 3 or e.get('elo') == 0:
                audit['excluded_placements_unrated'] += 1
                continue
            # A witnessed season transition is conservatively excluded; no
            # unobserved first match in a truncated history is called placement.
            if transition:
                audit['excluded_witnessed_act_opener'] += 1
                continue
            if m.get('draw', m.get('rw') == m.get('rl')):
                audit['excluded_draws'] += 1
                continue
            if m.get('party', 1) >= 5:
                audit['excluded_five_stack'] += 1
                continue
            # Many slim waves have no party size. Positive penalty is evidence
            # of a nonstandard payout; avoid silently treating those as solo.
            if (m.get('pen') or 0) > 0:
                audit['excluded_positive_party_penalty'] += 1
                continue
            if not isinstance(change, (float, int)) or not math.isfinite(x):
                audit['excluded_missing_numeric'] += 1
                continue
            if m.get('won') not in (True, False):
                audit['excluded_no_outcome'] += 1
                continue
            if (change > 0 and not m['won']) or (change < 0 and m['won']):
                audit['excluded_outcome_sign_mismatch'] += 1
                continue
            rows.append(dict(player=key, name=names[key], season=season, mid=mid, date=e['date'],
                x=float(x), derived_x=float(derived), y=float(abs(change)), won=bool(m['won']),
                tier=int(pre_tier), post_tier=int(tier), coordinate_discrepancy=bool(gap),
                coordinate_delta=float(delta), party_known='party' in m, party=m.get('party'),
                rd=m.get('rd'), acs_z=m.get('acs_z'), production_detail=bool(m.get('production_detail')),
                shield=bool(e.get('was_derank_protected')),
                refund=refund))
    by = collections.defaultdict(list)
    for row in rows:
        by[(row['player'], row['season'], row['won'])].append(row)
    groups = []
    for key, seq in sorted(by.items()):
        seq.sort(key=lambda r: r['date'])
        if len(seq) >= 6:
            groups.append({'key': key, 'rows': seq, 'x': np.array([r['x'] for r in seq]),
                           'y': np.array([r['y'] for r in seq]),
                           'tuning': int(hashlib.sha256(key[0].encode()).hexdigest()[:8], 16) % 10 < 5})
    audit['eligible_rows'] = len(rows)
    audit['eligible_players'] = len({r['player'] for r in rows})
    audit['eligible_player_acts'] = len({(r['player'], r['season']) for r in rows})
    audit['evaluation_groups'] = len(groups)
    audit['evaluation_rows'] = sum(len(g['rows']) for g in groups)
    audit['party_size_unknown_eligible'] = sum(not r['party_known'] for r in rows)
    summary = dict(audit=audit, sources=sources, dates=[min(history_dates), max(history_dates)],
        ranks={label: {'rows': sum(lo <= r['tier'] <= hi for r in rows),
                      'players': len({r['player'] for r in rows if lo <= r['tier'] <= hi})}
               for label, lo, hi in [('Iron',3,5),('Bronze',6,8),('Silver',9,11),('Gold',12,14),
                                     ('Platinum',15,17),('Diamond',18,20),('Ascendant',21,23),('Immortal+',24,27)]},
        group_size_percentiles=np.percentile([len(g['y']) for g in groups], [0,25,50,75,90,100]).tolist())
    (OUT / 'corpus.json').write_text(json.dumps({'summary': summary, 'rows': rows}, ensure_ascii=False), encoding='utf-8')
    return rows, groups, summary


def configurations():
    models = [{'id':'act_mean', 'kind':'mean'}, {'id':'act_linear', 'kind':'linear', 'prior':8}]
    for span in [30,40,60,100]:
        for k in [5,10,20]:
            for prior in [0,8,20]:
                models.append(dict(id=f'hard_s{span}_k{k}_p{prior}', kind='hard', span=span, k=k, prior=prior))
    for h in [20,30,40,60,80,100,150,200]:
        for prior in [0,8,20]:
            models.append(dict(id=f'gaussian_h{h}_p{prior}', kind='gaussian', h=h, prior=prior))
    for h in [40,60,80,100,150,200]:
        for prior in [0,8]:
            for degree in [0,1]:
                models.append(dict(id=f'tricube_h{h}_d{degree}_p{prior}', kind='tricube', h=h, degree=degree, prior=prior))
    for k in [10,20,30]:
        for cap in [100,200]:
            models.append(dict(id=f'adaptive_k{k}_cap{cap}', kind='adaptive', k=k, cap=cap, prior=8))
    return models


def predict(train_x, train_y, targets, model, excluded=None):
    """Return prediction including act-mean fallback, local support, and effective n.

    excluded[target, train row] removes held-out observations from every term,
    including the prior; it allows efficient leave-one-match-out evaluation.
    """
    xx = np.asarray(targets)
    n, nt = len(train_y), len(xx)
    allowed = np.ones((nt,n), bool) if excluded is None else ~excluded
    count = allowed.sum(axis=1)
    mu = (allowed @ train_y) / np.maximum(count,1)
    dx = train_x[None,:] - xx[:,None]
    distance = np.abs(dx)
    kind = model['kind']
    if kind == 'mean':
        return mu, np.zeros(nt,bool), count.astype(float)
    if kind == 'hard':
        preds, cover, eff = mu.copy(), np.zeros(nt,bool), np.zeros(nt)
        for i in range(nt):
            indexes = np.flatnonzero(allowed[i])
            indexes = indexes[np.argsort(train_x[indexes],kind='stable')]
            after=int(np.searchsorted(train_x[indexes],xx[i],side='left'))
            before=after-1
            selected, lo, hi = [], math.inf, -math.inf
            while len(selected)<model['k'] and (before>=0 or after<len(indexes)):
                take_before=before>=0 and (after==len(indexes) or
                    xx[i]-train_x[indexes[before]]<=train_x[indexes[after]]-xx[i])
                if take_before:
                    idx=indexes[before];before-=1
                else:
                    idx=indexes[after];after+=1
                if distance[i,idx] > model['span']:
                    break
                candidate_lo, candidate_hi = min(lo,train_x[idx]), max(hi,train_x[idx])
                if candidate_hi-candidate_lo > model['span']:
                    continue
                selected.append(idx); lo,hi=candidate_lo,candidate_hi
            eff[i] = len(selected)
            if len(selected) >= 3:
                cover[i] = True
                preds[i] = (sum(train_y[selected]) + model['prior']*mu[i])/(len(selected)+model['prior'])
        return preds, cover, eff
    if kind == 'linear':
        h = max(float(np.std(train_x)), 50)
        w = allowed.astype(float)
        degree = 1
    else:
        degree = model.get('degree', 0)
        if kind == 'adaptive':
            ordered = np.sort(np.where(allowed,distance,np.inf),axis=1)
            kth = ordered[:,min(model['k'],n)-1]
            h = np.minimum(model['cap'],np.maximum(kth*1.01,30))[:,None]
            degree = 1
        else:
            h = model['h']
        if kind == 'gaussian':
            w = np.exp(-.5*(dx/h)**2)*allowed
            w[distance > 3*h] = 0
        else:
            w = np.maximum(0,1-(distance/h)**3)**3*allowed
    s0 = w.sum(axis=1)
    eff = s0*s0/np.maximum((w*w).sum(axis=1),1e-12)
    cover = (eff >= 3) & (s0 >= 1)
    prior = model['prior']
    if not degree:
        pred = ((w @ train_y) + prior*mu) / np.maximum(s0+prior,1e-12)
    else:
        z = dx/h
        s1 = (w*z).sum(axis=1)
        s2 = (w*z*z).sum(axis=1) + 2  # Ridge on local slope, avoids edge blowup.
        t0 = (w @ train_y) + prior*mu
        t1 = ((w*z) @ train_y)
        pred = (t0*s2-s1*t1) / np.maximum((s0+prior)*s2-s1*s1,1e-12)
    return np.where(cover,np.maximum(pred,0),mu), cover, eff


def evaluate(groups, models):
    # Match-level errors are stored for paired comparisons and player bootstrap.
    results = {}
    start = time.monotonic()
    for number, model in enumerate(models):
        values = []
        for g in groups:
            x,y = g['x'],g['y']
            loo, local, eff = predict(x,y,x,model,np.eye(len(x),dtype=bool))
            blocked, bc, be = np.empty(len(x)), np.zeros(len(x),bool), np.empty(len(x))
            for indexes in np.array_split(np.arange(len(x)),3):
                training = np.setdiff1d(np.arange(len(x)),indexes)
                blocked[indexes],bc[indexes],be[indexes] = predict(x[training],y[training],x[indexes],model)
            cut = max(3, int(len(x)*.7))
            forecast,fc,_ = predict(x[:cut],y[:cut],x[cut:],model)
            values.append(dict(player=g['key'][0],key=g['key'], tuning=g['tuning'],
                tier=np.array([r['tier'] for r in g['rows']]),
                discrepancy=np.array([r['coordinate_discrepancy'] for r in g['rows']]),
                loo_error=loo-y,loo_cover=local,blocked_error=blocked-y,blocked_cover=bc,
                forecast_error=forecast-y[cut:],forecast_cover=fc,
                n=len(x)))
        results[model['id']] = values
        if number % 12 == 0:
            print(f"Benchmarked {number+1}/{len(models)} models ({time.monotonic()-start:.1f}s)",flush=True)
    return results


def summarize(values, split='holdout', regime='blocked', tier=None, clean=False):
    selected = [v for v in values if split=='all' or v['tuning']==(split=='tuning')]
    byplayer = collections.defaultdict(list)
    covers, errors, groupmse = [], [], []
    for v in selected:
        er=v[regime+'_error']; cv=v[regime+'_cover']
        mask=np.ones(len(er),bool)
        if regime != 'forecast':
            if tier=='low': mask &= v['tier'] < 24
            if tier=='high': mask &= v['tier'] >= 24
            if clean: mask &= ~v['discrepancy']
        if not mask.any(): continue
        er=er[mask];cv=cv[mask]
        errors.extend(er); covers.extend(cv); groupmse.append(float(np.mean(er**2)))
        byplayer[v['player']].extend(er)
    if not errors:return {}
    errors=np.array(errors)
    return dict(rows=len(errors),players=len(byplayer),rmse=float(np.sqrt(np.mean(errors**2))),
        mae=float(np.mean(np.abs(errors))),coverage=float(np.mean(covers)),
        player_rmse=float(np.sqrt(np.mean([np.mean(np.array(e)**2) for e in byplayer.values()]))),
        group_rmse=float(np.sqrt(np.mean(groupmse))),
        player_mse={p:float(np.mean(np.array(e)**2)) for p,e in byplayer.items()})


def bootstrap_difference(base, alternative, repetitions=3000):
    common=sorted(set(base)&set(alternative))
    a=np.array([base[p] for p in common]);b=np.array([alternative[p] for p in common])
    samples=RNG.integers(0,len(common),(repetitions,len(common)))
    delta=np.sqrt(b[samples].mean(axis=1))-np.sqrt(a[samples].mean(axis=1))
    return dict(player_rmse_difference=float(np.sqrt(b.mean())-np.sqrt(a.mean())),
                ci95=np.percentile(delta,[2.5,97.5]).tolist(),players=len(common))


def display_metrics(groups, models):
    out={}
    for model in models:
        values=[]
        for g in groups:
            x,y=g['x'],g['y']
            grid=np.arange(math.ceil(x.min()/5)*5,x.max()+.1,5)
            if len(grid)<3: continue
            pred,support,eff=predict(x,y,grid,model)
            # Hard estimator joins only its observed centers, with gaps > span.
            if model['kind']=='hard':
                centers=np.unique(x)
                cp,cs,_=predict(x,y,centers,model)
                support=np.zeros(len(grid),bool)
                for i in range(len(centers)-1):
                    if cs[i] and cs[i+1] and centers[i+1]-centers[i]<=model['span']:
                        mask=(grid>=centers[i])&(grid<=centers[i+1])
                        support[mask]=True
                        pred[mask]=np.interp(grid[mask],centers[i:i+2],cp[i:i+2])
            supported=np.flatnonzero(support)
            components=int(np.sum(support & ~np.r_[False,support[:-1]]))
            differences=np.diff(pred)
            triples=support[:-2]&support[1:-1]&support[2:]
            rough=float(np.mean(np.abs(np.diff(pred,2))[triples])) if triples.any() else 0
            # Remove each observation and measure curve perturbation on the
            # SAME grid, recording fallback jumps separately from mean shifts.
            perturbations=[]
            for i in range(len(x)):
                keep=np.arange(len(x))!=i
                deleted,ds,_=predict(x[keep],y[keep],grid,model)
                comparable=support & ds
                if comparable.any():perturbations.append(float(np.mean(np.abs(deleted[comparable]-pred[comparable]))))
            values.append(dict(player=g['key'][0],coverage=float(np.mean(support)),components=components,
                roughness=rough,perturbation=float(np.mean(perturbations)) if perturbations else None,
                span=float(x.max()-x.min()),group_n=len(x)))
        good=[v['perturbation'] for v in values if v['perturbation'] is not None]
        out[model['id']]=dict(groups=len(values),median_grid_coverage=float(np.median([v['coverage'] for v in values])),
            mean_grid_coverage=float(np.mean([v['coverage'] for v in values])),
            fragmented_fraction=float(np.mean([v['components']>1 for v in values])),
            median_components=float(np.median([v['components'] for v in values])),
            mean_roughness=float(np.mean([v['roughness'] for v in values])),
            mean_delete_one_change=float(np.mean(good)) if good else None)
    return out


def main():
    rows,groups,corpus=build_corpus()
    print(json.dumps(corpus['audit'],indent=2),flush=True)
    models=configurations()
    results=evaluate(groups,models)
    table=[]
    for model in models:
        record={'model':model}
        for split in ['tuning','holdout','all']:
            for regime in ['loo','blocked','forecast']:
                record[f'{split}_{regime}']=summarize(results[model['id']],split,regime)
        for tier in ['low','high']:
            record[f'holdout_blocked_{tier}']=summarize(results[model['id']],'holdout','blocked',tier)
        record['holdout_blocked_clean']=summarize(results[model['id']],'holdout','blocked',clean=True)
        table.append(record)
    ranked=sorted(table,key=lambda r:r['tuning_blocked']['player_rmse'])
    print('Tuning ranking:',[(r['model']['id'],round(r['tuning_blocked']['player_rmse'],4)) for r in ranked[:12]],flush=True)
    baseline=next(r for r in table if r['model']['id']=='hard_s30_k5_p8')
    best=ranked[0]
    selected_ids=list(dict.fromkeys(['act_mean','act_linear','hard_s30_k5_p8','hard_s40_k5_p8',best['model']['id']]+[r['model']['id'] for r in ranked[:5]]))
    selected=[m for m in models if m['id'] in selected_ids]
    # Display behavior is evaluated on held-out players with >= 10 outcomes.
    display=display_metrics([g for g in groups if not g['tuning'] and len(g['x'])>=10],selected)
    comparisons={r['model']['id']:bootstrap_difference(baseline['holdout_blocked']['player_mse'],r['holdout_blocked']['player_mse']) for r in table if r['model']['id'] in selected_ids}
    clean_table=[]
    for r in table:
        copy=dict(r)
        for key,value in copy.items():
            if isinstance(value,dict) and 'player_mse' in value:
                copy[key]={k:v for k,v in value.items() if k!='player_mse'}
        clean_table.append(copy)
    report=dict(corpus=corpus,models=clean_table,selected_ids=selected_ids,tuning_winner=best['model']['id'],
        comparisons=comparisons,display=display)
    (OUT/'results.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
    (OUT/'model-definitions.json').write_text(json.dumps(models,indent=2),encoding='utf-8')
    # Export candidate curves for a reviewable corpus explorer and sxllow detail.
    examples=[]
    example_players=list(dict.fromkeys(['sxllow#vapo']+[g['key'][0] for g in sorted(groups,key=lambda g:len(g['x']),reverse=True)[:30]]))
    for player in example_players:
        for g in groups:
            if g['key'][0]!=player:continue
            x,y=g['x'],g['y'];grid=np.arange(x.min(),x.max()+1,5)
            curves={}
            for model in selected:
                if model['kind']=='hard': gx=np.unique(x)
                else: gx=grid
                p,s,e=predict(x,y,gx,model)
                curves[model['id']]=[dict(x=float(xx),y=float(yy),supported=bool(ss),effective_n=float(ee)) for xx,yy,ss,ee in zip(gx,p,s,e)]
            examples.append(dict(name=g['rows'][0]['name'],season=g['key'][1],won=g['key'][2],
                points=[dict(x=r['x'],y=r['y'],date=r['date'],tier=r['tier']) for r in g['rows']],curves=curves))
    (OUT/'examples.json').write_text(json.dumps(examples,ensure_ascii=False),encoding='utf-8')
    print('Holdout winner:',best['model']['id'],{k:v for k,v in best['holdout_blocked'].items() if k!='player_mse'},flush=True)


if __name__=='__main__':
    main()
