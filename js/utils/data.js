// js/utils/data.js
import * as d3 from "d3";
import * as Cesium from "cesium";
import * as satellite from "satellite.js";
import {ctx} from "/js/utils/config";
import {getCachedData, isCacheValid, saveToCache} from "/js/utils/cacheUtils";
import {EARTH_RADIUS_METERS, ORBIT_TYPES} from "/js/utils/constants.js";

// Keep col: #Launch_Tag, Launch_Date, Piece, Name, PLName, SatOwner, SatState, Launch_Site
const REQUIRED_COLUMNS = ["#Launch_Tag", "Launch_Date", "Piece", "Name", "PLName", "SatOwner", "SatState", "Launch_Site", "LVState"];
const SITE_REQUIRED_COLUMNS = ["#Site", "Longitude", "Latitude", "Type", "TStart", "TStop"];
const MONTH_INDEX = {jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11};

export function dataUpdate(data, currentDate) {
    const oneYearAgo = new Date(currentDate.getTime() - 365 * 24 * 60 * 60 * 1000);
    const filteredData = data.filter(d => d.Launch_Date >= oneYearAgo && d.Launch_Date <= currentDate);
    ctx.NUM_SC = Object.fromEntries(
        d3.group(filteredData, d => d.SatState)
            .entries()
            .map(([key, values]) => [key, values.length])
    );
    return null;
}

function parseStringDate(rawDatetime) {
    if (typeof rawDatetime !== "string" || !rawDatetime.trim()) return null;

    const match = rawDatetime.replaceAll('?', '').trim()
        .match(/^(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})(?:\s+(\d{1,4})(?::\d{1,2})?)?/);
    if (!match) return null;

    const [, yearText, monthText, dayText, timeText = "0000"] = match;
    const year = Number(yearText);
    const month = MONTH_INDEX[monthText.toLowerCase()];
    const day = Number(dayText);
    const time = timeText.padStart(4, "0");
    const hour = Number(time.slice(0, 2));
    const minute = Number(time.slice(2, 4));
    if (month === undefined || hour > 23 || minute > 59) return null;

    const parsedDatetime = new Date(year, month, day, hour, minute);
    if (parsedDatetime.getFullYear() !== year || parsedDatetime.getMonth() !== month || parsedDatetime.getDate() !== day) {
        return null;
    }
    return parsedDatetime;
}

function updateClockStopTime(data) {
    if (!Array.isArray(data) || !data.length || !ctx.view3D?.clock) return;

    const latestLaunchDate = d3.max(data, row => new Date(row.Launch_Date));
    if (!latestLaunchDate || !Number.isFinite(latestLaunchDate.getTime())) return;

    const stopDate = latestLaunchDate > new Date() ? latestLaunchDate : new Date();
    ctx.view3D.clock.stopTime = Cesium.JulianDate.fromDate(stopDate);
    if (ctx.view2D?.clock) ctx.view2D.clock.stopTime = ctx.view3D.clock.stopTime;
}

export async function loadSites() {
    if (await isCacheValid(ctx.SITES.CACHE_KEY)) {
        ctx.SITES.DATA = await getCachedData(ctx.SITES.CACHE_KEY);
        console.log("Fetched sites data from cache");
        return ctx.SITES.DATA;
    }

    try {
        const data = await d3.dsv('\t', ctx.SITES.URL);
        const parsedData = data.map(row => ({
            ...row
        }));
        let cleanedData = parsedData.map(row => {
            const cleanedRow = {};
            SITE_REQUIRED_COLUMNS.forEach(col => cleanedRow[col] = row[col] ?? '');
            return cleanedRow;
        });
        cleanedData = cleanedData.filter(d => {
            const longitude = Number(d.Longitude);
            const latitude = Number(d.Latitude);
            return d.Type === "LS" && Number.isFinite(longitude) && Number.isFinite(latitude) &&
                longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90;
        });
        // console.log(cleanedData);
        ctx.SITES.DATA = cleanedData.reduce((acc, site) => {
            const siteKey = site["#Site"].trim();
            const longitude = parseFloat(site["Longitude"]);
            const latitude = parseFloat(site["Latitude"]);

            acc[siteKey] = {Longitude: longitude, Latitude: latitude};
            return acc;
        }, {});

        saveToCache(ctx.SITES.CACHE_KEY, ctx.SITES.DATA, ctx.CACHE_DURATION).then(() => console.log("Fetched sites data from server"));

        return ctx.SITES.DATA;
    } catch (error) {
        console.error("Failed to fetch sites data", error);
        ctx.SITES.DATA = [];
    }
}

export async function loadCountry() {
    if (await isCacheValid(ctx.COUNTRY.CACHE_KEY)) {
        ctx.COUNTRY.DATA = await getCachedData(ctx.COUNTRY.CACHE_KEY);
        console.log("Fetched country data from cache");
        return;
    }

    try {
        const data = await d3.dsv('\t', ctx.COUNTRY.URL);
        const parsedData = data.map(row => ({
            ...row
        }));

        ctx.COUNTRY.DATA = parsedData.reduce((acc, site) => {
            const country = site["SatelliteState"].trim();
            const longitude = parseFloat(site["Longitude"]);
            const latitude = parseFloat(site["Latitude"]);

            acc[country] = {Longitude: longitude, Latitude: latitude};
            return acc;
        }, {});
        console.log("Fetched country data from server");

        saveToCache(ctx.COUNTRY.CACHE_KEY, ctx.COUNTRY.DATA, ctx.CACHE_DURATION).then(() => console.log("Saved launch log data to cache"));

        return ctx.COUNTRY.DATA;
    } catch (error) {
        console.error("Failed to fetch country data", error);
        ctx.COUNTRY.DATA = [];
    }
}

export async function loadLaunchLog() {
    if (await isCacheValid(ctx.LAUNCHLOG.CACHE_KEY)) {
        const cachedData = await getCachedData(ctx.LAUNCHLOG.CACHE_KEY);
        if (cachedData) {
            ctx.LAUNCHLOG.DATA = cachedData.map(row => ({
                ...row,
                Launch_Date: new Date(row.Launch_Date),
            }));
            updateClockStopTime(ctx.LAUNCHLOG.DATA);
            console.log("Fetched launch log data from cache");
            return;
        }
    }

    try {
        const data = await d3.dsv('\t', ctx.LAUNCHLOG.URL);

        // GCAT adds comment/metadata records (for example "# Updated ...")
        // after the TSV header. Ignore those and malformed individual rows so
        // one metadata line cannot discard the entire launch history.
        const parsedData = data
            .filter(row => {
                const launchTag = row["#Launch_Tag"]?.trim();
                return launchTag && !launchTag.startsWith("#");
            })
            .map(row => ({
                ...row,
                Launch_Date: parseStringDate(row.Launch_Date),
            }));

        const cleanedData = parsedData
            .filter(row => row.Launch_Date instanceof Date && Number.isFinite(row.Launch_Date.getTime()))
            .map(row => {
                const cleanedRow = {};
                REQUIRED_COLUMNS.forEach(col => cleanedRow[col] = row[col] ?? "");
                return cleanedRow;
            });

        if (!cleanedData.length) throw new Error("The launch log contains no rows with valid launch dates");
        ctx.LAUNCHLOG.DATA = cleanedData;
        console.log("Fetched launch log data from server");

        // Keep the playback range aligned with dates represented in the feed.
        // Weekly feed updates naturally move this boundary forward; avoid a
        // five-year empty tail after the newest known launch.
        updateClockStopTime(cleanedData);

        // Load sites data and match with location
        const siteData = await loadSites();
        cleanedData.forEach(launch => {
            const launchSite = launch.Launch_Site;
            const map_loc = siteData[launchSite];
            if (map_loc) launch["loc"] = map_loc;
            else launch["loc"] = null;
        });

        saveToCache(ctx.LAUNCHLOG.CACHE_KEY, cleanedData, ctx.CACHE_DURATION).then(() => console.log("Fetched launch log data from server"));
    } catch (error) {
        console.error("Failed to fetch launch log data", error);
        ctx.LAUNCHLOG.DATA = [];
    }
}

function determineOrbitType(altitude, inclination) {
    // Check for Sun-synchronous orbit
    if (inclination >= ORBIT_TYPES.SSO.inclMin && inclination <= ORBIT_TYPES.SSO.inclMax && altitude < ORBIT_TYPES.LEO.maxAltitude) {
        return ORBIT_TYPES.SSO.id;
    }

    // Determine by altitude ranges
    if (altitude < ORBIT_TYPES.LEO.maxAltitude) return ORBIT_TYPES.LEO.id;
    if (altitude >= ORBIT_TYPES.MEO.minAltitude && altitude < ORBIT_TYPES.MEO.maxAltitude) return ORBIT_TYPES.MEO.id;
    if (altitude >= ORBIT_TYPES.GEO.minAltitude && altitude <= ORBIT_TYPES.GEO.maxAltitude) return ORBIT_TYPES.GEO.id;
    if (altitude > ORBIT_TYPES.GEO.maxAltitude) return ORBIT_TYPES.HEO.id;

    return ORBIT_TYPES.UNKNOWN.id;
}

export async function loadOrbitsTLEDate(satGroup) {
    // Check if the satellite name exists ctx.SAT_GROUP
    const satName = satGroup.NAME;
    const satGroupCacheKey = satGroup.CACHE_KEY;
    const satGroupUrl = satGroup.URL;

    // Check if cache is still valid
    if (await isCacheValid(satGroupCacheKey)) {
        const cachedData = await getCachedData(satGroupCacheKey);
        if (cachedData) {
            satGroup.DATA = cachedData;
            console.log(`Fetched TLE data for ${satName} from cache`);
            return;
        }
    }

    try {
        const satellites = []; // [{SatName/ID, launch date, satrec}]

        const response = await fetch(satGroupUrl);
        const text = (await response.text()).replaceAll('\r', '');
        const lines = text.split('\n');
        // 3 lines by 3 lines process
        for (let idx = 0; idx + 2 < lines.length; idx += 3) {
            const line1 = lines[idx + 1]?.trim();
            const line2 = lines[idx + 2]?.trim();
            if (!line1 || !line2) {
                console.error(`${lines.length}, ${idx}`);
                console.error(`${lines[idx]}, ${lines[idx + 1]}, ${lines[idx + 2]}`);
                console.error(`Invalid TLE data for ${lines[idx].trim()}`);
                continue;
            }
            const satRec = satellite.twoline2satrec(line1, line2);
            // Semi-major axis in meters
            const semiMajorAxis = satRec.a * EARTH_RADIUS_METERS;
            // Orbital altitude in meters
            const altitude = semiMajorAxis - EARTH_RADIUS_METERS
            // Inclination in degrees
            const inclination = Cesium.Math.toDegrees(satRec.inclo);
            const orbitType = determineOrbitType(altitude, inclination);

            // Name Date with some special processing
            const [name, launchDate, launchState] = satellitesAlignments(satGroup, lines[idx].trim());

            // sat rec
            if (satRec && launchDate) {
                satellites.push({
                    Name: name,
                    Launch_Date: launchDate,
                    Launch_State: launchState,
                    SatRec: satRec,
                    Orbit_Type: orbitType,
                    Orbit_Altitude: altitude,
                });
            } else {
                console.warn(`Failed to process TLE data for ${name}, ld:${launchDate}, rec:${satRec}`);
            }
        }

        satGroup.DATA = satellites;

        saveToCache(satGroupCacheKey, satellites).then(() => console.log(`Fetched TLE data for ${satName} from server`));
    } catch (error) {
        console.error(`Failed to fetch TLE data for ${satName}`, error);
        satGroup.DATA = [];
    }
}

function satellitesAlignments(satGroup, rawName) {
    let name, launchDate, launchState;
    switch (satGroup) {
        /****************************************** Communication Satellites ******************************************/
        case ctx.SAT_GROUP.STARLINK:
            name = rawName.replaceAll('-', ' ').split(' ').slice(0, 2).join(' ');
            ctx.LAUNCHLOG.DATA.find(row => {
                if (row.Name.toLowerCase() === name.toLowerCase()) {
                    launchDate = row.Launch_Date;
                    launchState = row.LVState;
                }
            });
            break;
        /******************************************* Navigation Satellites *******************************************/
        case ctx.SAT_GROUP.GPS:
            const _id = rawName.split("(")[1].trim().split(")")[0].split(" ")[1].replace(/^0+/, "")
            name = `GPS SVN ${_id}`;
            if (_id <= 7) name = `Navstar ${name}`;
            ctx.LAUNCHLOG.DATA.find(row => {
                if (row.PLName.toLowerCase() === name.toLowerCase()) {
                    launchDate = row.Launch_Date;
                    launchState = row.LVState;
                }
            });
            break;
        case ctx.SAT_GROUP.GLONASS:
            name = rawName.split("(")[0].trim().replaceAll("COSMOS", "Kosmos").replaceAll(" ", "-");
            ctx.LAUNCHLOG.DATA.find(row => {
                if (row.Name.toLowerCase() === name.toLowerCase()) {
                    launchDate = row.Launch_Date;
                    launchState = row.LVState;
                }
            });
            break;
        case ctx.SAT_GROUP.BEIDOU:
            // "BEIDOU-2 M4 (C12)       "->"BEIDOU-2 M4"
            name = rawName.split("(")[0].trim()
                .replace("BEIDOU-", "Beidou-")
                .replace(" IGSO-", " I")
                .replace(" M", " M")
                .replaceAll("S", "-S")
                .replace("Q", "Q")
                //Beidou-3-S I1-S -> Beidou-3 I1-S, Beidou-2-S W1-S -> Beidou-2 W1-S
                .replace(/Beidou-(\d+)-S\s*(\w+)/, "Beidou-$1 $2");
            ctx.LAUNCHLOG.DATA.find(row => {
                if (row.PLName.split("(")[0].trim().toLowerCase() === name.toLowerCase() ||
                    row.PLName.split("(")[0].trim().toLowerCase() === (name + "Q").toLowerCase()) {
                    launchDate = row.Launch_Date;
                    launchState = row.LVState;
                }
            });
            // console.log(`Beidou: ${rawName}->${name}, ${launchDate}`);
            break;
        case ctx.SAT_GROUP.GALILEO:
            // take number from the end of string "GSAT0206 (GALILEO 10)   " -> "10" / "GSAT0103 (GALILEO-FM3)  " -> "3"
            const namePrefix = "GalileoSat-";
            const trimmedName = rawName.trim();
            const match = trimmedName.match(/\(GALILEO(?:-([A-Z]+)(\d*))?\s*(\d+)?\)/);
            if (!match) return null; // No match found, return null or handle error
            let number;
            const prefixGroup = match[1]; // e.g. "FM" or "PFM" (might be undefined if not present)
            const fmNumber = match[2];    // e.g. "3" if "GALILEO-FM3"
            const standaloneNumber = match[3]; // e.g. "10" if "GALILEO 10"

            if (standaloneNumber) { // "GALILEO X" format
                number = standaloneNumber;
            } else if (prefixGroup) { // "GALILEO-FM#" or "GALILEO-PFM"
                if (prefixGroup === "PFM") { // PFM corresponds to satellite number 1
                    number = "1";
                } else { // FM group, number should be in fmNumber
                    number = fmNumber;
                }
            }
            name = `${namePrefix}${number}`;
            ctx.LAUNCHLOG.DATA.find(row => {
                if (row.Name.toLowerCase() === name.toLowerCase()) {
                    launchDate = row.Launch_Date;
                    launchState = row.LVState;
                }
            });
            // console.log(`Galileo: ${name}, ${launchDate}`);
            break;
        /********************************************* Weather Satellites *********************************************/
        case ctx.SAT_GROUP.NOAA:
            name = rawName.split("(")[0].trim().replaceAll(' ', '-');
            ctx.LAUNCHLOG.DATA.find(row => {
                if (row.Name.toLowerCase().replaceAll(' ', '-') === name.toLowerCase()) {
                    launchDate = row.Launch_Date;
                    launchState = row.LVState;
                }
            });
            // console.log(`NOAA: ${name}, ${launchDate}`);
            break;
        case ctx.SAT_GROUP.GOES:
            // find "GOES \d{1,2}"
            name = rawName.match(/GOES \d{1,2}/)[0].toString();
            ctx.LAUNCHLOG.DATA.find(row => {
                if (row.Name.toLowerCase() === name.toLowerCase()) {
                    launchDate = row.Launch_Date;
                    launchState = row.LVState;
                }
            });
            break;
        /********************************************* Science Satellites *********************************************/
        case ctx.SAT_GROUP.GEODETIC:
            name = rawName.split("(")[0].replaceAll(/ 1$/g, "").replaceAll("COSMOS", "Kosmos").trim().replaceAll(" ", "-");
            ctx.LAUNCHLOG.DATA.find(row => {
                if (row.Name.toLowerCase().replaceAll(" ", "-") === name.toLowerCase()) {
                    launchDate = row.Launch_Date;
                    launchState = row.LVState;
                }
            });
            break;
        default:
            console.error(`Invalid satellite group: ${satGroup}`);
            break;
    }
    if (!launchDate || !launchState) console.warn(`Geodetic: ${rawName} --> ${name}, ${launchDate}, ${launchState}`);
    return [name, launchDate, launchState];
}


export async function getFlagSvg(countryCode) {
    const cacheKey = `flag_${countryCode}`;
    const cachedSvg = localStorage.getItem(cacheKey);

    if (cachedSvg) {
        // If SVG is cached, return as a data URI
        return `data:image/svg+xml;base64,${btoa(cachedSvg)}`;
    }

    const url = `https://hatscripts.github.io/circle-flags/flags/${countryCode.toLowerCase()}.svg`;

    try {
        const response = await fetch(url);

        if (response.ok) {
            const svgText = await response.text();
            // Cache the SVG content in localStorage
            localStorage.setItem(cacheKey, svgText);
            // Return as a data URI
            return `data:image/svg+xml;base64,${btoa(svgText)}`;
        }
    } catch (error) {
        console.error(`Failed to fetch flag for ${countryCode}:`, error);
    }

    // Fallback: Return a generic placeholder or null
    return 'path_to_fallback_image.svg'; // Provide a valid fallback path
}
