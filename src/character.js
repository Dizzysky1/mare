/* ────────────────────────────────────────────────────────────────
   The person, before the boat. A GAME model, not a genetics
   simulation: it borrows real, well-established mechanisms where
   they are simple, well-understood and actually visible in the
   game (colour vision is the standout — X-linked recessive, taught
   in every intro genetics course, ~8% of men and ~0.5% of women),
   and it is deliberately conservative everywhere else. Pure math
   and data tables, no imports, no DOM, no Three.js — safe to run
   and test under plain node.

   The thing this file refuses to do, on purpose: it does not model
   "genes for" skill, seamanship, courage or temperament. Those come
   from `background` (upbringing, trade, years at sea) and from
   chance, never from the family tree. Every trait below carries a
   `provenance` entry saying plainly whether it was inherited,
   developmental, learned from experience, or just chance — that
   list is the thing stopping this from quietly turning into a
   genetic-determinism toy. If you are extending this file and are
   not sure which bucket a new trait belongs in, it almost certainly
   belongs in `background`, not in `family`.
   ──────────────────────────────────────────────────────────────── */

function clamp(x, a, b){ return x < a ? a : (x > b ? b : x); }

// Same mulberry32 used elsewhere in the project (waves.js, islands.js) —
// duplicated rather than imported so this stays a zero-dependency leaf
// module that a specialist can test with `node` alone.
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function pick(rng, arr){ return arr[Math.floor(rng() * arr.length) % arr.length]; }

// Box-Muller. Used for every "continuous liability" below (vision,
// constitution, thermal, vestibular) — those are modelled as N(0,1)
// polygenic-style scores, which is the standard shorthand for "many
// small hereditary and environmental influences summed together"
// without pretending to simulate actual loci.
function gaussian(rng, mean = 0, sd = 1){
  let u = 0, v = 0;
  while(u === 0) u = rng();
  while(v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ── name data ──────────────────────────────────────────────────
   Aegean-flavoured but invented outright — no real families, no
   real villages. Kept plain and short, matching the game's own
   dry naming (the ship is "Elpida", Greek for hope, nothing more
   ornate than that). */
const MALE_NAMES = ['Andonis','Yannis','Petros','Kostas','Michalis','Dimitris','Stavros',
  'Nikos','Manolis','Iason','Alexis','Theo','Spyros','Christos','Vassilis','Panos'];
const FEMALE_NAMES = ['Eleni','Marina','Sofia','Katerina','Ariadne','Despina','Foteini',
  'Irini','Zoe','Anastasia','Voula','Athina','Calliope','Danae','Ismene','Thalia'];
const SURNAMES = ['Vlachos','Karydis','Papadakis','Stavridis','Anagnostou','Kondos',
  'Michalopoulos','Theodorou','Ninos','Argyris','Kastellis','Roussos','Fokas','Drakos',
  'Halkias','Petrakis'];
const PLACES = ['Kalyves','Ammoudi','Petradi','Skalonisi','Vourliani','Palionero',
  'Mikros Yialos','Avlonas','Thermisi','Karvouni','Ligovitsi','Xerolimni'];

const NAUTICAL_TRADES = ['fisherman','boatbuilder','ropemaker','ferry-pilot',
  'sponge-diver','lighthouse-keeper','net-mender','ships-cook'];
const INLAND_TRADES = ['olive-farmer','shepherd','merchant-clerk','customs-clerk',
  'monastery-gardener','salt-pan-worker','charcoal-burner'];
const ALL_TRADES = NAUTICAL_TRADES.concat(INLAND_TRADES);

/* ── colour vision: the one honestly hereditary trait in this file ──
   Red-green colour vision deficiency is carried on the X chromosome,
   recessive, at two largely independent loci (OPN1LW → protan,
   OPN1MW → deutan). A man has one X, so any deficient allele shows;
   a woman has two, so she is only affected if both copies carry the
   SAME deficiency (homozygous) — a heterozygous woman is a silent
   carrier, not colour-blind herself. This file treats the two genes
   as one locus with three alleles for simplicity (real biology keeps
   them separate; a rare true double-heterozygote is not modelled),
   which is the one deliberate simplification here.

   Allele frequencies below (protan 1%, deutan 7%) are picked, not
   quoted from a single study, specifically so that:
     male rate   = p + d          = 8%
     female rate = p² + d²        = 0.5%
   which lands exactly on the "~8% of men, ~0.5% of women" figure the
   brief asks to sanity-check the inheritance model against. */
const CVD_FREQ = { protan: 0.010, deutan: 0.070 };

function drawXAllele(rng){
  const r = rng();
  if(r < CVD_FREQ.protan) return 'protan';
  if(r < CVD_FREQ.protan + CVD_FREQ.deutan) return 'deutan';
  return 'normal';
}

// Phenotype from genotype. Hemizygous men express whatever they carry;
// women only express a deficiency if both X's carry the SAME one —
// this is what makes the female rate ~q² instead of ~q, and it is the
// mechanism actually being tested by the distribution check in the
// verification script, not a rolled-directly number.
function phenotypeFromAlleles(sex, xAlleles){
  if(sex === 'M') return xAlleles[0];
  const [a, b] = xAlleles;
  return (a === b && a !== 'normal') ? a : 'normal';
}

/* ── one generation of inheritance ─────────────────────────────── */

// A founder with no parents in the tree: alleles and liabilities drawn
// straight from population frequencies/distributions.
function founder(rng, sex){
  const xAlleles = sex === 'M' ? [drawXAllele(rng)] : [drawXAllele(rng), drawXAllele(rng)];
  const p = {
    sex, xAlleles,
    visionLiability: gaussian(rng),      // polygenic myopia risk score, see deriveVision()
    constitution: gaussian(rng),         // cardiovascular "build", see derivePhysiology()
    thermalLiability: gaussian(rng),     // genetic sweat/cold-tolerance set point
    vestibularLiability: gaussian(rng),  // genetic motion-sensitivity score
  };
  p.colourVision = phenotypeFromAlleles(sex, xAlleles);
  return p;
}

// A child of two tree members: real X-linked meiosis for the colour
// locus (a mother passes one of her two X's at random to any child; a
// father passes his single X only to daughters, never to sons — this
// is exactly why colour-blindness famously "skips" from grandfather to
// grandson through an unaffected, carrier daughter), and simple
// midparent-plus-noise for the continuous liabilities, which is the
// standard toy model for "many genes, each with small effect."
function meiosisChild(rng, sex, father, mother){
  const fromMother = mother.xAlleles[rng() < 0.5 ? 0 : 1];
  const xAlleles = sex === 'M' ? [fromMother] : [fromMother, father.xAlleles[0]];

  // Segregation noise sized at sqrt(1/2): averaging two independent
  // parental values halves the variance, so adding back noise of that
  // size restores the child's liability to the same total spread as
  // the parents' generation instead of the population regressing to
  // zero every generation.
  const blend = (key) => (father[key] + mother[key]) / 2 + gaussian(rng, 0, Math.SQRT1_2);

  const p = {
    sex, xAlleles,
    visionLiability: blend('visionLiability'),
    constitution: blend('constitution'),
    thermalLiability: blend('thermalLiability'),
    vestibularLiability: blend('vestibularLiability'),
  };
  p.colourVision = phenotypeFromAlleles(sex, xAlleles);
  return p;
}

// Trade and handedness are attached to tree members separately from
// the genetic step above, on purpose: occupation is cultural/familial
// (you learn your father's trade, or don't) rather than inherited, and
// handedness has at most a weak, contested genetic contribution, so
// neither belongs inside meiosisChild().
function assignTrade(rng, famNauticalFrac){
  const chance = clamp(0.30 + famNauticalFrac * 0.45, 0.05, 0.85);
  return rng() < chance ? pick(rng, NAUTICAL_TRADES) : pick(rng, INLAND_TRADES);
}
function assignHandedness(rng, father, mother){
  // ~12% of any population is left-handed. Twin studies put heritability
  // low (family clustering exists but is weak and poorly understood) —
  // modelled here as a small nudge, not a Mendelian trait, and never
  // strong enough to read as "inherited handedness."
  let leftBias = 0.12;
  if(father && father.handedness === 'left') leftBias += 0.02;
  if(mother && mother.handedness === 'left') leftBias += 0.02;
  return rng() < leftBias ? 'left' : 'right';
}

function buildFamily(rng, sex){
  const paternalGrandfather = founder(rng, 'M');
  const paternalGrandmother = founder(rng, 'F');
  const maternalGrandfather = founder(rng, 'M');
  const maternalGrandmother = founder(rng, 'F');
  paternalGrandfather.trade = assignTrade(rng, 0.35);
  paternalGrandmother.trade = assignTrade(rng, 0.35);
  maternalGrandfather.trade = assignTrade(rng, 0.35);
  maternalGrandmother.trade = assignTrade(rng, 0.35);
  paternalGrandfather.handedness = assignHandedness(rng);
  paternalGrandmother.handedness = assignHandedness(rng);
  maternalGrandfather.handedness = assignHandedness(rng);
  maternalGrandmother.handedness = assignHandedness(rng);

  const father = meiosisChild(rng, 'M', paternalGrandfather, paternalGrandmother);
  const mother = meiosisChild(rng, 'F', maternalGrandfather, maternalGrandmother);
  const fatherFam = [paternalGrandfather.trade, paternalGrandmother.trade]
    .filter(t => NAUTICAL_TRADES.includes(t)).length / 2;
  const motherFam = [maternalGrandfather.trade, maternalGrandmother.trade]
    .filter(t => NAUTICAL_TRADES.includes(t)).length / 2;
  father.trade = assignTrade(rng, fatherFam);
  mother.trade = assignTrade(rng, motherFam);
  father.handedness = assignHandedness(rng, paternalGrandfather, paternalGrandmother);
  mother.handedness = assignHandedness(rng, maternalGrandfather, maternalGrandmother);

  const person = meiosisChild(rng, sex, father, mother);

  return {
    tree: { paternalGrandfather, paternalGrandmother, maternalGrandfather, maternalGrandmother, father, mother },
    person,
  };
}

function nauticalFraction(tree){
  const members = Object.values(tree);
  return members.filter(m => NAUTICAL_TRADES.includes(m.trade)).length / members.length;
}

function familyNotes(tree){
  const labels = {
    paternalGrandfather: "father's father", paternalGrandmother: "father's mother",
    maternalGrandfather: "mother's father", maternalGrandmother: "mother's mother",
    father: 'father', mother: 'mother',
  };
  const carriers = [];
  for(const key of Object.keys(tree)){
    const m = tree[key];
    if(m.colourVision !== 'normal') carriers.push(`${labels[key]} (${m.colourVision})`);
    else if(m.sex === 'F' && m.xAlleles.some(a => a !== 'normal')) carriers.push(`${labels[key]} (unaffected carrier)`);
  }
  return carriers.length
    ? `Colour vision in the tree: ${carriers.join('; ')}.`
    : 'No colour vision deficiency or known carriers traced in the last two generations.';
}

/* ── vision ─────────────────────────────────────────────────────
   Colour vision is read straight off the genotype above. Refractive
   error is deliberately NOT — myopia heritability estimates from twin
   studies commonly land in the 60-80% range, which is high, but that
   still leaves a large, well-documented environmental slice (near
   work, years of schooling, childhood time outdoors are all
   independently associated with myopia onset). Modelling refractive
   error as pure genetics would be the exact mistake the brief warns
   against, so it is split into a genetic liability term and an
   independent developmental term of comparable size. */
function deriveVision(rng, person, age){
  const colourVision = person.colourVision;

  const geneticD = -2.2 * clamp(person.visionLiability, -2.5, 2.5);   // negative = myopic
  // No childhood/near-work system exists yet to drive this honestly, so
  // it is rolled as chance for now — a future "upbringing" module could
  // feed something like "hours of chart-work as a child" in here instead.
  const developmentalD = gaussian(rng, 0, 1.6);
  const sphereMean = clamp(geneticD * 0.5 + developmentalD * 0.5, -9, 3);

  // Slight myopic drift through school-age years, flattening in adulthood —
  // shape only, not a real growth-curve fit.
  const ageDrift = clamp((age - 10) * -0.01, -0.4, 0);
  // Each eye gets independent noise: real eyes are rarely identical
  // (anisometropia), and the two genetic/developmental terms above are
  // whole-person, not per-eye.
  const rightSphere = clamp(sphereMean + ageDrift + gaussian(rng, 0, 0.35), -10, 4);
  const leftSphere = clamp(sphereMean + ageDrift + gaussian(rng, 0, 0.35), -10, 4);

  const worst = Math.max(Math.abs(rightSphere), Math.abs(leftSphere));
  const needsCorrection = worst > 0.75;          // roughly the clinical threshold for a prescription
  const dependence = clamp((worst - 0.5) / 4.5, 0, 1);

  // Night vision: age-related rod loss is real and roughly monotonic
  // from mid-adulthood on. Beyond that there is no defensible hereditary
  // story here — individual rod-density variation is chance, not "a
  // gene for good night eyes" — so age gets the only structured term.
  const nightVision = clamp(1 - clamp(age - 30, 0, 45) * 0.006 + gaussian(rng, 0, 0.08), 0.5, 1.15);

  return { rightSphere, leftSphere, needsCorrection, dependence, colourVision, nightVision };
}

/* ── background: knowledge, not numbers ────────────────────────
   Where someone grew up and what they did with their hands is family
   and chance, not genetics — a fisherman's daughter is not "born
   knowing knots," she was simply around them. That distinction is why
   trade/origin live entirely outside the genetic tree above, even
   though `nauticalFraction(tree)` (an environmental, not hereditary,
   signal — the household you were raised in) nudges the odds. */
function pickYearsAtSea(rng, age, nautical){
  const adultYears = Math.max(0, age - 15);
  if(nautical) return Math.round(adultYears * (0.35 + rng() * 0.55));
  return Math.round(rng() * rng() * 4); // usually a handful of ferry crossings, occasionally a real stint
}

function aOrAn(word){ return /^[aeiou]/i.test(word) ? 'an' : 'a'; }

function backgroundProse(bg){
  const label = bg.trade.replace(/-/g, ' ');
  const lines = [];
  lines.push(`${bg.nautical ? 'Most households there have a share in a boat' : 'There the sea is a neighbour, not a living'}.`);
  if(bg.nautical){
    lines.push(bg.yearsAtSea > 10
      ? `${bg.yearsAtSea} years ${label === 'fisherman' ? 'fishing' : `working as ${aOrAn(label)} ${label}`}, long enough that most of it is done without being thought about.`
      : `${bg.yearsAtSea} year${bg.yearsAtSea === 1 ? '' : 's'} ${aOrAn(label)} ${label}, still counting.`);
  } else {
    lines.push(`Worked as ${aOrAn(label)} ${label}. Boats were something other people did.`);
  }
  return lines.join(' ');
}

// Knowledge is named and queryable, not a stat. A non-sailor is not
// "-20 sailing" — they simply do not have these flags set, which the
// rest of the game can use to decide what to explain and what to gate.
function deriveKnowledge(rng, background, vision){
  const k = new Set();
  if(background.nautical){
    k.add('knots'); k.add('reefing'); k.add('tides');
    k.add('storeSilhouettes');   // reading a boat's rig/type at a glance
    k.add('navLights');          // knows red = port, green = starboard exists as a system
    if(background.yearsAtSea >= 2) k.add('barometer');
    if(background.yearsAtSea >= 5) k.add('weatherReading');
    if(background.yearsAtSea >= 8) k.add('starNavigation');
    if(background.trade === 'fisherman' || background.trade === 'net-mender') k.add('netMending');
    if(background.trade === 'boatbuilder' || background.trade === 'ropemaker') k.add('riggingRepair');
    if(background.trade === 'sponge-diver') k.add('freeDiving');
    if(background.trade === 'lighthouse-keeper') k.add('lighthouseLore');
    if(rng() < 0.85) k.add('swimming');
  } else {
    if(['shepherd','olive-farmer','charcoal-burner'].includes(background.trade)) k.add('foraging');
    if(rng() < 0.40) k.add('swimming');
    if(rng() < 0.30) k.add('firstAid');
  }
  // A colour-deficient sailor does not see red/green nav lights any
  // differently by wishing to — they learn a workaround (bearing/
  // position instead of hue) precisely BECAUSE they are at sea enough
  // to need one. The trait and the background interact; neither alone
  // produces this flag.
  if(vision.colourVision !== 'normal' && background.nautical) k.add('navLightsByPosition');
  return k;
}

/* ── physiology: moderate heritability, large training effect ───
   Resting heart rate, aerobic ceiling, sweat rate and cold tolerance
   all have real but modest heritability in the literature (commonly
   cited family/twin estimates run 20-40% for resting HR, similar
   order for thermoregulatory set points) alongside training and
   acclimatisation effects that are known to be large (10-20 bpm of
   resting HR, double-digit percentage VO2max shifts). The weighting
   below is deliberately environment-heavy, per the brief. */
function derivePhysiology(rng, person, age, background){
  const activeTrade = NAUTICAL_TRADES.includes(background.trade) || background.trade === 'shepherd';

  const geneticHR = -3.0 * person.constitution;
  const trainingHR = -clamp(background.yearsAtSea, 0, 30) * 0.35 - (activeTrade ? 3 : 0);
  const ageHR = clamp(age - 40, 0, 40) * 0.04;   // resting HR creeps up mildly past 40
  const restingHR = clamp(72 + geneticHR + trainingHR + ageHR + gaussian(rng, 0, 3.5), 46, 96);

  // Cardio's own default (restingHR0 = 74 − 8×(fitness−1)) inverted, so a
  // low resting HR reliably implies the faster/deeper recovery kinetics
  // Cardio's `fitness` also controls — the two numbers stay consistent
  // with each other instead of contradicting.
  const fitness = clamp(1 + (72 - restingHR) / 9, 0.55, 1.65);

  const geneticAerobic = 0.06 * person.constitution;
  const trainingAerobic = clamp(background.yearsAtSea, 0, 25) / 25 * 0.35 + (activeTrade ? 0.08 : 0);
  const ageAerobic = -clamp(age - 25, 0, 45) * 0.006; // ~textbook VO2max decline shape past the mid-20s
  const aerobicCeiling = clamp(1 + geneticAerobic + trainingAerobic + ageAerobic + gaussian(rng, 0, 0.05), 0.55, 1.6);

  // sweatRate and coldTolerance share ONE underlying genetic knob
  // (thermalLiability) with opposite signs — the honest single-liability
  // version of "some people just run warm, some run cold" — while years
  // at sea (heat/cold exposure and acclimatisation) does most of the
  // actual work, per the brief's steer toward the environmental side.
  const envThermal = clamp(background.yearsAtSea, 0, 20) / 20 * 0.30;
  const sweatRate = clamp(1 + 0.08 * person.thermalLiability + envThermal + gaussian(rng, 0, 0.08), 0.6, 1.5);
  const coldTolerance = clamp(1 - 0.08 * person.thermalLiability + envThermal + gaussian(rng, 0, 0.08), 0.6, 1.5);

  return { restingHR, aerobicCeiling, sweatRate, coldTolerance, ageYears: age, fitness };
}

/* ── the handful of other defensible traits ─────────────────────
   Handedness: weak, contested heritability — see assignHandedness().
   Seasickness susceptibility: twin studies do show a real (moderate)
   heritable component to motion sickness, but habituation from time
   actually spent on a moving deck is a well-documented and large
   effect in its own right, so experience gets the dominant weight. */
function deriveTraits(rng, person, background, father, mother){
  const handedness = assignHandedness(rng, father, mother);
  const rawSusceptibility = clamp(0.5 + 0.3 * person.vestibularLiability + gaussian(rng, 0, 0.15), 0, 1.3);
  const habituation = clamp(background.yearsAtSea / 12, 0, 0.7); // up to ~70% blunted after a decade-plus at sea
  const seasicknessSusceptibility = clamp(rawSusceptibility * (1 - habituation), 0, 1);
  return { handedness, seasicknessSusceptibility };
}

function makeName(rng, sex){
  const first = pick(rng, sex === 'M' ? MALE_NAMES : FEMALE_NAMES);
  const last = pick(rng, SURNAMES);
  return `${first} ${last}`;
}

/* ── public API ─────────────────────────────────────────────────── */

export function generateCharacter(seed){
  const rng = mulberry32((seed ?? 0) >>> 0);

  const sex = rng() < 0.5 ? 'M' : 'F';
  const age = Math.round(18 + rng() * 38); // 18..56: plausible adult crew range

  const { tree, person } = buildFamily(rng, sex);

  const vision = deriveVision(rng, person, age);

  const famFrac = nauticalFraction(tree);      // environmental signal: the household you grew up in
  const origin = pick(rng, PLACES);
  const trade = assignTrade(rng, famFrac);
  const nautical = NAUTICAL_TRADES.includes(trade);
  const yearsAtSea = pickYearsAtSea(rng, age, nautical);
  const background = { origin, trade, yearsAtSea, nautical };
  background.prose = backgroundProse(background);

  const knowledge = deriveKnowledge(rng, background, vision);
  const physiology = derivePhysiology(rng, person, age, background);
  const traits = deriveTraits(rng, person, background, tree.father, tree.mother);

  const name = makeName(rng, sex);

  // Every trait, why it has the value it has. This is the part that
  // keeps the model honest — see the file header. Traits with a mixed
  // origin (refractive error, physiology) list every contributing
  // bucket rather than being forced into a single label.
  const provenance = {
    name: 'chance', age: 'chance', sex: 'chance',
    colourVision: 'inherited',
    refractiveError: ['inherited', 'developmental', 'chance'],
    restingHR: ['inherited', 'experience'],
    aerobicCeiling: ['inherited', 'experience'],
    sweatRate: ['inherited', 'experience'],
    coldTolerance: ['inherited', 'experience'],
    nightVision: ['developmental', 'chance'],
    handedness: ['chance', 'inherited'],
    seasicknessSusceptibility: ['inherited', 'experience', 'chance'],
    knowledge: 'experience',
    background: ['experience', 'chance'],
    // Explicitly not modelled anywhere in this file — see header.
    skill: 'not modelled (background/experience only, never genetic)',
    seamanship: 'not modelled (background/experience only, never genetic)',
    courage: 'not modelled (background/experience only, never genetic)',
    temperament: 'not modelled (background/experience only, never genetic)',
  };

  return {
    seed, name, age, sex,
    family: { tree, notes: familyNotes(tree) },
    vision, physiology, background, knowledge, traits, provenance,
  };
}

export function knows(character, topic){
  return character.knowledge.has(topic);
}

export function cardioOptionsFor(character){
  return {
    age: character.physiology.ageYears,
    restingHR: character.physiology.restingHR,
    fitness: character.physiology.fitness,
  };
}

// A short paragraph in the game's own voice — dry, spare, understated
// (see survival.js's logbook/death text). This is also where the "an
// object gains character-dependent value" idea actually shows up:
// glasses are not mentioned at all for someone who does not need them,
// and are close to the most important thing in the world for someone
// who does.
export function describe(character){
  const { name, age, sex, vision, background, knowledge } = character;
  const he = sex === 'M' ? 'He' : 'She';
  const his = sex === 'M' ? 'his' : 'her';
  const lines = [`${name}, ${age}, out of ${background.origin}.`, background.prose];

  if(vision.colourVision !== 'normal'){
    const hue = vision.colourVision === 'protan'
      ? 'reds read dark and uncertain, easy to lose against the sea at dusk'
      : 'reds and greens both read as a muddy yellow';
    const compensates = knows(character, 'navLightsByPosition');
    lines.push(`${he} cannot be trusted to tell red from green — ${hue}.` +
      (compensates
        ? ` ${he} stopped reading harbour lights by colour years ago and reads them by position instead.`
        : ` It has simply never come up enough to matter.`));
  }

  if(vision.dependence > 0.55){
    lines.push(`Without ${his} glasses the horizon is a rumour; ${he.toLowerCase()} does not go far without them.`);
  } else if(vision.dependence > 0.15){
    lines.push(`${he} can manage without glasses, at a squint, for most of what a day at sea asks.`);
  }

  return lines.join(' ');
}
