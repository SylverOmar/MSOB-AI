"use strict";

const CACHE_NAME = "msob-static-v4";
const APP_SHELL = [
  "/",
  "/index.html",
  "/secure.css?v=28",
  "/secure-app.js?v=29",
  "/mascot.js?v=12",
  "/manifest.webmanifest",
  "/favicon.png",
  "/Logo.png",
  "/Logo_lower.png",
  "/Logo_upper.png",
  "/pwa-icon-192.png",
  "/pwa-icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request).catch(async () => (
        (await caches.match("/index.html")) || Response.error()
      ))
    );
    return;
  }

  if (["script", "style", "manifest"].includes(request.destination)) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (["image", "font"].includes(request.destination)) {
    event.respondWith(cacheFirst(request));
  }
});
