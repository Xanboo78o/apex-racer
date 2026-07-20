// Track definitions for Apex Racer.
// Each track: name, desc, width (half-width is width/2), surface, env theme,
// points: [x, z, y?] control points of the closed centerline loop (travel order).

function ovalPoints(halfLength, halfWidth, cornerR, ptsPerCorner) {
  // Rounded rectangle, driven counter-clockwise (like Indy).
  const pts = [];
  const cx = halfLength - cornerR, cz = halfWidth - cornerR;
  const corners = [
    { x: cx, z: cz, a0: 0 },            // corner centers + start angle
    { x: -cx, z: cz, a0: Math.PI / 2 },
    { x: -cx, z: -cz, a0: Math.PI },
    { x: cx, z: -cz, a0: 3 * Math.PI / 2 },
  ];
  for (const c of corners) {
    for (let i = 0; i <= ptsPerCorner; i++) {
      const a = c.a0 + (i / ptsPerCorner) * (Math.PI / 2);
      pts.push([c.x + cornerR * Math.cos(a), c.z + cornerR * Math.sin(a)]);
    }
  }
  return pts;
}

const TRACKS = [
  {
    id: 'indy',
    name: 'Brickyard Oval',
    desc: 'Flat-out superspeedway. Lift? Never.',
    width: 46,
    hills: 0.12,
    surface: 'asphalt',
    env: 'oval',
    laps: 5,
    points: ovalPoints(560, 240, 170, 6),
  },
  {
    id: 'monza',
    name: 'Autodromo Monza',
    desc: 'Temple of speed: long straights, hard chicanes.',
    width: 40,
    hills: 0.4,
    surface: 'asphalt',
    env: 'forest',
    laps: 3,
    points: [
      [0, 550], [0, 250], [0, -180],
      [8, -240], [45, -255], [55, -300],          // Rettifilo chicane
      [120, -430], [260, -500],                    // Curva Grande
      [420, -520], [470, -505], [505, -530],       // della Roggia
      [590, -540], [650, -480],                    // Lesmo 1
      [680, -420], [660, -350],                    // Lesmo 2
      [520, -80], [470, 40],                       // Serraglio
      [430, 80], [450, 130], [410, 170],           // Ascari
      [420, 320], [430, 480],                      // back straight
      [400, 580], [300, 640], [150, 640], [40, 600], // Parabolica
    ],
  },
  {
    id: 'monaco',
    name: 'Cote d\'Azur Streets',
    desc: 'Barriers everywhere. Precision or pain.',
    width: 24,
    hills: 0.5,
    surface: 'asphalt',
    env: 'city',
    laps: 3,
    walls: true,
    points: [
      [0, 150], [0, -20],
      [14, -60], [50, -75],                        // Ste Devote
      [150, -85],
      [230, -95], [270, -120], [310, -118], [340, -95], // Massenet/Casino
      [395, -85], [415, -55],                      // Mirabeau
      [412, -15], [410, 15], [428, 28], [442, 10], // hairpin
      [445, -25], [455, -55],                      // Portier
      [500, -60], [600, -63], [700, -45],          // tunnel run
      [740, -20], [735, 10], [755, 25],            // chicane
      [750, 60], [720, 80],                        // Tabac
      [600, 95], [500, 90],
      [450, 80], [430, 100], [380, 110], [360, 95], // swimming pool
      [300, 105],
      [200, 110], [150, 98],                       // Rascasse
      [90, 108], [35, 140], [8, 152],              // Anthony Noghes
    ],
  },
  {
    id: 'silverstone',
    name: 'Northampton GP',
    desc: 'Fast and flowing. Rolling hills, deep forest.',
    width: 42,
    hills: 0.8,
    surface: 'asphalt',
    env: 'meadow',
    laps: 3,
    points: [
      [0, 160], [0, -20],
      [35, -75], [100, -105],                      // Copse
      [180, -85], [255, -130], [330, -90], [390, -130], // Maggotts/Becketts
      [560, -110],                                 // Hangar straight
      [640, -85], [660, -30],                      // Stowe
      [650, 40], [670, 80],                        // Vale
      [640, 130], [560, 160],                      // Club
      [400, 170],
      [330, 150], [280, 180],                      // Abbey-ish esses
      [200, 190], [160, 215],                      // Brooklands
      [120, 235], [74, 232],                       // Luffield
      [38, 224], [14, 200], [2, 178],              // Woodcote sweep onto the straight (z monotonic, no fold)
    ],
  },
  {
    id: 'suzuka',
    name: 'Figure Eight',
    desc: 'The crossover classic. Over and under.',
    width: 36,
    hills: 0.55,
    surface: 'asphalt',
    env: 'forest',
    laps: 3,
    points: [
      [400, 150], [150, 100],                      // main straight (heading W)
      [60, 60], [-60, -40],                        // sweep down to crossover (under)
      [-150, -100],
      [-190, -140], [-230, -115], [-270, -160],    // esses
      [-340, -100], [-350, 20], [-280, 90],        // left lobe loop
      [-180, 80],
      [-90, 45, 4], [0, 0, 8], [90, -45, 4],       // bridge OVER the crossover
      [180, -90], [280, -120],                     // 130R-ish
      [360, -80], [380, 10], [415, 90],            // final corners
    ],
  },
  {
    id: 'baja',
    name: 'Dust Devil Rally',
    desc: 'Loose dirt, big slides. Momentum is king.',
    width: 46,
    hills: 1.0,
    surface: 'dirt',
    env: 'desert',
    laps: 3,
    points: [
      [0, 0, 0], [200, -60, 3], [320, -180, 6], [280, -320, 2],
      [380, -420, 0], [540, -380, 4], [620, -240, 7], [560, -120, 3],
      [680, -40, 0], [660, 120, 2], [500, 180, 5], [380, 120, 3],
      [260, 200, 0], [80, 180, 2], [-60, 80, 4], [-50, -10, 1],
    ],
  },
];
