// Minimal service worker so the app is installable as a PWA.
// Phase 2 will add offline caching of the app shell and push-notification
// handling (for background timer alerts). For now it just claims clients so
// the install criteria are met.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Server-driven timer pushes (and the test alert) land here.
self.addEventListener("push", (event) => {
  const data = (() => {
    try { return event.data.json(); } catch { return { title: "Get Fried", body: "Timer" }; }
  })();
  event.waitUntil(
    self.registration.showNotification(data.title || "Get Fried", {
      body: data.body || "",
      vibrate: [300, 150, 300, 150, 300],
      tag: data.tag || "air-fry-timer",
      renotify: true,
      requireInteraction: true, // stay on screen until dismissed (Android)
    })
  );
});

// Focus an existing tab if open, otherwise open the app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) return c.focus();
      }
      return self.clients.openWindow("/");
    })
  );
});
