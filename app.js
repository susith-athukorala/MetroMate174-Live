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
"https://api-cf-au5.anytrip.com.au/api/v3/region/au5/vehicles?routeGroupIds=au5:buses:174";

let map;


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

        const url =
        "https://gtfs.adelaidemetro.com.au/v1/realtime/vehicle_positions/debug";

        const response = await fetch(url);

        console.log("Status:", response.status);

        const text = await response.text();

        console.log(text.substring(0,500));

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