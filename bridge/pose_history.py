"""Bounded capture-time SDK pose history, independent of Olympe and the radio."""
from collections import deque
import math
import threading


class PoseHistory:
    def __init__(self, seconds=3.):
        self.seconds=seconds
        self.samples={name:deque() for name in ('altitude','attitude','camera','speed')}
        self.lock=threading.Lock()

    def record(self, name, at, values):
        if name not in self.samples or not math.isfinite(at):return
        values={k:float(v) for k,v in values.items()
                if isinstance(v,(float,int)) and not isinstance(v,bool) and math.isfinite(v)}
        with self.lock:
            series=self.samples[name]
            if series and at<=series[-1][0]:return
            series.append((at,values))
            while series and series[0][0]<at-self.seconds:series.popleft()

    def snapshot_at(self, at, max_skew=.15):
        """Interpolate bounded brackets; never stamp a cache read as fresh.

        These are local receipt timestamps, so transport latency remains a
        measurement limitation. Snapshot diagnostics retain both endpoints.
        """
        result={};times={}
        with self.lock:
            for name in ('altitude','attitude','camera'):
                series=list(self.samples[name])
                if not series:raise ValueError('No capture-time '+name+' history')
                before=next((s for s in reversed(series) if s[0]<=at),None)
                after=next((s for s in series if s[0]>=at),None)
                if before and after and at-before[0]<=max_skew and after[0]-at<=max_skew:
                    span=after[0]-before[0];fraction=0 if span==0 else (at-before[0])/span
                    values={}
                    for key in before[1].keys() & after[1].keys():
                        start=before[1][key];delta=after[1][key]-start
                        if name=='attitude':delta=(delta+math.pi)%(2*math.pi)-math.pi
                        elif name=='camera' and key.endswith('_absolute'):delta=(delta+180)%360-180
                        values[key]=start+fraction*delta
                    times[name]=[before[0],after[0]]
                else:
                    nearest=min(series,key=lambda s:abs(s[0]-at))
                    if abs(nearest[0]-at)>max_skew:raise ValueError('Fire frame and '+name+' history are not synchronized')
                    values=dict(nearest[1]);times[name]=[nearest[0]]
                result[name]=values
        result['sample_times']=times
        return result
