// Staff-Config für die Dino-Token-Tools im Overlay.
// ⚠️ GESPIEGELT vom Bot (Bot/src/config/mutations.ts, primeConditions.ts, dinoDiet.ts).
// Bei Änderungen dort HIER mitziehen (zwei Quellen — bewusst dupliziert, da Bot=TS / token-service=JS).

export const MUTATIONS = [
  { value: 'Accelerated Prey Drive', label: 'Accelerated Prey Drive', diet: 'carni', description: 'Mehr Schaden gegen Tiere mit niedriger Gesundheit (10%)' },
  { value: 'Advanced Gestation', label: 'Advanced Gestation', diet: 'both', femaleOnly: true, description: 'Schnellere Ei-Gestation/Inkubation/Cooldown (50%)' },
  { value: 'Barometric Sensitivity', label: 'Barometric Sensitivity', diet: 'herbi', description: 'Vorwarnung vor Stürmen oder Dürren' },
  { value: 'Cellular Regeneration', label: 'Cellular Regeneration', diet: 'both', description: 'Regeneriert Gesundheit etwas schneller (15%)' },
  { value: 'Congenital Hypoalgesia', label: 'Congenital Hypoalgesia', diet: 'both', description: 'Weniger Schaden gegen größere Spezies (15%)' },
  { value: 'Efficient Digestion', label: 'Efficient Digestion', diet: 'both', description: 'Nahrungsverbrauch verlangsamt sich (20%)' },
  { value: 'Enlarged Meniscus', label: 'Enlarged Meniscus', diet: 'both', description: 'Fallschaden trifft zuerst die Ausdauer' },
  { value: 'Epidermal Fibrosis', label: 'Epidermal Fibrosis', diet: 'both', description: 'Erhöht Blutungsresistenz (15%)' },
  { value: 'Featherweight', label: 'Featherweight', diet: 'both', description: 'Fußabdrücke verblassen schneller (50%)' },
  { value: 'Hematophagy', label: 'Hematophagy', diet: 'both', description: 'Stellt beim Fressen etwas Durst wieder her (15%)' },
  { value: 'Hemomania', label: 'Hemomania', diet: 'carni', description: 'Zusatzschaden gegen blutende Ziele (5%)' },
  { value: 'Hydrodynamic', label: 'Hydrodynamic', diet: 'both', description: 'Erhöhte Schwimmgeschwindigkeit (15%)' },
  { value: 'Hydro-regenerative', label: 'Hydro-regenerative', diet: 'both', description: 'Schnellere HP-Regen bei Regen (25%)' },
  { value: 'Hypervigilance', label: 'Hypervigilance', diet: 'herbi', description: 'Größerer Kamerawinkel beim Essen/Trinken, besseres Hören (50%)' },
  { value: 'Increased Inspiratory Capacity', label: 'Increased Inspiratory Capacity', diet: 'both', description: 'Erhöhte Sauerstoffkapazität (15%)' },
  { value: 'Infrasound Communication', label: 'Infrasound Communication', diet: 'both', description: 'Deutlich weniger Lärm beim Sprechen (50%)' },
  { value: 'Nocturnal', label: 'Nocturnal', diet: 'both', description: 'Schnellere Regen. & höheres Tempo nachts (5%)' },
  { value: 'Osteosclerosis', label: 'Osteosclerosis', diet: 'both', description: 'Resistenz gegen Knochenbrüche (20%)' },
  { value: 'Photosynthetic Regeneration', label: 'Photosynthetic Regeneration', diet: 'herbi', description: 'Erhöhte Ausdauerregen. am Tag (10%)' },
  { value: 'Photosynthetic Tissue', label: 'Photosynthetic Tissue', diet: 'both', description: 'Schnellere Regen. & höheres Tempo am Tag (5%)' },
  { value: 'Reabsorption', label: 'Reabsorption', diet: 'both', description: 'Stellt etwas Wasser bei Regen/Schwimmen wieder her' },
  { value: 'Social Behavior', label: 'Social Behavior', diet: 'both', description: 'Erhöhte Gruppengröße' },
  { value: 'Submerged Optical Retention', label: 'Submerged Optical Retention', diet: 'both', description: 'Erhöhte Sichtweite unter Wasser (5%)' },
  { value: 'Sustained Hydration', label: 'Sustained Hydration', diet: 'both', description: 'Wasserverbrauch verlangsamt sich (20%)' },
  { value: 'Truculency', label: 'Truculency', diet: 'herbi', description: 'Tritte schütteln festgeklammerte Tiere eher ab (5%)' },
  { value: 'Wader', label: 'Wader', diet: 'both', description: 'Weniger behindert beim Waten durch flaches Wasser (25%)' },
  { value: 'Xerocole Adaptation', label: 'Xerocole Adaptation', diet: 'herbi', description: 'Erhält Wasser beim Verzehr von Pflanzen (15%)' },
  { value: 'Tactile Endurance', label: 'Tactile Endurance', diet: 'herbi', description: 'Verwandelt eingehenden Schaden in Ausdauer' },
  { value: 'Traumatic Thrombosis', label: 'Traumatic Thrombosis', diet: 'both', description: 'Verhindert Tod durch Blutverlust beim Ruhen' },
  { value: 'Gastronomic Regeneration', label: 'Gastronomic Regeneration', diet: 'both', description: 'Essen stellt etwas Gesundheit wieder her' },
  { value: 'Hypermetabolic Inanition', label: 'Hypermetabolic Inanition', diet: 'carni', description: 'Je weniger Hunger, desto mehr Schaden' },
  { value: 'Augmented Tapetum', label: '★ Augmented Tapetum', diet: 'carni', description: 'Erhöhte Nachtsicht' },
  { value: 'Cannibalistic', label: '★ Cannibalistic', diet: 'carni', description: 'Eigene Spezies als bevorzugte Beute' },
  { value: 'Enhanced Digestion', label: '★ Enhanced Digestion', diet: 'both', description: 'Verringert Abbaurate von Nährstoffen' },
  { value: 'Heightened Ghrelin', label: '★ Heightened Ghrelin', diet: 'both', description: 'Erhöhte Kapazität für übermäßiges Essen' },
  { value: 'Multichambered Lungs', label: '★ Multichambered Lungs', diet: 'both', description: 'Verringert Schwelle für Ausdauerregeneration' },
  { value: 'Osteophagic', label: '★ Osteophagic', diet: 'carni', description: 'Kann Knochen fressen, heilt Knochenbrüche schneller' },
  { value: 'Prolific Reproduction', label: '★ Prolific Reproduction', diet: 'both', femaleOnly: true, description: 'Junge wachsen schneller, brauchen weniger Nahrung' },
  { value: 'Reinforced Tendons', label: '★ Reinforced Tendons', diet: 'both', description: 'Springen kostet weniger Ausdauer' },
  { value: 'Reniculate Kidneys', label: '★ Reniculate Kidneys', diet: 'both', description: 'Kann Salzwasser trinken' },
];

export const PRIME_LABELS = [
  'Sanctuary als Juvenile besucht',
  'Genested (Get Nested In)',
  'Perfekte Ernährung (1% je Makro)',
  'Mass-Migration-Zone besucht',
  '2 Migrations-Zonen besucht',
  '4 Patrol-Zonen besucht',
  'Nie unfruchtbar (auto)',
  'Keine Muskelkrämpfe (auto)',
  'Kinder zu Subadult großgezogen',
  'Spezies-Bonus (auto)',
];

export const DINOS = {
  Allosaurus: 'carni', Carnotaurus: 'carni', Ceratosaurus: 'carni', Deinosuchus: 'carni', Dilophosaurus: 'carni',
  Herrerasaurus: 'carni', Omniraptor: 'carni', Pteranodon: 'carni', Troodon: 'carni', Tyrannosaurus: 'carni', Rex: 'carni',
  Diabloceratops: 'herbi', Dryosaurus: 'herbi', Hypsilophodon: 'herbi', Maiasaura: 'herbi', Maiasaurus: 'herbi',
  Pachycephalosaurus: 'herbi', Stegosaurus: 'herbi', Tenontosaurus: 'herbi', Triceratops: 'herbi',
  Beipiaosaurus: 'both', Gallimimus: 'both',
};
const DINO_ALIASES = new Set(['Rex', 'Maiasaurus']);   // Schreibweisen-Duplikate aus dem Dropdown nehmen

export const getDiet = (dinoClass) => DINOS[(dinoClass || '').split('_')[0]] ?? 'both';
export const activeSpecies = () => Object.keys(DINOS).filter((d) => !DINO_ALIASES.has(d)).sort();
// Mutationen gefiltert nach Diät + Geschlecht (gleiche Regel wie der Bot-Picker).
export const mutationsFor = (diet, gender) =>
  MUTATIONS.filter((m) => (m.diet === 'both' || m.diet === diet) && (!m.femaleOnly || gender === 'female'));

// ── PvP-Turnier-Builds (gespiegelt von Bot/src/config/pvpBuilds.ts) ──────────
// Alle: 100% Grow, Elder 3 Stacks, alle 10 Prime, 16 Mutationen, Male.
export const PVP_LABEL_PREFIX = '🏆 PvP';
const M = (base, parent, elder) => ({ base, parent, elder });
const CARNI_BASE = ['Epidermal Fibrosis', 'Osteosclerosis', 'Congenital Hypoalgesia', 'Hemomania'];
const CARNI_PARENT = ['Accelerated Prey Drive', 'Traumatic Thrombosis', 'Gastronomic Regeneration', 'Multichambered Lungs'];
const SMALL_BASE = ['Epidermal Fibrosis', 'Hemomania', 'Congenital Hypoalgesia', 'Accelerated Prey Drive'];
const SMALL_PARENT = ['Hypermetabolic Inanition', 'Traumatic Thrombosis', 'Gastronomic Regeneration', 'Multichambered Lungs'];
export const PVP_BUILDS = [
  { key: 'rex', label: 'Tyrannosaurus — PvP', dinoClass: 'Tyrannosaurus', blurb: 'Apex-Bruiser: Burst + Sustain', mutations: M(CARNI_BASE, CARNI_PARENT, ['Cellular Regeneration', 'Hydro-regenerative', 'Increased Inspiratory Capacity', 'Reinforced Tendons', 'Osteophagic', 'Hypermetabolic Inanition', 'Augmented Tapetum', 'Enlarged Meniscus']) },
  { key: 'allo', label: 'Allosaurus — PvP', dinoClass: 'Allosaurus', blurb: 'Bleed-Carni: Anti-Heal + Burst', mutations: M(CARNI_BASE, CARNI_PARENT, ['Cellular Regeneration', 'Hydro-regenerative', 'Increased Inspiratory Capacity', 'Reinforced Tendons', 'Osteophagic', 'Hypermetabolic Inanition', 'Augmented Tapetum', 'Enlarged Meniscus']) },
  { key: 'carno', label: 'Carnotaurus — PvP', dinoClass: 'Carnotaurus', blurb: 'Schnell: Hit&Run + Sustain', mutations: M(CARNI_BASE, CARNI_PARENT, ['Cellular Regeneration', 'Hydro-regenerative', 'Increased Inspiratory Capacity', 'Reinforced Tendons', 'Osteophagic', 'Hypermetabolic Inanition', 'Augmented Tapetum', 'Enlarged Meniscus']) },
  { key: 'cera', label: 'Ceratosaurus — PvP', dinoClass: 'Ceratosaurus', blurb: 'Bleed-Mid + Durst-Sustain', mutations: M(CARNI_BASE, CARNI_PARENT, ['Cellular Regeneration', 'Hydro-regenerative', 'Hematophagy', 'Reinforced Tendons', 'Osteophagic', 'Hypermetabolic Inanition', 'Augmented Tapetum', 'Enlarged Meniscus']) },
  { key: 'deino', label: 'Deinosuchus — PvP', dinoClass: 'Deinosuchus', blurb: 'Wasser-Apex: Tauch-Sustain', mutations: M(CARNI_BASE, ['Hydrodynamic', 'Traumatic Thrombosis', 'Gastronomic Regeneration', 'Multichambered Lungs'], ['Cellular Regeneration', 'Hydro-regenerative', 'Increased Inspiratory Capacity', 'Submerged Optical Retention', 'Reabsorption', 'Hypermetabolic Inanition', 'Augmented Tapetum', 'Reinforced Tendons']) },
  { key: 'dilo', label: 'Dilophosaurus — PvP', dinoClass: 'Dilophosaurus', blurb: 'Kleiner Bleeder + Mobilität', mutations: M(SMALL_BASE, SMALL_PARENT, ['Cellular Regeneration', 'Hydro-regenerative', 'Increased Inspiratory Capacity', 'Reinforced Tendons', 'Enlarged Meniscus', 'Osteosclerosis', 'Augmented Tapetum', 'Hydrodynamic']) },
  { key: 'herrera', label: 'Herrerasaurus — PvP', dinoClass: 'Herrerasaurus', blurb: 'Schneller Bleeder + Sustain', mutations: M(SMALL_BASE, SMALL_PARENT, ['Cellular Regeneration', 'Hydro-regenerative', 'Reinforced Tendons', 'Enlarged Meniscus', 'Increased Inspiratory Capacity', 'Cannibalistic', 'Augmented Tapetum', 'Hematophagy']) },
  { key: 'omni', label: 'Omniraptor — PvP', dinoClass: 'Omniraptor', blurb: 'Rudel-Raptor: Gruppe + Burst', mutations: M(SMALL_BASE, SMALL_PARENT, ['Cellular Regeneration', 'Hydro-regenerative', 'Reinforced Tendons', 'Enlarged Meniscus', 'Increased Inspiratory Capacity', 'Social Behavior', 'Augmented Tapetum', 'Hydrodynamic']) },
  { key: 'ptera', label: 'Pteranodon — PvP', dinoClass: 'Pteranodon', blurb: 'Flieger: Ausdauer + Dive', mutations: M(CARNI_BASE, ['Increased Inspiratory Capacity', 'Traumatic Thrombosis', 'Gastronomic Regeneration', 'Multichambered Lungs'], ['Cellular Regeneration', 'Hydro-regenerative', 'Reinforced Tendons', 'Enlarged Meniscus', 'Hematophagy', 'Hypermetabolic Inanition', 'Augmented Tapetum', 'Hydrodynamic']) },
  { key: 'troodon', label: 'Troodon — PvP', dinoClass: 'Troodon', blurb: 'Nacht-Jäger: Bleed + Tempo', mutations: M(SMALL_BASE, SMALL_PARENT, ['Cellular Regeneration', 'Hydro-regenerative', 'Reinforced Tendons', 'Enlarged Meniscus', 'Increased Inspiratory Capacity', 'Nocturnal', 'Augmented Tapetum', 'Hematophagy']) },
  { key: 'trike', label: 'Triceratops — PvP', dinoClass: 'Triceratops', blurb: 'Tank-Herbi: Anti-Latch', mutations: M(['Epidermal Fibrosis', 'Osteosclerosis', 'Congenital Hypoalgesia', 'Truculency'], ['Tactile Endurance', 'Traumatic Thrombosis', 'Gastronomic Regeneration', 'Multichambered Lungs'], ['Cellular Regeneration', 'Hydro-regenerative', 'Photosynthetic Regeneration', 'Reinforced Tendons', 'Enlarged Meniscus', 'Increased Inspiratory Capacity', 'Hypervigilance', 'Hydrodynamic']) },
  { key: 'stego', label: 'Stegosaurus — PvP', dinoClass: 'Stegosaurus', blurb: 'Tank-Herbi: Bleed-Resist', mutations: M(['Epidermal Fibrosis', 'Traumatic Thrombosis', 'Osteosclerosis', 'Congenital Hypoalgesia'], ['Truculency', 'Tactile Endurance', 'Multichambered Lungs', 'Photosynthetic Regeneration'], ['Enlarged Meniscus', 'Reinforced Tendons', 'Cellular Regeneration', 'Hydro-regenerative', 'Gastronomic Regeneration', 'Increased Inspiratory Capacity', 'Hypervigilance', 'Hydrodynamic']) },
];
export const getPvpBuild = (key) => PVP_BUILDS.find((b) => b.key === key);
