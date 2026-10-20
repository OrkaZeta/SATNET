import {cp, mkdir, rename, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const SEED_DIR = process.env.SEED_DIR ?? '/seed-data';
const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const feeds = [
    {
        name: 'launchlog.tsv',
        url: 'https://planet4589.org/space/gcat/tsv/derived/launchlog.tsv',
        headers: ['#Launch_Tag', 'Launch_Date', 'Launch_Site', 'LVState'],
        minimumRows: 1000,
    },
    {
        name: 'sites.tsv',
        url: 'https://planet4589.org/space/gcat/tsv/tables/sites.tsv',
        headers: ['#Site', 'Type', 'TStart', 'TStop', 'Longitude', 'Latitude'],
        minimumRows: 20,
    },
];

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

async function seedMissingFiles() {
    await mkdir(DATA_DIR, {recursive: true});
    // The shared volume replaces the image's /data directory, so retain all
    // bundled static assets (country map, TLE files, etc.) on first startup.
    await cp(SEED_DIR, DATA_DIR, {recursive: true, force: false, errorOnExist: false});
    for (const feed of feeds) {
        const file = join(DATA_DIR, feed.name);
        const info = await stat(file);
        if (!info.size) throw new Error(`Seed data file is empty: ${feed.name}`);
    }
    log('Seeded missing static data files from the bundled snapshot');
}

async function downloadFeed(feed) {
    const response = await fetch(feed.url, {signal: AbortSignal.timeout(60_000)});
    if (!response.ok) throw new Error(`${feed.name}: HTTP ${response.status}`);

    const body = await response.text();
    const firstLine = body.split(/\r?\n/, 1)[0];
    const columns = firstLine.replace(/^#/, '').split('\t');
    const missingHeaders = feed.headers.filter((header) => !columns.includes(header.replace(/^#/, '')));
    const rows = body.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).length;

    if (missingHeaders.length) throw new Error(`${feed.name}: missing columns ${missingHeaders.join(', ')}`);
    if (rows < feed.minimumRows) throw new Error(`${feed.name}: only ${rows} data rows; refusing update`);

    const updated = body.match(/^# Updated .*$/m)?.[0] ?? 'source update timestamp unavailable';
    return {feed, body, rows, updated};
}

async function update() {
    try {
        // Validate every feed before replacing either current file.
        const downloads = await Promise.all(feeds.map(downloadFeed));
        const staged = [];

        for (const {feed, body, rows, updated} of downloads) {
            const temporary = join(DATA_DIR, `.${feed.name}.${process.pid}.tmp`);
            await writeFile(temporary, body, {encoding: 'utf8', mode: 0o644});
            staged.push({feed, temporary, rows, updated});
        }

        for (const {feed, temporary, rows, updated} of staged) {
            await rename(temporary, join(DATA_DIR, feed.name));
            log(`Updated ${feed.name}: ${rows} rows (${updated})`);
        }
        return true;
    } catch (error) {
        log(`Update failed; keeping the last valid data: ${error.message}`);
        return false;
    }
}

await seedMissingFiles();
await update();
log('Next data update in 7 days');
setInterval(update, INTERVAL_MS);
