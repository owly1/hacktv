'use strict';
/* Emberwatch demo cases, hardcoded into the dashboard so Demo mode needs
   neither a drone nor the backend's dataset. Fire records come from
   examples/historical-fires.mjs (recorded events). Each case's "drone" block
   is SIMULATED: ANAFI-01 hovering 1.5 km upwind of the ignition point, looking
   along the recorded spread direction. No drone flew these fires. */
window.EMBER_DEMO = {
 "context": "Context: Canada's 2023 season burned ≈18.5 M ha nationally (CIFFC) — more than double the previous national record.",
 "cases": [
  {
   "id": "horse-river-2016",
   "name": "Horse River (Fort McMurray)",
   "region": "Alberta, Canada",
   "startDate": "2016-05-01",
   "cause": "Human-caused (under investigation; official cause undetermined)",
   "lat": 56.618,
   "lon": -111.197,
   "areaHa": 589552,
   "directionDeg": 60,
   "drivers": {
    "tempC": 32.8,
    "windKmh": 40,
    "rhPct": 12,
    "fuel": "Extreme drought; cured boreal fuels (FFMC >90)"
   },
   "impacts": {
    "structures": 2400,
    "evacuated": 88000,
    "deaths": 0,
    "costCad": 3580000000
   },
   "notes": "≈2,400 homes/buildings destroyed; largest evacuation in Alberta history. ~$3.58 B insured — costliest disaster in Canadian history. 2 indirect deaths during evacuation.",
   "source": "Alberta Wildfire / Insurance Bureau of Canada records",
   "drone": {
    "telemetry": {
     "drone_id": "ANAFI-01",
     "provenance": "demo-simulated",
     "latitude": 56.611263,
     "longitude": -111.218209,
     "altitude_m": 120,
     "ground_speed_mps": 0,
     "battery_pct": 82,
     "state": "hovering",
     "extra": {
      "heading_deg": 60,
      "gimbal_pitch_deg": -30,
      "position_source": "gps"
     }
    },
    "detection": {
     "source": "fire-model",
     "label": "fire",
     "confidence": 0.94,
     "fire": {
      "latitude": 56.618,
      "longitude": -111.197,
      "distance_m": 1500,
      "bearing_deg": 60,
      "position_source": "gps+gimbal-ray"
     }
    }
   }
  },
  {
   "id": "lytton-2021",
   "name": "Lytton Creek",
   "region": "British Columbia, Canada",
   "startDate": "2021-06-30",
   "cause": "Within rail corridor; cause disputed (not officially attributed)",
   "lat": 50.231,
   "lon": -121.581,
   "areaHa": 83800,
   "directionDeg": 10,
   "drivers": {
    "tempC": 49.6,
    "windKmh": 30,
    "rhPct": 10,
    "fuel": "Heat-dome-dried forest/grass interface"
   },
   "impacts": {
    "structures": null,
    "evacuated": null,
    "deaths": 2,
    "costCad": null
   },
   "notes": "≈90% of the Village of Lytton destroyed; reached it in minutes along the canyon. Burned the day after Lytton set Canada's all-time temperature record (49.6 °C).",
   "source": "BC Wildfire Service / coroner records",
   "drone": {
    "telemetry": {
     "drone_id": "ANAFI-01",
     "provenance": "demo-simulated",
     "latitude": 50.21773,
     "longitude": -121.584658,
     "altitude_m": 120,
     "ground_speed_mps": 0,
     "battery_pct": 74,
     "state": "hovering",
     "extra": {
      "heading_deg": 10,
      "gimbal_pitch_deg": -30,
      "position_source": "gps"
     }
    },
    "detection": {
     "source": "fire-model",
     "label": "fire",
     "confidence": 0.91,
     "fire": {
      "latitude": 50.231,
      "longitude": -121.581,
      "distance_m": 1500,
      "bearing_deg": 10,
      "position_source": "gps+gimbal-ray"
     }
    }
   }
  },
  {
   "id": "jasper-2024",
   "name": "Jasper townsite complex",
   "region": "Alberta, Canada",
   "startDate": "2024-07-22",
   "cause": "Lightning",
   "lat": 52.874,
   "lon": -118.081,
   "areaHa": 32700,
   "directionDeg": 350,
   "drivers": {
    "tempC": 30,
    "windKmh": 50,
    "rhPct": null,
    "fuel": "Fire-smarted but drought-stressed parkland forest"
   },
   "impacts": {
    "structures": 358,
    "evacuated": 25000,
    "deaths": 0,
    "costCad": 880000000
   },
   "notes": "≈358 structures (~30% of the townsite) lost when north and south fires converged on Jasper overnight; ≈$880 M insured damage.",
   "source": "Parks Canada / Insurance Bureau of Canada",
   "drone": {
    "telemetry": {
     "drone_id": "ANAFI-01",
     "provenance": "demo-simulated",
     "latitude": 52.86073,
     "longitude": -118.077123,
     "altitude_m": 120,
     "ground_speed_mps": 0,
     "battery_pct": 88,
     "state": "hovering",
     "extra": {
      "heading_deg": 350,
      "gimbal_pitch_deg": -30,
      "position_source": "gps"
     }
    },
    "detection": {
     "source": "fire-model",
     "label": "fire",
     "confidence": 0.96,
     "fire": {
      "latitude": 52.874,
      "longitude": -118.081,
      "distance_m": 1500,
      "bearing_deg": 350,
      "position_source": "gps+gimbal-ray"
     }
    }
   }
  },
  {
   "id": "elephant-hill-2017",
   "name": "Elephant Hill",
   "region": "British Columbia, Canada",
   "startDate": "2017-07-06",
   "cause": "Suspected human-caused (smoking materials suspected, unproven)",
   "lat": 51.166,
   "lon": -121.077,
   "areaHa": 191865,
   "directionDeg": 60,
   "drivers": {
    "tempC": 35,
    "windKmh": 40,
    "rhPct": 15,
    "fuel": "Drought-cured interior forest and grass"
   },
   "impacts": {
    "structures": 100,
    "evacuated": null,
    "deaths": 0,
    "costCad": null
   },
   "notes": "≈100 structures destroyed across Cache Creek / Loon Lake area; burned for over two months in the record 2017 BC season.",
   "source": "BC Wildfire Service records",
   "drone": {
    "telemetry": {
     "drone_id": "ANAFI-01",
     "provenance": "demo-simulated",
     "latitude": 51.159263,
     "longitude": -121.09561,
     "altitude_m": 120,
     "ground_speed_mps": 0,
     "battery_pct": 69,
     "state": "hovering",
     "extra": {
      "heading_deg": 60,
      "gimbal_pitch_deg": -30,
      "position_source": "gps"
     }
    },
    "detection": {
     "source": "fire-model",
     "label": "fire",
     "confidence": 0.89,
     "fire": {
      "latitude": 51.166,
      "longitude": -121.077,
      "distance_m": 1500,
      "bearing_deg": 60,
      "position_source": "gps+gimbal-ray"
     }
    }
   }
  },
  {
   "id": "mcdougall-2023",
   "name": "McDougall Creek (West Kelowna)",
   "region": "British Columbia, Canada",
   "startDate": "2023-08-15",
   "cause": "Undetermined (human-caused suspected)",
   "lat": 49.865,
   "lon": -119.578,
   "areaHa": 13970,
   "directionDeg": 75,
   "drivers": {
    "tempC": 30,
    "windKmh": 50,
    "rhPct": 15,
    "fuel": "Extreme drought; embers spotted across Okanagan Lake"
   },
   "impacts": {
    "structures": 189,
    "evacuated": 10700,
    "deaths": 0,
    "costCad": null
   },
   "notes": "≈189 structures lost; ≈10,700 under evacuation order and ~35,000 under order or alert across the Central Okanagan. Part of Canada's record 2023 season (≈18.5 M ha nationally).",
   "source": "BC Wildfire Service / Central Okanagan EOC records",
   "drone": {
    "telemetry": {
     "drone_id": "ANAFI-01",
     "provenance": "demo-simulated",
     "latitude": 49.861512,
     "longitude": -119.598192,
     "altitude_m": 120,
     "ground_speed_mps": 0,
     "battery_pct": 91,
     "state": "hovering",
     "extra": {
      "heading_deg": 75,
      "gimbal_pitch_deg": -30,
      "position_source": "gps"
     }
    },
    "detection": {
     "source": "fire-model",
     "label": "fire",
     "confidence": 0.93,
     "fire": {
      "latitude": 49.865,
      "longitude": -119.578,
      "distance_m": 1500,
      "bearing_deg": 75,
      "position_source": "gps+gimbal-ray"
     }
    }
   }
  },
  {
   "id": "camp-fire-2018",
   "name": "Camp Fire (Paradise)",
   "region": "California, USA",
   "startDate": "2018-11-08",
   "cause": "Electrical transmission equipment failure",
   "lat": 39.813,
   "lon": -121.435,
   "areaHa": 62053,
   "directionDeg": 245,
   "drivers": {
    "tempC": 10,
    "windKmh": 80,
    "rhPct": 23,
    "fuel": "Critically dry fuels after drought; Jarbo gap winds"
   },
   "impacts": {
    "structures": 18804,
    "evacuated": 52000,
    "deaths": 85,
    "costUsd": 16500000000
   },
   "notes": "Deadliest and most destructive fire in California history; reached Paradise within hours driven by downslope winds.",
   "source": "CAL FIRE incident records",
   "drone": {
    "telemetry": {
     "drone_id": "ANAFI-01",
     "provenance": "demo-simulated",
     "latitude": 39.818695,
     "longitude": -121.419102,
     "altitude_m": 120,
     "ground_speed_mps": 0,
     "battery_pct": 77,
     "state": "hovering",
     "extra": {
      "heading_deg": 245,
      "gimbal_pitch_deg": -30,
      "position_source": "gps"
     }
    },
    "detection": {
     "source": "fire-model",
     "label": "fire",
     "confidence": 0.97,
     "fire": {
      "latitude": 39.813,
      "longitude": -121.435,
      "distance_m": 1500,
      "bearing_deg": 245,
      "position_source": "gps+gimbal-ray"
     }
    }
   }
  },
  {
   "id": "dixie-2021",
   "name": "Dixie Fire",
   "region": "California, USA",
   "startDate": "2021-07-13",
   "cause": "Electrical line contact with tree",
   "lat": 39.794,
   "lon": -121.406,
   "areaHa": 389837,
   "directionDeg": 120,
   "drivers": {
    "tempC": 35,
    "windKmh": 45,
    "rhPct": 12,
    "fuel": "Record-dry fuels; first fire to burn from west to east Sierra crest"
   },
   "impacts": {
    "structures": 1329,
    "evacuated": 16000,
    "deaths": 1,
    "costUsd": null
   },
   "notes": "Second-largest single fire in California history; destroyed most of Greenville.",
   "source": "CAL FIRE incident records",
   "drone": {
    "telemetry": {
     "drone_id": "ANAFI-01",
     "provenance": "demo-simulated",
     "latitude": 39.800737,
     "longitude": -121.421188,
     "altitude_m": 120,
     "ground_speed_mps": 0,
     "battery_pct": 85,
     "state": "hovering",
     "extra": {
      "heading_deg": 120,
      "gimbal_pitch_deg": -30,
      "position_source": "gps"
     }
    },
    "detection": {
     "source": "fire-model",
     "label": "fire",
     "confidence": 0.92,
     "fire": {
      "latitude": 39.794,
      "longitude": -121.406,
      "distance_m": 1500,
      "bearing_deg": 120,
      "position_source": "gps+gimbal-ray"
     }
    }
   }
  },
  {
   "id": "marshall-2021",
   "name": "Marshall Fire",
   "region": "Colorado, USA",
   "startDate": "2021-12-30",
   "cause": "Power line ignition in extreme wind (plus a second ignition point)",
   "lat": 39.956,
   "lon": -105.212,
   "areaHa": 2461,
   "directionDeg": 100,
   "drivers": {
    "tempC": 8,
    "windKmh": 160,
    "rhPct": 15,
    "fuel": "Drought-cured grassland-urban interface"
   },
   "impacts": {
    "structures": 1084,
    "evacuated": 30000,
    "deaths": 2,
    "costUsd": 2000000000
   },
   "notes": "Colorado's most destructive fire by structure count; hurricane-force downslope winds drove it through Superior and Louisville in hours. Area is small because fuels were grass, not forest.",
   "source": "Boulder County / NIST investigation records",
   "drone": {
    "telemetry": {
     "drone_id": "ANAFI-01",
     "provenance": "demo-simulated",
     "latitude": 39.95834,
     "longitude": -105.229312,
     "altitude_m": 120,
     "ground_speed_mps": 0,
     "battery_pct": 72,
     "state": "hovering",
     "extra": {
      "heading_deg": 100,
      "gimbal_pitch_deg": -30,
      "position_source": "gps"
     }
    },
    "detection": {
     "source": "fire-model",
     "label": "fire",
     "confidence": 0.9,
     "fire": {
      "latitude": 39.956,
      "longitude": -105.212,
      "distance_m": 1500,
      "bearing_deg": 100,
      "position_source": "gps+gimbal-ray"
     }
    }
   }
  },
  {
   "id": "eaton-2025",
   "name": "Eaton Fire (Altadena)",
   "region": "California, USA",
   "startDate": "2025-01-07",
   "cause": "Suspected electrical transmission ignition (under investigation)",
   "lat": 34.19,
   "lon": -118.088,
   "areaHa": 5674,
   "directionDeg": 240,
   "drivers": {
    "tempC": 16,
    "windKmh": 150,
    "rhPct": 9,
    "fuel": "8+ months without significant rain; chaparral-urban interface"
   },
   "impacts": {
    "structures": 9400,
    "evacuated": 100000,
    "deaths": 17,
    "costUsd": null
   },
   "notes": "≈9,400 structures damaged or destroyed; extreme Santa Ana downslope event drove it into Altadena overnight alongside the Palisades fire.",
   "source": "CAL FIRE / Los Angeles County records",
   "drone": {
    "telemetry": {
     "drone_id": "ANAFI-01",
     "provenance": "demo-simulated",
     "latitude": 34.196737,
     "longitude": -118.073893,
     "altitude_m": 120,
     "ground_speed_mps": 0,
     "battery_pct": 80,
     "state": "hovering",
     "extra": {
      "heading_deg": 240,
      "gimbal_pitch_deg": -30,
      "position_source": "gps"
     }
    },
    "detection": {
     "source": "fire-model",
     "label": "fire",
     "confidence": 0.95,
     "fire": {
      "latitude": 34.19,
      "longitude": -118.088,
      "distance_m": 1500,
      "bearing_deg": 240,
      "position_source": "gps+gimbal-ray"
     }
    }
   }
  }
 ]
};
