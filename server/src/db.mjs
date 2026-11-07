// Open SQLite (node:sqlite), run idempotent migrations, and seed the catalog.
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

// Broker catalog (demo). Stable IDs let schedules survive restarts.
const CLAWS = [
  ['spokeo', 'Spokeo', 'people-search', 'spokeo.com', 'People directory aggregating addresses, phone numbers and relatives.'],
  ['whitepages', 'Whitepages', 'people-search', 'whitepages.com', 'Reverse lookup of names, addresses and phone numbers.'],
  ['beenverified', 'BeenVerified', 'background-check', 'beenverified.com', 'Background check reports.'],
  ['intelius', 'Intelius', 'background-check', 'intelius.com', 'People search and public record checks.'],
  ['radaris', 'Radaris', 'people-search', 'radaris.com', 'Public profiles aggregated from open records.'],
  ['acxiom', 'Acxiom', 'marketing', 'acxiom.com', 'Marketing data broker and segmentation.'],
  ['epsilon', 'Epsilon Data', 'marketing', 'epsilon.com', 'Audience data for direct marketing.'],
  ['oracle-ads', 'Oracle Advertising', 'ad-tech', 'oracle.com/advertising', 'Advertising profiles and behavioral targeting.'],
  ['liveramp', 'LiveRamp', 'ad-tech', 'liveramp.com', 'Identity resolution for advertising.'],
  ['truthfinder', 'TruthFinder', 'background-check', 'truthfinder.com', 'Public records and background files.'],
  ['peoplefinders', 'PeopleFinders', 'people-search', 'peoplefinders.com', 'People search, addresses and residence history.'],
  ['mylife', 'MyLife', 'people-search', 'mylife.com', 'Reputation profiles and scores assigned to individuals.'],
  ['fastpeoplesearch', 'FastPeopleSearch', 'people-search', 'fastpeoplesearch.com', 'Free directory of names, phone numbers and addresses.'],
  ['truepeoplesearch', 'TruePeopleSearch', 'people-search', 'truepeoplesearch.com', 'People search and associated relatives.'],
  ['thatsthem', 'That’s Them', 'people-search', 'thatsthem.com', 'Reverse lookup by email, IP and address.'],
  ['peekyou', 'PeekYou', 'people-search', 'peekyou.com', 'Aggregation of web and social media presence.'],
  ['pipl', 'Pipl', 'people-search', 'pipl.com', 'Online identity engine: emails, profiles, phone numbers.'],
  ['zabasearch', 'ZabaSearch', 'people-search', 'zabasearch.com', 'Public directory of people and phone numbers.'],
  ['nuwber', 'Nuwber', 'people-search', 'nuwber.com', 'People profiles, relatives and addresses.'],
  ['clustrmaps', 'ClustrMaps', 'people-search', 'clustrmaps.com', 'Maps of residents by address.'],
  ['cocofinder', 'CocoFinder', 'people-search', 'cocofinder.com', 'Multi-source people search.'],
  ['idtrue', 'IDTrue', 'people-search', 'idtrue.com', 'Identity verification and contact details.'],
  ['usphonebook', 'USPhoneBook', 'residences-phones', 'usphonebook.com', 'Reverse phone number directory.'],
  ['addresses-com', 'Addresses.com', 'residences-phones', 'addresses.com', 'Residential address search.'],
  ['numlookup', 'NumLookup', 'residences-phones', 'numlookup.com', 'Reverse lookup of landline and mobile numbers.'],
  ['reversephonelookup', 'Reverse Phone Lookup', 'residences-phones', 'reversephonelookup.com', 'Identifies phone line owners.'],
  ['411-com', '411.com', 'residences-phones', '411.com', 'Online white pages.'],
  ['anywho', 'AnyWho', 'residences-phones', 'anywho.com', 'Residential phone directory.'],
  ['advanced-background-checks', 'Advanced Background Checks', 'background-check', 'advancedbackgroundchecks.com', 'Public records, background and contacts.'],
  ['instantcheckmate', 'Instant Checkmate', 'background-check', 'instantcheckmate.com', 'Background reports and public criminal records.'],
  ['checkpeople', 'CheckPeople', 'background-check', 'checkpeople.com', 'Background checks and people search.'],
  ['peoplelooker', 'PeopleLooker', 'background-check', 'peoplelooker.com', 'Verification reports and address history.'],
  ['publicrecords-com', 'PublicRecords.com', 'background-check', 'publicrecords.com', 'Public records search engine.'],
  ['ussearch', 'US Search', 'background-check', 'ussearch.com', 'People search and background checks.'],
  ['smartbackgroundchecks', 'SmartBackgroundChecks', 'background-check', 'smartbackgroundchecks.com', 'Background reports and phone numbers.'],
  ['sterling', 'Sterling', 'background-check', 'sterlingcheck.com', 'Pre-employment screening for employers.'],
  ['hireright', 'HireRight', 'background-check', 'hireright.com', 'Candidate screening and verification.'],
  ['checkr', 'Checkr', 'background-check', 'checkr.com', 'Background checks via API.'],
  ['firstadvantage', 'First Advantage', 'background-check', 'fadv.com', 'Professional background screening.'],
  ['acxiom-uk', 'Acxiom UK', 'marketing', 'acxiom.co.uk', 'Consumer data for UK marketing.'],
  ['experian-marketing', 'Experian Marketing Services', 'marketing', 'experian.com/marketing-services', 'Segmentation and audience data.'],
  ['equifax-marketing', 'Equifax Marketing', 'marketing', 'equifax.com', 'Prospect lists and consumer attributes.'],
  ['transunion-marketing', 'TransUnion Marketing', 'marketing', 'transunion.com', 'Identity data and marketing targeting.'],
  ['nielsen', 'Nielsen Marketing', 'marketing', 'nielsen.com', 'Consumer measurement and segmentation.'],
  ['kantar', 'Kantar', 'marketing', 'kantar.com', 'Consumer research and panels.'],
  ['data-axle', 'Data Axle', 'marketing', 'data-axle.com', 'Consumer and business lists.'],
  ['alliant', 'Alliant Data', 'marketing', 'alliantdata.com', 'Purchase data for direct marketing.'],
  ['exactdata', 'ExactData', 'marketing', 'exactdata.com', 'Targeted consumer lists.'],
  ['melissa', 'Melissa Data', 'marketing', 'melissa.com', 'Contact verification and enrichment.'],
  ['kbm-group', 'KBM Group', 'marketing', 'kbmg.com', 'Household marketing database.'],
  ['dun-bradstreet', 'Dun & Bradstreet', 'data-broker', 'dnb.com', 'Data on companies and their executives.'],
  ['zoominfo', 'ZoomInfo', 'data-broker', 'zoominfo.com', 'Professional contact details for B2B.'],
  ['lusha', 'Lusha', 'data-broker', 'lusha.com', 'Professional emails and phone numbers.'],
  ['apollo', 'Apollo.io', 'data-broker', 'apollo.io', 'Sales contact database.'],
  ['rocketreach', 'RocketReach', 'data-broker', 'rocketreach.co', 'Contact details of professionals.'],
  ['clearbit', 'Clearbit', 'data-broker', 'clearbit.com', 'Profile enrichment from an email address.'],
  ['fullcontact', 'FullContact', 'data-broker', 'fullcontact.com', 'Identity resolution and enrichment.'],
  ['datalogix', 'Datalogix', 'data-broker', 'datalogix.com', 'Purchase data linked to profiles.'],
  ['corelogic', 'CoreLogic', 'property-records', 'corelogic.com', 'Real estate data and property titles.'],
  ['zillow', 'Zillow', 'property-records', 'zillow.com', 'Property history and valuations.'],
  ['realtor-data', 'Realtor Data', 'property-records', 'realtor.com', 'Listings and sales history.'],
  ['propertyshark', 'PropertyShark', 'property-records', 'propertyshark.com', 'Property owners and real estate transfers.'],
  ['homemetry', 'Homemetry', 'property-records', 'homemetry.com', 'Owner and neighborhood information.'],
  ['blockshopper', 'BlockShopper', 'property-records', 'blockshopper.com', 'Named real estate transactions.'],
  ['neighborwho', 'NeighborWho', 'property-records', 'neighborwho.com', 'Neighbors and residents of an address.'],
  ['familytreenow', 'FamilyTreeNow', 'genealogy', 'familytreenow.com', 'Family trees and relatives.'],
  ['ancestry-public', 'Ancestry Public Records', 'genealogy', 'ancestry.com', 'Public genealogy records.'],
  ['myheritage', 'MyHeritage Records', 'genealogy', 'myheritage.com', 'Genealogy archives and records.'],
  ['archives-com', 'Archives.com', 'genealogy', 'archives.com', 'Vital records.'],
  ['leakpeek', 'LeakPeek', 'breach-identity', 'leakpeek.com', 'Index of accounts from data breaches.'],
  ['dehashed', 'DeHashed', 'breach-identity', 'dehashed.com', 'Search engine for compromised credentials.'],
  ['snusbase', 'Snusbase', 'breach-identity', 'snusbase.com', 'Indexed breach database.'],
  ['intelx', 'Intelligence X', 'breach-identity', 'intelx.io', 'Archive of leaks and exposed data.'],
  ['leakcheck', 'LeakCheck', 'breach-identity', 'leakcheck.io', 'Credential search in data breaches.'],
  ['spycloud', 'SpyCloud', 'breach-identity', 'spycloud.com', 'Identity data recovered after breaches.'],
  ['voterrecords', 'VoterRecords', 'public-records', 'voterrecords.com', 'Public voter rolls.'],
  ['courtrecords', 'CourtRecords Index', 'public-records', 'courtrecords.org', 'Public court records.'],
  ['inmatesearch', 'InmateSearch', 'public-records', 'inmatesearch.org', 'Public incarceration records.'],
  ['arrests-org', 'Arrests.org', 'public-records', 'arrests.org', 'Public arrest records.'],
  ['mugshots-com', 'Mugshots.com', 'public-records', 'mugshots.com', 'Police booking photos.'],
  ['bizapedia', 'Bizapedia', 'public-records', 'bizapedia.com', 'Company records and officers.'],
  ['opencorporates', 'OpenCorporates', 'public-records', 'opencorporates.com', 'Global company register.'],
  ['criteo', 'Criteo', 'ad-tech', 'criteo.com', 'Ad retargeting and audience profiles.'],
  ['the-trade-desk', 'The Trade Desk', 'ad-tech', 'thetradedesk.com', 'Advertising platform and unified identifiers.'],
  ['lotame', 'Lotame', 'ad-tech', 'lotame.com', 'Audience data platform (DMP).'],
  ['bluekai', 'BlueKai', 'ad-tech', 'bluekai.com', 'Audience data management and targeting.'],
  ['neustar', 'Neustar', 'ad-tech', 'home.neustar', 'Identity resolution and targeting data.'],
  ['tapad', 'Tapad', 'ad-tech', 'tapad.com', 'Cross-device graph.'],
  ['quantcast', 'Quantcast', 'ad-tech', 'quantcast.com', 'Audience measurement and targeting.'],
  ['taboola', 'Taboola', 'ad-tech', 'taboola.com', 'Content recommendation and profiling.'],
  ['adobe-audience', 'Adobe Audience Manager', 'ad-tech', 'adobe.com/experience-cloud', 'Cross-device audience segments.'],
  ['near-data', 'Near', 'location-data', 'near.co', 'Location and mobility data.'],
  ['safegraph', 'SafeGraph', 'location-data', 'safegraph.com', 'Places and foot traffic data.'],
  ['placer-ai', 'Placer.ai', 'location-data', 'placer.ai', 'Geolocated foot traffic analytics.'],
  ['x-mode', 'X-Mode Social', 'location-data', 'xmode.io', 'Location data collected from apps.'],
  ['veraset', 'Veraset', 'location-data', 'veraset.com', 'Device movement data feeds.'],
  ['venntel', 'Venntel', 'location-data', 'venntel.com', 'Mobile device location data.'],
];

const AXES = [
  ['claude-ai', 'Claude.ai', 'Conversation history with the assistant.', 'ai-chat'],
  ['facebook-messenger', 'Facebook Messenger', 'Messenger messages and threads.', 'messaging'],
  ['quora', 'Quora', 'Published questions, answers and comments.', 'q-and-a'],
  ['wordpress', 'WordPress', 'Blog posts and comments.', 'blog'],
  ['discord', 'Discord', 'Server and channel messages.', 'chat'],
];

const DEFAULT_SETTINGS = { theme: 'dark', mode: 'demo', language: 'en' };

function migrate(d) {
  d.exec(SCHEMA);
  const insClaw = d.prepare('INSERT INTO claw VALUES (?,?,?,?,?,1,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, website=excluded.website, description=excluded.description');
  for (const c of CLAWS) insClaw.run(...c);
  const insAxe = d.prepare('INSERT INTO axe VALUES (?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, category=excluded.category');
  for (const a of AXES) insAxe.run(...a);
  const insSet = d.prepare('INSERT OR IGNORE INTO setting VALUES (?,?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSet.run(k, JSON.stringify(v));
}

// Open the database once. FORGET_DB_PATH can override the path.
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
