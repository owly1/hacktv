"""Estimate a QR's physical size from independently measured vertical travel.

No aircraft commands are issued here. Camera intrinsics/profile, synchronized
attitude and altitude, correct QR identity, and a stationary marker are required
inputs. This fit cannot distinguish a changing zoom or a marker moving in exact
proportion to the aircraft's climb from a different physical marker size.
"""
from dataclasses import dataclass
import math


@dataclass(frozen=True)
class QRScaleFit:
    side_m: float
    anchor_down_m: float
    residual_m: float
    uncertainty_fraction: float
    baseline_m: float
    samples: int
    inliers: int
    # Empirical worst residual amongst accepted observations, in metres. This
    # is separate from RMS so downstream motion cannot mistake a rough fit for
    # centimetre precision.
    max_error_m: float = 0.


def _line(points):
    n=len(points)
    mx=sum(x for x,y in points)/n;my=sum(y for x,y in points)/n
    sxx=sum((x-mx)**2 for x,y in points)
    if sxx<=1e-12:return None
    slope=sum((x-mx)*(y-my) for x,y in points)/sxx
    intercept=my-slope*mx
    errors=[y-slope*x-intercept for x,y in points]
    return slope,intercept,errors,sxx


class AdaptiveQRScale:
    """A bounded deterministic robust fit; no guessed ruler correction.

    ``unit_down`` is the QR camera-to-centre translation's vertical component
    after rotation into world down, divided by the side used by PnP. It must
    exclude the camera-to-body origin offset. ``origin_down`` is that known
    offset rotated into world down. ``altitude`` is metres above takeoff.

        altitude - origin_down = side_m * unit_down - anchor_down_m

    ``observe`` returns a fit only after enough independent vertical travel and
    repeated observations at both ends. Callers must keep flight horizontal
    movement disabled until a fit is accepted, then freeze the result for that
    flight and retain independent consistency checks. Repeated camera frames
    must retain their original ``at``; replayed timestamps are ignored.
    """
    def __init__(self, *, min_baseline=.5, max_residual=None, max_samples=96,
                 rough=False):
        self.min_baseline=min_baseline
        self.max_residual=(.20 if rough else .05) if max_residual is None else max_residual
        self.rough=rough
        self.max_uncertainty=.25 if rough else .10
        self.max_samples=max_samples;self.samples=[]
        self.reason='Waiting for QR observations at different measured heights'
        self.fit=None

    def observe(self, unit_down, altitude, origin_down=0., *, at):
        values=(unit_down,altitude,origin_down,at)
        if not all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) for v in values):
            self.reason='QR scale inputs must be finite measurements';self.fit=None;return None
        if abs(unit_down)>1000 or abs(altitude)>100 or abs(origin_down)>.3:
            self.reason='QR scale inputs exceed the calibrated local geometry';self.fit=None;return None
        if self.samples and at<=self.samples[-1][0]:
            return self.fit
        self.samples.append((float(at),float(unit_down),float(altitude),float(origin_down)))
        # Preserve the first ground observations if an acquisition takes time.
        if len(self.samples)>self.max_samples:del self.samples[3]
        self.fit=self._estimate()
        return self.fit

    def _estimate(self):
        rows=self.samples;n=len(rows)
        if n<6:
            self.reason='Need at least six fresh QR scale observations';return None
        low=min(r[2] for r in rows);high=max(r[2] for r in rows)
        if high-low<self.min_baseline:
            self.reason='Need at least 0.5 m of measured vertical travel';return None
        points=[(r[1],r[2]-r[3]) for r in rows]
        # Pair hypotheses span independent metric altitude, avoiding ill-
        # conditioned fits through almost identical hovering observations.
        candidates=[]
        # Bound the CPU cost independently of the observation window: at most
        # 16 altitude-spread endpoints make 120 hypotheses, while every sample
        # still participates in consensus and the final fit.
        ordered=sorted(range(n),key=lambda k:(rows[k][2],rows[k][0]))
        endpoints=(ordered if n<=16 else
                   [ordered[round(i*(n-1)/15)] for i in range(16)])
        for a,i in enumerate(endpoints):
            for j in endpoints[a+1:]:
                if abs(rows[j][2]-rows[i][2])<self.min_baseline/2:continue
                dx=points[j][0]-points[i][0]
                if abs(dx)<1e-9:continue
                slope=(points[j][1]-points[i][1])/dx
                if not .03<=slope<=.6:continue
                intercept=points[i][1]-slope*points[i][0]
                keep=[k for k,(x,y) in enumerate(points) if abs(y-slope*x-intercept)<=self.max_residual]
                if len(keep)<6:continue
                fit=_line([points[k] for k in keep])
                if fit is None:continue
                slope,intercept,errors,sxx=fit
                candidates.append((len(keep),-sum(e*e for e in errors),keep,fit))
        if not candidates:
            self.reason='QR perspective does not agree with measured vertical travel';return None
        _,_,keep,fit=max(candidates,key=lambda c:c[:2])
        slope,intercept,errors,sxx=fit
        if len(keep)<math.ceil(.8*n) or not .03<=slope<=.6 or max(abs(e) for e in errors)>self.max_residual:
            self.reason='Too many inconsistent QR scale observations';return None
        selected=[rows[k] for k in keep]
        selected_low=min(r[2] for r in selected);selected_high=max(r[2] for r in selected)
        # Three independent frames at each end are required after outlier
        # rejection; a single spurious altitude cannot create the baseline.
        if (selected_high-selected_low<self.min_baseline
                or sum(r[2]<=selected_low+.10 for r in selected)<3
                or sum(r[2]>=selected_high-.10 for r in selected)<3):
            self.reason='Need three consistent observations at both measured heights';return None
        if self.rough:
            # Distinct timestamps alone can be a burst of almost identical
            # observations. Require an actual observation interval at both
            # measured ends, without selecting a convenient slice of history.
            for end in ([r for r in selected if r[2]<=selected_low+.10],
                        [r for r in selected if r[2]>=selected_high-.10]):
                if max(r[0] for r in end)-min(r[0] for r in end)<.30:
                    self.reason='Need sustained QR observations at both measured heights';return None
        rms=math.sqrt(sum(e*e for e in errors)/len(errors))
        standard_error=math.sqrt(sum(e*e for e in errors)/max(1,len(errors)-2)/sxx)
        # Refit without each observation: a sample that dominates the estimate
        # must not establish a trusted physical scale on its own.
        variations=[]
        for omitted in keep:
            alternative=_line([points[k] for k in keep if k!=omitted])
            if alternative is None:
                self.reason='QR scale is poorly conditioned';return None
            variations.append(abs(alternative[0]/slope-1))
        uncertainty=max(2*standard_error/slope,max(variations))
        max_error=max(abs(e) for e in errors)
        if self.rough:
            # More frames reduce statistical standard error, but do not remove
            # systematic disagreement caused by pose/altitude errors. Preserve
            # that disagreement in the scale uncertainty used by the caller.
            uncertainty=max(uncertainty,max_error/(selected_high-selected_low))
        if uncertainty>self.max_uncertainty:
            self.reason=('QR scale uncertainty exceeds twenty-five percent' if self.rough
                         else 'QR scale uncertainty exceeds ten percent');return None
        self.reason=('Approximate QR scale fits measured travel within the bounded error budget'
                     if self.rough else 'QR scale agrees with independently measured vertical travel')
        return QRScaleFit(slope,-intercept,rms,uncertainty,selected_high-selected_low,n,len(keep),max_error)
