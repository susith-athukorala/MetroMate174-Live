// ======================================
// MetroMate174
// Adelaide Metro Dashboard
// ======================================

const OUTBOUND_STOP = "12429";
const INBOUND_STOP = "13278";

const REALTIME_API =
"https://metromate-tripupdates.susithathukorala-8d7.workers.dev/?stop=";
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
// Bus tracking
//
// The Adelaide Metro "next scheduled services" list drops a bus the
// instant its scheduled time passes, even if the real bus is still a
// minute or two from the stop. To keep it visible until it actually
// gets there, once we lock onto a trip_id we keep following that same
// bus (via the worker's realtime feed) rather than jumping to
// whatever the schedule API now calls "next" — and only let go of it
// once its live GPS is close enough to the stop to count as arrived.
// -------------------------------

const ARRIVED_DISTANCE_KM = 0.12; // ~120m — close enough to call it arrived
const MAX_MISSED_CYCLES = 6;      // ~1 min of gaps in the feed before giving up

const tracked = {
    [OUTBOUND_STOP]: { tripId: null, snapshot: null, missed: 0 },
    [INBOUND_STOP]: { tripId: null, snapshot: null, missed: 0 }
};

function resolveFocusBus(stopKey, buses, realtime){

    const state = tracked[stopKey];
    const stop = STOPS[stopKey];

    let trip = state.tripId &&
        realtime.find(t => String(t.tripId) === String(state.tripId));

    if (trip) {

        state.missed = 0;

        if (trip.vehicle) {

            const km = distanceKm(
                trip.vehicle.lat, trip.vehicle.lon,
                stop.lat, stop.lon
            );

            if (km <= ARRIVED_DISTANCE_KM) {

                // It made it to the stop — stop tracking it, the
                // next cycle will pick up whichever bus is next.
                state.tripId = null;
                state.snapshot = null;
                trip = null;

            }

        }

    } else if (state.tripId) {

        // Missing from this cycle — could be a brief gap in the
        // feed, could mean the trip has genuinely ended. Give it a
        // few cycles before giving up on it.
        state.missed++;

        if (state.missed > MAX_MISSED_CYCLES) {

            state.tripId = null;
            state.snapshot = null;
            state.missed = 0;

        }

    }

    if (state.tripId) {

        const bus = buses.find(
            b => String(b.trip_id) === String(state.tripId)
        ) || state.snapshot;

        return { bus, trip: trip || null };

    }

    // Nothing tracked yet — adopt the next scheduled bus.
    const candidate = buses[0];

    if (!candidate) return { bus: null, trip: null };

    state.tripId = candidate.trip_id;
    state.snapshot = candidate;
    state.missed = 0;

    const candidateTrip = realtime.find(
        t => String(t.tripId) === String(candidate.trip_id)
    );

    return { bus: candidate, trip: candidateTrip || null };

}

function mergeFocusIntoList(focusBus, buses){

    if (!focusBus) return buses;

    const alreadyThere = buses.some(
        b => String(b.trip_id) === String(focusBus.trip_id)
    );

    return alreadyThere ? buses : [focusBus, ...buses];

}


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
    const vehicle = trip && trip.vehicle;

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

    const stopsAway = typeof trip.stopsAway === "number" ? trip.stopsAway : null;

    const statusText =
        stopsAway !== null
            ? `🚌 ${stopsAwayLabel(stopsAway)} — ${vehicleStatusLabel(vehicle)}`
            : `🚌 ${vehicleStatusLabel(vehicle)} (live GPS)`;

    distanceEl.textContent = statusText;
    distanceEl.classList.add("live");

    entry.busMarker.setLatLng([vehicle.lat, vehicle.lon]);
    entry.busMarker.setPopupContent(
        `Route 174 — ${stopsAway !== null ? stopsAwayLabel(stopsAway) : "en route"}, ${vehicleStatusLabel(vehicle)}`
    );

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

function populateTable(tableId, buses, realtime){

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
    

const trip = realtime.find(
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

    if (Math.abs(delay) <= 1) {

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

    const scheduledTime = new Date(bus.arrival_time);

    if (scheduledTime > new Date()) {
        arrival += " 🟡 Scheduled";
    } else {
        arrival += " ⚪ Live unavailable";
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

    const response = await fetch(
        REALTIME_API + stop
    );

    return await response.json();

}


// -------------------------------
// Load Dashboard
// -------------------------------

async function loadDashboard(){

    const outbound =
    await loadStop(OUTBOUND_STOP);

const inbound =
    await loadStop(INBOUND_STOP);

const outboundRealtime =
    await loadRealtime(OUTBOUND_STOP);

const inboundRealtime =
    await loadRealtime(INBOUND_STOP);

const outboundFocus =
    resolveFocusBus(OUTBOUND_STOP, outbound, outboundRealtime);

const inboundFocus =
    resolveFocusBus(INBOUND_STOP, inbound, inboundRealtime);

populateTable(
    "outboundTable",
    mergeFocusIntoList(outboundFocus.bus, outbound),
    outboundRealtime
);

populateTable(
    "inboundTable",
    mergeFocusIntoList(inboundFocus.bus, inbound),
    inboundRealtime
);

updateBusMap(
    OUTBOUND_STOP,
    "outboundDistance",
    outboundFocus
);

updateBusMap(
    INBOUND_STOP,
    "inboundDistance",
    inboundFocus
);

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
