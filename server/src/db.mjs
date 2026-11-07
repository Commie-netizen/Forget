// Ouverture SQLite (node:sqlite), migrations idempotentes et seed du catalogue.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = resolve(here, '..', 'data', 'forget.sqlite');
export { VERSION } from './version.mjs';

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profile(id TEXT PRIMARY KEY, primaryName TEXT, primaryAddress TEXT, dateOfBirth TEXT,
  emails TEXT, phones TEXT, createdAt INTEGER, updatedAt INTEGER);
CREATE TABLE IF NOT EXISTS claw(id TEXT PRIMARY KEY, name TEXT, category TEXT, website TEXT, description TEXT,
  demo INTEGER, enabled INTEGER);
CREATE TABLE IF NOT EXISTS scanJob(id TEXT PRIMARY KEY, profileId TEXT, clawId TEXT, status TEXT, trigger TEXT,
  createdAt INTEGER, startedAt INTEGER, completedAt INTEGER, failure TEXT);
CREATE TABLE IF NOT EXISTS scanResult(id TEXT PRIMARY KEY, scanJobId TEXT, profileUrl TEXT, names TEXT, age INTEGER,
  addresses TEXT, relatives TEXT, emails TEXT, phones TEXT, extras TEXT, hash TEXT, createdAt INTEGER);
CREATE TABLE IF NOT EXISTS screenshot(id TEXT PRIMARY KEY, scanResultId TEXT, kind TEXT, label TEXT, data TEXT, createdAt INTEGER);
CREATE TABLE IF NOT EXISTS removalJob(id TEXT PRIMARY KEY, clawId TEXT, profileId TEXT, scanResultId TEXT, status TEXT,
  trigger TEXT, startedAt INTEGER, finishedAt INTEGER, nextPollAt INTEGER, pollTimeoutAt INTEGER, failure TEXT,
  createdAt INTEGER, updatedAt INTEGER);
CREATE TABLE IF NOT EXISTS removalStep(id TEXT PRIMARY KEY, removalJobId TEXT, name TEXT, type TEXT, result TEXT,
  createdAt INTEGER, updatedAt INTEGER);
CREATE TABLE IF NOT EXISTS axe(id TEXT PRIMARY KEY, name TEXT, description TEXT, category TEXT, demo INTEGER);
CREATE TABLE IF NOT EXISTS axeAccount(id TEXT PRIMARY KEY, axeId TEXT, displayName TEXT, status TEXT, connectedAt INTEGER);
CREATE TABLE IF NOT EXISTS axeJob(id TEXT PRIMARY KEY, axeId TEXT, accountId TEXT, status TEXT, mode TEXT,
  createdAt INTEGER, startedAt INTEGER, completedAt INTEGER, totalItems INTEGER, totalDeleted INTEGER);
CREATE TABLE IF NOT EXISTS thing(id TEXT PRIMARY KEY, jobId TEXT, axeId TEXT, accountId TEXT, serverName TEXT,
  channelName TEXT, text TEXT, thingDate INTEGER, archivedAt INTEGER, isDeleted INTEGER, markedForDeletion INTEGER);
CREATE TABLE IF NOT EXISTS schedule(id TEXT PRIMARY KEY, kind TEXT, targetId TEXT, cron TEXT, enabled INTEGER,
  lastRunAt INTEGER, nextRunAt INTEGER);
CREATE TABLE IF NOT EXISTS event(id TEXT PRIMARY KEY, at INTEGER, type TEXT, payload TEXT);
CREATE TABLE IF NOT EXISTS setting(key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_scanResult_job ON scanResult(scanJobId);
CREATE INDEX IF NOT EXISTS idx_thing_job ON thing(jobId);
CREATE INDEX IF NOT EXISTS idx_step_job ON removalStep(removalJobId);
`;

// Catalogue de brokers (démo). Ids stables pour que les schedules survivent aux relances.
const CLAWS = [
  ['spokeo', 'Spokeo', 'people-search', 'spokeo.com', "Annuaire de personnes agrégeant adresses, téléphones et proches."],
  ['whitepages', 'Whitepages', 'people-search', 'whitepages.com', 'Recherche inversée de noms, adresses et numéros.'],
  ['beenverified', 'BeenVerified', 'background-check', 'beenverified.com', "Rapports de vérification d'antécédents."],
  ['intelius', 'Intelius', 'background-check', 'intelius.com', 'Recherche de personnes et vérifications publiques.'],
  ['radaris', 'Radaris', 'people-search', 'radaris.com', 'Profils publics agrégés depuis des registres ouverts.'],
  ['acxiom', 'Acxiom', 'marketing', 'acxiom.com', 'Courtier en données marketing et segmentation.'],
  ['epsilon', 'Epsilon Data', 'marketing', 'epsilon.com', "Données d'audience pour le marketing direct."],
  ['oracle-ads', 'Oracle Advertising', 'ad-tech', 'oracle.com/advertising', 'Profils publicitaires et ciblage comportemental.'],
  ['liveramp', 'LiveRamp', 'ad-tech', 'liveramp.com', "Résolution d'identité pour la publicité."],
  ['truthfinder', 'TruthFinder', 'background-check', 'truthfinder.com', 'Dossiers et antécédents publics.'],
  ['peoplefinders', 'PeopleFinders', 'people-search', 'peoplefinders.com', 'Recherche de personnes, adresses et historique de résidence.'],
  ['mylife', 'MyLife', 'people-search', 'mylife.com', 'Profils de réputation et scores attribués aux particuliers.'],
  ['fastpeoplesearch', 'FastPeopleSearch', 'people-search', 'fastpeoplesearch.com', 'Annuaire gratuit de noms, téléphones et adresses.'],
  ['truepeoplesearch', 'TruePeopleSearch', 'people-search', 'truepeoplesearch.com', 'Recherche de personnes et de proches associés.'],
  ['thatsthem', 'That’s Them', 'people-search', 'thatsthem.com', 'Recherche inversée par email, IP et adresse.'],
  ['peekyou', 'PeekYou', 'people-search', 'peekyou.com', 'Agrégation de présences web et réseaux sociaux.'],
  ['pipl', 'Pipl', 'people-search', 'pipl.com', 'Moteur d’identité en ligne : emails, profils, téléphones.'],
  ['zabasearch', 'ZabaSearch', 'people-search', 'zabasearch.com', 'Annuaire public de personnes et numéros.'],
  ['nuwber', 'Nuwber', 'people-search', 'nuwber.com', 'Profils de personnes, proches et adresses.'],
  ['clustrmaps', 'ClustrMaps', 'people-search', 'clustrmaps.com', 'Cartographie de résidents par adresse.'],
  ['cocofinder', 'CocoFinder', 'people-search', 'cocofinder.com', 'Recherche de personnes multi-sources.'],
  ['idtrue', 'IDTrue', 'people-search', 'idtrue.com', 'Vérification d’identité et coordonnées.'],
  ['usphonebook', 'USPhoneBook', 'residences-phones', 'usphonebook.com', 'Annuaire inversé de numéros de téléphone.'],
  ['addresses-com', 'Addresses.com', 'residences-phones', 'addresses.com', 'Recherche d’adresses résidentielles.'],
  ['numlookup', 'NumLookup', 'residences-phones', 'numlookup.com', 'Recherche inversée de numéros fixes et mobiles.'],
  ['reversephonelookup', 'Reverse Phone Lookup', 'residences-phones', 'reversephonelookup.com', 'Identification de titulaires de lignes.'],
  ['411-com', '411.com', 'residences-phones', '411.com', 'Pages blanches en ligne.'],
  ['anywho', 'AnyWho', 'residences-phones', 'anywho.com', 'Annuaire téléphonique résidentiel.'],
  ['advanced-background-checks', 'Advanced Background Checks', 'background-check', 'advancedbackgroundchecks.com', 'Dossiers publics, antécédents et contacts.'],
  ['instantcheckmate', 'Instant Checkmate', 'background-check', 'instantcheckmate.com', 'Rapports d’antécédents et casiers publics.'],
  ['checkpeople', 'CheckPeople', 'background-check', 'checkpeople.com', 'Vérifications d’antécédents et recherche de personnes.'],
  ['peoplelooker', 'PeopleLooker', 'background-check', 'peoplelooker.com', 'Rapports de vérification et historique d’adresses.'],
  ['publicrecords-com', 'PublicRecords.com', 'background-check', 'publicrecords.com', 'Moteur de recherche de registres publics.'],
  ['ussearch', 'US Search', 'background-check', 'ussearch.com', 'Recherche de personnes et vérifications.'],
  ['smartbackgroundchecks', 'SmartBackgroundChecks', 'background-check', 'smartbackgroundchecks.com', 'Rapports d’antécédents et téléphones.'],
  ['sterling', 'Sterling', 'background-check', 'sterlingcheck.com', 'Vérifications pré-embauche pour employeurs.'],
  ['hireright', 'HireRight', 'background-check', 'hireright.com', 'Dépistage et vérification de candidats.'],
  ['checkr', 'Checkr', 'background-check', 'checkr.com', 'Vérifications d’antécédents via API.'],
  ['firstadvantage', 'First Advantage', 'background-check', 'fadv.com', 'Dépistage d’antécédents professionnels.'],
  ['acxiom-uk', 'Acxiom UK', 'marketing', 'acxiom.co.uk', 'Données de consommateurs pour le marketing britannique.'],
  ['experian-marketing', 'Experian Marketing Services', 'marketing', 'experian.com/marketing-services', 'Segmentation et données d’audience.'],
  ['equifax-marketing', 'Equifax Marketing', 'marketing', 'equifax.com', 'Listes de prospects et attributs consommateurs.'],
  ['transunion-marketing', 'TransUnion Marketing', 'marketing', 'transunion.com', 'Données d’identité et ciblage marketing.'],
  ['nielsen', 'Nielsen Marketing', 'marketing', 'nielsen.com', 'Mesure de consommation et segmentation.'],
  ['kantar', 'Kantar', 'marketing', 'kantar.com', 'Études de consommateurs et panels.'],
  ['data-axle', 'Data Axle', 'marketing', 'data-axle.com', 'Listes de consommateurs et d’entreprises.'],
  ['alliant', 'Alliant Data', 'marketing', 'alliantdata.com', 'Données d’achats pour le marketing direct.'],
  ['exactdata', 'ExactData', 'marketing', 'exactdata.com', 'Listes ciblées de consommateurs.'],
  ['melissa', 'Melissa Data', 'marketing', 'melissa.com', 'Vérification et enrichissement de contacts.'],
  ['kbm-group', 'KBM Group', 'marketing', 'kbmg.com', 'Base de données marketing de ménages.'],
  ['dun-bradstreet', 'Dun & Bradstreet', 'data-broker', 'dnb.com', 'Données sur les entreprises et leurs dirigeants.'],
  ['zoominfo', 'ZoomInfo', 'data-broker', 'zoominfo.com', 'Coordonnées professionnelles de contacts B2B.'],
  ['lusha', 'Lusha', 'data-broker', 'lusha.com', 'Emails et téléphones professionnels.'],
  ['apollo', 'Apollo.io', 'data-broker', 'apollo.io', 'Base de contacts commerciaux.'],
  ['rocketreach', 'RocketReach', 'data-broker', 'rocketreach.co', 'Coordonnées de professionnels.'],
  ['clearbit', 'Clearbit', 'data-broker', 'clearbit.com', 'Enrichissement de profils par email.'],
  ['fullcontact', 'FullContact', 'data-broker', 'fullcontact.com', 'Résolution d’identité et enrichissement.'],
  ['datalogix', 'Datalogix', 'data-broker', 'datalogix.com', 'Données d’achats associées à des profils.'],
  ['corelogic', 'CoreLogic', 'property-records', 'corelogic.com', 'Données immobilières et titres de propriété.'],
  ['zillow', 'Zillow', 'property-records', 'zillow.com', 'Historique de propriété et estimations.'],
  ['realtor-data', 'Realtor Data', 'property-records', 'realtor.com', 'Annonces et historique de ventes.'],
  ['propertyshark', 'PropertyShark', 'property-records', 'propertyshark.com', 'Propriétaires et mutations immobilières.'],
  ['homemetry', 'Homemetry', 'property-records', 'homemetry.com', 'Informations de propriétaires et voisinage.'],
  ['blockshopper', 'BlockShopper', 'property-records', 'blockshopper.com', 'Transactions immobilières nominatives.'],
  ['neighborwho', 'NeighborWho', 'property-records', 'neighborwho.com', 'Voisins et résidents d’une adresse.'],
  ['familytreenow', 'FamilyTreeNow', 'genealogy', 'familytreenow.com', 'Arbres généalogiques et proches.'],
  ['ancestry-public', 'Ancestry Public Records', 'genealogy', 'ancestry.com', 'Registres publics généalogiques.'],
  ['myheritage', 'MyHeritage Records', 'genealogy', 'myheritage.com', 'Archives et fiches généalogiques.'],
  ['archives-com', 'Archives.com', 'genealogy', 'archives.com', 'Documents d’état civil.'],
  ['leakpeek', 'LeakPeek', 'breach-identity', 'leakpeek.com', 'Index de comptes issus de fuites de données.'],
  ['dehashed', 'DeHashed', 'breach-identity', 'dehashed.com', 'Moteur de recherche d’identifiants compromis.'],
  ['snusbase', 'Snusbase', 'breach-identity', 'snusbase.com', 'Base de données de fuites indexées.'],
  ['intelx', 'Intelligence X', 'breach-identity', 'intelx.io', 'Archive de fuites et de données exposées.'],
  ['leakcheck', 'LeakCheck', 'breach-identity', 'leakcheck.io', 'Recherche d’identifiants dans les fuites.'],
  ['spycloud', 'SpyCloud', 'breach-identity', 'spycloud.com', 'Données d’identité récupérées après compromission.'],
  ['voterrecords', 'VoterRecords', 'public-records', 'voterrecords.com', 'Listes électorales publiques.'],
  ['courtrecords', 'CourtRecords Index', 'public-records', 'courtrecords.org', 'Dossiers judiciaires publics.'],
  ['inmatesearch', 'InmateSearch', 'public-records', 'inmatesearch.org', 'Registres d’incarcération publics.'],
  ['arrests-org', 'Arrests.org', 'public-records', 'arrests.org', 'Fiches d’arrestations publiques.'],
  ['mugshots-com', 'Mugshots.com', 'public-records', 'mugshots.com', 'Photographies d’identité judiciaire.'],
  ['bizapedia', 'Bizapedia', 'public-records', 'bizapedia.com', 'Registres d’entreprises et dirigeants.'],
  ['opencorporates', 'OpenCorporates', 'public-records', 'opencorporates.com', 'Registre mondial des sociétés.'],
  ['criteo', 'Criteo', 'ad-tech', 'criteo.com', 'Reciblage publicitaire et profils d’audience.'],
  ['the-trade-desk', 'The Trade Desk', 'ad-tech', 'thetradedesk.com', 'Plateforme publicitaire et identifiants unifiés.'],
  ['lotame', 'Lotame', 'ad-tech', 'lotame.com', 'Plateforme de données d’audience (DMP).'],
  ['bluekai', 'BlueKai', 'ad-tech', 'bluekai.com', 'Gestion de données d’audience et ciblage.'],
  ['neustar', 'Neustar', 'ad-tech', 'home.neustar', 'Résolution d’identité et données de ciblage.'],
  ['tapad', 'Tapad', 'ad-tech', 'tapad.com', 'Graphe d’appareils multi-écrans.'],
  ['quantcast', 'Quantcast', 'ad-tech', 'quantcast.com', 'Mesure d’audience et ciblage.'],
  ['taboola', 'Taboola', 'ad-tech', 'taboola.com', 'Recommandation de contenu et profilage.'],
  ['adobe-audience', 'Adobe Audience Manager', 'ad-tech', 'adobe.com/experience-cloud', 'Segments d’audience inter-appareils.'],
  ['near-data', 'Near', 'location-data', 'near.co', 'Données de localisation et de mobilité.'],
  ['safegraph', 'SafeGraph', 'location-data', 'safegraph.com', 'Données de lieux et de déplacements.'],
  ['placer-ai', 'Placer.ai', 'location-data', 'placer.ai', 'Analyse de fréquentation géolocalisée.'],
  ['x-mode', 'X-Mode Social', 'location-data', 'xmode.io', 'Données de localisation issues d’applications.'],
  ['veraset', 'Veraset', 'location-data', 'veraset.com', 'Flux de données de mouvement d’appareils.'],
  ['venntel', 'Venntel', 'location-data', 'venntel.com', 'Données de localisation d’appareils mobiles.'],
];

const AXES = [
  ['claude-ai', 'Claude.ai', "Historique de conversations avec l'assistant.", 'ai-chat'],
  ['facebook-messenger', 'Facebook Messenger', 'Messages et fils de discussion Messenger.', 'messaging'],
  ['quora', 'Quora', 'Questions, réponses et commentaires publiés.', 'q-and-a'],
  ['wordpress', 'WordPress', 'Articles et commentaires de blog.', 'blog'],
  ['discord', 'Discord', 'Messages de serveurs et de salons.', 'chat'],
];

const DEFAULT_SETTINGS = { theme: 'dark', mode: 'demo', language: 'fr' };

function migrate(d) {
  d.exec(SCHEMA);
  const insClaw = d.prepare('INSERT OR IGNORE INTO claw VALUES (?,?,?,?,?,1,1)');
  for (const c of CLAWS) insClaw.run(...c);
  const insAxe = d.prepare('INSERT OR IGNORE INTO axe VALUES (?,?,?,?,1)');
  for (const a of AXES) insAxe.run(...a);
  const insSet = d.prepare('INSERT OR IGNORE INTO setting VALUES (?,?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSet.run(k, JSON.stringify(v));
}

// Ouvre (une seule fois) la base. Le chemin peut être surchargé par FORGET_DB_PATH.
export function getDb() {
  if (db) return db;
  const path = process.env.FORGET_DB_PATH || DEFAULT_DB_PATH;
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}
