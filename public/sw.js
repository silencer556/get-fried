// Minimal service worker so the app is installable as a PWA.
// Phase 2 will add offline caching of the app shell and push-notification
// handling (for background timer alerts). For now it just claims clients so
// the install criteria are met.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Placeholder: Phase 2 server-driven timer pushes will be handled here.
self.addEventListener("push", (event) => {
  const data = (() => {
    try { return event.data.json(); } catch { return { title: "Get Fried", body: "Timer" }; }
  })();
  event.waitUntil(
    self.registration.showNotification(data.title || "Get Fried", {
      body: data.body || "",
      vibrate: [200, 100, 200],
      tag: "air-fry-timer",
      renotify: true,
    })
  );
});
