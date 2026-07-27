// =======================================
// MetroMate174 Service Worker
// Version 1.0
// =======================================

const CACHE_NAME = "metromate174-v1";

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

    // Never cache Adelaide Metro API responses.
    if(event.request.url.includes("api-cloudfront.adelaidemetro.com.au")){

        event.respondWith(fetch(event.request));

        return;

    }

    event.respondWith(

        caches.match(event.request)

            .then(response => {

                return response || fetch(event.request);

            })

    );

});