// =======================================
// MetroMate174 Service Worker
// Version 1.0
// =======================================

const CACHE_NAME = "metromate174-v3";

const FILES_TO_CACHE = [
    "./",
    "./index.html",
    "./style.css",
    "./app.js",
    "./manifest.json",
    "./icon-192.png",
    "./icon-512.png"
];


// ----------------------------
// Install
// ----------------------------

self.addEventListener("install", event => {

    console.log("MetroMate174 installed");

    event.waitUntil(

        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(FILES_TO_CACHE))

    );

    self.skipWaiting();

});


// ----------------------------
// Activate
// ----------------------------

self.addEventListener("activate", event => {

    event.waitUntil(

        caches.keys().then(keys => {

            return Promise.all(

                keys.map(key => {

                    if(key !== CACHE_NAME){

                        return caches.delete(key);

                    }

                })

            );

        })

    );

    self.clients.claim();

});


// ----------------------------
// Fetch
// ----------------------------

self.addEventListener("fetch", event => {

    // Never cache Adelaide Metro / realtime API responses — this
    // dashboard is only useful with fresh data.
    if(
        event.request.url.includes("api-cloudfront.adelaidemetro.com.au") ||
        event.request.url.includes("workers.dev")
    ){

        event.respondWith(fetch(event.request));

        return;

    }

    // Network-first for the app shell itself (index.html, style.css,
    // app.js, ...): always try to fetch the latest version first, so
    // a new deploy is picked up immediately instead of quietly
    // serving a stale cached copy. Only fall back to the cache if the
    // network request fails (e.g. offline).
    event.respondWith(

        fetch(event.request)

            .then(response => {

                const copy = response.clone();

                caches.open(CACHE_NAME)
                    .then(cache => cache.put(event.request, copy));

                return response;

            })

            .catch(() => caches.match(event.request))

    );

});
