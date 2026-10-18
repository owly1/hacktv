/* Placeholder data for the BOSCO Dashboard. Every incident value, drone,
   lead and log entry the Dashboard shows comes from here; components never
   embed these literals. Records are shaped like API payloads (numbers with
   units in the field name, ISO-free display times kept as given) so a real
   feed can replace window.BoscoFixtures without touching the rendering code.

   Conventions (matching the emberwatch.v1 contract): angles are degrees
   clockwise from north; wind direction points *toward*; altitude is height
   above takeoff. Map coordinates are positions on the illustrative 1000×600
   terrain drawing, not measured GPS. */
(function () {
  'use strict';

  window.BoscoFixtures = Object.freeze({
    incident: {
      id: 'horse-river-2016',
      name: 'Horse River (Fort McMurray)',
      region: 'Alberta, Canada',
      subtitle: 'Alberta, Canada · historical replay · boreal forest fuels',
      kicker: 'Historical incident · Fleet',
      bannerLabel: 'FLEET · HORSE RIVER (FORT MCMURRAY)',
      patrolCaption: 'Fleet perimeter patrol and outlined fire area',
      fireDetected: true,
    },

    conditions: {
      windSpeedKmh: 40,
      windTowardLabel: 'NE',
      windTowardDeg: 45,
      detectionConfidencePct: 96,
    },

    // Fire area projection: area(ha) = baseAreaHa × k², k = 1 + minute/60 × growthPerHour.
    spread: {
      baseAreaHa: 9.6,
      growthPerHour: 0.9,
      horizonMin: 60,
      ignition: { x: 380, y: 300 },
      outlineRotateDeg: -35,
    },

    // Per-minute decay used to project each lead's fire ETA and distance along the timeline.
    leadProjection: { etaMinPerMinute: 0.4, distanceMPerMinute: 12, minEtaMin: 1, minDistanceM: 50 },

    connections: [
      { id: 'anafi', label: 'ANAFI', connected: true },
      { id: 'tigerdata', label: 'TigerData', connected: false },
    ],

    // Fleet. `map` is the marker position and camera-cone rotation on the terrain drawing;
    // `feed` holds the placeholder camera thumbnail shapes (160×78 and 400×220 boxes).
    drones: [
      { id: 'ANAFI-01', state: 'Searching perimeter', altitudeM: 36.0, groundSpeedMs: 4.2, batteryPct: 76, headingDeg: 283, cameraTiltDeg: -45, fireEdgeM: 1000, peopleSpotted: 2,
        map: { x: 300, y: 370, coneDeg: -20 },
        feed: { tone: 1, ridge: 'M0 52 L30 40 L60 48 L95 34 L130 44 L160 38 L160 78 L0 78Z', burn: 'M70 58 C80 50 96 50 104 56 C100 62 82 64 70 58Z', burnLarge: 'M160 150 C190 128 236 128 258 144 C246 160 196 164 160 150Z' } },
      { id: 'ANAFI-02', state: 'Observing', altitudeM: 48.5, groundSpeedMs: 2.1, batteryPct: 81, headingDeg: 214, cameraTiltDeg: -45, fireEdgeM: 640, peopleSpotted: 2,
        map: { x: 640, y: 240, coneDeg: 160 },
        feed: { tone: 2, ridge: 'M0 46 L40 30 L80 42 L120 26 L160 36 L160 78 L0 78Z', burn: 'M40 44 C70 34 110 36 130 42 C110 50 70 52 40 44Z', burnLarge: 'M90 130 C170 96 290 104 340 122 C290 146 170 150 90 130Z' } },
      { id: 'ANAFI-03', state: 'Observing', altitudeM: 52.0, groundSpeedMs: 1.8, batteryPct: 69, headingDeg: 305, cameraTiltDeg: -45, fireEdgeM: 820, peopleSpotted: 1,
        map: { x: 560, y: 420, coneDeg: 220 },
        feed: { tone: 3, ridge: 'M0 56 L35 46 L70 52 L110 40 L160 50 L160 78 L0 78Z', burn: 'M60 60 C76 54 92 56 100 60 C90 64 72 64 60 60Z', burnLarge: 'M160 150 C190 128 236 128 258 144 C246 160 196 164 160 150Z' } },
      { id: 'ANAFI-04', state: 'Returning to launch', altitudeM: 40.2, groundSpeedMs: 6.5, batteryPct: 34, headingDeg: 48, cameraTiltDeg: -45, fireEdgeM: 1450, peopleSpotted: 2,
        map: { x: 830, y: 120, coneDeg: 200 },
        feed: { tone: 4, ridge: 'M0 40 L50 50 L90 36 L130 46 L160 32 L160 78 L0 78Z', burn: 'M120 50 C130 46 140 47 146 50 C140 53 128 54 120 50Z', burnLarge: 'M160 150 C190 128 236 128 258 144 C246 160 196 164 160 150Z' } },
    ],

    // Rescue leads. kind: 'possible' (POSSIBLE PERSON) or 'candidate' (NEEDS ANOTHER ANGLE).
    leads: [
      { id: 1, kind: 'possible',  lat: 56.62398, lon: -111.37620, accuracyM: 4, lastSeen: '3:47:33 AM', sightings: 11, angles: 3, angleSeparationDeg: 60, sourceDrones: ['ANAFI-01'], movement: 'Person at a fixed location',   fireEtaMin: 15, fireDistanceM: 1026, bearingDeg: 132, map: { x: 300, y: 330 } },
      { id: 2, kind: 'candidate', lat: 56.62815, lon: -111.37104, accuracyM: 5, lastSeen: '3:47:21 AM', sightings: 7,  angles: 2, angleSeparationDeg: 45, sourceDrones: ['ANAFI-01'], movement: 'Person at a fixed location',   fireEtaMin: 22, fireDistanceM: 1310, bearingDeg: 154, map: { x: 345, y: 255 } },
      { id: 3, kind: 'candidate', lat: 56.63044, lon: -111.35880, accuracyM: 5, lastSeen: '3:46:58 AM', sightings: 6,  angles: 2, angleSeparationDeg: 40, sourceDrones: ['ANAFI-02'], movement: 'Person moving slowly',         fireEtaMin: 28, fireDistanceM: 1580, bearingDeg: 218, map: { x: 560, y: 205 } },
      { id: 4, kind: 'possible',  lat: 56.62671, lon: -111.35217, accuracyM: 4, lastSeen: '3:47:05 AM', sightings: 12, angles: 3, angleSeparationDeg: 55, sourceDrones: ['ANAFI-02'], movement: 'Person at a fixed location',   fireEtaMin: 12, fireDistanceM: 870,  bearingDeg: 246, map: { x: 630, y: 300 } },
      { id: 5, kind: 'candidate', lat: 56.62105, lon: -111.35966, accuracyM: 6, lastSeen: '3:46:40 AM', sightings: 5,  angles: 2, angleSeparationDeg: 35, sourceDrones: ['ANAFI-03'], movement: 'Person moving away from fire', fireEtaMin: 31, fireDistanceM: 1720, bearingDeg: 288, map: { x: 540, y: 395 } },
      { id: 6, kind: 'possible',  lat: 56.63390, lon: -111.34472, accuracyM: 4, lastSeen: '3:47:12 AM', sightings: 10, angles: 3, angleSeparationDeg: 70, sourceDrones: ['ANAFI-04'], movement: 'Person at a fixed location',   fireEtaMin: 18, fireDistanceM: 1140, bearingDeg: 205, map: { x: 760, y: 165 } },
      { id: 7, kind: 'possible',  lat: 56.63188, lon: -111.33901, accuracyM: 4, lastSeen: '3:47:29 AM', sightings: 9,  angles: 3, angleSeparationDeg: 50, sourceDrones: ['ANAFI-04'], movement: 'Person at a fixed location',   fireEtaMin: 20, fireDistanceM: 1260, bearingDeg: 232, map: { x: 840, y: 210 } },
    ],

    closeReasons: [
      { id: 'rescued', label: 'Rescued', groundObserved: true },
      { id: 'safe', label: 'Confirmed safe', groundObserved: true },
      { id: 'duplicate', label: 'Duplicate', groundObserved: false },
      { id: 'false', label: 'Not a person', groundObserved: false },
    ],

    // Search log, newest first. kind: drones | people | fire | review.
    log: [
      { time: '3:47:40 AM', kind: 'drones', text: 'ANAFI-01 descending; 7 unique people spotted.' },
      { time: '3:47:33 AM', kind: 'people', text: 'Target 1 seen by ANAFI-01 at the perimeter.' },
      { time: '3:47:29 AM', kind: 'people', text: 'Target 7 seen by ANAFI-04 at the perimeter.' },
      { time: '3:47:21 AM', kind: 'people', text: 'Target 2 seen by ANAFI-01 at the perimeter.' },
      { time: '3:47:12 AM', kind: 'people', text: 'Target 6 seen by ANAFI-04 at the perimeter.' },
      { time: '3:47:05 AM', kind: 'people', text: 'Target 4 seen by ANAFI-02 at the perimeter.' },
      { time: '3:46:58 AM', kind: 'people', text: 'Target 3 seen by ANAFI-02 at the perimeter.' },
      { time: '3:46:50 AM', kind: 'fire', text: 'Fire outline refreshed from fleet sightings.' },
      { time: '3:46:40 AM', kind: 'people', text: 'Target 5 seen by ANAFI-03 at the perimeter.' },
      { time: '3:46:20 AM', kind: 'drones', text: 'ANAFI-04 returning to launch · battery 34%.' },
    ],
  });
})();
