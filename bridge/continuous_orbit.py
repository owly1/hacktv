"""Measured, continuous orbit control. No SDK, radio, or flight authorization.

The adapter owns bounded piloting leases and acknowledged settings. This
controller owns velocity/height feedback and capture-time target correction;
its caller still enforces LAND, presence, battery, attitude and flight limits.
"""
from collections import deque
from dataclasses import dataclass, replace
import math
import time


MAX_TILT_DEG = 10.
MAX_YAW_DEG_S = 60.
MAX_VERTICAL_MPS = .3
PERIOD = .05


@dataclass(frozen=True)
class Motion:
    at: float
    yaw_rad: float
    vx: float
    vy: float
    vz: float  # SDK north/east/down velocity, metres/second.
    altitude: float
    velocity_at: float | None = None  # Receipt time of SpeedChanged specifically.


@dataclass(frozen=True)
class Control:
    roll: int = 0
    pitch: int = 0
    yaw: int = 0
    gaz: int = 0


def clamp(value, low, high):
    return max(low, min(high, value))


def wrap(angle):
    return math.atan2(math.sin(angle), math.cos(angle))


def bounded(x, y, maximum):
    scale = min(1., maximum / max(1e-9, math.hypot(x, y)))
    return x * scale, y * scale


def _capture_pose(history, at):
    if not history or at < history[0][0] or at > history[-1][0]:
        return None
    for first, second in zip(history, list(history)[1:]):
        if first[0] <= at <= second[0]:
            fraction = (at-first[0]) / max(1e-9, second[0]-first[0])
            return (first[1]+fraction*(second[1]-first[1]),
                    first[2]+fraction*(second[2]-first[2]),
                    first[3]+fraction*wrap(second[3]-first[3]),
                    first[4]+fraction*(second[4]-first[4]))
    return history[-1][1:]


def _coherent_correction(samples):
    """A moving drift residual is not a stationary-location outlier.

    Use elapsed time rather than a fixed frame count so 5/10/30 Hz cameras
    all get a chance to confirm a returned target after a visual gap.
    """
    if len(samples)<3 or samples[-1][0]-samples[0][0]<.35:
        return False
    means = tuple(sum(row[i] for row in samples)/len(samples) for i in range(4))
    variance = sum((row[0]-means[0])**2 for row in samples)
    slopes = tuple(sum((row[0]-means[0])*(row[i]-means[i]) for row in samples)/variance
                   for i in range(1,4))
    residual = max(math.hypot(row[1]-means[1]-slopes[0]*(row[0]-means[0]),
                              row[2]-means[2]-slopes[1]*(row[0]-means[0])) for row in samples)
    return (residual<.10 and math.hypot(*slopes[:2])<1.25
            and (slopes[2]>.15 or samples[-1][0]-samples[0][0]>=.9))


def run_continuous_orbit(target, limits, check, motion, command, report,
                         remember=None, diagnostic=None,
                         clock=time.monotonic, sleep=time.sleep):
    """Orbit a fixed 3D point; correct drift inward before resuming a lap.

    Received velocity propagates aircraft position between visual sightings.
    Later sightings correct that position, never move the locked fire centre.
    Translation around that point plus inward yaw/pitch defines the cone.
    """
    diagnostic = diagnostic or (lambda *args: None)
    if limits.lap_seconds != 15 or not .1 <= limits.speed_mps <= .6:
        raise ValueError('Continuous orbit requires the bounded 15-second profile')
    started = previous_time = clock()
    previous_motion = velocity_sample = None
    measured_ax = measured_ay = 0.
    x = y = 0.
    centre = None
    history = deque()
    visual_ranges = deque()
    observed_at = float('-inf')
    visual_outward = 0.
    visual_at = float('-inf')
    integral_x = integral_y = 0.
    swept = phase_elapsed = 0.
    lap = 0
    lap_started = started
    reported_at = status_at = float('-inf')
    progress_time = started
    progress_angle = 0.
    recovering = False
    recovery_started = settled_since = None
    recovery_progress_at = None
    recovery_error_checkpoint = recovery_motion_checkpoint = recovery_motion_progress = 0.
    initial_approach_available = True
    initial_approach_active = False
    startup_wait_reported = False
    rejected = deque()
    # Scheduling never demands a burst of speed after radial recovery.
    scheduled_seconds = 14.
    try:
        while True:
            _, observed = check()
            state = motion()
            # A callback arriving during the cache read is not a future sample.
            now = clock()
            dt = now-previous_time
            values = (state.at, state.yaw_rad, state.vx, state.vy, state.vz, state.altitude)
            if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values):
                raise InterruptedError('Continuous orbit requires finite measured motion')
            if not 0 <= now-state.at <= .6 or not 0 <= dt <= .3:
                raise InterruptedError('Continuous orbit motion or control loop is stale')
            if math.hypot(state.vx, state.vy) > .75 or abs(state.altitude-limits.height_m) > .2:
                raise InterruptedError('Continuous orbit exceeded the speed or height envelope')
            velocity_at = state.at if state.velocity_at is None else state.velocity_at
            if not isinstance(velocity_at,(int,float)) or not math.isfinite(velocity_at) or not 0 <= now-velocity_at <= .6:
                raise InterruptedError('Continuous orbit velocity sample is stale')
            if velocity_sample is not None and velocity_at > velocity_sample[0]:
                span = velocity_at-velocity_sample[0]
                if .02 <= span <= .6:
                    measured_ax, measured_ay = bounded((state.vx-velocity_sample[1])/span,
                                                        (state.vy-velocity_sample[2])/span, 1.2)
            if velocity_sample is None or velocity_at > velocity_sample[0]:
                velocity_sample = (velocity_at,state.vx,state.vy)
            old_x, old_y = x, y
            if previous_motion is not None:
                x += .5*(previous_motion.vx+state.vx)*dt
                y += .5*(previous_motion.vy+state.vy)*dt
            c, s = math.cos(state.yaw_rad), math.sin(state.yaw_rad)
            history.append((now, x, y, state.yaw_rad, state.altitude))
            while history and history[0][0] < now-2:
                history.popleft()

            fresh = (observed is not None and observed.episode == target.episode
                     and not getattr(observed,'position_source','').endswith('propagated-fire')
                     and observed_at < observed.at <= now and now-observed.at <= .8
                     and all(math.isfinite(v) for v in (observed.forward_m, observed.right_m, observed.down_m))
                     and .25 <= math.hypot(observed.forward_m, observed.right_m) <= 3
                     and -.15 <= observed.down_m <= 4)
            if centre is None:
                # A stale displacement-propagated handoff previously consumed
                # almost the entire correction allowance before orbit began.
                # Lock a freshly measured location while the aircraft is still.
                if not fresh or math.hypot(state.vx,state.vy) > .12:
                    command(Control())
                    if not startup_wait_reported:
                        report('recover', 'Waiting for fresh measured fire location and settled aircraft',
                               None, limits.segments)
                        startup_wait_reported = True
                    previous_motion, previous_time = state, now
                    sleep(max(0., PERIOD-(clock()-now)))
                    continue
                centre = (x+c*observed.forward_m-s*observed.right_m,
                          y+s*observed.forward_m+c*observed.right_m,
                          observed.down_m-state.altitude)
                target = observed
                started = lap_started = progress_time = now
                diagnostic('continuous_orbit_started', {'lap_seconds':limits.lap_seconds,
                    'radius_m':limits.radius_m, 'control_hz':1/PERIOD,
                    'fixed_centre_m':list(centre), 'initial_visual_at_mono':observed.at})

            if fresh:
                observed_at = observed.at
                captured = _capture_pose(history, observed.at)
                if captured is not None:
                    px, py, yaw, height = captured
                    cc, ss = math.cos(yaw), math.sin(yaw)
                    measured_rx = cc*observed.forward_m-ss*observed.right_m
                    measured_ry = ss*observed.forward_m+cc*observed.right_m
                    # Correct the estimated aircraft, not the stationary fire.
                    # There is deliberately no cumulative 30 cm clamp: that
                    # clamp silently discarded the real outward spiral.
                    dx, dy = centre[0]-px-measured_rx, centre[1]-py-measured_ry
                    innovation = math.hypot(dx,dy)
                    coherent = innovation <= .6
                    if not coherent:
                        rejected.append((observed.at,dx,dy,math.hypot(measured_rx,measured_ry)))
                        while rejected and observed.at-rejected[0][0]>1.2:
                            rejected.popleft()
                        coherent = _coherent_correction(rejected)
                        if not coherent:
                            diagnostic('continuous_target_rejected', {'age_s':now-observed.at,
                                'innovation_m':innovation, 'reason':'awaiting coherent location correction'})
                    if coherent:
                        rejected.clear()
                        dx, dy = bounded(.25*dx,.25*dy,.3)
                        x += dx; y += dy
                        old_x += dx; old_y += dy
                        # Correct the whole recent trajectory by the same
                        # offset, preserving measured motion and capture lag.
                        history = deque((at,hx+dx,hy+dy,hyaw,h) for at,hx,hy,hyaw,h in history)
                        target = observed
                        visual_at = observed.at
                        visual_ranges.append((observed.at,math.hypot(measured_rx,measured_ry)))
                        while visual_ranges and observed.at-visual_ranges[0][0] > .7:
                            visual_ranges.popleft()
                        if len(visual_ranges)>=3 and visual_ranges[-1][0]-visual_ranges[0][0]>=.3:
                            first,last = visual_ranges[0],visual_ranges[-1]
                            visual_outward = (last[1]-first[1])/(last[0]-first[0])
                        diagnostic('continuous_target_corrected', {'captured_at_mono':observed.at,
                            'age_s':now-observed.at, 'centre_m':list(centre),
                            'aircraft_correction_m':[dx,dy], 'innovation_m':innovation,
                            'visual_radius_m':visual_ranges[-1][1], 'visual_outward_mps':visual_outward})

            rx, ry = centre[0]-x, centre[1]-y
            radius = math.hypot(rx, ry)
            if radius < .1:
                raise InterruptedError('Orbit centre geometry is singular')
            # Centre/position corrections cannot manufacture measured laps.
            if previous_motion is not None:
                turn = wrap(math.atan2(y-centre[1], x-centre[0])-
                            math.atan2(old_y-centre[1], old_x-centre[0]))
                before = swept
                swept = max(0., swept+turn)
                while swept >= (lap+1)*2*math.pi:
                    fraction = clamp(((lap+1)*2*math.pi-before)/max(1e-9, turn), 0., 1.)
                    crossed = previous_time+dt*fraction
                    lap += 1
                    diagnostic('orbit_lap_completed', {'lap':lap,'duration_s':crossed-lap_started,
                        'elapsed_s':crossed-started,'measured_sweep_deg':math.degrees(swept)})
                    lap_started = crossed
                    report('circle', f'Tracking fire · lap {lap+1}', 1, limits.segments)

            ex, ey = rx/radius, ry/radius
            bearing = wrap(math.atan2(ry, rx)-state.yaw_rad)
            lead = min(.25, now-velocity_at)
            feedback_x = state.vx+measured_ax*lead
            feedback_y = state.vy+measured_ay*lead
            inward_speed = feedback_x*ex+feedback_y*ey
            outward = max(0.,-inward_speed)
            if now-visual_at <= .8 and not (initial_approach_active and radius < limits.radius_m):
                outward = max(outward,visual_outward)
                # Optical range change independently catches under-reported
                # outward divergence beyond the ring. Inside the ring the
                # outward approach is intentional; its delayed optical rate
                # must not override newer measured braking or delay settling.
                if recovering and visual_outward > .15 and visual_outward > -inward_speed:
                    correction = -visual_outward-inward_speed
                    feedback_x += correction*ex
                    feedback_y += correction*ey
            error = radius-limits.radius_m
            predicted_radius = radius+outward*.6
            needs_correction = abs(error) > .15 or (outward > .18 and predicted_radius > limits.radius_m+.18)
            if needs_correction and not recovering:
                recovering = True
                recovery_started = now
                initial_approach_active = initial_approach_available
                recovery_progress_at = now
                recovery_error_checkpoint = abs(error)
                recovery_motion_checkpoint = recovery_motion_progress = 0.
                initial_approach_available = False
                settled_since = None
                integral_x = integral_y = 0.
                diagnostic('orbit_radial_recovery_started', {'radius_m':radius,
                    'outward_mps':outward, 'predicted_radius_m':predicted_radius,
                    'no_progress_limit_s':5., 'minimum_progress_m':.04,
                    'elapsed_s':now-started})
                report('circle','Correcting radius toward the fixed fire location',None,limits.segments)
            if recovering:
                # Visual corrections shift old and current position together.
                # Their jumps therefore cannot count as physical radial travel.
                previous_error = abs(math.hypot(centre[0]-old_x,centre[1]-old_y)-limits.radius_m)
                recovery_motion_progress += previous_error-abs(error)
                measured_progress = recovery_motion_progress-recovery_motion_checkpoint
                geometric_progress = recovery_error_checkpoint-abs(error)
                if measured_progress >= .04 and geometric_progress >= .04:
                    recovery_progress_at = now
                    recovery_motion_checkpoint = recovery_motion_progress
                    recovery_error_checkpoint = abs(error)
                    diagnostic('orbit_radial_recovery_progress', {'radius_m':radius,
                        'duration_s':now-recovery_started,
                        'measured_radial_progress_m':measured_progress,
                        'radius_error_reduction_m':geometric_progress})
                # Translation toward the ring gets priority over lateral orbit.
                # Give it a real attempt; no new radius-triggered instant stop.
                if abs(error) < .09 and outward < .10 and abs(inward_speed) < .15:
                    if settled_since is None:settled_since = now
                    if now-settled_since >= .3:
                        initial_dwell = min(.3, now-settled_since) if initial_approach_active else 0.
                        recovering = False
                        initial_approach_active = False
                        integral_x = integral_y = 0.
                        # The initial stable on-ring dwell is already part of
                        # the first lap's clock. Later recovery never catches up.
                        phase_elapsed = swept*scheduled_seconds/(2*math.pi)+initial_dwell
                        progress_time,progress_angle = now,swept
                        if lap==0 and swept<math.radians(5):
                            # Initial radial alignment precedes the first lap.
                            lap_started = settled_since if initial_dwell else now
                        diagnostic('orbit_radial_recovery_completed', {'radius_m':radius,
                            'duration_s':now-recovery_started})
                else:settled_since = None
                # A slow converging approach can continue within caller flight
                # limits. Stop only when a corrective attempt makes no confirmed
                # geometric AND measured-motion progress for five seconds.
                if recovering and now-recovery_progress_at >= 5:
                    raise InterruptedError('Radius correction stalled without confirmed inward/outward progress')
            if not recovering:
                # Keep the requested lap pace, but slower real motion is not a
                # stall. Only measured angular travel renews this checkpoint.
                if swept-progress_angle >= math.radians(2.5):
                    progress_time, progress_angle = now, swept
                if now-progress_time >= 5:
                    raise InterruptedError('Continuous orbit made insufficient measured progress')
            if recovering:
                tangent = 0.
                radial = clamp(.9*error,-.2,.2)
                # The velocity feedback brakes outward momentum. Do not also
                # demand a large inward speed: delayed vision made that extra
                # impulse overshoot the ring during correction.
                # Inside the ring, outward motion is the intended approach.
                # The signed radial setpoint slows it toward zero at the ring;
                # velocity feedback already brakes outward divergence beyond it.
            else:
                phase_elapsed += dt
                phase_error = 2*math.pi*phase_elapsed/scheduled_seconds-swept
                tangent = clamp(limits.radius_m*(2*math.pi/scheduled_seconds+.3*phase_error),
                                .1,limits.speed_mps)
                tangent *= max(0.,math.cos(min(abs(bearing)*2,math.pi/2)))
                radial = clamp(1.8*error,-.25,.3)
            if tangent > 1e-6:
                initial_approach_available = False
            desired_x, desired_y = bounded(radial*ex+tangent*ey,
                                            radial*ey-tangent*ex, limits.speed_mps)
            error_x, error_y = desired_x-feedback_x, desired_y-feedback_y
            integral_x, integral_y = bounded(integral_x+error_x*dt, integral_y+error_y*dt, .4)
            actual_tangent = feedback_x*ey-feedback_y*ex
            centripetal = actual_tangent*actual_tangent/radius
            ax = 2.4*error_x+.6*integral_x+centripetal*ex
            ay = 2.4*error_y+.6*integral_y+centripetal*ey
            ax, ay = bounded(ax, ay, 1. if recovering else .8)
            forward, right = c*ax+s*ay, -s*ax+c*ay
            pitch = math.degrees(math.atan2(forward, 9.81))/MAX_TILT_DEG*100
            roll = math.degrees(math.atan2(right, 9.81))/MAX_TILT_DEG*100
            actual_omega = (ry*state.vx-rx*state.vy)/(radius*radius)
            yaw_rate = math.degrees(actual_omega+2.5*bearing)
            up = clamp(1.5*(limits.height_m-state.altitude)+.4*state.vz,
                       -MAX_VERTICAL_MPS, MAX_VERTICAL_MPS)
            output = Control(round(clamp(roll,-100,100)), round(clamp(pitch,-100,100)),
                             round(clamp(yaw_rate/MAX_YAW_DEG_S*100,-75,75)),
                             round(up/MAX_VERTICAL_MPS*100))
            current = replace(target, forward_m=c*rx+s*ry, right_m=-s*rx+c*ry,
                              down_m=centre[2]+state.altitude,position_source='velocity-propagated-fire')
            if remember is not None:remember(current)
            command(output)
            if now-status_at >= 1:
                status_at = now
                report('circle', 'Correcting radius toward fire' if recovering else f'Tracking fire · lap {lap+1}',
                       int((swept%(2*math.pi))/(2*math.pi)*limits.segments)+1, limits.segments)
            if now-reported_at >= .2:
                reported_at = now
                diagnostic('continuous_orbit', {'radius_m':radius,'altitude_m':state.altitude,
                    'sweep_deg':math.degrees(swept),'lap':lap+1,'elapsed_s':now-started,
                    'desired_speed_mps':math.hypot(desired_x,desired_y),
                    'actual_speed_mps':math.hypot(state.vx,state.vy),
                    'outward_mps':outward,'recovering_radius':recovering,
                    'recovery_no_progress_s':now-recovery_progress_at if recovering else None,
                    'recovery_measured_progress_m':recovery_motion_progress if recovering else None,
                    'desired_radial_mps':radial,'desired_tangent_mps':tangent,
                    'fixed_centre_m':list(centre),'position_m':[x,y],
                    'heading_error_deg':math.degrees(bearing), 'command':vars(output)})
            previous_motion, previous_time = state, now
            sleep(max(0., PERIOD-(clock()-now)))
    finally:
        command(Control())
