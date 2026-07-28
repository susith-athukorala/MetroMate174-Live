// ======================================
// MetroMate174
// Adelaide Metro Dashboard
// ======================================

const OUTBOUND_STOP = "12501";
const INBOUND_STOP = "13284";

const API =
    "https://api-cloudfront.adelaidemetro.com.au/stops/next-scheduled-services?stop=";

// ======================================
// Live Vehicle API
// ======================================

const VEHICLE_API =
"https://metromate174-proxy.susithathukorala-8d7.workers.dev/";

let map;
let busMarkers = {};
let selectedTripId = null;

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

    if(minutes<=5){

        colour="red";

    }
    else if(minutes<=10){

        colour="orange";

    }
    else{

        colour="green";

    }

    return `<span class="badge ${colour}">
                ${minutes} min
            </span>`;

}

// -------------------------------
// Initialise Leaflet Map
// -------------------------------

function initialiseMap(){

    map = L.map("map").setView(
        [-34.9213,138.6380],
        13
    );

    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            attribution:
            "&copy; OpenStreetMap contributors"
        }
    ).addTo(map);

}

// -------------------------------
// Load Live Vehicles
// -------------------------------

async function loadVehicles() {

    try {

        const response = await fetch(VEHICLE_API);

        const buses = await response.json();

        // Track vehicles seen in this update
        const activeVehicles = new Set();

        buses.forEach(bus => {

            if (
    selectedTripId &&
    bus.tripId != selectedTripId
){
    return;
}

            activeVehicles.add(bus.vehicle);

            const latlng = [bus.latitude, bus.longitude];

            const popup = `
                <b>🚌 Route ${bus.route}</b><br>
                Bus: ${bus.label}<br>
                Speed: ${(bus.speed * 3.6).toFixed(1)} km/h<br>
                Direction: ${bus.direction}<br>
                Bearing: ${bus.bearing.toFixed(0)}°
            `;

            if (busMarkers[bus.vehicle]) {

                // Move existing marker
                busMarkers[bus.vehicle].setLatLng(latlng);
                busMarkers[bus.vehicle].setPopupContent(popup);

            } else {

                // Create new marker once
                const busIcon = L.divIcon({
                    html: "🚌",
                    className: "bus-icon",
                    iconSize: [30, 30],
                    iconAnchor: [15, 15]
                });

                busMarkers[bus.vehicle] = L.marker(latlng, {
                    icon: busIcon
                })
                .addTo(map)
                .bindPopup(popup);

                busMarkers[bus.vehicle] = marker;

// Only zoom if this is the selected trip
if (
    selectedTripId &&
    bus.tripId == selectedTripId &&
    !map.getBounds().contains(latlng)
) {

    map.flyTo(latlng, 15, {
        animate: true,
        duration: 1
    });

    marker.openPopup();

}

                console.log("Created marker:", bus.vehicle);

            }

        });

        // Remove buses no longer present
        Object.keys(busMarkers).forEach(vehicleId => {

            if (!activeVehicles.has(vehicleId)) {

                map.removeLayer(busMarkers[vehicleId]);
                delete busMarkers[vehicleId];

                console.log("Removed marker:", vehicleId);

            }

        });

    }
    catch(err){

        console.error(err);

    }

}

// -------------------------------
// Build Table
// -------------------------------

function populateTable(tableId,buses){

    const tbody=document.querySelector(
        "#" + tableId + " tbody"
    );

    tbody.innerHTML="";

    if(buses.length===0){

        tbody.innerHTML=
        `<tr>
            <td colspan="3">
                No Route 174 services
            </td>
        </tr>`;

        return;
    }


    buses.forEach(bus=>{

        const row=document.createElement("tr");

        row.innerHTML=`

            <td>${bus.route_id}</td>

            <td>${formatTime(bus.arrival_time)}</td>

            <td>${badge(bus.min)}</td>

        `;

        row.style.cursor = "pointer";

row.onclick = () => {

    selectedTripId = bus.trip_id;

    loadVehicles();

};

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

        console.log(services);

        return services
            .filter(x=>x.route_id==="174")
            .slice(0,10);

    }

    catch(e){

        console.error(e);

        return [];

    }

}



// -------------------------------
// Load Dashboard
// -------------------------------

async function loadDashboard(){

    const outbound=
        await loadStop(OUTBOUND_STOP);

    const inbound=
        await loadStop(INBOUND_STOP);

    populateTable(
        "outboundTable",
        outbound
    );

    populateTable(
        "inboundTable",
        inbound
    );

    await loadVehicles();

    document.getElementById(
        "updated"
    ).textContent=
        "Last updated : "
        + new Date().toLocaleTimeString("en-AU");

}



// -------------------------------
// Refresh
// -------------------------------

initialiseMap();

loadDashboard();

setInterval(
    loadDashboard,
    15000
);