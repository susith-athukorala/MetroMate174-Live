// ======================================
// MetroMate174
// Adelaide Metro Dashboard
// ======================================

const OUTBOUND_STOP = "12429";
const INBOUND_STOP = "13278";

const REALTIME_API =
"https://trip-updates-worker.susithathukorala-8d7.workers.dev/?stop=";
const API =
    "https://api-cloudfront.adelaidemetro.com.au/stops/next-scheduled-services?stop=";


// -------------------------------
// Stop locations (for the live map + distance)
// -------------------------------

const STOPS = {

    [OUTBOUND_STOP]: {
        name: "Stop 21 Lower North East Rd",
        lat: -34.880273,
        lon: 138.662438
    },

    [INBOUND_STOP]: {
        name: "Stop I1 North Tce",
        lat: -34.920937,
        lon: 138.608466
    }

};


// -------------------------------
// Bus tracking (v4)
//
// The Adelaide Metro "next scheduled services" list drops a bus the
// instant its scheduled time passes, and the realtime feed can drop
// its stop entry when the predicted time passes, even if a delayed
// bus is still several minutes away. So the app picks one bus (a
// trip_id), follows its live GPS, and only lets go of it once it has
// actually reached the stop and moved on.
//
//  - The tracked bus is saved in localStorage, so a page refresh (or
//    the phone killing the tab) does not lose it.
//  - A fresh page can adopt a bus that the schedule list has already
//    dropped, as long as the realtime feed still lists it.
//  - If GPS goes quiet, the last known position stays on the map
//    (faded, "last seen X min ago") instead of disappearing.
// -------------------------------

const STORAGE_KEY = "metromate174.tracking.v4";

const APPROACH_KM = 0.15;            // within ~150 m: at / arriving at the stop
const PASSED_MARGIN_KM = 0.15;       // this far beyond its closest point = it has gone past
const FAR_PASS_KM = 0.6;             // GPS can skip the stop zone, so also check coarsely...
const FAR_PASS_MARGIN_KM = 0.35;     // ...came this close, then moved this much further, heading away
const WAKE_PASS_MARGIN_KM = 1.0;     // heading away and this much further than closest point (e.g. phone slept)
const GPS_STALE_MS = 30 * 1000;      // no fresh GPS for this long: show as "last seen"
const GPS_LOST_LIMIT_MS = 6 * 60 * 1000;      // no GPS for this long: give up on the bus
const NO_GPS_AFTER_DUE_MS = 8 * 60 * 1000;    // never had GPS and now well past due: give up
const MAX_TRACK_AFTER_DUE_MS = 25 * 60 * 1000; // absolute cap past the due time
const RESTORE_MAX_AGE_MS = 25 * 60 * 1000;    // ignore saved tracking older than this
const WATCH_GAP_MS = 60 * 1000;      // we had no look at the bus for this long (phone asleep, feed gap)
const COLD_START_NO_GPS_S = 5 * 60;  // new page, no GPS: only adopt if due within the last 5 min

function blankState(){
    return {
        tripId: null,
        snapshot: null,
        lockedAt: null,
        dueMs: null,
        minKm: null,
        lastVehicle: null,
        lastSeen: null,
        lastTouched: null,
        doneTrips: []
    };
}

const tracked = {
    [OUTBOUND_STOP]: blankState(),
    [INBOUND_STOP]: blankState()
};

function saveTracking(){
    try {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ savedAt: Date.now(), tracked })
        );
    } catch (e) { /* storage unavailable — tracking still works in memory */ }
}

function restoreTracking(){
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;

        const saved = JSON.parse(raw);
        if (!saved || !saved.tracked) return;

        for (const key of Object.keys(tracked)) {

            const s = saved.tracked[key];
            if (!s) continue;

            const restored = Object.assign(blankState(), s);

            const age = Date.now() - (s.lastTouched || saved.savedAt || 0);

            if (age > RESTORE_MAX_AGE_MS) {
                // Too old to trust the bus, but keep the "already
                // handled" list so we don't re-adopt a gone trip.
                restored.tripId = null;
                restored.snapshot = null;
            }

            tracked[key] = restored;
        }
    } catch (e) { /* corrupt or unavailable storage — start fresh */ }
}

function releaseBus(stopKey){

    const state = tracked[stopKey];

    const done = state.doneTrips || [];

    if (state.tripId) done.unshift(String(state.tripId));

    // Reset in place: callers hold a reference to this same object.
    Object.assign(
        state,
        blankState(),
        { doneTrips: done.slice(0, 12) }
    );

}

function isDone(stopKey, tripId){
    return (tracked[stopKey].doneTrips || []).includes(String(tripId));
}

function bearingBetween(lat1, lon1, lat2, lon2){

    const rad = d => d * Math.PI / 180;

    const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
    const x =
        Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
        Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));

    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

}

function angleDiff(a, b){

    const d = Math.abs(a - b) % 360;

    return d > 180 ? 360 - d : d;

}

// True when the bus is heading away from the stop (more than 100 degrees
// off a straight line towards it).
function movingAway(vehicle, stop){

    if (vehicle.bearing === null || vehicle.bearing === undefined) return false;

    const toStop = bearingBetween(
        vehicle.lat, vehicle.lon, stop.lat, stop.lon
    );

    return angleDiff(vehicle.bearing, toStop) > 100;

}

// Quick single-sample guess used only when a fresh page has no history:
// is this vehicle clearly beyond the stop already?
function looksPassed(vehicle, stop){

    if (!vehicle) return false;

    const km = distanceKm(vehicle.lat, vehicle.lon, stop.lat, stop.lon);

    if (km <= APPROACH_KM) return false;

    return km < 3 && movingAway(vehicle, stop);

}

// Has the tracked bus reached the stop and gone on past it?
function hasPassed(state, vehicle, stop, km){

    const min = state.minKm;

    if (min === null) return false;

    // Reached the stop area, then moved clearly away from its closest point.
    if (min <= APPROACH_KM && km >= min + PASSED_MARGIN_KM) return true;

    // GPS fixes can skip the stop zone, so also catch "came close, then
    // clearly heading away".
    if (min <= FAR_PASS_KM && km >= min + FAR_PASS_MARGIN_KM &&
        movingAway(vehicle, stop)) return true;

    // Long gap (e.g. phone asleep): well beyond its closest point and heading away.
    if (km >= min + WAKE_PASS_MARGIN_KM && movingAway(vehicle, stop)) return true;

    return false;

}

function pickCandidate(stopKey, buses, trips){

    const stop = STOPS[stopKey];
    const nowS = Date.now() / 1000;

    const fromRealtime = trips.find(t =>
        !isDone(stopKey, t.tripId) &&
        (t.vehicle
            ? !looksPassed(t.vehicle, stop)
            : t.arrival >= nowS - COLD_START_NO_GPS_S)
    );

    const fromSchedule = buses.find(b => !isDone(stopKey, b.trip_id));

    if (!fromRealtime && !fromSchedule) return null;

    const rtMs = fromRealtime ? fromRealtime.arrival * 1000 : Infinity;

    let schMs = fromSchedule
        ? new Date(fromSchedule.arrival_time).getTime()
        : Infinity;

    if (!Number.isFinite(schMs)) schMs = Infinity;

    if (fromRealtime && rtMs <= schMs) {

        const bus = buses.find(
            b => String(b.trip_id) === String(fromRealtime.tripId)
        ) || {
            trip_id: fromRealtime.tripId,
            route_id: fromRealtime.route || "174",
            arrival_time: new Date(rtMs).toISOString(),
            min: Math.max(0, Math.ceil((rtMs - Date.now()) / 60000)),
            synthetic: true // schedule no longer lists it, so no timetable time to compare with
        };

        return { bus, trip: fromRealtime };

    }

    return {
        bus: fromSchedule,
        trip: trips.find(
            t => String(t.tripId) === String(fromSchedule.trip_id)
        ) || null
    };

}

function resolveFocusBus(stopKey, buses, realtime){

    const state = tracked[stopKey];
    const stop = STOPS[stopKey];

    const trips = (realtime && realtime.trips) || [];
    const vehicles = (realtime && realtime.vehicles) || {};

    const nowMs = Date.now();

    if (state.tripId) {

        const trip = trips.find(
            t => String(t.tripId) === String(state.tripId)
        );

        const vehicle = vehicles[state.tripId] || null;

        if (trip) {
            state.dueMs = Math.max(state.dueMs || 0, trip.arrival * 1000);
        }

        let release = false;

        if (vehicle) {

            // How long since we last saw this bus on GPS (before this cycle).
            const unwatchedMs = state.lastSeen ? nowMs - state.lastSeen : 0;

            state.lastVehicle = vehicle;
            state.lastSeen = nowMs;

            const km = distanceKm(
                vehicle.lat, vehicle.lon, stop.lat, stop.lon
            );

            state.minKm = state.minKm === null
                ? km
                : Math.min(state.minKm, km);

            if (hasPassed(state, vehicle, stop, km)) release = true;

            // If we lost sight of it for a while, it may have gone through
            // the stop zone unseen. Back in view and clearly heading away
            // from the stop = it has passed.
            if (unwatchedMs > WATCH_GAP_MS && looksPassed(vehicle, stop)) {
                release = true;
            }

        } else if (state.lastSeen) {

            if (nowMs - state.lastSeen > GPS_LOST_LIMIT_MS) release = true;

        } else if (nowMs > (state.dueMs || 0) + NO_GPS_AFTER_DUE_MS) {

            // We never saw this bus on GPS and it is well past due.
            release = true;

        }

        if (nowMs > (state.dueMs || 0) + MAX_TRACK_AFTER_DUE_MS) release = true;

        if (release) releaseBus(stopKey);

    }

    if (!state.tripId) {

        const pick = pickCandidate(stopKey, buses, trips);

        if (!pick) {
            saveTracking();
            return {
                bus: null, trip: null, vehicle: null,
                stale: false, lastSeen: null, dueMs: null
            };
        }

        const candidateMs = new Date(pick.bus.arrival_time).getTime();

        state.tripId = pick.bus.trip_id;
        state.snapshot = pick.bus;
        state.lockedAt = nowMs;
        state.minKm = null;
        state.lastVehicle = null;
        state.lastSeen = null;
        state.dueMs = Math.max(
            Number.isFinite(candidateMs) ? candidateMs : 0,
            pick.trip ? pick.trip.arrival * 1000 : 0
        );

        const live = vehicles[state.tripId] || (pick.trip && pick.trip.vehicle);

        if (live) {
            state.lastVehicle = live;
            state.lastSeen = nowMs;
            state.minKm = distanceKm(live.lat, live.lon, stop.lat, stop.lon);
        }

    }

    state.lastTouched = nowMs;

    const bus = buses.find(
        b => String(b.trip_id) === String(state.tripId)
    ) || state.snapshot;

    const trip = trips.find(
        t => String(t.tripId) === String(state.tripId)
    ) || null;

    const liveVehicle = vehicles[state.tripId] || null;

    const vehicle = liveVehicle || state.lastVehicle;

    const stale = !liveVehicle && !!vehicle &&
        (nowMs - (state.lastSeen || 0) > GPS_STALE_MS);

    saveTracking();

    return {
        bus,
        trip,
        vehicle,
        stale,
        lastSeen: state.lastSeen,
        dueMs: state.dueMs
    };

}

function mergeFocusIntoList(focusBus, buses){

    if (!focusBus) return buses;

    const alreadyThere = buses.some(
        b => String(b.trip_id) === String(focusBus.trip_id)
    );

    return alreadyThere ? buses : [focusBus, ...buses];

}

restoreTracking();


// -------------------------------
// Register service worker
// -------------------------------

if ("serviceWorker" in navigator) {

    window.addEventListener("load", () => {

        navigator.serviceWorker
            .register("./sw.js")
            .catch(err =>
                console.error("Service worker registration failed:", err)
            );

    });

}


// -------------------------------
// Live Clock
// -------------------------------

function updateClock() {

    const now = new Date();

    document.getElementById("clock").textContent =
        now.toLocaleTimeString("en-AU");

}

setInterval(updateClock,1000);
updateClock();



// -------------------------------
// Format time
// -------------------------------

function formatTime(timeString){

    const d=new Date(timeString);

    return d.toLocaleTimeString(
        "en-AU",
        {
            hour:"2-digit",
            minute:"2-digit"
        }
    );

}



// -------------------------------
// Badge Colour
// -------------------------------

function badge(minutes){

    let colour="grey";
    let label = `${minutes} min`;

    if(minutes<=0){

        colour="red";
        label="Due";

    }
    else if(minutes<=3){

        colour="red";

    }
    else if(minutes<=10){

        colour="orange";

    }
    else{

        colour="green";

    }

    return `<span class="badge ${colour}">
                ${label}
            </span>`;

}



// -------------------------------
// Distance between two GPS points (Haversine, in km)
// -------------------------------

function distanceKm(lat1, lon1, lat2, lon2){

    const R = 6371;

    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;

}


// -------------------------------
// Speed / heading / stops-away display
// -------------------------------

function bearingToCompass(bearing){

    const directions =
        ["N","NE","E","SE","S","SW","W","NW"];

    const index = Math.round(bearing / 45) % 8;

    return directions[index];

}

function stopsAwayLabel(stopsAway){

    if (stopsAway === 0) return "Approaching your stop";
    if (stopsAway === 1) return "1 stop away";

    return `${stopsAway} stops away`;

}

function vehicleStatusLabel(vehicle){

    const speedKmh = Math.round((vehicle.speed || 0) * 3.6);

    if (speedKmh <= 2) return "stopped";

    const compass =
        vehicle.bearing !== null && vehicle.bearing !== undefined
            ? ` heading ${bearingToCompass(vehicle.bearing)}`
            : "";

    return `${speedKmh} km/h${compass}`;

}


// -------------------------------
// Live bus mini-maps
// -------------------------------

const busIcon = L.divIcon({
    className: "",
    html: "🚌",
    iconSize: [28, 28],
    iconAnchor: [14, 14]
});

const stopIcon = L.divIcon({
    className: "",
    html: "📍",
    iconSize: [26, 26],
    iconAnchor: [13, 26]
});

const maps = {};

function initMap(stopKey, mapElementId){

    const stop = STOPS[stopKey];

    const map = L.map(mapElementId, {
        zoomControl: false,
        attributionControl: false
    }).setView([stop.lat, stop.lon], 14);

    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        { maxZoom: 18 }
    ).addTo(map);

    L.control.attribution({ prefix: false })
        .addAttribution("&copy; OpenStreetMap contributors")
        .addTo(map);

    const stopMarker = L.marker([stop.lat, stop.lon], { icon: stopIcon })
        .addTo(map)
        .bindPopup(stop.name);

    const busMarker = L.marker([stop.lat, stop.lon], { icon: busIcon })
        .bindPopup("Route 174");

    maps[stopKey] = { map, stopMarker, busMarker, busVisible: false };

}

function updateBusMap(stopKey, distanceElementId, focus){

    const entry = maps[stopKey];
    const distanceEl = document.getElementById(distanceElementId);

    if (!entry) return;

    const stop = STOPS[stopKey];

    const topBus = focus && focus.bus;
    const trip = focus && focus.trip;
    const vehicle = focus && focus.vehicle;

    if (!topBus) {

        distanceEl.textContent = "No upcoming Route 174 services";
        distanceEl.classList.remove("live");

        if (entry.busVisible) {
            entry.map.removeLayer(entry.busMarker);
            entry.busVisible = false;
        }

        return;
    }

    if (!vehicle) {

        distanceEl.textContent =
            "Live GPS unavailable for the next bus — showing stop only";
        distanceEl.classList.remove("live");

        if (entry.busVisible) {
            entry.map.removeLayer(entry.busMarker);
            entry.busVisible = false;
        }

        entry.map.setView([stop.lat, stop.lon], 14);

        return;
    }

    const stopsAway =
        trip && typeof trip.stopsAway === "number" ? trip.stopsAway : null;

    const km = distanceKm(vehicle.lat, vehicle.lon, stop.lat, stop.lon);

    let statusText;
    let popupText;

    if (focus.stale) {

        const minsAgo = Math.round((Date.now() - focus.lastSeen) / 60000);

        const when = minsAgo < 1 ? "under a minute ago" : `${minsAgo} min ago`;

        statusText = `🚌 GPS paused — last seen ${when}`;
        popupText = `Route 174 — last known position, seen ${when}`;

    } else if (km <= APPROACH_KM) {

        statusText = "🚌 At your stop";
        popupText = "Route 174 — at your stop";

    } else if (stopsAway !== null) {

        statusText = `🚌 ${stopsAwayLabel(stopsAway)} — ${vehicleStatusLabel(vehicle)}`;
        popupText = `Route 174 — ${stopsAwayLabel(stopsAway)}, ${vehicleStatusLabel(vehicle)}`;

    } else {

        statusText = `🚌 On the way — ${vehicleStatusLabel(vehicle)}`;
        popupText = `Route 174 — on the way, ${vehicleStatusLabel(vehicle)}`;

    }

    distanceEl.textContent = statusText;
    distanceEl.classList.toggle("live", !focus.stale);

    entry.busMarker.setLatLng([vehicle.lat, vehicle.lon]);
    entry.busMarker.setOpacity(focus.stale ? 0.5 : 1);
    entry.busMarker.setPopupContent(popupText);

    if (!entry.busVisible) {
        entry.busMarker.addTo(entry.map);
        entry.busVisible = true;
    }

    entry.map.fitBounds(
        L.latLngBounds(
            [vehicle.lat, vehicle.lon],
            [stop.lat, stop.lon]
        ),
        { padding: [30, 30], maxZoom: 15 }
    );

}


// -------------------------------
// Build Table
// -------------------------------

function populateTable(tableId, buses, realtime, focus){

    const tbody = document.querySelector(
        "#" + tableId + " tbody"
    );

    tbody.innerHTML = "";

    if(buses.length === 0){

        tbody.innerHTML = `
        <tr>
            <td colspan="3">
                No Route 174 services
            </td>
        </tr>`;

        return;
    }

    buses.forEach(bus => {

        const row = document.createElement("tr");


        let arrival = formatTime(bus.arrival_time);
        let minutes = bus.min;
    

const trip = (realtime.trips || []).find(
    t => String(t.tripId) === String(bus.trip_id)
);

if (trip) {

    const scheduled =
        Math.round(
            new Date(bus.arrival_time).getTime() / 1000
        );

    const delay =
        Math.round(
            (trip.arrival - scheduled) / 60
        );

    const liveMinutes =
    Math.max(
        0,
        Math.ceil(
            (trip.arrival * 1000 - Date.now()) / 60000
        )
    );

    minutes = liveMinutes;

    arrival = new Date(trip.arrival * 1000)
        .toLocaleTimeString("en-AU", {
            hour: "2-digit",
            minute: "2-digit"
        });

    if (bus.synthetic) {

    arrival += " 🚌 Live";

}
else if (Math.abs(delay) <= 1) {

    arrival += " 🟢 On time";

}
else if (delay > 0 && delay <= 5) {

    arrival += ` 🟠 ${delay} min late`;

}
else if (delay > 5) {

    arrival += ` 🔴 ${delay} min late`;

}
else {

    arrival += ` 🔵 ${Math.abs(delay)} min early`;

}
}


if (!trip) {

    const isFocus =
        focus && focus.bus &&
        String(bus.trip_id) === String(focus.bus.trip_id);

    if (isFocus) {

        // Tracked bus that the feeds have stopped listing: keep it on
        // the board, show it as due, and say it is followed by GPS.
        minutes = Math.max(
            0,
            Math.ceil(((focus.dueMs || Date.now()) - Date.now()) / 60000)
        );

        if (focus.vehicle) {

            arrival += focus.stale
                ? " ⚪ GPS paused"
                : " 🚌 Tracking by GPS";

        } else {

            // No GPS at all for this bus: don't claim we are tracking it.
            arrival += (focus.dueMs || 0) > Date.now()
                ? " 🟡 Scheduled"
                : " ⚪ Live unavailable";

        }

    } else {

        const scheduledTime = new Date(bus.arrival_time);

        if (scheduledTime > new Date()) {
            arrival += " 🟡 Scheduled";
        } else {
            arrival += " ⚪ Live unavailable";
        }

    }

}


        row.innerHTML = `
    <td>${bus.route_id}</td>
    <td>${arrival}</td>
    <td>${badge(minutes)}</td>
`;

        tbody.appendChild(row);

    });

}



// -------------------------------
// Load One Stop
// -------------------------------

async function loadStop(stop){

    try{

        const response=
            await fetch(API+stop);

        const json=
            await response.json();

        // API returns array
        // services are in index 2

        const services=json[2] || [];

        return services
            .filter(x=>x.route_id==="174")
            .slice(0,10);

    }

    catch(e){

        console.error(e);

        return [];

    }

}

async function loadRealtime(stop) {

    try {

        const response = await fetch(
            REALTIME_API + stop
        );

        const json = await response.json();

        // Older worker versions returned a bare array of trips.
        if (Array.isArray(json)) return { trips: json, vehicles: {} };

        return {
            trips: json.trips || [],
            vehicles: json.vehicles || {}
        };

    }

    catch(e){

        console.error(e);

        return { trips: [], vehicles: {} };

    }

}


// -------------------------------
// Load Dashboard
// -------------------------------

async function loadDashboard(){

    const outboundAll = await loadStop(OUTBOUND_STOP);
    const inboundAll = await loadStop(INBOUND_STOP);

    const outboundRealtime = await loadRealtime(OUTBOUND_STOP);
    const inboundRealtime = await loadRealtime(INBOUND_STOP);

    const outboundFocus =
        resolveFocusBus(OUTBOUND_STOP, outboundAll, outboundRealtime);

    const inboundFocus =
        resolveFocusBus(INBOUND_STOP, inboundAll, inboundRealtime);

    // A bus we have already seen reach and pass the stop should not
    // linger in the list just because its scheduled time is still ahead
    // (an early bus).
    const outbound =
        outboundAll.filter(b => !isDone(OUTBOUND_STOP, b.trip_id));

    const inbound =
        inboundAll.filter(b => !isDone(INBOUND_STOP, b.trip_id));

    populateTable(
        "outboundTable",
        mergeFocusIntoList(outboundFocus.bus, outbound),
        outboundRealtime,
        outboundFocus
    );

    populateTable(
        "inboundTable",
        mergeFocusIntoList(inboundFocus.bus, inbound),
        inboundRealtime,
        inboundFocus
    );

    updateBusMap(OUTBOUND_STOP, "outboundDistance", outboundFocus);
    updateBusMap(INBOUND_STOP, "inboundDistance", inboundFocus);

    document.getElementById(
        "updated"
    ).textContent=
        "Last updated : "
        + new Date().toLocaleTimeString("en-AU");

}



// -------------------------------
// Init maps, then start refreshing
// -------------------------------

initMap(OUTBOUND_STOP, "outboundMap");
initMap(INBOUND_STOP, "inboundMap");

loadDashboard();

setInterval(
    loadDashboard,
    10000
);
